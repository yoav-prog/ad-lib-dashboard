-- ═════════════════════════════════════════════════════════════════════════════
-- 0006_review_status.sql
-- Relevance review queue for keyword-search junk.
--
-- The Ad Library query is a keyword search over ad text, so it returns ads that
-- merely mention the queried domain. The scraper now routes ads whose
-- destination does not point at the tracked domain to a review queue instead of
-- straight into the feed:
--   approved  destination matches the domain (or a human approved it) - in feed
--   pending   destination mismatch, awaiting a human decision - Review tab only
--   rejected  human said no; the row is KEPT so dedup never re-imports the ad
--
-- Default 'approved' keeps every pre-existing row visible until
-- backfill_review_status.py re-classifies them with the scraper's own rule.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.ads
    add column if not exists review_status text not null default 'approved'
        check (review_status in ('approved', 'pending', 'rejected'));

-- The Review tab reads only pending rows; keep that lookup cheap as ads grows.
create index if not exists ads_review_pending_idx
    on public.ads (review_status) where review_status = 'pending';
