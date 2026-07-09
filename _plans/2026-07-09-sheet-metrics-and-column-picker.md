# Sheet metrics on Fresh Finds + Review, and a column picker

Date: 2026-07-09
Branch: sheet-metrics-and-column-picker (stacked on ad-archive-id-column, which
added the Ad Archive ID column these tables now have)

## Goal

The team keeps campaign performance in a Google Sheet ("Comp Test", tab DB2:
one row per campaign with network, target URL, revenue prediction, clicks, RPC,
top keywords). Bring four of those numbers into AdIntel next to each ad:

1. Read the DB2 tab, keep only rows whose `network_normalized` is
   `facebook-rsoc`.
2. Match sheet rows to ads by landing-page URL with tracking parameters
   stripped on both sides (`...usco?dest=...&network=facebook` and
   `...usco` are the same page).
3. Show `revenue_prediction_finalized`, `click_count`, `RPC`, and
   `top_10_keywords` as columns on Fresh Finds and Review.
4. Include the four columns in the CSV and Google-Sheet exports.
5. Let the user choose which columns each table shows, remembered per browser.
6. The join must hold on every run without anyone thinking about it (added by
   the user mid-build), plus a manual refresh button. Covered by design: every
   page render re-joins against the sheet (10-minute cache), so each scrape's
   results carry metrics the moment they render; the admin-only "⟳ METRICS"
   button in Fresh Finds forces an immediate re-read when the sheet just
   changed.

## Assumptions (stated so they can be corrected cheaply)

- Only ads in AdIntel's TONIC RSOC feed are matched (confirmed by the user
  mid-build: "this is just for TONIC RSOC feed"). Other feeds always show
  dashes, so a coincidental URL overlap can never borrow TONIC's numbers.
- Matching is by URL only, not URL + country. The sheet has several rows per
  URL (one per country); those are aggregated: revenue and clicks are summed,
  RPC is recomputed as summed revenue / summed clicks (the weighted average),
  and keywords come from the highest-revenue row. Confirmed with Amit (Slack,
  2026-07-09): totals are what he wants, plus a GEOS column showing the
  revenue split per sheet country as "CC-percent" pairs, biggest first
  (e.g. ES-90,MX-10). GEOS is revenue-only by design and deliberately
  independent of AdIntel's own Country column - it tells the reader where an
  article actually earns even when the scraped country guess was wrong.
- The sheet is read live with a short server cache, not synced into Postgres.
  The metrics change in the sheet, ads keep no history, and a DB copy would
  need a migration plus a sync job for no read-path benefit at 500 rows.
- The spreadsheet ID and tab default to the sheet the user pointed at
  (`1ErBMP6TNNjNDBJg9qTIQOAkaO0fzpaOIDZ_BakphM-g` / `DB2`) as code constants,
  overridable with `METRICS_SPREADSHEET_ID` / `METRICS_SHEET_TAB` env vars.
  The ID alone grants no access, so it is not a secret.
- Sheet headers are matched by name, not position (`campaign_target_url`,
  `network_normalized`, `click_count`, `RPC`, `top_10_keywords`, and
  `revenue_prediction_finalized` with a prefix fallback to
  `revenue_prediction*`), so column reordering in the sheet cannot break it.
- Metric columns default to visible; the picker is how you turn them off.

## Alternatives rejected

- **Sync sheet -> Postgres table**: survives Sheets outages and is queryable in
  SQL, but needs a migration, a sync trigger, and staleness handling. The live
  read with a 10-minute cache gets the same freshness with far less machinery;
  revisit if the tab grows past tens of thousands of rows.
- **Client-side fetch of the sheet**: would need the service-account key in
  the browser. Never.
- **Match including query params**: the ad URLs carry per-campaign tracking
  params the sheet URLs lack; almost nothing would match. Stripping params is
  the user's explicit spec.

## Architecture

Layers stay as they are: data access on the server (lib), presentation in
components, joined data flows down as props.

- `web/lib/sheets.js`: export `readSheetTab({ spreadsheetId, tabName }, nowMs)`
  wrapping the existing private `readRows` + token flow. Read-only use of the
  same `spreadsheets` scope.
- `web/lib/metrics.js` (new, server-only fetch + pure helpers):
  - `normalizeUrlKey(url)` -> `host/path` key: lowercase host, `www.` and
    scheme dropped, query/fragment dropped, trailing slash trimmed.
  - `adUrlKeys(linkUrl)` -> keys for every ` | `-joined DCO destination.
  - `buildMetricsIndex(values)` -> Map(urlKey -> { revenue, clicks, rpc,
    keywords, rows }) from raw tab values (header row parsed by name,
    facebook-rsoc filter, duplicate-URL aggregation, comma-tolerant numbers).
  - `attachSheetMetrics(ads, index)` -> ads copied with `sheet_revenue`,
    `sheet_clicks`, `sheet_rpc`, `sheet_keywords` (null when no match);
    first matching DCO destination wins.
  - `getSheetMetricsIndex(nowMs)` -> cached fetch (10 min TTL in-module, like
    the token cache); on failure serves the last good index, else null.
    Never throws: a Sheets outage degrades to empty metric cells.
- `web/app/page.js`: fetch the index in the same `Promise.all`, attach to both
  `ads` and `reviewAds` before rendering. SSOT for the join is metrics.js; the
  client never re-derives it.
- `web/app/actions.js` `exportToSheet`: attach metrics after `getAdsByIds` so
  the sheet export carries the same four fields. CSV needs nothing: it builds
  client-side from the already-joined rows.
- `web/lib/ui.js`: four new `SHEET_COLUMNS` entries (Revenue Prediction,
  Clicks, RPC, Top Keywords) after Slug -> CSV, sheet export, and the export
  modal's picker all inherit them. Plus `sanitizeColumnKeys(stored, defs)` for
  the table pickers.
- `web/components/ColumnPicker.jsx` (new): COLUMNS button + checkbox popover
  and a `useColumnPrefs(storageKey, defs)` hook (localStorage persistence,
  unknown keys dropped on load).
- `web/components/Dashboard.jsx` (FreshFinds) and `ReviewView.jsx`: the four
  metric cells, the picker wired in the toolbar, every non-structural column
  render gated on visibility, `tableMinW` computed from visible widths.
  Thumbnail and Headline stay fixed (the table's anchor), as do the
  checkbox/decision columns. Fresh Finds gains `revenue` and `rpc` sort keys
  (metric columns without sort are half-useful).
- localStorage keys: `adintel.cols.freshfinds`, `adintel.cols.review`
  (same naming family as `adintel.export.*`).

## Security

- The service-account key never leaves the server; reading uses the already
  granted scope. The account must be given at least Viewer on the sheet.
- Sheet cell values are rendered as text only (no formulas executed, no HTML).
- Viewers see the metric columns like any other ad field; the sheet holds
  team-internal campaign data the dashboard already parallels. No new inputs
  from untrusted users; no secrets logged.

## Observability

- `[metrics] loaded` (rows read, facebook-rsoc rows, unique URLs, ms),
  `[metrics] cache` hits, `[metrics] failed` with the reason and whether stale
  data is being served, `[metrics] attach` (ads in, matched count) on the
  server; `[columns] saved` with the key list on the client.

## Settings

- The column picker itself is the new user-facing setting (per browser).
- Metrics source sheet/tab: env override, documented in SETUP.md; not in the
  UI because it changes ~never and a wrong value silently blanks four columns.
- Not exposed: cache TTL, aggregation rule (one correct definition each).

## Testing

- `web/tests/metrics.test.mjs` (pure helpers): URL normalization incl. the
  user's exact example, DCO multi-URL keys, header mapping incl. the
  `revenue_prediction*` fallback, facebook-rsoc filtering, duplicate-URL
  aggregation (sums + weighted RPC + top row's keywords), comma numbers,
  missing headers -> empty index, attach with match / no match / null index.
- `web/tests/ui.test.mjs` additions: new columns flow through `buildCsv` and
  `buildSheetData`; `sanitizeColumnKeys` drops unknowns and falls back.
- Full `npm test` (web) green; Python untouched, but `pytest` run to confirm.

## Deploy

- Normal flow: PR into `main`; merge deploys the dashboard via Vercel.
- One-time: share the spreadsheet with the service account (`GCS_CLIENT_EMAIL`)
  as Viewer, else the columns stay blank (the server logs `[metrics] failed`
  with the permission message).
- No migration, no scraper change. Rollback = revert the PR.
- Cost: Google Sheets API reads are free at this volume (1 read / 10 min).

## QA checklist

- Ad whose link_url matches a sheet row (params stripped) shows all four
  values; the same row appears identically in CSV and sheet export.
- Ad with no sheet match shows dashes everywhere, exports empty cells.
- Sheets unreachable / key missing locally: page renders normally, dashes.
- Duplicate-URL sheet rows aggregate (spot-check one URL by hand).
- Column picker: hide/show every optional column on both tabs, reload
  restores, RESET returns to defaults, table width tracks visible columns.
- Sort by revenue / rpc places unmatched ads at the bottom in both directions.
