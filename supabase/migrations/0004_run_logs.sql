-- ═════════════════════════════════════════════════════════════════════════════
-- 0004_run_logs.sql
-- Live run visibility: a durable, in-app log stream plus heartbeat/progress so
-- the dashboard can show exactly what a scrape is doing, whether it is still
-- alive, and its full logs, without anyone opening GitHub Actions.
--
--   run_logs   one row per flushed log line, keyed to a run (append-only)
--   runs.*     heartbeat + progress snapshot the runner refreshes as it works
--
-- The runner writes here as the privileged role (bypasses RLS); the dashboard
-- reads through an admin-gated endpoint. Liveness is judged from
-- last_heartbeat_at on the database clock, never from status alone.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── run_logs ─────────────────────────────────────────────────────────────────
create table if not exists public.run_logs (
    id       bigserial   primary key,          -- monotonic; doubles as the poll cursor
    run_id   uuid        not null references public.runs (id) on delete cascade,
    ts       timestamptz not null default now(),
    level    text        not null default 'info'
               check (level in ('info', 'warn', 'error', 'success')),
    message  text        not null
);

-- "logs for this run after cursor X" - the dashboard's only read pattern.
create index if not exists run_logs_run_idx on public.run_logs (run_id, id);

-- ── runs: heartbeat + live progress snapshot ─────────────────────────────────
alter table public.runs
    add column if not exists last_heartbeat_at timestamptz,
    add column if not exists current_domain    text,
    add column if not exists domains_total     integer not null default 0,
    add column if not exists domains_done      integer not null default 0,
    add column if not exists ads_found_so_far  integer not null default 0;

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Parity with the other tables. The scraper connects as the privileged role and
-- bypasses RLS; dashboard reads are gated at the app layer (admin only).
alter table public.run_logs enable row level security;

create policy "team full access" on public.run_logs
    for all to authenticated using (true) with check (true);
