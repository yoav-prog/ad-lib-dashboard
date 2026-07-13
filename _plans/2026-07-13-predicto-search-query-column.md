# Predicto "Search Query" column + Google-Sheet export

Date: 2026-07-13
Branch: (new) predicto-search-query-column

## Goal

Ads in the **Predicto** feed point at a search-arbitrage landing page whose
searched phrase is the interesting signal. Surface that phrase as a **Search
Query** column on Fresh Finds (only when the current view actually contains
Predicto ads, exactly like the existing Tarzo **Slug** column) and include it in
the CSV + Google-Sheet exports.

Two link shapes occur in the wild (both confirmed live on 2026-07-13):

- **Format A - direct.** The phrase is already in the stored `link_url`:
  `https://tunefulsoul.com/asrsearch?search=<slug>-c29903&trackingId=38523`
  -> `HTTP 200, 0 redirects`. Wanted output keeps the hyphen slug and strips the
  trailing `-c29903` content id:
  `understanding-bladder-cancer-surgery-a-comprehensive-guide-to-the-procedure-and-recovery-process`
- **Format B - redirect.** The stored `link_url` is a tracker
  (`https://wildflares.com/teleport?...`) that **302s** (server-side, no JS -
  `curl -L` resolved it in one hop) to
  `https://searchpredictor.com/asrsearch/?search=Startup+Grants+Guide+2026+en&...`.
  The phrase (`search=`) is only visible after the redirect. Wanted output turns
  `+` into spaces: `Startup Grants Guide 2026 en`.

User decisions (2026-07-13): **do both formats now**; **match the examples**
(A stays a hyphen slug, B becomes spaced; trailing `-c<digits>` stripped on both,
casing left as-is).

## The key finding (why this is cheap and low-risk)

The scraper **already** ScrapingBee-fetches every ad's `link_url` for the landing
article (`_scrape_article_sync`, `render_js: false`). ScrapingBee follows the 302
and returns the final URL in the **`Spb-Resolved-Url`** response header, which the
code currently discards. Capturing that header costs **zero extra requests and
zero extra credits** and is more robust than a direct fetch (ScrapingBee's proxy
already reaches these hosts; a datacenter IP might get blocked). No `render_js`,
no second call, no new dependency.

Format A needs no network at all - the phrase is in `link_url`, parsed client-side
like `tarzoSlug`. Only Format B needs the stored resolved URL.

## Chosen approach

Store the post-redirect URL once at scrape time (feed-agnostic), then derive the
clean phrase in a pure client-side helper that the table and both exports share -
mirroring the established `tarzoSlug` / `Slug` pattern end to end.

### Backend (Python)
1. **Migration `0008_resolved_url.sql`**: `alter table public.ads add column if
   not exists resolved_url text;` (nullable, no index, no backfill in SQL).
2. **`facebookadscraperapify2026-v2.py`**: `_scrape_article_sync` and
   `scrape_article_async` return `(title, body, resolved_url)` where
   `resolved_url = response.headers.get('Spb-Resolved-Url', '')` on the success
   path and `''` on every early-return / error path. Update the in-module legacy
   caller (`process_single_ad`, line ~1128) to unpack and discard the third value.
3. **`run_scrape.py`**: `process_ad` captures the resolved URL from
   `scrape_article_async` (empty for pending ads that skip the scrape) and passes
   it to `build_ad_dict`; `build_ad_dict` adds a `resolved_url` param and emits it
   in the dict.
4. **`db.py`**: add `'resolved_url'` to `AD_COLUMNS` (in the scraped-landing
   group, after `article_content`). It rides the existing upsert + `_UPDATE_COLUMNS`
   (refreshed on every re-sighting).
5. **`backfill_resolved_url.py`** (new, modeled on `backfill_review_status.py`):
   for Predicto ads with a null/empty `resolved_url`, follow the redirect with a
   plain `requests.get(firstUrl(link_url), allow_redirects=True, timeout=15)` and
   store `.url`. Free (it's a 302, no ScrapingBee). Flags: `--dry-run`,
   `--limit N`, `--all-feeds`. Browser User-Agent (matches the verified curl).

### Frontend (JS)
6. **`web/lib/queries.js`**: add `resolved_url` to `FEED_COLUMNS` and to `mapAd`.
   Because `getAds`, `getReviewAds`, and `getAdsByIds` all read `FEED_COLUMNS`,
   this single change feeds the table, the CSV, and the Sheet export at once.
7. **`web/lib/ui.js`**:
   - `isPredicto(ad)` = `(ad.feed||'').toLowerCase() === 'predicto'`.
   - `predictoQuery(ad)`: `''` unless Predicto; else read the `search` param from
     `resolved_url` (Format B) falling back to `firstUrl(link_url)` (Format A) via
     `URL().searchParams.get('search')` (auto-decodes `+`->space and %xx), then
     strip a trailing `-c\d+` content id and collapse whitespace. Unknown/blank
     -> `''` (degrade to empty, never guess).
   - One `SHEET_COLUMNS` entry after `slug`:
     `{ key:'query', header:'Search Query', kind:'text', get:(a)=>predictoQuery(a),
       width:260, align:'LEFT', wrap:true }`. CSV, Sheet export, and the export
     column-picker inherit it automatically.
8. **`web/components/Dashboard.jsx`** (Fresh Finds table only, matching Slug's
   scope): `showQuery = filtered.some(isPredicto)`; add its width to `tableMinW`;
   header + a `CopyCell` cell mirroring the Slug column; and a `SEARCH ·` line in
   the Detail view beside the existing `SLUG ·` line.

## Alternatives rejected

- **A dedicated ScrapingBee call (with `render_js`) to resolve the redirect.**
  What the user first asked about, but it's the expensive option for a plain 302:
  a JS render is ~5 credits and we'd be paying twice (the article scrape already
  fetches the same URL). Capturing the header off the existing call is free.
- **Resolve at display/export time (server action per render).** Adds latency to
  every page load / export and re-fetches the same redirect repeatedly. Resolve
  once at ingest, store, read cheaply forever.
- **Direct `requests` redirect-resolve in the live scraper instead of the header.**
  One extra HTTP call per ad and exposed to datacenter-IP blocking on hosts we
  already reach fine through ScrapingBee's proxy. (We do use plain `requests` for
  the one-off backfill, where free + simple beats robust, and it can be re-pointed
  at ScrapingBee if a host blocks it.)
- **Store the extracted phrase instead of the resolved URL.** The URL is the raw
  fact; the cleaning rule (suffix strip, decoding) is young (one sample per
  format) and will get tuned. Keep the URL, derive the phrase in one pure,
  test-covered place so a rule change is a code edit, not a re-scrape.
- **Humanize Format A to spaced Title Case.** User chose "match the examples" -
  A stays a hyphen slug.

## Security / safety (rule 13)

- No new secret, no new external dependency, no new inbound input. `resolved_url`
  is a scraper-derived string rendered as **text only** (Sheet export already
  writes `valueInputOption=RAW`, formula-injection safe; the table renders it in a
  `CopyCell` span, not HTML).
- The `Spb-Resolved-Url` value is attacker-influenced in principle (a competitor
  controls where their link redirects). It is never `eval`'d, never used to build
  a request, only parsed for a query param and displayed. `new URL()` in a
  `try/catch` means a malformed value yields `''`, never a throw.
- The backfill hits competitor tracker URLs. That is exactly what the production
  scraper already does on every run; one extra idempotent GET per Predicto ad is
  no new exposure. `--dry-run` first. No credentials or PII logged.
- `resolved_url` is not added to `run_logs`; the redaction boundary in `db.py` is
  untouched.

## Verification (before shipping - rule 1)

- **One real ScrapingBee call** with the exact production params
  (`render_js:false, return_page_markdown:true, block_resources:true`) against the
  Format-B teleport URL, asserting `Spb-Resolved-Url` is present and points at
  `searchpredictor.com`. If absent, fall back to `json_response:true` +
  `resolved-url`. (Costs ~1 credit; key is in `.env.local`.)
- **JS unit tests** (`web/tests/ui.test.mjs`): `predictoQuery` for Format A
  (strips `-c29903`, keeps hyphens), Format B from `resolved_url` (`+`->spaces),
  Format B fallback when `resolved_url` empty -> `''`, non-Predicto feed -> `''`,
  malformed URL -> `''`, DCO pipe-joined `link_url` (first destination wins), and
  the new column flowing through `buildCsv` / `buildSheetData`.
- **Python**: `pytest` green after the tuple-arity change; update the
  `scrape_article_async` fake in `tests/test_review_routing.py` to a 3-tuple.
- **Manual QA** (rule 6): a Predicto Format-A ad shows the slug; a Format-B ad
  shows the spaced phrase after backfill; a non-Predicto view hides the column;
  the same value appears identically in the on-screen cell, the CSV, and the
  Sheet; a Predicto ad with no resolvable `search` shows blank, not garbage.

## Deploy

- Migration first (`apply_migration.py` / Supabase), then merge the app + scraper.
  Column is nullable so old rows read blank until the next scrape or the backfill.
- Run `backfill_resolved_url.py --dry-run` then for real to light up existing
  Predicto rows.
- Rollback = revert the PR; the nullable column can stay (harmless) or be dropped.

## Open questions

- The `-c\d+` suffix and the `search` param name are each generalized from a
  single live example per format. If other Predicto campaigns use a different
  tracker param or id shape, the helper returns blank (safe) and the rule gets
  one more case. Worth a second look once real data lands.
- Scope is Fresh Finds + exports (Slug's footprint). If the Predicto column is
  also wanted in Competitor / Review views, that's a small follow-up.
