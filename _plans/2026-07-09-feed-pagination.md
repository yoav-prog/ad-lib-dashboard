# Feed pagination: drop the 500-row cap, page the tables

Date: 2026-07-09
Branch: feed-pagination (stacked on geos-revenue-popup, which is pushed but not yet merged)

## The problem

Amit ran a scrape that found 1800 results, and the dashboard "went back to 500".
It looked like the app deletes old ads. It does not: nothing in the codebase
auto-deletes rows (the only delete is the explicit bulk DELETE button). The
feed query simply fetches the newest 500 rows by last_seen_at
(`getAds(limit = 500)` in web/lib/queries.js) and the UI renders whatever
arrives, so anything older than the newest 500 becomes invisible.

## Goals

- Never hide data: the feed shows every approved ad, the review tab every
  pending ad, no matter how many there are.
- No slowness: the browser must not render thousands of table rows at once.
- The user picks how many rows per page, from several options.

## Chosen approach

Keep the existing architecture (server fetches everything once, all
filtering / search / sort stays client-side) and paginate the *rendering*:

1. **web/lib/queries.js** - remove the 500-row LIMIT from `getAds` and
   `getReviewAds`. Every eligible row ships to the client, so facet counts,
   ticker metrics, search, Trends and Competitors views all see the full
   dataset (they already operate on the `ads` array).
   **Measured correction during QA**: the database holds 5,588 approved ads
   whose `article_content` alone is ~38 MB; shipping `select *` uncapped
   produced a 19.8 MB page. So the feed queries now select an explicit column
   list WITHOUT `article_content` (plus a `has_article` flag), and the Detail
   view fetches the one article it shows on demand via a new read-only server
   action (`getAdArticle`), caching it into client state. Smart search stops
   matching article bodies (titles still match) - the tradeoff that keeps the
   page ~25x smaller.
2. **web/lib/paging.js** (new) - pure, unit-testable paging math:
   `PAGE_SIZES` (50 / 100 / 250 / 500 / all, default 100), `pageCount`,
   `clampPage`, `pageSlice`, `parsePageSize`.
3. **web/components/Pager.jsx** (new) - `usePageSize` hook (persisted per
   browser in localStorage, applied after mount exactly like
   `useColumnPrefs` so hydration never desyncs), a `PageSizePicker`
   segmented control (matches the images S/M/L control), and a `Pager`
   (first / prev / "PAGE X OF Y" / next / last) that hides itself when there
   is only one page.
4. **Dashboard.jsx** - page + pageSize state lives next to sort/filters;
   the table renders `pageSlice(filtered, ...)`. Page resets to 0 whenever
   query / filters / date range / sort / page size change, and clamps when
   the list shrinks. j/k keyboard navigation walks the visible page and
   rolls over to the next / previous page at the edges. Select-all, CSV
   export and Sheet export keep operating on the whole filtered set (all
   pages), as their tooltips already promise.
5. **ReviewView.jsx** - same treatment with its own persisted page size,
   so a 2000-row review queue cannot freeze the tab either.

Images already lazy-load (`loading="lazy"` in Thumb.jsx), and pagination
bounds the DOM to the chosen page size, which is what actually keeps
scrolling fast.

## Alternatives rejected

- **Server-side pagination (LIMIT/OFFSET per page + API route)**: scales to
  millions of rows, but every client-side feature - facet counts, smart
  search, sorting, ticker metrics, Trends, Competitors, Pipeline - reads the
  full `ads` array today. Paging on the server would silently break all of
  them or force a large refactor to move filtering into SQL. Not worth it at
  the current scale (thousands of rows). Revisit above ~20k rows.
- **Virtualized scrolling (react-window etc.)**: smooth, but adds a
  dependency, fights the dynamic row heights (thumbnail S/M/L), and the user
  explicitly asked for pages with a page-size choice.
- **Raising the cap to a bigger number**: same bug later, just delayed.

## Settings

- Rows-per-page picker (50 / 100 / 250 / 500 / ALL) in each table's toolbar,
  default 100, remembered per browser per table
  (`adintel.pagesize.freshfinds`, `adintel.pagesize.review`). ALL is offered
  for users who want one long page and accept the rendering cost.
- Not exposed: the server fetch size (there is none any more, by design).

## Observability

- `[feed paging]` console logs on page change and page-size change with
  `{ table, page, pages, pageSize, total }`.
- Existing `[metrics] attach` server log keeps reporting the full row counts.

## Security

No new inputs reach the server; paging is purely client-side. Removing the
LIMIT does not widen access (same auth guard, same WHERE clauses).

## Testing

- New `web/tests/paging.test.mjs` (node --test, same as existing suites):
  pageCount / clampPage / pageSlice / parsePageSize over empty lists, exact
  multiples, out-of-range pages, 'all', and junk localStorage values.
- Full `npm test` in web/ must stay green.

## Deploy

Work lands on `feed-pagination`, stacked on the unmerged
`geos-revenue-popup` branch (both touch Dashboard.jsx). Nothing is pushed or
merged without explicit approval; production tracks `main` via PR merge.

## Open questions

- If the ads table grows past ~20k rows the one-shot fetch (payload includes
  full article text) becomes the next bottleneck; the move then is
  server-side pagination plus SQL-side filters.
