# Our Articles by Domain — pick one of our domains, see what we already have

Date: 2026-08-19
Branch / worktree: `worktree-our-articles-by-domain` → `.claude/worktrees/our-articles-by-domain`
Requested by: Yoav.

## Why this replaces the last attempt

PR #77 shipped a `Our Version` column that renders a green `OURS` chip and nothing else. The
`URL` column sits immediately to its right, so the grid reads as "our version url =
`https://mysearchtracking…`" when that URL is the *competitor's* landing page. Two separate
problems:

1. **It never shows one of our links in the grid.** The links only exist inside the ad detail.
2. **It only matches an exact URL clone** (`article_lineage.parent_url`), which covers
   1,826 of 28,498 approved ads. Everything else shows a dash, which reads as "we have
   nothing" when we usually do have something on-topic.

What was actually wanted: choose one of *our* domains, and per competitor ad see whether we
already have articles on that domain for the same country, language and topic, with the links.

## Verified facts (live, both DBs, 2026-08-19)

- Our articles: **250,602** own articles (`is_external = false`) across **47 domains**,
  **1,979** distinct verticals, 93 countries.
- Adintel: **29,966** approved ads. **25,913 (86%) already store the landing article text** in
  `ads.article_content` (avg 8.1k chars). Only **4,053** need a fresh ScrapingBee fetch.
- **Country codes disagree**: our articles use `UK` (14,573 rows), adintel uses `GB` (914 ads).
  Today's strict country gate therefore matches *nothing* for the UK — a live bug in Client
  Kits' matcher too. `GB` is the only alias mismatch across all 84 adintel codes.
- **Language formats disagree**: adintel stores `English`, articles store `en`.
  `lib/ui.langCode` already converts, but returns uppercase; articles are lowercase.
- `articles.vertical_group_id` is set on only **2,179 of 250,602** rows, and `vertical_groups`
  is `(id, topic, source, created_at)`. It is **not** a usable vertical-family map.
  `ref_category_mapping` covers 2,200 verticals but leaves 2,001 of them with a NULL category.
  The family has to be derived, not looked up.
- Distinct `(domain, country, language, vertical)` combinations: 61,505. Small enough to match
  a page of 100 ads with a single scoped query.
- `pgvector` is *available* (not enabled) on the adintel project. Not needed by this design.

## Chosen approach

### 1. Derive each ad's vertical family from its own article (Python, one-off + repeatable)

For every approved ad, once:

1. **Get the article text.** Use the stored `article_content`; only when it is missing or under
   200 chars, fetch it with ScrapingBee using the *same* parameters the scraper uses
   (`render_js=False`, `block_resources=True`) and persist `article_title` / `article_content` /
   `resolved_url` so the fetch is never repeated.
2. **Shortlist by embedding.** Embed every distinct vertical in our articles DB (as
   `"<vertical> — <its most common category>"`) and the ad's `title + first 1,200 chars`, with
   `text-embedding-3-small`. Cosine top 25. The scraper's existing shortlist is keyword overlap,
   which cannot work here: 11k of our 30k ads are non-English while every vertical name is
   English. Embeddings are multilingual, so this is the part that makes cross-language matching
   possible at all.
3. **LLM picks the family.** `gpt-4.1-mini` (the model every other classifier in this repo uses)
   reads the article excerpt and the 25 candidates and returns **up to 8** verticals that belong
   to the same family — not one label. Anything it returns that is not verbatim in the candidate
   list is dropped, so the output is always real vocabulary.
4. Write `ads.article_verticals text[]` + `ads.article_verticals_at`.

This is domain-independent, so one backfill serves all 47 domains.

**When there is no article to read (RSOC).** About 3,400 approved ads are search-arbitrage:
they land on a search page, not an advertorial, so there is nothing to scrape and never will
be. Those are classified from the vertical the pipeline already assigned them (98.5% carry one)
plus a 400-character slice of their own ad copy, then through the identical shortlist + model
stages. The vertical is labelled `Topic hint:` rather than stated as fact, and the system prompt
says to trust the text over the hint where they disagree: sampled live, a meaningful minority of
those verticals are plainly wrong for their ad — `AARP membership` on an ad for a small electric
car for seniors, `Accountant Jobs` on one for security-services work. A right hint still does the
work; a wrong one cannot drag the whole family off-topic on its own.

`--no-article-only` re-derives exactly this set, so improving the fallback costs ~3.4k calls
rather than re-running all 30k.

### 2. Materialize which of our domains actually have a match (same job, second pass)

For each ad with a family, ask the articles DB which domains hold at least one article with
`domain = D and country = <ad country, GB→UK> and language = <ad language as ISO> and
vertical = any(article_verticals)`, and write the list to `ads.our_article_domains text[]`.

This exists for exactly one reason: the feed is server-side paginated and filtered in SQL
against the *adintel* DB, and the articles live in a *different* Postgres. A materialized column
is the only way "only ads I already have an article for" can be a real SQL filter rather than a
client-side afterthought. It uses the identical matching rule as the live lookup below, so the
only possible drift is articles published since the last refresh.

### 3. Live lookup for what is actually displayed (Next.js)

The counts and links shown are **never** read from the materialized column — they are queried
live per page, so they are always current:

- `lib/ourmatch.js` (new, pure, dependency-free, unit-tested, mirrors `lib/owned.js`):
  `countryKey` (upper + `GB→UK`), `languageKey` (name or code → lowercase ISO), `adLocale`,
  and `groupOurArticles` which buckets fetched rows back onto their ads.
- `lib/articles.js` (stays the only module touching `ARTICLES_DATABASE_URL`):
  `getOurArticlesForAds(rows, domain)` issues one query for the page's distinct
  `(country, language)` pairs and the union of their verticals, then
  `attachOurArticles(rows, domain)` hangs `our_articles` (top 6) + `our_articles_count` on each
  row. Best-effort: a failure returns the rows unchanged, exactly like `attachOwned`.

### 4. UI

- **Domain picker** at the top of the Fresh Finds filter rail ("OUR DOMAIN"), listing the 47
  domains with their article counts, remembered in `localStorage`. Nothing else in this feature
  does anything until a domain is chosen, and the column says so rather than showing a dash.
- **"Only ads we have an article for"** toggle right beneath it, enabled once a domain is
  chosen. Drives the SQL filter on `our_article_domains`.
- **`our_article` column** replaces `owned` in the grid: a count chip (`3 OURS`) plus the first
  matching headline, click-through opens the detail.
- **Ad detail** gets an `OUR ARTICLES ON <domain>` panel listing each match with headline,
  country/language/vertical, and OPEN / COPY URL / SET AS LINKED — the same three actions the
  current sister panel offers. The old lineage result is **kept** but demoted to a single
  `EXACT CLONE OF THIS URL` line inside that panel, since it is stronger evidence when present.

## Rejected alternatives

- **Keyword/token shortlist instead of embeddings** (what the scraper does today). Free, but
  collapses on the 38% of ads whose article is not in English, and cannot see that "Stair Lift"
  and "Mobility Aids" are the same family.
- **LLM against the full 1,979-vertical vocabulary per ad.** Closest to the literal request;
  ~$9 and several hours, and the vocabulary would have to be domain-scoped, forcing a re-run
  whenever the chosen domain changes. The 25-candidate shortlist gets the same answer for a
  fraction of the prompt.
- **Materializing a per-(ad, domain) match table** (up to 1.4M rows). Rejected: the array column
  answers the only question SQL needs to answer, and the live query answers everything else.
- **Soft country fallback** (language-only when the country has nothing). Rejected by Yoav in
  favour of the strict country+language gate; a US ad must not be offered an AU article.
- **Classifying RSOC ads from their creative copy alone** (the first cut). Ad copy is mostly
  hype per token and often names no subject at all; the assigned vertical is the more specific
  signal, so it leads and the copy disambiguates.
- **Trusting `ads.vertical` outright for RSOC.** Too often wrong to state as fact — hence the
  `Topic hint:` framing rather than either extreme.

## Architecture / boundaries

- `web/lib/articles.js` remains the ONLY module that reads `ARTICLES_DATABASE_URL` or opens a
  client to it; `web/tests/articles-boundary.test.mjs` already fails the build otherwise.
- Pure matching rules live in `web/lib/ourmatch.js` (browser-safe, no driver import), the same
  split `lib/owned.js` uses. Python's `article_verticals.py` holds the mirror-image rules for
  the backfill so the live path and the backfill cannot drift, exactly as `brand.py` does.
- SSOT for "which of our domains has an article for this ad" = the matching rule in
  `ourmatch.js` / `article_verticals.py`. `ads.our_article_domains` is a cache of it, never a
  second definition.

## Cost (checked online 2026-08-19, not from training data)

| Item | Rate | Backfill of 29,966 ads |
|---|---|---|
| ScrapingBee, 4,053 missing articles | non-JS request, $0.0002/credit on Freelance | **< $1** |
| `text-embedding-3-small` | $0.02 / 1M tokens | **~$0.25** |
| `gpt-4.1-mini`, one call per ad | $0.40 in / $1.60 out per 1M | **~$8** |
| **Total, one time** | | **~$9** |

Ongoing: a new ad costs about $0.0003 to classify. `--model gpt-4o-mini` cuts the backfill to
about $3 if the quality holds; `gpt-4.1-mini` is the default because every other classifier in
this repo uses it and its Chat Completions parameters are known-good here.

## Security

- Read-only SELECTs against the articles DB through the existing enforced boundary.
- Every value reaches SQL as a bound parameter; the chosen domain is additionally validated
  against `listOurDomains()` server-side, so a hand-crafted client value cannot widen the query.
- The new actions are gated to signed-in, matching the feed. Nothing new is logged beyond URLs
  and headlines that already flow through the app.
- `ARTICLES_DATABASE_URL` stays env-only and is never written into this repo. The backfill reads
  it from the environment.
- ScrapingBee fetches only URLs already stored on ads the pipeline itself collected. No
  user-supplied URL reaches it.

## Observability

`[our articles] vocabulary built`, `[our articles] page matched { rows, domain, matched }`,
`[our articles] backfill batch { done, total, scraped, classified }`, and a warn (never a
throw) when the articles DB or OpenAI is unreachable.

## Testing

- `web/tests/ourmatch.test.mjs`: `countryKey` (GB→UK, case, junk), `languageKey` (full name,
  ISO code, unknown), `adLocale` (creative_language precedence), `groupOurArticles`
  (hit, miss, multi-ad, strict country+language gate, empty).
- `tests/test_article_verticals.py`: candidate parsing (drops hallucinated verticals, caps at 8,
  case-insensitive match), locale normalization parity with the JS, vocabulary descriptor build.
- Full `web` suite (238 passing today) and the pytest suite must stay green.

## Deploy

One PR from `worktree-our-articles-by-domain` into `main`. Migration `0017` must be applied to
prod **before** the deploy (the feed selects the new columns). Then run
`python backfill_article_verticals.py`. Rollback = revert the PR; the columns are additive and
harmless if left in place.

## Open questions

- Refresh cadence for `our_article_domains` as new articles are published. Manual re-run for
  now; a nightly GitHub Action is the obvious follow-up if it proves useful.
