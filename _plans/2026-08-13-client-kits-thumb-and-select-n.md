# Client Kits: best-effort Meta creative in RSOC + shared select-first-N

Date: 2026-08-13
Branch: client-kits-thumb-selectn
Status: built this PR.

## Asks (from the user, testing the RSOC view)

1. Add the deferred Meta creative "side by side" in the RSOC source.
2. Reuse the Fresh Finds "select first N" control in Client Kits (do not re-code it).
3. (Question) Where do assigned links show up later — answered in chat, not code.

## What shipped

### Shared select control
- `SelectMenu` (the header caret: This page / First N / All matching / Clear) moved out of
  `Dashboard.jsx` into `components/SelectMenu.jsx`, imported by Fresh Finds and BOTH kit
  views (Meta and RSOC). One definition, reused verbatim - no second implementation.
- Each kit table wires it to a `selectMany(n)` that selects the first n rows (or all),
  matching the Fresh Finds behavior.

### Best-effort Meta creative in the RSOC view
- `queries.getThumbnailsByHosts(hosts)`: one representative creative (newest ad) per
  landing host from the adintel `ads` table.
- `loadCompRows` attaches a `thumb` to each comp row whose landing host matches a Meta ad
  (coarse host-level join). The RSOC row shows it as a small thumbnail; rows with no match
  show a dashed placeholder. Verified live: 3 of 5 sampled competitor hosts resolve a
  creative - the expected ~1/3 coverage, so it is a bonus, never required. The join failing
  never blocks the row (wrapped so a thumbnail-lookup error still returns the rows).

## Not built (by design)
- A consolidated "my assignments" view / "paired only" filter. The user asked to be
  *reminded* where choices live, not to build a viewer. Offered as a follow-up instead.
- The Meta thumbnail is in-app only; the sheet export stays data-only (no image column).

## Security / Observability / Testing / Deploy
- No new secret / env var / migration. `getThumbnailsByHosts` is read-only, host list
  deduped and capped at 500. Reads gated to signed-in; assigns still `export_data`.
- Logs: `[kit comp rows]` now reports how many thumbnails matched.
- Tests: 198 green (unchanged pure surface; the additions are DB-backed and verified live
  read-only). `next build` clean.
- Additive; rollback = revert. Merge -> Vercel deploy.
