# Client Kits: true sister-family matching (article_lineage)

Date: 2026-08-13
Branch: client-kits-sister-family
Status: built this PR.

## The precise match

`article_lineage` links a competitor/source `parent_url` to OUR child articles, grouped by
`family_id` - which equals the articles' `sister_family_id` (verified: 3,691/3,694 rows
match). So a competitor URL we have cloned yields a family, and our articles in that family
(`is_external = false`) are the exact sister versions. Verified live: an exact
`parent_url = ref_comp_rows.url` match covers ~938 comp rows, and a real competitor URL
resolves to thousands of sisters across up to 20 of our domains, correctly on-network and
on-language.

## What shipped

- **Backend** (all read-only on the articles DB):
  - `getSisterFamilyUrls(urls)` - which competitor URLs have a family (for row badges).
  - `getSisterLinksForUrls(urls, network)` - our sister articles per competitor URL
    (is_external=false, optional network), capped at 3000.
  - `queries.getTakenOurUrls(urls)` - global availability for the sister set (spans domains,
    so the per-domain helper does not fit).
  - Actions: `searchSisterLinks({competitorUrl, network})` (available, capped 200) and
    `bulkAssignSisters({source, ids, network})` for both Meta ads and RSOC comp rows.
- **UI**:
  - Assign panel: a pinned **"★ Sister articles (exact match)"** group above the normal
    domain search, for both sources. Competitor URL = the RSOC comp row's url or the Meta
    ad's resolved_url.
  - Bulk **"★ ASSIGN SISTERS"** button (Meta + RSOC): assigns each selected row its exact
    sister (network-filtered), ignoring the domain picker; reports rows with no sister.
  - RSOC rows carry a **★ SISTER** badge (`has_sister`, attached in loadCompRows).

## Matching model
- Sister match is the exact, lineage-based path (strongest). The vertical/language/country
  scorer from before still powers the normal (non-sister) suggestions and bulk-to-domain.
- A sister lives on whatever domain we published it on, so the sister flows are domain-
  agnostic (network filter still applies); the domain picker governs only the normal search.

## Security / Observability / Testing / Deploy
- No new secret / env var / migration. All lineage/article reads are SELECT-only; assigns
  reuse the `export_data` gate and the global `unique(our_url)` availability guarantee.
- Logs: `[kit sisters ...]` on search/bulk; `[kit comp rows]` now reports sister count.
- Tests: existing suite green; `next build` clean. Sister resolution verified live read-only
  (the join is DB-backed, so it is checked against real data rather than mocked).
- Additive; rollback = revert.
