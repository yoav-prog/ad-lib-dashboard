-- ═════════════════════════════════════════════════════════════════════════════
-- 0010_content_flag.sql
-- Prohibited-content classification of the creative (keeps policy-violating
-- competitor ads OUT of the feed).
--
-- Each ad is screened against Google Publisher Policies' Prohibited Content Topics,
-- looking at BOTH the image (what it depicts) and the ad copy (what it says). One
-- most-severe category slug is stored, or 'none' when the ad is clean:
--   none | adult | weapons | gambling | political | hate |
--   dangerous | before_after | drugs | egg_donation | policy_other
--
-- The feed hides any row whose content_flag is a real category (everything but
-- 'none'); 'none' and NULL stay visible. NULL means "not classified yet": new ads
-- are filled by gpt_detect_prohibited during a scrape, existing rows by a one-off
-- backfill_content_flag.py. A human can clear a false positive from the Filtered view
-- (sets it back to 'none'), which returns the ad to the feed.
--
-- NULL still shows on purpose, so the existing feed is not blanked before the backfill
-- runs - only real category hits are hidden, and only once classified.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.ads
    add column if not exists content_flag text
        check (content_flag is null or content_flag in (
            'none', 'adult', 'weapons', 'gambling', 'political', 'hate',
            'dangerous', 'before_after', 'drugs', 'egg_donation', 'policy_other'
        ));

-- The feed excludes flagged rows and the Filtered view reads them; a partial index on
-- the prohibited rows keeps both cheap as ads grows (the clean/NULL majority is not
-- indexed).
create index if not exists ads_content_flag_idx
    on public.ads (content_flag)
 where content_flag is not null and content_flag <> 'none';
