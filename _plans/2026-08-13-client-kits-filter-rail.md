# Client Kits: robust faceted filter rail (like Fresh Finds)

Date: 2026-08-13
Branch: client-kits-filter-rail
Status: built this PR.

## What shipped

- New shared `web/components/FilterRail.jsx`: multi-select chip groups (per-value counts,
  inline search when a group is long) + optional numeric range filters + a Clear — modeled
  on the Fresh Finds rail, now a reusable component.
- **Meta view:** a left filter rail with facets computed from the competitor's ads -
  Vertical / Country / Language / Format (multi-select) + a Days-Running range. Filters
  apply on top of the domain pick, search and Unique toggle.
- **RSOC view:** its network/vertical/geo dropdowns are replaced by the same rail, now
  multi-select. `searchCompRows` accepts arrays and filters server-side
  (`lower(network)=any(...)`, etc.), so the facets narrow the real (capped) result set.
- Both views keep the S/M/L image toggle and the new Country/Vertical columns.

## Notes / limitations
- Meta facets are client-side over the in-memory feed (the Meta source already loads it).
  RSOC facets come from `getCompFacets` and filter server-side.
- The rail is a left column beside the table (align-stretch); it is not independently
  sticky/full-height - a fine v1, can be made sticky later.
- Fresh Finds still uses its own inline rail; it can adopt this shared component in a later
  pass (kept out of scope to avoid touching the core view blind).

## Testing / deploy
- 203 tests green; `next build` clean; RSOC multi-select SQL verified live read-only
  (facebook+outbrain × US+GB -> 2,431 rows). No env var / migration. Additive; rollback =
  revert.
