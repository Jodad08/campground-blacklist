# Campground Blacklist Checker — Cloudflare Worker

The same exact + fuzzy (typo-tolerant) matching as the Python version, ported to
JavaScript so it runs at the edge on Cloudflare Workers — permanently free on the
free tier (100k requests/day), no server, fast everywhere.

## Files

- `worker.js` — the Worker: `GET /` UI, `POST /check` API, `PUT /blacklist` (KV).
- `matching.js` — pure matching logic (exact sets, OSA fuzzy, length bucketing).
- `test.mjs` — Node tests (correctness + the double-field option).
- `wrangler.toml` — deploy config (optional KV binding).
- `package.json` — scripts + wrangler dev dependency.
- `blacklist-template.csv`, `bookings-template.csv` — example input files.

## Deploy (free)

```bash
npm install
npx wrangler login        # opens browser, one time
npm run deploy            # publishes to your-worker.workers.dev
```

That's it — you get a free `*.workers.dev` URL. Local preview: `npm run dev`.

## Matching

Two tiers, identical semantics to the Python version:

1. **Exact** — normalized email/name/phone via O(1) set lookups (case, spacing,
   punctuation, and phone formatting are normalized away).
2. **Fuzzy** (name + email only) — Optimal String Alignment distance, so
   transpositions like `Jhon`→`John` count as one edit. Phone is exact-only.

**Double-field mode** (`minFields: 2`): a booking is only flagged when it matches
a banned guest on **2 or more** distinct fields (e.g. name *and* phone). This
sharply cuts false positives from common names. Toggle it with the checkbox in the
UI, or send `"minFields": 2` to the API.

## API

`POST /check` with JSON:

```json
{
  "bookingsCsv": "Full Name,Email,Phone\\nJhon Smith,a@b.com,555-1234",
  "blacklistCsv": "name,email,phone\\nJohn Smith,banned@b.com,555-9999",
  "threshold": 0.85,
  "fuzzy": true,
  "minFields": 1
}
```

For a **single-person search**, send `booking` instead of `bookingsCsv`:

```json
{ "booking": { "name": "Jhon Smith", "email": "", "phone": "555-1234" },
  "threshold": 0.85, "fuzzy": true, "minFields": 1 }
```

`blacklistCsv` is optional if you've stored one in KV (see below). Response:

```json
{
  "total": 1,
  "flagged": [
    { "row": { ... }, "banned": true,
      "reasons": [ { "field": "name", "matchType": "fuzzy",
                     "similarity": 0.9, "bannedValue": "John Smith" } ] }
  ],
  "minFields": 1, "threshold": 0.85, "fuzzy": true
}
```

## Storing the blacklist server-side (optional)

So clients only ever upload bookings, keep the ban list in Workers KV (free):

```bash
npx wrangler kv namespace create BLACKLIST
# paste the returned id into wrangler.toml, uncomment the [[kv_namespaces]] block
npx wrangler secret put ADMIN_TOKEN        # optional, protects the upload

# upload the current blacklist:
curl -X PUT https://your-worker.workers.dev/blacklist \
  -H "authorization: Bearer YOUR_TOKEN" \
  --data-binary @blacklist.csv
```

After that, `/check` calls can omit `blacklistCsv` and the Worker uses the stored one.

## Using the app

The page has three steps:

1. **Load your blacklist** — upload your banned-guest CSV. It's held in the
   browser (nothing is uploaded until you run a check). It shows how many
   entries loaded.
2a. **Search one person** — type any of name / email / phone and get an instant
    BANNED / not-on-the-list answer. Good for a walk-up or a phone booking.
2b. **Check a bookings CSV** — upload a whole bookings file to flag every banned
    guest at once and download `flagged.csv`.

The match settings (typo tolerance, fuzzy on/off, 2+ field mode) apply to both
the search and the bulk check.

## CSV format

Plain comma-separated with a **header row**. Both files use the same idea: one
row per person, columns for name / email / phone. Headers are auto-detected and
are **case- and spacing-insensitive**, so any of these work:

- name: \`name\`, \`full name\`, \`guest name\`, \`customer name\`
- email: \`email\`, \`email address\`, \`e-mail\`
- phone: \`phone\`, \`phone number\`, \`mobile\`, \`cell\`, \`telephone\`

You only need the columns you actually have — a blacklist of just emails, or just
names + phones, is fine. **Blank cells are ignored** (they never match), so leave
a field empty if you don't have it. Order of columns doesn't matter, and extra
columns (e.g. \`notes\`, \`date_banned\`) are kept and passed through but not used
for matching.

**Blacklist example** (`blacklist-template.csv`):

    name,email,phone
    John Smith,john.smith@example.com,555-123-4567
    Jane Doe,,555-987-6543
    Repeat Offender,repeat@example.com,

**Bookings example** (`bookings-template.csv`):

    Full Name,Email,Phone
    Alice Green,alice@example.com,555-000-1111
    Bob Jones,bob@example.com,555-222-3333

Formatting is normalized automatically before matching, so you don't need to
clean the data first: phone punctuation/country code (\`+1 (555) 123-4567\` ==
\`5551234567\`), letter case, and extra spaces/punctuation in names are all
handled. Both templates are downloadable from inside the app, too.

Tips: save as **CSV UTF-8** from Excel/Sheets. If a value itself contains a comma
(e.g. \`"Smith, John"\`), wrap it in double quotes — standard CSV and the parser
handles it.

## Notes / limits

- Workers have a CPU-time limit per request (10 ms on the free plan). Exact-first
  + length bucketing keeps each check tiny, so a campground-sized blacklist
  (hundreds of entries) is comfortably within budget. For very large blacklists
  (tens of thousands) or huge booking files, prefer server-side KV + smaller
  batches, or bump to the paid plan's higher CPU limit.
- Everything is processed in the request; nothing is logged or persisted unless
  you opt into KV.

## Tests

```bash
node test.mjs
```
