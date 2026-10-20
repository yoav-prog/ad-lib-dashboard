# Run selected jumps the queue

Date: 2026-10-20. Branch: `run-selected-jumps-queue`.

## Goal

While a big scrape is running (for example "run all", 87 competitors, 45 minutes),
someone selects a few rows and clicks RUN. Today the button is locked ("RUN IN
PROGRESS...") and nothing is queued, so the only way to get those rows is STOP, then
RUN, then wait for the hourly runner to pick the big run back up.

Wanted: the selected rows run next, right after the competitor being scraped now,
and the big run then carries on by itself. No STOP, no second click.

## Constraints

- One run at a time stays. The GitHub `scrape` concurrency group and the
  `runs_single_active` DB lock exist for good reasons (shared `existing_ids`,
  schedule bumps, one live panel). This plan does not loosen either.
- A domain is never abandoned midway. The runner only changes course between domains.
- GitHub keeps one pending run per concurrency group and a newer one cancels the
  older. A plan that leaves a targeted run pending behind the big run can be
  silently wiped by the next hourly tick, so this plan does not depend on that.

## Approach (chosen)

The running job takes the request itself.

1. New column `domains.run_requested_at` (NULL = no request). "Run selected" while a
   live run exists sets it to `now()` on the selected rows instead of dispatching.
2. Before each domain, the runner claims the oldest request
   (`take_next_requested_domain`, `for update skip locked`) and scrapes that row
   next. If the row was also later in its own list, it is removed there so it is not
   scraped twice. Then the runner continues its own list.
3. Requests ignore enabled / due-ness, like a targeted run (an explicit ask).
4. Requests that the 45-minute budget cuts off stay flagged. `any_domain_due` also
   counts flagged rows, so the next run (hourly tick, or the backstop below) takes
   them first.
5. Backstop: the dashboard also dispatches a plain sweep. It waits behind the live
   run in GitHub's queue and, once the live run ends, picks up anything still flagged
   or due. If the hourly tick replaces it, the tick does the same work.

Also in this PR, both from Amit's screenshots:

- The live panel's "Remaining" ignored the 45-minute budget ("~2:58:30 left"). The
  runner now writes `runs.budget_ends_at` at the claim; the estimate is capped by it
  and says the rest continues on the next run.
- The live panel lists queued rows ("Up next: a.com, b.com").

## Alternatives rejected

- **Stop the big run cleanly, start a targeted run, resume the big run after.**
  Needs a stop-request signal, a resume input, and a pending GitHub run that the
  hourly tick can cancel. More moving parts for the same result.
- **True parallel runs.** Needs a per-run lock, de-duplication across concurrent
  `existing_ids`, schedule races, a multi-run live panel, and a check of Apify's
  concurrency limit. Much more risk for little gain over this plan.

## Architecture

- SSOT for "what runs next": `db.take_next_requested_domain` (runner) and the single
  `update domains set run_requested_at` in `runDomains` (web).
- SSOT for the budget: the runner's `_time_budget_minutes`; the UI only reads
  `budget_ends_at`, never assumes 45.
- ETA and the queued message are pure helpers in `web/lib/ui.js` (`runEta`,
  `queuedRunMessage`) so they are unit tested.

## Security

- `runDomains` keeps `requireCapability('run_scrapes')` and `cleanDomainIds`
  (UUID-validated, max 50). The request write casts to `uuid[]`.
- No new secrets. The backstop dispatch reuses `dispatchScrapeWorkflow`.

## Observability

- Runner: `[run queue] running requested row next: <query>` and
  `[run queue] could not read run requests (...)` (fail-open).
- Web: `console.info('[run queue] queued rows behind live run', { count, current })`
  and the existing `[scrape dispatch]` logs for the backstop.

## Settings

No new settings. The budget is already `RUN_TIME_BUDGET_MINUTES`. The queue behavior
is the only sensible default for a click on RUN during a run, so there is no toggle.

## Testing

- Python: `_scrape_domain_rows` with an injected `take_requested`: request runs
  before the next queued row, a duplicate is not scraped twice, `domains_total`
  grows only for new rows, the deadline leaves unclaimed requests alone, and a
  failing request reader does not stop the run.
- Web: `runEta` (no budget, capped, uncapped) and `queuedRunMessage`.

## Deploy

1. Apply `0020_run_requests.sql` to the production DB (additive, two nullable
   columns and a partial index). It must land before merge: the runner reads the
   new column on every run.
2. PR into `main`, CI green, merge. Vercel deploys the web; the next scrape uses the
   new runner.
3. Rollback: revert the merge. The columns can stay; nothing reads them then.
