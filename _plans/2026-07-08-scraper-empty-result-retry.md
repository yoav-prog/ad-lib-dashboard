# Scraper: retry when the Apify actor SUCCEEDS but returns 0 ads

## Symptom

User tracked `mytips.com`, ran it, and the run finished COMPLETED with 0 ads and a
scary `Exception in thread Thread-3 (_stream_log)` traceback in the live log. A
manual search on the Facebook Ad Library for `mytips.com` (United States) returned
~140 live ads, so the competitor is clearly advertising.

## Root cause (verified by running the real actor, not theorised)

Ran the exact failed-run parameters (`query=mytips.com`, `country=ALL`,
`max=100`) through `fetch_facebook_ads_apify` five times:
`10, 10, 109, 109, 109` ads. The pipeline, the parameters, and the keyword-by-domain
search all work. The failed run got 0 because **the Apify actor reported `SUCCEEDED`
but handed back an empty dataset on that one run** - it cold-started (the log showed
"Pulling container image" and the log-stream read timed out, both signs of a slow,
degraded boot) and came back empty.

`fetch_facebook_ads_apify_with_resume` was called with `retries=1`
([run_scrape.py](../run_scrape.py) passes `args.retries`, default 1), so it tried the
actor once, got 0 items, hit `if not new_cursor: break`, and returned []. `scrape_query`
printed "no ads returned" and the run finished found=0. A transient empty became a
permanent 0 for that run.

### Ruled out (so a future session does not re-chase these)

- **"Advertisers don't put the domain in ad copy."** False here - mytips.com shows
  `MYTIPS.COM` on every ad and Meta returns ~140 by keyword.
- **`country=ALL` is invalid.** False - `ALL` returned 109, same as `US` returned 10;
  both non-zero. Country is not the bug.
- **Domain-vs-Page-ID architecture.** Not needed. Keyword-by-domain works for this
  and typical cases. Page-ID tracking (`view_all_page_id`) remains a *possible future
  enhancement* for competitors whose ads never name their domain, but it is not
  required to fix this and was explicitly deprioritised.

## The traceback (separate, cosmetic, left as-is per user)

The `_stream_log` `impit.TimeoutException` is the Apify client's background
log-streaming thread timing out during the cold container pull. It does not affect the
scrape result. User chose to keep the live Apify logs; documented only so it is not
re-investigated. (Kill switch if ever wanted: `logger=None` on
`client.actor(...).call(...)`.)

## Fix (done)

`fetch_facebook_ads_apify_with_resume` ([facebookadscraperapify2026-v2.py:870](../facebookadscraperapify2026-v2.py))
gained `empty_retries=3, empty_delay=15`. After a fetch, if it returned **0 items on a
fresh start** (no resume cursor), it re-runs the actor from scratch up to
`empty_retries` times with a short backoff before believing the zero. A
mid-pagination empty (cursor present) is left alone - that legitimately means pages
ran out. Independent of the user's `--retries`, which governs cursor resume, not
empty recovery.

## Verification

- Stubbed unit test (no network / no Apify cost): transient case (empty, empty, data)
  recovers and returns the ads on the 3rd call; genuine-empty case gives up cleanly
  after 1 + 3 calls. Both PASS.
- Real actor, exact failed params, 5x before the fix: 10/10/109/109/109 (pipeline
  proven healthy; the fix only adds recovery on the rare empty).

## Follow-ups (not done, flag for the user)

- **Week-old filter.** `scrape_query` keeps only `is_ad_at_least_week_old` ads, so the
  freshest mytips.com ads (started Jul 4/Jul 6, < 7 days as of Jul 8) are excluded
  until they age. Older ones (Jun) still store. If the user wants brand-new ads too,
  relax or make this filter configurable.
- **Tune `empty_retries`/`empty_delay`** once we see how often the actor returns a real
  transient empty in production (GitHub Actions cold starts).
- **Optional Page-ID mode** if a real competitor's ads never mention their domain.
