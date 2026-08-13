# Client Kits: RSOC pulls in the Meta creative (image + description)

Date: 2026-08-13
Branch: client-kits-rsoc-meta-creative
Status: built this PR.

## Why

Testing on the Meta source, revenue/RPC were empty and the metrics looked thin. Root cause
(not a bug): the Meta Ad Library has no revenue/RPC for competitors - those live in the RSOC
data (ref_comp_rows), which also has vertical + geo. The full creative (image + description)
is the opposite: rich on Meta, absent on RSOC. Decision (with the user): make RSOC the
metrics-complete source and pull the Meta creative onto its rows where a host match exists.

## What shipped

- `queries.getMetaCreativesByHosts(hosts)` (was getThumbnailsByHosts): returns one
  representative Meta creative per landing host - image AND body/description - newest first.
- `loadCompRows` and `exportCompKitToSheet` attach `thumb` (image) + `meta_body`
  (description) to each RSOC row whose host matches a Meta ad (~1/3 of rows).
- RSOC view: shows the Meta description line under the competitor title (image was already a
  thumbnail cell).
- RSOC export (COMP_KIT_COLUMNS): added **Competitor Image** and **Competitor Description**
  columns. So the RSOC kit now carries image + title + description + revenue/RPC/vertical/geo
  + our link.

## Not changed
- The Meta source's Revenue/RPC columns are left in place (the user asked not to hide them),
  even though they stay empty for competitors - Meta has no such data.

## Honest limitation
Image + description only exist for the ~1/3 of RSOC rows whose landing host also appears in
the Meta ad library. The rest keep title + metrics only. This is the same coarse host match
flagged from the start; there is no shared id to do better.

## Testing / deploy
- 203 tests green; next build clean; the creative lookup verified live (returns thumb + body
  per host). No new env var / migration. Additive; rollback = revert.
