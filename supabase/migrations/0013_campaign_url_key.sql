-- ═════════════════════════════════════════════════════════════════════════════
-- 0013_campaign_url_key.sql
-- The campaign_metrics.url_key (migration 0012) that each Fresh Finds ad resolves to,
-- stored on the ad so the feed can join its revenue / RPC / GEOS in the database. This is
-- the last piece needed to sort and filter the feed by those columns server-side instead
-- of in the browser (see _plans/2026-07-28-fresh-finds-performance.md, Phase 2).
--
-- Only 'tonic rsoc' ads carry metrics, so this stays NULL for every other feed and for a
-- tonic ad whose link matches no campaign. It is resolved in JS by the metrics sync
-- (web/lib/metrics.js resolveCampaignKey), reusing the exact adUrlKeys normalization the
-- in-memory join uses, so there is one source of the matching rule - the same reason the
-- metrics themselves are parsed by one shared buildMetricsIndex.
--
-- A partial index on the matched minority keeps the feed's join cheap without indexing the
-- NULL majority (most feeds are not tonic rsoc).
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.ads add column if not exists campaign_url_key text;

create index if not exists ads_campaign_url_key_idx
    on public.ads (campaign_url_key)
 where campaign_url_key is not null;
