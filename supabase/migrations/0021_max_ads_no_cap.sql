-- ═════════════════════════════════════════════════════════════════════════════
-- 0021_max_ads_no_cap.sql
-- Lift the 1000 ceiling on a tracked row's Max Ads.
--
-- The 0001 schema capped domains.max_ads at 1..1000 and the app clamped to the
-- same range, so a big competitor could never be scraped past 1000 ads. The scrape
-- already stops on its own when the Ad Library runs out, so the only rule kept is
-- "at least 1". The app clamps to the integer column's own maximum.
--
-- Safe to apply before or after the matching app code: it only relaxes a check.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.domains drop constraint if exists domains_max_ads_check;
alter table public.domains
    add constraint domains_max_ads_check check (max_ads >= 1);
