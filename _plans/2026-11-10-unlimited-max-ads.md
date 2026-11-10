# Max Ads without a ceiling

## Problem
A user selected intuitionlink.com, typed 2500 in the bulk bar's Max ads box, and pressed RUN. The run scraped 300.

Two causes:
1. The typed value was never saved. The bulk Max ads box only applies on SET or Enter, and RUN ignored it, so the row kept its stored 300.
2. Even after SET, Max Ads was capped at 1000: `clampMaxAds` in `web/app/actions.js` and the `domains_max_ads_check` constraint (`1..1000`) from migration 0001.

## Goal
Any row can be scraped for as many ads as the user wants. Typing a number and pressing RUN does what it looks like.

## Approach (chosen)
- `clampMaxAds` moves to `web/lib/ui.js` (shared by server actions and the Control Room). Lower bound 1, upper bound only the Postgres integer max, so a silly paste fails safe instead of erroring.
- All three write paths clamp: `addDomain`, `updateDomain`, `bulkUpdateDomains` (addDomain and updateDomain did not clamp before).
- Migration `0021_max_ads_no_cap.sql` replaces the check with `max_ads >= 1`.
- Control Room: RUN applies a typed-but-unsaved Max ads value first (awaited, then dispatch or queue). The "up to N ads" hint counts the pending value. Input widened for 5+ digit numbers, with a tooltip.

## Rejected
- A higher fixed cap (say 10,000): the user asked for no limit, and the scrape already stops when the Ad Library runs out.
- Disabling RUN while a value is unsaved: more friction than just applying it.

## Cost
Apify actor `memo23/facebook-ads-library-scraper-cheerio` is pay per event, from about $0.30 per 1,000 results (checked 2026-11-10). 2,500 ads is about $0.75. Downstream spend (OpenAI policy checks, landing scrapes, GCS uploads) only applies to ads that are new, not re-surfaced.

## Risks
- Time: a domain is never abandoned midway, so a very large Max Ads on one row can run long. The scrape workflow has a 90 minute job timeout. 300 ads took about 2 minutes, so a few thousand is fine; tens of thousands on one row could hit the timeout.

## Security
Server actions still require `manage_domains`. Input is coerced to an integer and bounded; values never reach SQL unparameterized.

## Observability
`[domains bulk] update` (server, rows/fields/maxAds) and `[control run] applying unsaved max ads before run` (client, rows/maxAds).

## Settings
No new setting. Max Ads is already per row.

## Testing
`web/tests/ui.test.mjs`: no 1000 ceiling, rounding, integer-max bound, junk/zero/negative fallbacks. Full web suite + `next build`.

## Deploy
1. Apply `0021` to the production database (relaxes a check, safe before the code).
2. PR into `main`, merge, Vercel deploys from `main`.
Rollback: revert the PR. The relaxed check can stay.
