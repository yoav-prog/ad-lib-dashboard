-- ═════════════════════════════════════════════════════════════════════════════
-- 0018_country_from_geos.sql
-- Correct an ad's country from where its revenue actually comes from.
--
-- `ads.country` is a GPT guess made from the landing article. `campaign_metrics.geos`
-- is measured: the Tonic revenue report, split per country ("GB-99,ES-0"), which
-- web/lib/metrics.js already describes as what "tells a reader WHERE an article
-- actually earns - regardless of what AdIntel's own Country column guessed".
--
-- Measured on live data, the guess is wrong for 189 approved ads in one consistent
-- way: it picks a language's default market instead of the real one. NL->BE, FR->CH,
-- FR->BE, DE->CH, DE->AT, MX->ES, BR->PT, US->GB, GB->IE. That is the same class of
-- error as the "headline is Belgium, link is France" mismatch the Client Kits matcher
-- was hardened against, and it matters beyond display: country is a HARD GATE in the
-- our-articles match and in Client Kits' link assignment, so a wrong one silently
-- matches nothing at all.
--
-- Amit's rule, applied by syncCampaignMetrics on every metrics sync: take the
-- dominant GEOS country when it holds more than 50% of the split AND the ad earned at
-- least $50, so a decisive split backed by real money overrides the guess and noise
-- never does.
--
--   country_scraped  the value we replaced, so nothing is lost and the Detail view can
--                    show "corrected from US". NULL means this ad has never been
--                    corrected - it is not a copy of every ad's country.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.ads
    add column if not exists country_scraped text;

-- The correction joins ads to campaign_metrics on this key; it is how the feed already
-- joins them, but that join had no index of its own.
create index if not exists ads_campaign_url_key_idx
    on public.ads (campaign_url_key) where campaign_url_key is not null;
