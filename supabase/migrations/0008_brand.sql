-- ═════════════════════════════════════════════════════════════════════════════
-- 0008_brand.sql
-- Brand classification of the creative.
--
-- Each ad is tagged with whether its creative features a commercial brand, looking
-- at BOTH the image (logos, packaging, wordmarks) and the ad copy (brand names):
--   none       no recognizable brand - a generic / unbranded creative
--   brand      some recognizable commercial brand is present
--   car_brand  the brand is an automobile manufacturer - broken out on its own
--              because car brands are a lighter compliance category than the rest
--
-- NULL means "not classified yet": new ads are filled by gpt_detect_brand during a
-- scrape, and the existing rows by a one-off backfill_brand.py. A human can override
-- the value from the Detail view.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.ads
    add column if not exists brand text
        check (brand is null or brand in ('none', 'brand', 'car_brand'));

-- The Brand facet filters on this column; keep it cheap as ads grows.
create index if not exists ads_brand_idx on public.ads (brand) where brand is not null;
