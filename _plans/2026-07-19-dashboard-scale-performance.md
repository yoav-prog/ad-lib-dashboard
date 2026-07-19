# Dashboard performance at scale (keep all data, stop loading it all)

Date: 2026-07-19
Author: Yoav + Claude
Status: Phase 1 shipped; Phases 2-3 proposed, awaiting review.

## Problem (measured, not guessed)

The dashboard loads **every** ad into the browser on each request and does all
filtering, sorting, and search **client-side** over the full set. Today that is
**12,786 rows / ~15 MB** shipped as one payload, re-shipped on every
`router.refresh()` (after edits and each scrape poll). Symptoms: slow first load,
and typing/filtering feels stuck because the whole feed is re-scanned on every
keystroke.

This is an O(n)-everywhere client design. It was fine at hundreds of rows; at ~13k
it hurts and it grows every scrape. Keeping the data is not the problem - loading and
computing over all of it at once is.

Per-column weight of the shipped payload (top): link_url 3.1 MB, body_text 2.1,
link_description 1.7, original_image_urls 1.5, resolved_url 1.0, publisher_platform
0.9, title 0.8, article_title 0.7.

## Phase 1 - shipped (branch `perf-quickwins-search-debounce`)

Low-risk, immediate interaction relief:
- **Debounce the search box** (~220 ms) so the whole-feed filter runs once per pause,
  not per keystroke. This is the main fix for the "stuck while typing" feeling.
- **Lighter search index**: stop indexing the landing-article title and link
  description (heavy, almost never typed), so every haystack is smaller and the scan
  is faster.

Does not reduce the 15 MB payload - that is Phase 2/3.

## Phase 2 - trim the payload (contained, meaningful)

Move the Detail-only heavy fields out of the feed and lazy-load them when a card is
opened, reusing the pattern already used for article bodies (`getAds` computes
`has_article` without shipping the body; Detail fetches on open).

- Drop from `FEED_COLUMNS`: `link_description`, `publisher_platform`, `article_title`,
  `extra_texts`, `extra_image_urls`, `extra_video_urls` (~3.6 MB, ~24% of payload).
  None are used by the list, the facets, the search index, or either export
  (`SHEET_COLUMNS` does not read them).
- Extend the Detail lazy-fetch (`getAdArticle` -> `getAdDetail`) to return these plus
  the article, merged into the row on open with a `_detailLoaded` guard so it fetches
  once per card.
- Verify `getAdsByIds` (used by the Sheet export) still returns everything
  `SHEET_COLUMNS` needs; it does, so exports are unaffected.

Risk: touches the Detail data flow. Testable via build + a Detail smoke test.

## Phase 3 - the real fix: server-side list (durable)

Move filtering / sorting / search / pagination into the database so the browser only
ever holds one page (~50 rows) plus facet counts. Payload drops from ~15 MB to a few
KB; queries return in tens of ms on the existing indexes; scales to hundreds of
thousands of rows. **All data stays in the DB**, fetched a page at a time.

### The blocker to solve first: metrics live in a Google Sheet, not the DB
Revenue, Clicks, RPC, GEOS, and Top Keywords are joined from the team's metrics Sheet
at request time (`attachSheetMetrics`). The DB cannot `WHERE`/`ORDER BY` on numbers it
does not store. So Phase 3 starts by **persisting the sheet metrics into `ads`
columns** via a small periodic sync (the scrape run, or a cron), making them the
single source of truth and fully queryable. This also removes a per-request sheet read.

### Then
- A paginated read (server action or route handler): active facets -> `WHERE`, sort
  -> `ORDER BY`, page -> keyset (preferred) or `LIMIT/OFFSET`. Returns the page rows +
  total.
- Facet counts via `GROUP BY` aggregates, cached briefly (they change only on scrape).
- Search: Postgres `ILIKE` across the key columns now, or a `pg_trgm` / `tsvector`
  index if it needs to be faster; debounced from the client.
- Exports re-query the full filtered set server-side (Sheet export already does; move
  CSV export server-side too so it is not bound to what the browser holds).
- Detail already fetches on demand (Phase 2 finishes this).

### UX trade
Filtering/search become ~50-150 ms server round-trips instead of instant. With the
existing debounce and a small inline spinner this reads as responsive. Worth it for
the scale and the load-time win.

## Alternatives considered
- **Cap the initial load (most-recent N, load older on demand)**: a halfway measure
  that still loads thousands and complicates the mental model. Rejected in favor of
  proper server-side paging.
- **Web Worker for client filtering**: keeps the UI thread free but still ships and
  holds 15 MB and does not scale. A patch, not a fix.
- **Keep client-side, just trim payload (Phase 2 only)**: buys months but not the
  durable fix; still O(n) in the browser.

## Architecture / boundaries (rule 20)
- Sheet metrics become DB columns with the sync job as the single writer (SSOT); no UI
  path re-joins the sheet per request.
- The list's data access moves behind one server query function; the client holds a
  page, not the table. A test asserts the page query applies every active facet, so a
  filter can never silently be dropped server-side.

## Testing
- Phase 2: build + Detail smoke (fields appear after open, exports unaffected).
- Phase 3: unit tests for the query builder (each facet -> predicate), pagination
  (page boundaries, total), facet-count aggregates, and metric-sort ordering.

## Observability
- Log each page query with its filter set, row count, and duration, namespaced
  `[feed query]`, so a slow filter is visible in the console.

## Deploy
- Phase 1: this PR.
- Phase 2: its own PR.
- Phase 3: staged - metrics-sync PR first (additive columns + job), then the
  server-side list PR. Each additive and reversible; the sync columns are harmless if
  the app reverts.

## Cost
No new paid service. The metrics sync reuses the existing Sheet read. Slightly less
compute per request (no per-request full-table join once metrics are in the DB).
