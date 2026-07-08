-- ═════════════════════════════════════════════════════════════════════════════
-- 0005_domain_interval_days.sql
-- Replace the fixed cadence enum (hourly/daily/weekly/paused) with a numeric
-- "every N days" interval, editable per domain from the Control Room.
--
--   domains.interval_days   how many days between scrapes (1..365)
--
-- Pausing collapses onto the existing `enabled` flag (the Status toggle), so a
-- domain is scraped when it is enabled and due - there is no longer a second,
-- redundant "paused" cadence value. The hourly GitHub Actions poll is unchanged;
-- it only ever wakes the runner, which still exits early when nothing is due.
--
-- APPLY THIS MIGRATION BEFORE DEPLOYING THE MATCHING APP CODE: the app reads
-- interval_days and no longer reads cadence.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── new column ───────────────────────────────────────────────────────────────
alter table public.domains
    add column if not exists interval_days integer not null default 3
      check (interval_days between 1 and 365);

-- ── carry the old cadence forward ────────────────────────────────────────────
-- Faithful mapping of the retired enum onto day intervals.
update public.domains set interval_days = 1 where cadence in ('hourly', 'daily');
update public.domains set interval_days = 7 where cadence = 'weekly';

-- Preserve paused state on the enabled flag (its single home from now on).
update public.domains set enabled = false where cadence = 'paused';

-- Requested change: move active tracking to every 3 days. Only enabled domains
-- are touched; adjust any row's frequency afterward in the Control Room.
update public.domains set interval_days = 3 where enabled;

-- ── swap the "due" index predicate (cadence is going away) ───────────────────
drop index if exists public.domains_due_idx;
create index if not exists domains_due_idx
    on public.domains (next_run_at) where enabled;

-- ── retire the cadence column ────────────────────────────────────────────────
alter table public.domains drop column if exists cadence;
