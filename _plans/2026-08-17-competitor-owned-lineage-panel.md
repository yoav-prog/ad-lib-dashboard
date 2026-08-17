# Competitor "We Have Our Own Version" — inline lineage panel on the main feed

Date: 2026-08-17
Branch / worktree: `competitor-owned-badge` → `../adintel-competitor-owned-badge`
Requested by: Amit Golan ("add a connection to our data so we can know, in each row of
competitor articles, whether we already have an article of our own made inspired by the URL").

## Goal

On the main competitor feed (Fresh Finds), tell the user for each competitor ad whether we
have already produced our own article inspired by that ad's landing URL, and let them see and
reach those articles inline. "Our data" = the articles database (a.k.a. "Mega Uploader"),
already wired as `ARTICLES_DATABASE_URL`.

## Key finding (verified against both live DBs, 2026-08-17)

- The DB Amit/Yoav pointed at (`qetodgrrlglmwuuuhvcs`, eu-west-1) is **already connected** as
  `ARTICLES_DATABASE_URL`, powering Client Kits via `web/lib/articles.js`. No new secret.
- `article_lineage(parent_url, family_id, ...)` maps a competitor/source URL to our cloned
  "sister" articles (`articles.sister_family_id = family_id`, `is_external = false`). This IS
  "an article of ours made inspired by the URL." Client Kits already uses `getSisterFamilyUrls`
  / `getSisterLinksForUrls`; the main feed does not.
- Precise match coverage (feed `link_url` ∪ `resolved_url`, normalized to host+path, vs the set
  of parents that actually have our own articles): **1,826 / 28,498 approved ads**
  (TONIC RSOC 1,402, Predicto 257, Tarzo 167). The rest are RSOC search-arbitrage landings with
  no article URL to match — they correctly show nothing. This ceiling is the data's shape, not
  a code limitation.
- Index size: 1,030 parents with our own articles → 1,016 distinct normalized keys. Small enough
  to hold in memory with a TTL.

## Chosen approach (Option C — full inline lineage panel)

1. **Match layer (`web/lib/articles.js`, the single articles-DB boundary):**
   - `normalizeUrlKey(url)` — lowercase host (drop `www.`) + path, drop scheme/query/fragment/
     trailing slash. Pure, exported, unit-tested.
   - `getOwnedParentIndex()` — cached (10 min): `Map<normKey, { parent_url, family_id }>` built
     from the parents-with-our-own query.
   - `matchOwned(rows, index)` — pure: for each `{ ad_archive_id, link_url, resolved_url }`
     (link_url may be `" | "`-joined; try each), return `Map<ad_archive_id, {parent_url, family_id}>`.
   - `attachOwned(rows)` — calls the two above; returns rows with `owned_parent_url` /
     `owned_family_id` set (or null). No-op (returns rows unchanged) when `!articlesConfigured()`
     or the lookup throws — the feed must never break because the articles DB is down.
   - Reuse existing `getSisterLinksForUrls([parent_url])` for the panel's lazy fetch.

2. **Wire into the feed (both entry points):**
   - `web/app/page.js` — enrich the first server-rendered page via `attachOwned`.
   - `web/app/actions.js` `loadFeedPage` — enrich each fetched page via `attachOwned`.
   - New action `loadOwnedSisters(parentUrl)` → `getSisterLinksForUrls([parentUrl])`, gated
     signed-in (same as the feed).

3. **UI (`web/components/Dashboard.jsx`, `web/lib/columns.js`):**
   - New Fresh Finds column `owned` ("Our Version"): a compact "✓ OURS" chip on rows where
     `owned_parent_url` is set (dash otherwise). Hideable/reorderable via the columns manager.
   - Detail view: an "OUR VERSIONS OF THIS URL" section (parallels "SCRAPED LANDING ARTICLE"),
     lazily loading sisters when an owned ad opens: each shows domain · country/language ·
     headline with Open ↗, Copy, and "Set as linked article" (writes the existing
     `linked_article_url` via the existing commit path — that is the "assign").

## Rejected alternatives

- **A — precise badge only (no panel).** Ships fastest, honest, but Amit asked to *see* our
  versions; a bare badge under-delivers. Kept as the fallback if C runs long.
- **B — add a soft "active on this domain" tier (15k rows).** Noisy; a domain-level signal reads
  as "we have this one" when we don't. Rejected to avoid misleading the user.

## Architecture / boundaries (rule 20)

- SSOT for "do we have our own version made from this URL" = `article_lineage` + `articles`
  (`is_external=false`), read only through `web/lib/articles.js`. No new place computes it.
- `articles.js` stays the ONLY module that touches `ARTICLES_DATABASE_URL` / opens a client to
  it. `attachOwned` takes already-fetched adintel rows as plain data, so it does not cross into
  the adintel-DB layer (`lib/db.js`/`lib/queries.js`).
- Mechanical guard: `web/tests/articles-boundary.test.mjs` fails the build if any module other
  than `lib/articles.js` references `ARTICLES_DATABASE_URL` or constructs a `postgres(` client
  against it.

## Security (rule 13)

- Read-only SELECTs only, through the existing enforced boundary; ideally a read-only DB role.
- `parentUrl` reaches SQL only as a bound parameter (`= any($1)`); no interpolation.
- `loadOwnedSisters` gated to signed-in, matching feed access. No PII; nothing new logged that
  wasn't already (URLs/headlines already flow through the app).
- The credential currently lives in `.env`/Vercel env; the exposed string will be rotated by Yoav.

## Observability (rule 14)

- `[owned] index built { keys }`, `[owned] page matched { rows, owned }`,
  `[owned sisters] fetched { parent, count }`, and a warn on lookup failure with the error.

## Settings (rule 15)

- The `owned` column is hideable/reorderable through the existing columns manager — that is the
  user control. Not exposing a separate toggle. Possible future: an "Owned only" feed filter.

## Testing (rule 18)

- `web/tests/owned.test.mjs`: `normalizeUrlKey` (scheme/www/query/fragment/trailing-slash/case,
  `" | "`-joined link_url, junk input) and `matchOwned` (hit via link_url, hit via resolved_url,
  miss, multiple rows, empty index).
- `web/tests/articles-boundary.test.mjs`: the boundary guard above.
- Run the full `web` suite before calling done.

## Deploy (rule 19)

- One PR from `competitor-owned-badge` into `main`. CI runs; merge triggers the normal Vercel
  deploy. No direct push to `main`, no manual promotion. `ARTICLES_DATABASE_URL` must already be
  set in Vercel (it powers Client Kits today, so it is). Rollback = revert the PR.

## Open questions

- "Assign" is modeled as setting the ad's existing `linked_article_url`. If a richer
  per-ad→sister assignment (like Client Kits' `link_assignments`) is wanted on the main feed,
  that is a follow-up.
