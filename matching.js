// Blacklist matching logic for the campground booking checker.
// Pure, dependency-free ES module so it runs unchanged on Cloudflare Workers
// (V8) and under Node for tests.
//
// Two-tier matching:
//   1. EXACT  -- normalized values via O(1) Set lookups.
//   2. FUZZY  -- (name + email only) typo tolerance via Optimal String
//                Alignment (restricted Damerau-Levenshtein): an adjacent
//                transposition ("jhon"->"john") costs one edit. Phone numbers
//                are matched EXACTLY only -- a changed digit is a different,
//                valid number.
//
// Fuzzy candidates are pruned by string length before any distance is
// computed: a query of length L can only match banned entries whose length is
// in [t*L, L/t]. Distances are bounded/early-exit.

export const FIELD_ALIASES = {
  email: new Set(["email", "emailaddress", "e-mail", "mail"]),
  name: new Set(["name", "fullname", "guestname", "customername", "firstlast"]),
  phone: new Set(["phone", "phonenumber", "phoneno", "mobile", "cell", "tel",
    "telephone", "contactnumber"]),
};

export const FUZZY_FIELDS = ["name", "email"];

export function canonHeader(header) {
  const key = String(header || "").trim().toLowerCase().replace(/[\s_]+/g, "");
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.has(key)) return canonical;
  }
  return null;
}

// --- normalizers ----------------------------------------------------------

export function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}

export function normName(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "") // drop punctuation (O'Brien -> obrien)
    .replace(/\s+/g, " ");            // collapse whitespace
}

export function normPhone(v) {
  const digits = String(v || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export const NORMALIZERS = { email: normEmail, name: normName, phone: normPhone };

// --- edit distance (bounded OSA) ------------------------------------------

export function boundedOSA(a, b, maxDist) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let prev2 = null;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a[i - 1];
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b[j - 1] ? 0 : 1;
      let val = Math.min(
        prev[j] + 1,          // deletion
        cur[j - 1] + 1,       // insertion
        prev[j - 1] + cost,   // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, prev2[j - 2] + 1); // adjacent transposition
      }
      cur[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1; // whole row too far -> bail
    prev2 = prev;
    prev = cur;
  }
  return prev[lb];
}

export function similarity(a, b, threshold) {
  const m = Math.max(a.length, b.length);
  if (m === 0) return 1.0;
  let maxDist = Math.floor((1.0 - threshold) * m);
  if (maxDist < 0) maxDist = 0;
  const dist = boundedOSA(a, b, maxDist);
  if (dist > maxDist) return 0.0;
  return 1.0 - dist / m;
}

// --- CSV parsing (RFC-4180-ish, handles quotes/commas/newlines) ------------

export function parseCsv(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  const s = String(text || "").replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0];
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const rec = {};
    for (let c = 0; c < headers.length; c++) rec[headers[c]] = rows[r][c] ?? "";
    records.push(rec);
  }
  return { headers, records };
}

// Map a raw record's columns to canonical fields {email,name,phone}.
export function mapRecord(rec) {
  const mapped = {};
  for (const [rawHeader, value] of Object.entries(rec)) {
    const c = canonHeader(rawHeader);
    if (c) mapped[c] = value;
  }
  return mapped;
}

// --- blacklist ------------------------------------------------------------

export function buildBlacklist(records, { threshold = 0.85, fuzzy = true } = {}) {
  const exact = { email: new Set(), name: new Set(), phone: new Set() };
  const buckets = { email: new Map(), name: new Map() }; // len -> [[norm, raw]]

  for (const rec of records) {
    const mapped = mapRecord(rec);
    for (const f of ["email", "name", "phone"]) {
      if (!(f in mapped)) continue;
      const norm = NORMALIZERS[f](mapped[f]);
      if (!norm) continue;
      exact[f].add(norm);
      if (FUZZY_FIELDS.includes(f)) {
        const b = buckets[f];
        if (!b.has(norm.length)) b.set(norm.length, []);
        b.get(norm.length).push([norm, mapped[f]]);
      }
    }
  }
  return { exact, buckets, threshold, fuzzy };
}

function* fuzzyCandidates(bl, field, queryLen) {
  const t = bl.threshold;
  const lo = t <= 0 ? 0 : Math.ceil(t * queryLen);
  const hi = t <= 0 ? 1e9 : Math.floor(queryLen / t);
  const b = bl.buckets[field];
  for (let len = lo; len <= hi; len++) {
    const arr = b.get(len);
    if (arr) for (const pair of arr) yield pair;
  }
}

// Return an array of match reasons for the booking (one per matched field).
export function checkBooking(booking, bl) {
  // canonicalize booking keys
  const canon = {};
  for (const [k, v] of Object.entries(booking)) {
    const c = canonHeader(k) || (k in NORMALIZERS ? k : null);
    if (c) canon[c] = v;
  }

  const reasons = [];
  for (const f of ["email", "name", "phone"]) {
    if (!(f in canon)) continue;
    const norm = NORMALIZERS[f](canon[f]);
    if (!norm) continue;

    // Tier 1: exact
    if (bl.exact[f].has(norm)) {
      reasons.push({ field: f, bookingValue: canon[f], bannedValue: norm,
        matchType: "exact", similarity: 1.0 });
      continue;
    }
    // Tier 2: fuzzy (name + email only), first hit above threshold wins
    if (bl.fuzzy && FUZZY_FIELDS.includes(f)) {
      const t = bl.threshold;
      for (const [bannedNorm, bannedRaw] of fuzzyCandidates(bl, f, norm.length)) {
        const sim = similarity(norm, bannedNorm, t);
        if (sim >= t) {
          reasons.push({ field: f, bookingValue: canon[f], bannedValue: bannedRaw,
            matchType: "fuzzy", similarity: Math.round(sim * 1000) / 1000 });
          break;
        }
      }
    }
  }
  return reasons;
}

// Check an array of booking records (each keyed by column/field name) against
// a blacklist CSV. Shared by the bulk-CSV and single-person search paths.
// minFields: how many distinct fields must match for a booking to be flagged
//   (1 = default; 2 = "double field" mode, cuts false positives on common names).
export function checkRecords(records, blacklistCsv, opts = {}) {
  const { threshold = 0.85, fuzzy = true, minFields = 1 } = opts;
  const bl = buildBlacklist(parseCsv(blacklistCsv).records, { threshold, fuzzy });

  const results = records.map((raw) => {
    const reasons = checkBooking(mapRecord(raw), bl);
    return { row: raw, reasons, banned: reasons.length >= minFields };
  });
  const flagged = results.filter((r) => r.banned);
  return { total: results.length, results, flagged, minFields, threshold, fuzzy };
}

// Bulk: parse a bookings CSV and check every row.
export function runCheck(bookingsCsv, blacklistCsv, opts = {}) {
  return checkRecords(parseCsv(bookingsCsv).records, blacklistCsv, opts);
}
