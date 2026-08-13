# Client Kits: RSOC competitor source (build)

Date: 2026-08-13
Branch: client-kits-rsoc-source
Status: built this PR. Follow-up (Meta creative side-by-side) deferred — see bottom.

## Goal (decisions from the user)

Add the RSOC competitor source Maya's spreadsheet actually uses (ref_comp_rows) to Client
Kits, alongside the existing Meta Ad Library source, chosen by a toggle. Match our sister
links by vertical + country + language + network; keep the network filter from #64.

## What shipped

- **Source toggle** in Client Kits: "Meta Ads" (unchanged) vs "RSOC".
- **RSOC view** (`ClientKitsRsoc.jsx`): filter competitor rows by competitor network /
  vertical / geo / search; each row shows network, vertical, geo, adtitle, revenue, RPC,
  keywords; assign one of our links (shared assign panel), bulk-assign to a domain, export.
- **Assignments** now key on either a Meta ad (ad_archive_id) or an RSOC comp row
  (comp_row_id), tagged by `source`, via migration `0016`. Global link availability (unique
  our_url) is shared across both sources, so a link can't be handed out twice.
- **Matching reuse**: comp rows have a geo but no language, so `compToSubject` infers
  language from the URL's /xx/ path then a geo→language map, and feeds the same
  scoreLink / rankLinks / planBulkAssignment the Meta side uses.
- **Shared UI** extracted to `kit-shared.jsx` (assign panel, export modal, chrome), used by
  both sources so they can't drift.

## The `is_external` discovery (important)

`ref_comp_rows` shares the articles DB with our own links, and its landing hosts overlap
heavily with `articles.domain` — because `articles` catalogs BOTH our domains and external
competitor domains. The right "ours" signal is **`articles.is_external`**:
- `is_external = false` → OUR domains (45), our links, our networks (Tonic / Traffic Club /
  System1 / Inuvo). These are the only domains/links/networks the assign side offers.
- `is_external = true` → external competitor domains (195).

So: the "Exclude Aporia" step = drop comp rows whose host is one of our `is_external=false`
domains (4,655 dropped, 15,344 competitor rows remain). All our-side pickers filter
`is_external = false`. Verified live.

## Security / Observability / Testing / Deploy

- No new secret; reuses `ARTICLES_DATABASE_URL`. All ref_comp_rows access is SELECT-only in
  `lib/articles`. Reads gated to signed-in; assigns gated to `export_data`. The competitor's
  own URL is omitted from the export by construction (COMP_KIT_COLUMNS) — a kit can't leak it.
- Logs: `[articles db] comp facets`, `comp rows searched`; `[kit comp assign|bulk|export]`.
- Tests: 198 green (added geoToLang / urlLang / compToSubject / COMP_KIT_COLUMNS). `next
  build` clean. Comp SQL (incl. the host-exclusion fragment) verified live read-only.
- Migration `0016` applied to the adintel DB (additive, idempotent; ad_archive_id now
  nullable, comp_row_id + source added, XOR check). Deploy = merge → Vercel; rollback = revert
  (columns are additive and harmless if unused).

## Deferred (agreed): Meta creative side-by-side

The spike showed the RSOC↔Meta join is weak (~33% host overlap, coarse). Per the agreed
recommendation, this PR ships the reliable RSOC-row + our-link core WITHOUT the Meta
creative thumbnail. Adding a best-effort thumbnail on a confident host match is the next
increment, not blocking this.
