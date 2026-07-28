# Fresh Finds performance: move from all-rows-client-side to server-side

Date: 2026-07-28
Status: proposed (awaiting approval)
Owner: web dashboard

## Problem (measured, not guessed)

The Fresh Finds feed (`getAds` in `web/lib/queries.js`, rendered by `web/components/Dashboard.jsx`)
ships **every** approved, non-prohibited ad to the browser on **every** page load, with no cache
(`export const dynamic = 'force-dynamic'` in `web/app/page.js`). The browser then holds the whole
array in React state and does all filtering, sorting, searching, pagination, facet counting, and
CSV/Sheet export in memory.

Measured against the live DB on 2026-07-28:

| Metric | Value |
|---|---|
| Total ads | 18,813 |
| Rows the feed ships every load | 14,392 |
| Serialized feed payload | ~28 MB (before Next.js RSC framing) |
| Full feed query wall time | ~1.3 s |
| One page of 50 rows | 217 ms wall / **22 ms** DB execution |
| `count(*)` over the feed filter | ~202 ms (round-trip dominated) |

`EXPLAIN ANALYZE` on the paginated query: a 22 ms seq-scan + top-N heapsort. **The database is not the
bottleneck.** The 1.3 s is the cost of materializing and transferring 14,392 wide (~40-column) rows.
The bottleneck is the payload and the in-browser processing of 14k objects.

This gets worse every scrape. It is an architecture problem, not a tuning problem.

## Goal

Fresh Finds loads fast and stays responsive during interaction, and keeps doing so as the table grows
past 100k rows, without losing any current feature (filters, sorts, search, facet counts, ticker
counts, CSV/Sheet export, select-all, detail next/prev).

## The load-bearing constraint

Revenue, RPC, and GEOS are **not in Postgres**. They come from a Google Sheet, matched to ads in memory
per render (`web/lib/metrics.js`, `attachSheetMetrics`), and only for the `tonic rsoc` feed. The UI
sorts by revenue/RPC and filters by GEOS. **Server-side sort/filter by these is impossible until the
sheet data lives in Postgres.** Paginating server-side while sorting on a sheet-only column would be
silently wrong (the true top earner would land on a later page and never surface). Therefore the sheet
sync is a prerequisite, not an optional extra.

## Chosen approach: phased Option A (full server-side, sequenced to de-risk)

We land at full server-side pagination/filtering, but front-load the cheap wins and the prerequisite so
the rewrite is de-risked and users get relief immediately. Each phase ships independently.

### Phase 0 - Slim the payload + cache it (IMPLEMENTED 2026-07-28, uncommitted)

What shipped:
- `article_title` removed from the feed (`FEED_COLUMNS` + `mapAd`); the Detail pane already
  re-fetches it with the article body via `getAdArticle`. Measured ~1.3 MB off every load (~4-5%).
- Feed cached in a per-instance TTL cache (`web/lib/ttl-cache.js`, 60s), wired into `getAds`; ad
  mutations call `bustAdsCache()` for instant consistency. This is NOT Next's Data Cache (its 2 MB
  per-entry limit would silently drop a ~28 MB feed); it mirrors the metrics-index cache pattern.
- Tests: `web/tests/ttl-cache.test.mjs` (7, TTL/bust/refill) + a source guard in `ui.test.mjs` that
  the feed omits article_title/content while `getAdArticle` still fetches them. Full suite: 148 green.
  `next build` clean.
- Honest impact: caching removes the repeated ~1.3s query + re-serialization on navigation and across
  viewers (the real perceived-speed win); the column trim is marginal (~5%). The 28 MB baseline and the
  14k-object client interaction lag are unchanged - those need Phases 1-3.
- Known tradeoff: after a scrape completes (Python writes rows directly), the feed is up to 60s stale,
  since only in-app edits bust the cache. Accepted.

Original scope notes:
- Split feed columns into a **lean list-row set** (what the table rows and facets need:
  `ad_archive_id, page_id, page_name, domain, feed, title, cta_text, link_url, display_format,
  original_image_urls[0]/thumb, video_preview_url, rank, language, country, vertical, brand,
  creative_language, start_date, total_active_time, first_seen_at, last_seen_at, status, owner,
  is_saved, tags, review_status, has_article`) versus **heavy fields** loaded on demand
  (`body_text, extra_texts, caption, article_title, link_description, extra_image_urls,
  extra_video_urls, video_hd_url, publisher_platform, notes, linked_article_url, resolved_url`).
- The detail pane already lazy-loads `article_content` via `getAdArticle`; extend that path (or add a
  `getAdDetail(id)`) to fetch the heavy fields on row/detail open.
- Replace `force-dynamic` with a short revalidate window / cached read so navigations do not re-run the
  1.3 s query. Invalidate the cache on any ad mutation (edits, review decisions, scrape completion).
- Expected: payload ~28 MB -> ~5-8 MB, repeated query cost gone. Client model untouched.

### Phase 1 - Sheet -> Postgres sync (unblocks server-side sort/filter)
- New table `campaign_metrics`: `url_key text primary key, revenue numeric, clicks numeric,
  rpc numeric, geos text, geo_split jsonb, keywords text, source_feed text, updated_at timestamptz`.
- A sync job reuses the existing pure helpers in `web/lib/metrics.js` (`buildMetricsIndex`) to read the
  sheet and upsert rows keyed by `url_key`. Cadence: on scrape completion and/or a cron, plus the
  existing manual "refresh metrics" button re-points at this sync.
- `getAds` (and the future server query) left-join `campaign_metrics` on normalized `url_key`
  (`adUrlKeys(link_url)`), so revenue/rpc/geos become selectable, sortable, filterable columns.
- The Google Sheet stays the **authoritative source**; the table is a materialized cache. Store and
  surface `updated_at` ("metrics as of X") so staleness is visible. No UI behavior change in this phase.

### Phase 2 - Server-side query engine (behind a feature flag, diffed against old path)
- One parameterized query builder in the data layer producing: the current page (offset/limit), a
  total count, per-facet value+count aggregates for the current filter set, and the ticker counts
  (`count(*) filter (...)` in one round trip, mirroring `getSecondaryCounts`).
- All filter values passed as **parameters** via postgres.js tagged templates - never string
  interpolation (SQL injection boundary).
- Pagination: **offset/limit** (page-number UI already exists; measured 22 ms; keyset gives no benefit
  for numbered pages and is complex across arbitrary sort columns). Stable ordering via a deterministic
  tiebreak (`order by <sortkey>, ad_archive_id desc`).
- Search: `pg_trgm` GIN index over a concatenated searchable expression; multi-token `ILIKE`/`%>`
  matching. Good enough to 100k. (tsvector is a later upgrade if ranking/stemming is wanted.)
- Export: a separate server action runs the same filter builder **without** limit and returns the full
  matching set for CSV/Sheet, so the client never has to hold it.
- Facet/count aggregates are **debounced and fired in parallel**; slow-changing facet value lists
  (domains, feeds, verticals) are cached. This is the spot that "moves the 1.3 s from serialization to
  aggregation" if done naively - indexes + debounce + parallel are mandatory, not optional.

### Phase 3 - Rewire the Dashboard, virtualize, cut over
- Move filters/sort/search/pagination/facets/ticker/export/select-all/detail-next-prev from the
  in-memory array to server round-trips (server actions returning one page + counts).
- Virtualize the table rendering.
- Run the new path beside the old behind a flag; diff counts and a sample of pages until they match;
  then remove the full-array client model.

## Alternatives considered and rejected

- **Do nothing / just add indexes.** Rejected: measured, the DB does 22 ms; the index that would help
  the scan does not exist because there is nothing to fix there. The payload is the problem.
- **Big-bang full rewrite first.** Rejected by the council: high risk, no interim relief, and it would
  build on the un-synced sheet (silently wrong sorts). Phasing gives the same endpoint with relief in
  days and a diffable cutover.
- **Slim + cache only (Phase 0, stop there).** Tempting and cheap, buys months, but does not fix
  unbounded growth or in-browser interaction lag at 100k. Kept as Phase 0, not the finish line, because
  the user chose the durable fix.
- **Recent-window cap (only load last N days, load older on demand).** Reasonable middle path; folded
  into Phase 0/2 thinking but not chosen as the primary shape because it complicates "search everything"
  and still leaves the client model in place.
- **Keyset pagination.** Rejected for a numbered-page UI; no benefit, more complexity.
- **Keep metrics client-side, sort/filter only the current page by them.** Rejected: surprising and
  wrong (sorts only within a page).

## Architecture

- Layers: presentation (`web/components/*`, `web/app/*` server components) -> data/service
  (`web/lib/queries.js`, `web/lib/metrics.js`) -> Postgres. Presentation never touches `web/lib/db.js`
  directly; it goes through `queries.js`. This is already the convention.
- **Single source of truth:** the feed filter predicate (the approved + not-prohibited + completed-run
  rule) lives once in `queries.js` and is reused by the page query, counts, and export. The metrics
  normalization lives once in `metrics.js`. Do not duplicate either into the new query builder - import
  the shared fragments.
- **Mechanical guard:** add a test (or lint import-restriction) that fails the build if anything under
  `web/components/` imports `web/lib/db`. Convention that is not enforced by a failing check rots.
- **What breaks first at 100k:** the per-keystroke facet/count aggregates through the pooler, not
  pagination or search. Mitigation is designed in (debounce, parallel, cache, covering indexes).

## Security

- Every new server action and any new route enforces `requireAuth()` and the same capability gates the
  existing actions use (`export_data` for export, etc.). Hiding a control is courtesy; the server is the
  lock, as today.
- All filter/search/sort inputs are passed as postgres.js **parameters**; sort column and direction are
  mapped through a fixed allow-list (never interpolate a client-supplied column name into SQL).
- The metrics sync reads the sheet via the existing service-account path; no new secret surface. The DB
  table is a cache of already-displayed data, so no new data is exposed.
- Do not log ad body text, PII, or credentials. Log counts, ids, timings only.

## Observability

- Namespaced logs with values and timings: `[feed query]` (filters, page, rows, ms), `[feed facets]`
  (which facets, ms), `[feed counts]` (ticker numbers, ms), `[metrics sync]` (sheet rows, upserted,
  ms, updated_at), `[feed export]` (matched rows, ms). Enough that a slow interaction can be pasted from
  the console and pinned to a step.

## Settings

- Page size is already a user setting (`usePageSize`). Keep it. Consider exposing default sort and
  default date-range window as settings in the existing column/prefs layer; default sort stays "fresh".
  Metrics staleness ("as of X") is surfaced, not configurable.

## Testing

- Unit: the filter/sort/search query-builder as a pure function (inputs -> SQL fragment + params),
  covering each filter, numeric ranges, date range, multi-token search, sort allow-list, empty inputs.
- Unit: metrics sync parse/upsert mapping (extends existing `web/tests/metrics.test.mjs`).
- Parity: a test/fixture that asserts the new server-side facet + ticker counts equal the old
  client-side computation on the same data set (the diff-before-cutover gate).
- Run the affected suite green before each phase is called done (`web/` has a node test runner; Python
  side has pytest for any sync job placed there).

## Deploy

- Work on a dedicated branch off `main` (not the current `visymo-query-column`). PR into `main`; CI runs;
  merge triggers the Vercel deploy. Never push to `main` directly, never promote a preview by hand.
- DB changes ship as numbered `supabase/migrations/00NN_*.sql` (new `campaign_metrics` table, indexes,
  `pg_trgm` extension) applied through the project's existing migration path.
- Each phase is independently deployable and flag-guarded where it changes behavior. Rollback = flip the
  flag off / revert the phase's PR; earlier phases keep working.

## Decisions (2026-07-28)

- **Sequencing:** ship Phase 0 (slim + cache) first, as its own PR, for immediate relief. Phases 1-3
  follow.
- **Default view:** keep "all approved ads, always" - no recent-window cap. Phase 0 shrinks payload by
  column width and caching only, not by dropping rows; server-side pagination (Phase 2/3) still logically
  covers every ad.
- **Sync cadence:** sync the sheet on scrape completion **and** a periodic cron safety net.

## Still to confirm before Phase 2

- Facet-count semantics: reflect the current filter set (more queries) or the full feed (cheaper)?
  Current client behavior is feed-scoped domain facet but full-array counts elsewhere. Confirm before
  building the aggregates.
- Who owns reconciling a bad sheet edit once metrics are materialized.
