-- ═════════════════════════════════════════════════════════════════════════════
-- 0009_creative_language.sql
-- Language of the text ON the creative (not the ad's copy fields).
--
-- The existing `language` column is detected from the ad's TEXT fields
-- (body/caption/headline via ad_copy_text). This one is detected by a vision model
-- reading the creative itself - the text printed on the image, or shown on the
-- video's frame - so a Spanish-text image under an English caption reads Spanish.
--
-- Stored as a language NAME ("Spanish", "Portuguese"), like `language`, so the
-- dashboard's langCode badge works on both. NULL means "not classified yet": new
-- ads are filled by gpt_detect_creative_language during a scrape, existing ones by
-- backfill_creative_language.py. '' (empty) means the creative has no readable text.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.ads
    add column if not exists creative_language text;

-- The Creative Language facet filters on this column; keep it cheap as ads grows.
create index if not exists ads_creative_language_idx
    on public.ads (creative_language) where creative_language is not null;
