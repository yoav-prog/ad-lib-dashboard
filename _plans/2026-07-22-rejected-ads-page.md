# Rejected ads page (restore a rejected ad back to the feed)

Date: 2026-07-22
Branch: `rejected-ads-page` (stacked on `prohibited-content-filter`)
Requested by: Yoav.

## Goal

Today, rejecting an ad in the Review queue sets `review_status = 'rejected'` and the ad
disappears with no way back by hand - the reject button even says "permanently". The
only path back is the scraper auto-reopening it (rejected -> pending) when Meta is still
running the ad. Yoav wants a page that lists every rejected ad so one can be restored to
Fresh Finds on demand.

## Approach (mirrors the Filtered tab)

A new **Rejected** tab, same shape as Review / Filtered:
- Query `getRejectedAds()`: `review_status = 'rejected'`, same completed-run guard and
  no-cap / no-article-body rule as the others. Prohibited-content still wins - a flagged
  ad shows only in Filtered - so Rejected also applies the shared `notProhibited`
  fragment. That keeps one invariant: a prohibited ad appears in exactly one place.
- `RejectedView.jsx`: modeled on `ReviewView` (same domain / dest / page facets, same
  bulk triage), but with a single action - **Restore to feed** - instead of
  approve/reject.
- `restoreRejectedAds(ids)`: sets `review_status = 'approved'`, scoped to currently
  `rejected` rows so a stale tab can't flip an ad someone else already handled. Restoring
  to `approved` sticks: the resurface path only reopens `rejected` rows, never `approved`
  ones, so a later sighting won't undo the restore.
- Honesty fix (rule 16): the Review reject button/copy no longer says "permanently"; it
  now says the ad can be restored later from the Rejected tab.

## Data model

None. Reuses the existing `review_status` column (`0006_review_status.sql`); no
migration. The 'rejected' value and its kept-row semantics already exist.

## UI

- New `rejected` tab in `TopChrome`, with a count badge, after Filtered.
- Search placeholder "Search rejected ads...".
- Loaded in `page.js` (getRejectedAds -> attachSheetMetrics -> Dashboard prop), wired in
  `Dashboard.jsx` like reviewAds/filteredAds (state, sync effect, optimistic onRestore
  that removes locally then router.refresh()).

## Alternatives considered

- **Restore to the review queue (pending) instead of the feed (approved):** rejected.
  Yoav asked to "add one of them to fresh finds", so restore goes straight to approved.
  Re-triaging would just add a second click for no benefit here.
- **Generalize Review/Filtered/Rejected into one parametrized view:** deferred. The three
  are similar but differ in facets/columns/actions; a shared base is a clean-up worth
  doing once, but folding it in now would churn two already-tested, working views for no
  user-facing gain. Flagged as a follow-up, not hidden.
- **A hard delete option on the Rejected page:** out of scope. The whole point is
  reversibility, and deleting a row would let the scraper re-import the ad (dedup relies
  on the kept row). Delete already exists on Fresh Finds for true removal.

## Cost

None. No new external calls; pure DB reads/writes on an existing column.

## Security

`restoreRejectedAds` is admin-only (`requireAdmin`, like every mutating action), scoped
to `rejected` rows, id list deduped and capped at 1000. Only ever transitions to
`approved`; it cannot set an arbitrary status. No new data exposure - rejected ads are
the team's own scraped competitor ads, already in the DB.

## Observability

`restoreRejectedAds` logs `[rejected restore] { requested, updated }`, mirroring
`[review decide]` / `[content-flag clear]`, so a restore that matches fewer rows than
expected (stale tab) is visible in the console.

## Testing

- Web `ui.test.mjs` source guard: `getRejectedAds` targets `review_status = 'rejected'`
  and keeps the `notProhibited` exclusion (rule-20 guard, extends the existing query
  guard test).
- The Rejected view reuses `filterReviewAds` (domain/dest/page + text), already covered
  by the existing filter tests - no new helper.
- Full runs green before done: `pytest` (unaffected, should stay green) + web
  `node --test` + `next build`.
- Out of scope for automated tests: the server action's DB write (no seam without a live
  DB; the source guard + the shared query-fragment tests cover the SQL shape).

## Deploy

- Local `rejected-ads-page` branch, stacked on `prohibited-content-filter`. Nothing
  pushed/merged without explicit go-ahead.
- No migration, no data change, no external dependency. Additive UI + one column-value
  transition, so reverting the app code leaves data untouched.
- Open question for Yoav: ship as its own PR (after #41 merges) or fold into #41. Default
  recommendation: its own PR - the two features are independent concerns.
