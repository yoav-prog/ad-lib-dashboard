# Re-surface already-known ads on every scrape

Date: 2026-07-09. Branch: `resurface-known-ads`.

## Problem

A scrape only imports ads it has never stored. Everything else is dropped
before processing (`run_scrape.scrape_query` checks `existing_ids`), so a
re-seen ad is never touched again: its `last_seen_at` never updates, it never
re-enters the fresh window, and once it falls out of `getAds`' 500-row cap it
vanishes from the site entirely while still blocking re-import forever.

Evidence: inkperspective.com run on 2026-07-09 - Meta returned 158 ads
(everything it has for that query), 152 passed the week filter, but only 8 were
imported. The other 144 were already stored (from this domain's earlier runs
and from other domains' keyword searches) and most were no longer visible
anywhere on the site.

## Goal

A run should surface everything Meta returns for its query (within the max-ads
cap): never-seen ads go through the full pipeline as today; already-stored ads
get cheaply re-surfaced so they are visible again - unless they are already
sitting in Review awaiting a decision.

## Decisions (user, 2026-07-09)

- **Rejected ads come back**: a rejected ad that Meta is still running reopens
  as `pending` (back into Review) on re-sighting. The user explicitly chose
  this over permanent rejection.
- **Week filter stays**: ads younger than 7 days are still dropped, for both
  new and known ads.
- **Applies to every run**: manual "Run selected" and the hourly scheduled
  sweep behave the same.

## Approach

**Scraper (`run_scrape.py`, `db.py`)**
- `scrape_query` splits old-enough ads into never-seen (full `process_ad`
  pipeline, unchanged) and known (new cheap path).
- New `db.resurface_ads(conn, run_id, ad_ids, domain=None)`: one UPDATE that
  bumps `last_seen_at`/`last_run_id`, reopens `rejected` rows as `pending`,
  and (when `domain` is passed) re-stamps `domain` for ads whose destination
  matches the scraped domain. Returns `(touched, reopened)`.
- No ScrapingBee / GPT / media spend for known ads - pure DB update.
- Run counters: `ads_found` now counts new + re-surfaced; `ads_new` stays
  "fresh inserts only". Live progress counter includes re-surfaced.

**Dashboard (web/)**
- Fresh Finds' definition changes from "first seen since the last run" to
  "SEEN by the latest run": `isFresh` keys on `last_seen_at` (fallback
  `first_seen_at` for safety).
- `getAds` and `getReviewAds` order by `last_seen_at desc` so re-surfaced ads
  survive the 500-row cap and just-reopened ads sit on top of the Review
  queue. The default "freshness" sort comparator also keys on the last
  sighting, so a run's full result set clusters at the top of the table.
- Run banner reports both numbers ("+8 new / 150 re-surfaced"); the SEE-ADS
  button uses `ads_found`.

**Migration** `0007_last_seen_index.sql`: index on `ads (last_seen_at desc)`
for the new ordering. Apply with `python apply_migration.py
0007_last_seen_index.sql` (needs a real DATABASE_URL; the checked-in .env has
placeholders - run via the backfill workflow environment or locally with real
creds).

## Alternatives rejected

- **Bump `first_seen_at` on re-sighting**: simplest way to push ads into the
  existing fresh window, but it lies about history - "Added" dates, NEW badges
  and age metrics would all become fiction.
- **Full re-processing of known ads**: would re-run ScrapingBee/GPT/media for
  ~150 ads per domain per run. Real money for near-zero new information.
- **A separate `resurfaced_at` column**: honest but adds a column and a
  parallel concept when `last_seen_at` already means exactly "when a run last
  saw this ad" - it just was never updated (known ads were skipped entirely).

## Security

No new inputs or endpoints. `resurface_ads` uses bound parameters; ids come
from Apify payloads and are matched against existing rows only. Review-status
transitions are constrained in SQL to the single `rejected -> pending` case.

## Observability

Per-domain log line now reports the split:
`158 fetched, 152 old-enough, 144 re-surfaced (3 reopened for review), 8 new
to process (8 match "...", 0 sent to review)`.
DONE line's `found=` includes re-surfaced.

## Settings

No new settings. The user chose one behavior for all runs; exposing a
"resurface on/off" toggle would reintroduce the two-behaviors confusion.

## Testing

- New `tests/test_resurface.py`: scrape_query routes known ads to
  `resurface_ads` (matched ids get the domain re-stamp, junk does not), only
  never-seen ads reach `process_ad`, found/new counters include the split,
  week filter still applies to known ads, `resurface_ads` SQL semantics
  (rejected->pending only, no blanket status overwrite, domain re-stamp only
  when given, empty ids no-op).
- `test_review_routing.py` docstring updated: upsert still never overwrites a
  human decision; the reopen is a deliberate, separate path.
- Web has no JS test framework (Next.js app, none configured); the `isFresh` /
  sort / copy changes are covered by manual QA. Flagged per standing rule 18.

## Deploy

Standard flow: PR into `main`, merge triggers Vercel deploy of web/ and makes
the runner change live for the next workflow run. The migration must be
applied to Supabase before or with the merge (index creation is additive and
safe). Rollback: revert the PR; the index is harmless to leave.
