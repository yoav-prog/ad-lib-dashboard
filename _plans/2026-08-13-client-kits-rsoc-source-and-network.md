# Client Kits, round 2: network filter (done) + RSOC comp source, side by side (proposed)

Date: 2026-08-13
Branch: client-kits-network-filter (this PR = the network filter only)
Status: network filter SHIPPING here; the RSOC side-by-side rework below is a PROPOSAL,
not yet approved — do not build it until the open questions are answered.

## Why this exists

After the first Client Kits shipped, the user shared Maya's real working file
(`Innovations-WA.xlsx`, 34 tabs). It revealed the tool was built against the wrong
competitor source and missed the network dimension. This documents both what we fixed now
and what the real workflow needs next.

## What Maya's spreadsheet actually does

- **DBCMP / DBCMPFORNCMP**: competitor rows — `network_normalized, offer, country, adtitle,
  campaign_target_url, revenue_prediction_finalized, click_count, RPC, top_10_keywords`.
  Networks are RSOC sources: `mgid-rsoc, taboola-rsoc, outbrain-rsoc, facebook-rsoc, ...`.
- **WA** (the deliverable): "Our Internal Data" columns beside "Tonic Comp Data" columns.
- **WARS1 / SA-DB / oz-comp / ToAll / FromHere**: map a competitor/source URL to a **sister
  article** on one of our domains (`Inspired Article`, `Sister Article`, `Ready Link`),
  picking a target domain from our list.

## What this maps to in the databases

- The competitor rows are the articles DB table **`ref_comp_rows`** (19,999 rows:
  `network, adtitle, url, revenue, clicks, rpc, top_keywords, vertical, geo`). This is
  Maya's competitor source — NOT the adintel Meta-Ad-Library `ads` table the tab was built on.
- Our links are `public.articles`, which carry **`network`** (Tonic 194k, Traffic Club 29k,
  System1 10k, Inuvo 7.5k) and **`sister_family_id`** (set on 120,599 / 258,332 rows).

## Shipped in THIS PR (network filter)

Independent of the source question and needed regardless:
- `articles.searchOurLinks` takes a `network` param (case-insensitive); new
  `listOurNetworks()`.
- `bulkAssignOurLinks` and the search action thread `network` through.
- The assign panel and the bulk bar get a **Network** dropdown (Any / Tonic / System1 / ...),
  remembered in localStorage. A Tonic kit can now be kept to Tonic links.
- Verified live: mytips.com → 11,406 Tonic en/US links, 0 System1 (filter behaves).

## Proposed rework: RSOC comp source, side by side (NOT in this PR)

Decision from the user: show BOTH — the RSOC comp row and, where it exists, the matching
Meta creative.

### Layout (replaces/extends the Client Kits table)
Per row: **[our assigned link] | [RSOC comp row: network, offer, country, adtitle, revenue,
RPC, top keywords] | [Meta creative thumbnail, when matched]**. Group/sort by offer+country;
network filter at the top.

### Data
- New read module functions (articles DB, read-only) over `ref_comp_rows`: list distinct
  offers/countries/networks; fetch comp rows filtered by network/offer/country/geo, ranked by
  revenue. Cap + cache like the others.
- Our-link matching keyed on **offer/vertical + country + language + network**, preferring the
  **sister family** of a chosen source (via `sister_family_id` / `article_lineage`), not a bare
  domain scan.

### The hard open question — RSOC ↔ Meta creative join
`ref_comp_rows` has `url` + `adtitle` but no image; adintel `ads` has images but a different
identity (ad_archive_id, page, resolved_url). There is no shared key. Options to spike:
1. Match on the competitor landing host/domain (`ref_comp_rows.url` host vs `ads.resolved_url`
   host) — cheap, coarse.
2. Match on offer/vertical + country + fuzzy title/keywords — richer, noisier.
3. Accept "Meta creative optional; blank when no confident match" — safest first cut.
Recommend (3) for v1: show the RSOC row + our link reliably, attach a Meta creative only on a
high-confidence host match. Do a small spike before committing.

### Scope guard (rule 20)
This is a large change (new competitor source, new layout, cross-DB fuzzy join, sister
matching). It should be its own session/PR with its own plan section for Architecture,
Security, Observability, Testing, Deploy — after the join approach is chosen.

## Open questions (block the rework, not the network filter)
- Which RSOC↔Meta match do we accept for v1 (host match vs fuzzy vs none)?
- Is "offer" (e.g. "HIV Treatment PR") the join key to our articles' `offer_name`, or should we
  match on vertical? (articles has `offer_name`, `offer_id`, `vertical`.)
- Should the deliverable fully replace the WA tab (export shape), or stay an in-app view + the
  existing sheet export with comp columns added?
- Sister-family selection: auto-pick the sister on the chosen domain, or let the user pick?

## Security / Observability / Testing / Deploy (this PR)
- No new secret; reuses `ARTICLES_DATABASE_URL`. Reads gated to signed-in; assign gated to
  `export_data`. Network compared case-insensitively; still SELECT-only in `lib/articles`.
- Logs: `[articles db] networks listed`, and the existing search/assign logs now carry network.
- Tests: 193 green (pure planner unchanged); network filter is SQL-level, verified live
  read-only. `next build` clean.
- Deploy: additive; no schema change, no new env var. Rollback = revert. Merge → Vercel deploy.
