# Control Room: quick search, column sorting, bulk actions

Date: 2026-07-08
Branch: per-row-manual-run

## Goal

Make the Control Room domains table fast to work with at scale (dozens of tracked
rows and growing): find rows instantly, order them by any column, and act on many
rows at once instead of one at a time.

## Requirements

1. **Quick search** local to the Control Room table. Matches any visible field:
   domain/query, feed, country, status (active/paused), max ads, cadence. Available
   to viewers too (read-only), not just admins.
2. **Single + multi select with bulk actions.** Row checkboxes already exist for
   targeted runs; extend the existing selection bar with: activate, pause, set max
   ads, set cadence (days), set feed, delete. Keep the existing "Run N selected".
3. **Sorting** by clicking any column header (domain, feed, country, max ads, held,
   frequency, status), toggling ascending/descending.

## Approach (chosen)

Mirror patterns already proven in `web/components/Dashboard.jsx` (FreshFinds bulk
bar + sort defs) so the new UI reads like the rest of the app.

- `ControlRoom.jsx`
  - Local `search` state -> multi-field matcher `matchDomain`, AND-ed with the
    existing global `query` prop so both the top bar and the local box narrow the list.
  - Local `sortKey` / `sortDir` state; default keeps current created-order. A module
    `SortTh` header cell toggles asc/desc and shows an arrow.
  - Expand the existing `sel > 0` bar: activate / pause / max-ads input+SET /
    every-N-days input+SET / feed select / delete. Inline, no modal (matches the
    app's per-row-input idiom). Delete is behind `confirm()` like the single delete.
- `web/app/actions.js`
  - New admin-only server actions `bulkUpdateDomains(ids, patch)` and
    `deleteDomains(ids)`, matching the existing `bulkUpdateAds` / `deleteAds` shape.
  - `bulkUpdateDomains` reuses `updateDomain`'s interval_days re-spacing
    (`next_run_at = coalesce(last_run_at, now()) + make_interval`).
  - Shared `cleanDomainIds(ids, cap)` (UUID validate + dedupe + cap); `runDomains`
    refactored onto it (cap 50). `UUID_RE` moved to the top constants.

## Alternatives rejected

- **Reuse only the global top-bar search** instead of a local box. Rejected: the
  user asked for a search "for this" (the table) and the top bar is shared across
  tabs; a dedicated box sitting on the table is the obvious, lazy-user default. Both
  still compose (AND-ed) so the top bar is not dead weight.
- **Modal / popover for bulk edits.** Rejected: the app has no modal-edit idiom;
  everything is inline. A popup would feel foreign and add a click.
- **Loop single `updateDomain`/`deleteDomain` on the client.** Rejected: N server
  round-trips per bulk action, and it would duplicate the interval re-spacing logic.
  One bulk action per intent is cleaner and faster.

## Security (rule 13)

- Both new actions call `requireAdmin()` first (write path, admin-only).
- IDs key a `uuid` column with no `uuid = text` operator, so `cleanDomainIds`
  drops non-UUID input, dedupes, and caps count (default 500) before any query;
  values are cast `::uuid[]`. This is validation and correctness, not just hygiene.
- `max_ads` clamped server-side to 1..1000; `interval_days` clamped 1..365 via the
  existing `clampDays`. Fail safe in the app, not at the DB.
- No new logging of anything sensitive; no client trust for the mutation set
  (`pick` restricts to `DOMAIN_FIELDS`).

## QA checklist

- Search: empty shows all; matches domain, feed, country, "active"/"paused",
  a max-ads number, a cadence number; multi-word AND; clear (x) restores; count
  "N of M" is right; composes with the global top-bar search.
- Sort: each column asc/desc; held sorts by ad count; status groups active/paused;
  arrow shows on active column only; default order preserved before any click.
- Bulk: select all shown respects the current search; activate/pause flips status;
  max-ads SET (and Enter) writes; cadence SET writes and re-spaces next due; feed
  set (incl. clear); delete confirms and clears selection; viewer (canEdit=false)
  sees search + sort but no bulk bar or checkboxes.
- Regressions: single-row run, per-row status toggle, per-row interval, add domain,
  add feed all still work; live run panel unaffected.
