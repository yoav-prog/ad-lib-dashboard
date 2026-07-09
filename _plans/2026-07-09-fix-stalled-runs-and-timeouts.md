# Fix: false STALLED banners and hourly-sweep timeout kills

Date: 2026-07-09
Branch: fix-stalled-heartbeat-and-run-budget
Status: approved (Yoav, in chat, 2026-07-09)

## Problem

Amit reported two symptoms on the live dashboard (ad-lib-dashboard.vercel.app):

1. After adding 2-3 sites, the "automatic update" appeared to stop.
2. A manual per-site scrape showed STALLED ("No heartbeat for 90 seconds or
   more") almost immediately.

Investigated against the actual GitHub Actions history (workflow `scrape.yml`
in yoav-prog/ad-lib-dashboard). Two distinct root causes, both confirmed from
runner logs:

### Root cause A: blocking Apify call freezes the heartbeat (false STALLED)

`fetch_facebook_ads_apify()` in facebookadscraperapify2026-v2.py is synchronous:
`client.actor(...).call()` blocks until the Apify actor finishes (minutes), then
`list(client.dataset(...).iterate_items())` blocks again. It is called directly
on the asyncio event loop from `fetch_facebook_ads_apify_with_resume()`. While
it blocks, the 2-second heartbeat task in run_scrape.py cannot tick, so
`last_heartbeat_at` goes stale and the dashboard flips to STALLED at 90s even
though the runner is healthy. The live log freezes for the same reason.

Evidence: run 28997701076 (Amit's manual dispatch, 06:03 UTC) was alive and
waiting on Apify when it was cancelled at 3m14s via the dashboard STOP button,
which kills GitHub runs. A healthy, paid-for scrape was shot because the UI
cried wolf.

Verified against current Apify docs (Context7 /apify/apify-client-python): the
sync `call()` "polls internally and can take a long time for long-running
Actors"; `ApifyClientAsync` is the async variant.

Secondary offenders on the same loop: six sync GCS `check_media_exists_in_storage`
calls inside `process_ad_media` (short individually, but they stutter the loop).

### Root cause B: hourly sweep exceeds the 60-minute job timeout (real kills)

Five consecutive scheduled runs on 2026-07-08 died at exactly 1:00:15 --
`timeout-minutes: 60` in scrape.yml. Run 28982884728 had 12 due domains (max
300 ads each), finished 6 in ~48 min, and was hard-killed mid-domain. Each kill:

- leaves the DB run row 'running' until the next run reclaims it as stale
  (30 min), so the dashboard shows STALLED for half an hour;
- ends the run as 'failed', and Fresh Finds only surfaces ads from completed
  runs, so the 100+ ads that run captured (and paid Apify/OpenAI/ScrapingBee
  for) stay invisible;
- leaves unfinished domains due, so the next hourly sweep repeats the oversized
  run and often times out again (hence five kills in a row).

## Chosen approach

1. **Unblock the event loop** (fix A): wrap the two
   `fetch_facebook_ads_apify(...)` call sites in `asyncio.to_thread`, and the
   six `check_media_exists_in_storage` call sites likewise. Smallest possible
   diff; the sync client code itself is untouched.
2. **Time budget instead of hard kill** (fix B): run_scrape.py tracks a
   monotonic deadline (default 45 min, `RUN_TIME_BUDGET_MINUTES` env override).
   Before starting each domain it checks the deadline; when exhausted it marks
   the remaining domains due (`db.mark_domains_due`), logs exactly what was
   deferred, and finishes the run as COMPLETED. Ads become visible immediately,
   the lock is released cleanly, and the next hourly tick continues where this
   one left off. `timeout-minutes` raised to 90 as a belt only.
3. **Streaming CI logs**: `PYTHONUNBUFFERED: "1"` in scrape.yml so the Actions
   log shows progress live (the 07-08 logs came out in 10-minute buffered
   clumps, which made debugging much harder).
4. **Heartbeat-based stale reclaim** (found in QA): `claim_run` used to reclaim
   any run older than 30 minutes *since start* - but under the budget a healthy
   run may legitimately live 45-60 minutes, so a concurrent claimer (e.g. a
   local CLI run during CI) could falsely fail it and hide its ads. Reclaim now
   judges `coalesce(last_heartbeat_at, started_at)` silent for 10+ minutes: a
   live run heartbeats every 2s, so silence means death - dead runs are
   reclaimed 3x faster and healthy long runs never are.

## Alternatives rejected

- **Just raise timeout-minutes to 6h**: simpler, but every kill still hides
  captured ads and leaves a stale lock; one bad domain can still burn the whole
  window. Fails dirty instead of failing safe.
- **Raise the 90s STALLED threshold**: only widens the false-alarm window; a
  slow Apify run still trips it. The frozen loop is the defect.
- **Switch to ApifyClientAsync**: cleaner long-term, but a much larger change
  surface in a 1,100-line legacy module for the same behavioral result.
  `asyncio.to_thread` achieves loop liveness with two-line diffs.

## Architecture

Layers unchanged: dashboard (Next.js, read/dispatch) -> DB (Supabase, runs as
lock + progress) -> runner (Python on GitHub Actions). SSOT for liveness stays
`runs.last_heartbeat_at` judged on the DB clock. The budget logic lives only in
the runner (run_scrape.py); the dashboard needs no change. Mechanical guard: the
new tests fail if the resume fetch ever blocks the loop again or the budget loop
stops finishing runs cleanly; a new test workflow runs them on every PR.

## Security

No new inputs, endpoints, or secrets. `RUN_TIME_BUDGET_MINUTES` is parsed with
a safe fallback (non-numeric -> default). `mark_domains_due` takes UUIDs already
validated upstream and binds them as a uuid[] parameter. No change to logging
redaction; no PII involved.

## Observability

- Budget exhaustion prints a namespaced, explicit line:
  `[budget] time budget (45m) reached after N/M domains; marking K remaining domain(s) due for the next tick`
  followed by the deferred domain list. This lands in run_logs and the GH log.
- `PYTHONUNBUFFERED=1` makes the GitHub Actions log stream in real time.
- Heartbeat behavior unchanged (2s ticks) but now actually live during Apify
  waits, so the dashboard's STALLED banner becomes trustworthy.

## Settings

- New: `RUN_TIME_BUDGET_MINUTES` env var (default 45), documented in
  .env.example. Not exposed in the dashboard UI: it is an operator/runner
  concern, and the dashboard has no settings layer for runner tuning; the env
  var is the right surface for it today.
- Deliberately unchanged: the 90s STALLED threshold (honest once the heartbeat
  is unblocked).

## Testing

New pytest suite under tests/ (repo previously had zero tests; pytest +
pytest-asyncio added via requirements-dev.txt):

- test_event_loop_liveness.py: proves `fetch_facebook_ads_apify_with_resume`
  no longer starves the loop -- a ticker task must keep ticking while a
  monkeypatched blocking fetch sleeps. Fails on the old code, passes on the new.
  Also pins the heartbeat task's flush cadence during a threaded blocking call.
- test_time_budget.py: the extracted `_scrape_domain_rows` loop with a fake
  clock -- all domains processed when budget is ample; processing stops at the
  deadline, remaining ids are marked due, and the run still returns cleanly;
  zero-budget edge (all deferred); per-domain schedule bumps only for processed
  rows.
- test_db_helpers.py: `mark_domains_due` SQL shape + no-op on empty list;
  `claim_run` reclaims by heartbeat (never by age) and yields cleanly when
  another run holds the lock.

CI: .github/workflows/test.yml runs the suite on every PR and push to main.
Out of scope: end-to-end runs against live Apify/GCS/DB (external I/O; covered
by the existing live-run observability instead).

## Deploy

- Feature branch -> PR -> merge to main (repo's existing flow; production
  scraper runs from main via scrape.yml, dashboard deploys from main on Vercel).
- No direct pushes to main; no manual promotion. Rollback = revert the merge
  commit; the runner picks up the previous code on its next tick.
- Interim operator guidance (until merged): do NOT click STOP / MARK FAILED on
  a STALLED banner during a manual scrape -- it is almost certainly a false
  alarm and kills a healthy, paid-for run.

## Open questions

- Whether to also thread the short sync DB calls inside scrape_query
  (connect/upsert). Deliberately not done: they are subsecond against the
  pooler and the 90s threshold leaves ample margin; threading them adds
  failure modes for no observed symptom.
