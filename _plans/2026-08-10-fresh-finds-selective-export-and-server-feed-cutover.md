# Fresh Finds: selective export, quick bulk select, and the server-feed cutover

Date: 2026-08-10
Status: in progress
Owner: web dashboard
Branch: fresh-finds-row-select-and-speed

## Goals

1. Let a user export exactly the rows they choose to a Google Sheet (and to CSV), not
   only the whole filtered view.
2. Let a user select many rows in one gesture: a whole page, the first N of the current
   view, everything matching, or a shift-click range - instead of ticking one by one.
3. Fix the page speed. The feed still ships ~28 MB / ~14k rows to the browser on every
   load because the Phase 2 server-side feed (built and merged in PR #56, plan
   `2026-07-28-fresh-finds-performance.md`) is behind `SERVER_SIDE_FEED=1` and off by
   default. This work finishes the Phase 3 cutover and turns the server feed on.

## Approach

### Selection and export

- Row checkboxes and the bulk toolbar show for anyone with `edit_ads` OR `export_data`
  (previously edit-only). Edit actions inside the toolbar stay gated on `edit_ads`,
  refresh on `run_scrapes`; the toolbar gains `CSV (n)` and `SHEET (n)` buttons so a
  selection can be exported directly.
- When rows are selected, EXPORT CSV / EXPORT TO SHEET export exactly those rows,
  whatever page they sit on. With no selection, behavior is unchanged: the whole
  filtered view exports.
- A caret menu beside the header checkbox (ColumnPicker popover pattern) offers:
  This page / First N (typed number) / All matching / Clear. Shift-click on a row
  checkbox selects the range from the last-clicked checkbox.
- New ids-only query `getFeedIds` (same predicate/sort as `getFeedPage`, optional
  limit) powers select-all-matching and select-first-N in server mode; client mode
  slices its in-memory filtered list.
- `getFeedExport` accepts an explicit id list, so a selection CSV is re-read
  server-side in the current sort order with metrics attached.

### Server-feed cutover (speed)

- `SERVER_SIDE_FEED` flips from opt-in to opt-out: the server feed is the default,
  `SERVER_SIDE_FEED=0` restores the old all-rows client path (the rollback lever).
- The initial payload drops the facet aggregates (the Dashboard already refetches them
  on mount, so shipping them was double work); rows + ticker still server-render. The
  filter rail shows a loading line until facets arrive.
- Competitors, Trends and Pipeline still analyse every ad in the browser. In server
  mode they lazy-load the full feed once, on first open, exactly like the
  Review/Filtered/Rejected tabs do (new `loadFullFeed` action; server-side TTL cache
  keeps it cheap). Fresh Finds - the default view - never pays that cost.
- Control Room's per-domain "held" counts come from a new `getDomainAdCounts`
  group-by (same feed predicate) instead of counting the shipped array.
- Detail view lookup and prev/next walk the loaded page in server mode (cross-page
  stepping would need a fetch per step; noted as a follow-up). Keyboard j/k paging
  reads the server total.
- Page-size 'all' is not offered in server mode (the server pages at max 500); a
  remembered 'all' maps to 500.
- `loadFeedExport` gate changes from `export_data` to signed-in: the CSV download has
  always been available to every account (the data used to sit in their browser), and
  `loadSecondaryTab`/`loadFullFeed` already hand full row sets to any signed-in user.
  Writing to Google Sheets stays behind `export_data`.

## Alternatives considered

- Virtualized rendering of the full client-side list: rejected - it fixes DOM cost but
  not the 28 MB payload or the 14k-object memory/scan cost, and the server feed
  already exists.
- Keeping the flag opt-in and only setting the env var in Vercel: rejected - the flag
  path has known gaps (exports, select-all, detail nav, secondary views see one page)
  that would ship silently-wrong behavior; those must be fixed before any cutover, and
  once fixed the default should be the fast path. Rollback stays one env var away.
- Server-side rewrites of Competitors/Trends/Pipeline: correct endgame, out of scope
  here; lazy full-feed keeps them correct today at the old cost, paid only on open.

## Security

- New actions (`loadFeedIds`, `loadFullFeed`, `loadDomainAdCounts`) are read-only and
  gated on a signed-in session, matching `loadFeedPage`/`loadSecondaryTab`. All inputs
  reach SQL as bound parameters; sort keys map through the existing allow-list.
  `exportToSheet` keeps its `export_data` gate and its id re-read (server-authoritative
  rows, formula-injection-safe writes).
- No new secrets, no new logging of ad bodies or PII (counts, ids, timings only).

## QA

- Full node test suite + `next build` green.
- Data-layer parity against the live DB (read-only): `getAds().length` equals
  `getFeedPage` total; `getFeedIds` count/order matches `getFeedPage` rows; facet and
  ticker counts spot-checked against client-side computation.
- UI flows walked in code review (login-gated UI cannot be driven headlessly without
  prod credentials): select/deselect, select-N paths in both modes, exports with and
  without selection, lazy tabs, detail nav, keyboard nav, empty states.
- Human pass on the Vercel preview before merge: Fresh Finds loads fast, filters work,
  Competitors/Trends/Pipeline load on open, sheet export of a small selection lands.

## Follow-ups (not this PR)

- Detail prev/next across page boundaries in server mode.
- Palette ad-search over the whole feed in server mode before the full feed loads.
- Server-side Competitors/Trends/Pipeline aggregates, retiring `loadFullFeed`.
- Remove the client-side feed path entirely once the server path has soaked.
