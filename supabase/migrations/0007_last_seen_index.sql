-- The feed now keys on the latest sighting: getAds orders by last_seen_at so
-- ads the scraper just re-surfaced always make it inside the row cap. Keep
-- that sort cheap as ads grows.
create index if not exists ads_last_seen_idx
    on public.ads (last_seen_at desc);
