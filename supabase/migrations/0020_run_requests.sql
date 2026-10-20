-- ═════════════════════════════════════════════════════════════════════════════
-- 0020_run_requests.sql
-- "Run selected" while a scrape is already running, and an honest time left.
--
-- Only one scrape runs at a time. Before this, clicking RUN on a few rows during a
-- long run did nothing: the button was locked until the run ended. Now the click
-- flags the rows, and the running job scrapes them next, right after the competitor
-- it is on, then carries on with its own list.
--
--   domains.run_requested_at  when someone asked for this row to run next. NULL means
--                             no request. The runner clears it as it takes the row.
--                             Rows a run's time budget cuts off stay flagged, so the
--                             next run takes them first.
--   runs.budget_ends_at       when the run's soft time budget (RUN_TIME_BUDGET_MINUTES)
--                             runs out. The live panel caps its "time left" here, so a
--                             87-competitor run no longer claims to need three hours
--                             when it stops after 45 minutes and hands the rest on.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.domains
    add column if not exists run_requested_at timestamptz;

alter table public.runs
    add column if not exists budget_ends_at timestamptz;

-- The runner reads the oldest request before every domain; keep it on a tiny slice.
create index if not exists domains_run_requested_idx
    on public.domains (run_requested_at) where run_requested_at is not null;
