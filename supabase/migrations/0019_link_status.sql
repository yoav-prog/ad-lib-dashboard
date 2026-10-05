-- ═════════════════════════════════════════════════════════════════════════════
-- 0019_link_status.sql
-- Whether an ad's landing page still exists.
--
-- Competitors delete pages. Tarzo removed its whole /dcg/ article section in late
-- August 2026, leaving ~9k ads in the feed whose links all 404 - and nothing in the
-- dashboard said so, so a stopped ad with a deleted page looked exactly like a live
-- one. check_links.py now requests each ad's first landing URL and records what came
-- back; the dashboard marks 404/410 as DEAD and can hide or isolate them.
--
--   link_status      the final HTTP status after redirects. NULL means not checked
--                    yet, or the host never answered (timeout, refused, TLS error).
--                    Only 404 and 410 count as dead (link_health.py); a bot wall
--                    (202/403/429) or a 5xx is an unknown, never a dead link.
--   link_checked_at  when that status was read. The job re-checks after a week, so a
--                    page that comes back stops being marked dead.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.ads
    add column if not exists link_status smallint,
    add column if not exists link_checked_at timestamptz;

-- The job's work queue: never-checked first, then the stalest.
create index if not exists ads_link_checked_at_idx
    on public.ads (link_checked_at asc nulls first);

-- The rail's ONLY DEAD view selects this small slice directly.
create index if not exists ads_link_dead_idx
    on public.ads (ad_archive_id) where link_status in (404, 410);
