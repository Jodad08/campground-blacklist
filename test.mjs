// Node tests for the Worker matching logic.
//   node test.mjs
import assert from "node:assert";
import {
  normPhone, similarity, parseCsv, buildBlacklist, checkBooking, runCheck,
  checkRecords,
} from "./matching.js";

let pass = 0;
function t(name, fn) {
  fn();
  pass++;
  console.log("PASS ", name);
}

const BL = `name,email,phone
John Smith,banned.john@example.com,(555) 123-4567
Jane Doe,jane.doe@example.com,555-987-6543`;

function bl(threshold = 0.85, fuzzy = true) {
  return buildBlacklist(parseCsv(BL).records, { threshold, fuzzy });
}

// --- normalization + exact ---
t("phone normalization", () => {
  assert.equal(normPhone("+1 (555) 123-4567"), "5551234567");
  assert.equal(normPhone("555.123.4567"), "5551234567");
});

t("exact matches (case/format insensitive)", () => {
  const b = bl();
  assert.ok(checkBooking({ email: "BANNED.JOHN@EXAMPLE.COM" }, b).length);
  assert.ok(checkBooking({ phone: "+1 555 123 4567" }, b).length);
  assert.ok(checkBooking({ name: "john  smith" }, b).length);
});

// --- fuzzy ---
t("fuzzy catches typos incl. transposition", () => {
  const b = bl();
  for (const n of ["Jon Smith", "John Smyth", "Johm Smith", "Jhon Smith"]) {
    assert.ok(checkBooking({ name: n }, b).length, `should catch "${n}"`);
  }
  assert.ok(checkBooking({ email: "banned.jon@example.com" }, b).length);
});

t("fuzzy rejects different people", () => {
  const b = bl();
  assert.equal(checkBooking({ name: "Jane Smith" }, b).length, 0);
  assert.equal(checkBooking({ name: "Bob Lee" }, b).length, 0);
});

t("phone is exact-only (no fuzzy on digits)", () => {
  const b = bl();
  assert.ok(checkBooking({ phone: "5551234567" }, b).length);       // same number
  assert.equal(checkBooking({ phone: "555-123-4568" }, b).length, 0); // off by one
});

t("threshold controls strictness", () => {
  const loose = buildBlacklist(parseCsv("name\nKatherine").records, { threshold: 0.8 });
  const strict = buildBlacklist(parseCsv("name\nKatherine").records, { threshold: 0.95 });
  assert.ok(checkBooking({ name: "Katharine" }, loose).length);
  assert.equal(checkBooking({ name: "Katharine" }, strict).length, 0);
});

// --- double-field option ---
t("double-field: single-field match NOT flagged when minFields=2", () => {
  // matches on name only (email + phone are fresh)
  const csv = `Full Name,Email,Phone
John Smith,someone.new@example.com,555-000-1111`;
  const one = runCheck(csv, BL, { minFields: 1 });
  const two = runCheck(csv, BL, { minFields: 2 });
  assert.equal(one.flagged.length, 1, "minFields=1 flags a single-field match");
  assert.equal(two.flagged.length, 0, "minFields=2 does NOT flag a single-field match");
});

t("double-field: two-field match IS flagged when minFields=2", () => {
  // matches on name AND phone
  const csv = `Full Name,Email,Phone
John Smith,someone.new@example.com,(555) 123-4567`;
  const two = runCheck(csv, BL, { minFields: 2 });
  assert.equal(two.flagged.length, 1);
  const fields = two.flagged[0].reasons.map((r) => r.field).sort();
  assert.deepEqual(fields, ["name", "phone"]);
});

t("double-field: works with a fuzzy + exact combo", () => {
  // fuzzy name (Jhon->John) + exact email -> 2 fields
  const csv = `Full Name,Email,Phone
Jhon Smith,banned.john@example.com,555-000-2222`;
  const two = runCheck(csv, BL, { minFields: 2 });
  assert.equal(two.flagged.length, 1);
});

// --- CSV parser robustness ---
t("CSV parser handles quotes and embedded commas", () => {
  const { records } = parseCsv('name,note\n"Smith, John","a ""quoted"" note"');
  assert.equal(records[0].name, "Smith, John");
  assert.equal(records[0].note, 'a "quoted" note');
});

t("full runCheck end-to-end", () => {
  const bookings = `Full Name,Email Address,Phone Number
Alice Green,alice@example.com,555-000-1111
Jhon Smith,typo@example.com,555-444-5555
Clean Camper,clean@example.com,555-321-6540`;
  const r = runCheck(bookings, BL, { threshold: 0.85, fuzzy: true, minFields: 1 });
  assert.equal(r.total, 3);
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0].row["Full Name"], "Jhon Smith");
});

// --- single-person search (checkRecords with one record) ---
t("search: one banned person by name typo", () => {
  const r = checkRecords([{ name: "Jhon Smith", email: "", phone: "" }], BL, {});
  assert.equal(r.results[0].banned, true);
  assert.equal(r.results[0].reasons[0].field, "name");
});

t("search: one clean person", () => {
  const r = checkRecords([{ name: "Totally New", email: "new@x.com", phone: "555-000-0000" }], BL, {});
  assert.equal(r.results[0].banned, false);
  assert.equal(r.flagged.length, 0);
});

t("search: phone-only lookup matches banned number", () => {
  const r = checkRecords([{ phone: "+1 (555) 987-6543" }], BL, {});
  assert.equal(r.results[0].banned, true);
  assert.equal(r.results[0].reasons[0].field, "phone");
});

t("search: double-field mode needs 2 fields even for a single search", () => {
  // only name matches -> not banned under minFields=2
  const r = checkRecords([{ name: "John Smith", email: "brand.new@x.com" }], BL, { minFields: 2 });
  assert.equal(r.results[0].banned, false);
});

console.log(`\nAll ${pass} tests passed.`);
