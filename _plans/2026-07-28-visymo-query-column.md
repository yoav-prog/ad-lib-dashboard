# Visymo "Query" column (shared with Predicto)

Date: 2026-07-28
Branch: (new) visymo-query-column

## Goal

Ads in the **Visymo** feed point at a search-arbitrage landing page whose searched
phrase is the interesting signal, carried in the `q` query param of the stored
`link_url`. Surface that phrase on Fresh Finds and the exports.

Example link:
`https://www.clueblog.com/dsr?ctid=krd-97badd33&q=cirug%C3%ADa%20para%20eliminar%20la%20papada&asid=a2_ch59&de=m&rac=...`
→ display **cirugía para eliminar la papada** (decode only; `%20`→space,
`%C3%AD`→í). The `rac` param carries a similar phrase but is ad copy, not the
query, so it is ignored.

User decisions (2026-07-28):
- **Option A** formatting: URL-decode only. No capitalization, no title case
  (title case is wrong for Spanish and misrepresents the typed query).
- **Null** when the link exposes no `q` (matches the existing write-NULL pattern).
- **Same footprint as the Slug / Search Query columns** (Fresh Finds + exports).
- **One shared "Query" column, but each feed keeps its own parsing rule.** Since
  Fresh Finds mixes feeds, a single column shows each ad its own query rather than
  two near-identical blank-heavy columns.

## Why this is the cheapest case yet

Unlike Predicto (which needed a `resolved_url` DB column to capture a 302
redirect), Visymo's phrase is already in the stored `link_url`. So this is
**pure client-side**, exactly like `tarzoSlug`: **no migration, no scraper
change, no backfill, no new DB column.** Parse-and-display only.

## Chosen approach

Mirror the established `tarzoSlug` / `predictoQuery` pattern end to end, then unify
the display column so Predicto and Visymo share one "Query" column while each keeps
its own extraction rule.

### `web/lib/ui.js`
1. Generalize the existing `searchParam(url)` helper to `searchParam(url, name =
   'search')` so Predicto keeps reading `search` (default) and Visymo can read `q`.
   `URLSearchParams` undoes `%xx` and `+`, so the phrase reads as plain words.
2. Add `isVisymo(ad)` and `visymoQuery(ad)`: `''` unless Visymo; else the decoded
   `q` param of `firstUrl(link_url)`, whitespace-collapsed. No id-suffix stripping
   (that was Predicto-specific); casing left as-is.
3. Add the dispatcher `searchQuery(ad) = predictoQuery(ad) || visymoQuery(ad)`. An
   ad is only one feed, so exactly one helper fires; every other feed yields `''`.
4. The one `SHEET_COLUMNS` `query` entry: header `Search Query` → `Query`, accessor
   `predictoQuery` → `searchQuery`. Key stays `query`, so saved export selections
   and the column picker (`SHEET_COLUMN_META`) keep working, now labeled "Query".

### `web/components/Dashboard.jsx` (Fresh Finds table + Detail only)
5. Import `isVisymo`, `searchQuery` (drop `predictoQuery`).
6. `showQuery = filtered.some((a) => isPredicto(a) || isVisymo(a))` — the column
   rides along when either feed is present.
7. Header text `Search Query` → `Query`; tooltip names both feeds. Table cell reads
   `searchQuery(a)`. Detail line gated on `isPredicto || isVisymo`, label `QUERY ·`.

## Alternatives rejected

- **A separate Visymo-only "Query" column** (literal Slug/Predicto mirror). Purely
  additive, zero risk to Predicto, but a mixed view then shows two near-identical
  columns ("Search Query" and "Query"), each blank for the other feed — clutter a
  lazy user has to decode. The user chose one shared column.
- **Store the extracted phrase in a DB column.** Unnecessary: the phrase is already
  in `link_url`. Deriving it in one pure, test-covered helper means a rule change is
  a code edit, not a re-scrape (same reasoning as Predicto).
- **Title-case / capitalize the output.** Wrong for Spanish; misrepresents the
  actual typed query. User chose decode-only (Option A).

## Security / safety (rule 13)

- No new secret, dependency, DB column, or inbound input. The `q` value is
  competitor-controlled in principle, but it is only parsed for one query param and
  rendered as **text** (a `CopyCell` span, not HTML) and written to sheets as RAW
  (formula-injection safe, same boundary as Predicto). `new URL()` in try/catch
  means a malformed value yields `''`, never a throw. Never `eval`'d, never used to
  build a request. Same posture as the shipped `predictoQuery`.

## Testing (rule 18)

`web/tests/ui.test.mjs` — added and green (51/51 in the file):
- `visymoQuery` decodes the real example (accents + spaces), ignores other params.
- `+`→space; casing left as-is; trailing hex token NOT stripped (no Predicto rule).
- DCO pipe-joined `link_url` → first destination wins.
- Blank (never a guess) when `q` absent, URL malformed, or link empty.
- Feed gate is case-insensitive; a non-Visymo `q` stays blank.
- `searchQuery` dispatches per feed and blanks every other feed.
- The shared `Query` column flows through `buildSheetData` + `buildCsv` for both
  Predicto and Visymo; header asserts `Query`.

Note: `tests/google-oauth.test.mjs` fails in this environment with
`Cannot find package 'nodemailer'` — a missing-install issue unrelated to this
change (needs `npm install`).

## Deploy

Frontend-only, no migration. Rollback = revert the PR. Standard flow: PR into
`main`, CI, merge. Nothing touches production directly.

## Open questions

- The `q` param name is generalized from one live example. If a Visymo campaign
  uses a different param, the helper returns blank (safe) and the rule gets one
  more case. Worth a second look once more real data lands.
- Scope is Fresh Finds + exports. If the Query column is also wanted in
  Competitor / Review views, that's a small follow-up (same as Predicto's note).
