# One FilterRail everywhere + sticky kit rails

Date: 2026-08-13
Branch: client-kits-filterrail-share
Status: built this PR.

## What shipped

- **Fresh Finds now uses the shared `FilterRail`** instead of its own inline copy, so the
  rail is one component across the app. Extended `FilterRail` to cover everything Fresh Finds
  needs: multiple numeric ranges (Days, Rank), an optional **date-range** toggle
  (24h/7d/30d/all), a `chosenCount` for the "CLEAR (n)" label, a `loading` state, and a nicer
  RangeFilter (number inputs + reset). Removed Fresh Finds' inline rail, its now-unused
  `gsearch` state, and the duplicate local `RangeFilter`.
- **Kit filter rails are sticky/full-height**: `FilterRail` gained an opt-in `sticky`
  (+ `stickyTop`) mode - `position:sticky` under the top nav with its own scroll - used by
  both Client Kits views. Fresh Finds stays non-sticky (unchanged behavior).

## Risk / verification
- The Fresh Finds migration is like-for-like: same `groups` descriptor, same ranges, same
  date range, same clear count, same loading condition; the container
  (`display:flex;align-items:stretch;min-height:calc(100vh-118px)`) means `align-self:stretch`
  matches the old layout and `overflow-y:auto` only lets a very long facet list scroll
  internally. 203 tests green, `next build` clean.
- Fresh Finds is login-gated, so I could not drive it headlessly - the Vercel preview should
  be eyeballed once to confirm the rail (facets, ranges, date range, clear) behaves as before.

## Deploy
No env var / migration. Additive; rollback = revert.
