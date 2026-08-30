# Clean links + unique-links export for article creation

Date: 2026-08-30
Branch / worktree: `worktree-unique-links-export` -> `.claude/worktrees/unique-links-export`
Requested by: Amit (for Oz, who writes the articles).

## Goal

Amit's request, translated from his message:

1. **Show a clean link** for each ad's landing URL - strip the query params - EXCEPT
   Predicto and Visymo, where one specific param must stay (it identifies the article).
2. **A way to pull UNIQUE LINKS** so Oz can quickly see which articles need to be
   created, with a settings area where he marks the domains relevant to him, producing
   output that is fast to move into an article-creation tool.

The feed already answers "which ads have no article of ours" - the MISSING mode shipped
in PR #84. What is missing is the link-shaped output: deduplicated, cleaned, filtered to
the domains Oz actually works, one copy-paste away.

## Verified facts (live production DB, 2026-08-30)

Ran the planned clean-link rule over all 35,613 approved ads before writing any UI:

- **Predicto**: the article identity is the `search` param (2,145 of 3,657 ads carry it;
  the other 1,512 land on regular article pages where the path is the identity). Raw
  param values collapse 915 -> 788 under the `predictoQuery` normalization (trailing
  `-c<digits>` / 6-hex tracking ids), so the dedupe key must use the NORMALIZED phrase,
  not the raw param - otherwise the "unique" count is inflated by tracking suffixes.
- **Visymo**: `q` param on 4,003 of 4,327 ads; only 16 distinct host+path pairs, so
  without the param everything collapses to a handful of `/dsr` endpoints.
- **Every other feed** carries the article in the URL path; the varying params are pure
  tracking (`cid`, `channel`, `utm_*`, `subid4`, `mbid`, `asid`, `sko`, `rac`). Stripping
  params is exactly right there.
- **Known limitation, flagged not built**: `tonic rsoc` has search-endpoint links
  (`qcviwxfqmc.com/17`) whose topic lives in an `ekw` param - but `ekw` is an opaque
  encrypted token, useless in a link, and the readable `adtitle` is ad copy (the same
  thing the Visymo plan rejected as a topic source). ~300 such ads collapse to one line
  per endpoint. Same story for kueez's `/rchat/?q=` pages (172 ads, readable `q`). If
  Amit wants either handled, each is a one-line addition to the param map.
- Extra normalization (www./trailing slash) merges only 9 more pairs - included in the
  dedupe key anyway, cheap and correct.

## Chosen approach

### 1. Pure helpers in `web/lib/ui.js` (beside firstUrl/searchParam/searchQuery)

- A tiny per-feed param map `{ predicto: 'search', visymo: 'q' }` - a third arbitrage
  feed is one line, and the map reuses the exact feed keys `isPredicto`/`isVisymo` gate on.
- `cleanLink(ad)`: candidates are `resolved_url` then `firstUrl(link_url)` (the same
  precedence `ownedCandidateUrls` uses). For a mapped feed, the first candidate that
  actually carries the param wins and the output keeps ONLY that param (raw value, so the
  link still works); otherwise the first parseable candidate stripped to origin+pathname.
  Malformed/empty -> '' (degrade to blank, never guess).
- `cleanLinkKey(ad)`: the dedupe grain - host sans www + path sans trailing slash, plus
  the NORMALIZED phrase from `searchQuery(ad)` (lowercased) for mapped feeds. This is what
  the production check above proved necessary: raw-param keys overcount, path-only keys
  undercount.
- `uniqueCleanLinks(rows)`: fold rows into `[{ link, host, count }]`, most-shared first.
- One `SHEET_COLUMNS` entry `clean_link` after `link` - table, CSV, Sheet export and the
  export column picker inherit it from the one catalog. Client Kits exports are built
  from an explicit key list that omits competitor URLs, so the new column cannot leak there.

### 2. Clean Link column on Fresh Finds

`columns.js` freshfinds catalog + `FRESH_COLS` + header + a `CopyCell` cell styled
exactly like the URL column beside it. `resolveLayout` appends new catalog keys to saved
layouts, so existing users see it without touching their presets, and can hide it.

### 3. UNIQUE LINKS modal (the settings + output in one place)

A toolbar button beside the CSV/Sheet exports (server-feed mode only - MISSING is a SQL
filter). The modal:

- **Forces `ourArticle: 'missing'`** in its fetch (via the existing `loadFeedExport`
  action + a filter override on `fetchExportRows`) - never inherited silently from
  whatever the table happens to show. Everything else (feed, country, search...) carries
  over, and the modal says so in plain words.
- **Needs a chosen our-domain** (MISSING is measured against it); without one it explains
  instead of showing an empty mystery.
- **Relevant domains as click-to-toggle chips**, computed from the fetched links with
  per-domain counts - no typing, no typos. The selection persists in localStorage
  (`adintel.uniquelinks.domains`); a remembered domain that is absent today still shows
  with a zero count so the filter is never invisible. No selection = all domains, said
  out loud in the modal rather than silently.
- **Output**: unique links one per line, most-shared first, with COPY ALL (confirmation
  state on the button) and a CSV download (Link, Domain, Ads). Copy-paste is the fast
  path Amit asked for; the CSV is for a paper trail.

### 4. Detail view

A `CLEAN` line under the existing SLUG/QUERY lines, same styling, with the raw link
left untouched above it.

## Rejected alternatives

- **Settings-driven domain->param rules instead of the feed-keyed map.** The param-keep
  rule is not configuration-shaped: Predicto's rule includes id-stripping logic, not just
  a param name. Feed #2 (Visymo) arrived as its own small PR and that is the actual
  cadence. A config table would still need code for anything beyond the trivial case.
- **A new DB table for Oz's domain list.** localStorage matches every neighboring
  preference (chosen our-domain, sheet-export settings); worst case is re-clicking a few
  chips once per browser. `column_presets` proves the DB path exists if this ever needs
  to roam between devices.
- **"Unique links" as a dedupe checkbox on the existing CSV/Sheet export.** Considered
  (it reuses the most machinery) but the output shape is different in kind: links-only,
  deduplicated, domain-filtered, clipboard-first. Bolting that onto a row exporter makes
  both harder to explain. The modal still reuses the same `loadFeedExport` pipeline.
- **Free-text domain settings field.** Chips-from-data with counts beat typing for a
  zero-instruction user, and can never contain a typo'd domain that silently matches
  nothing.
- **Blocking the list until domains are chosen.** The other empty-state trap: it adds a
  mandatory setup step for a user who may genuinely want everything. Explicit "showing
  all domains" wording + one-click narrowing covers the noise risk without the friction.
- **Keeping the raw param value in the dedupe key.** Proven wrong against production
  data (915 raw vs 788 normalized Predicto phrases).

## Security (rule 13)

- No new secret, dependency, migration, or inbound data path. The modal reads through the
  existing signed-in-gated `loadFeedExport` action; nothing widens any query.
- Competitor-controlled URL strings are parsed with `new URL()` in try/catch and rendered
  as text / attribute values through the same `CopyCell`/anchor pattern as the existing
  URL column; never HTML, never eval, never used to build a server request.
- The clipboard payload and CSV contain only URLs already shown in the grid.
- localStorage holds a list of competitor hostnames - no PII, no credentials.

## Testing

- `web/tests/ui.test.mjs`: cleanLink (generic strip, Predicto direct/redirect/paramless,
  Visymo, pipe-joined link_url, malformed, missing), cleanLinkKey (tracking-suffix
  variants collapse, www/trailing-slash collapse, case), uniqueCleanLinks (dedupe,
  counts, ordering, junk rows), clean_link flowing through buildCsv/buildSheetData.
- Full `web` suite + pytest must stay green.

## Open questions (flagged to Amit, not built)

- **tonic rsoc / kueez search links** (see Verified facts): keep collapsing, or map them?
- **The completion loop**: a link leaves the MISSING list only when the article-verticals
  backfill re-runs after an article ships. Until a refresh cadence exists (open question
  in the 2026-08-19 plan too), Oz may re-see links he already handled; the count chip
  next to each link at least keeps the list stable to compare between sessions.
