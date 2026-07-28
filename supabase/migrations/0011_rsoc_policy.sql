-- ═════════════════════════════════════════════════════════════════════════════
-- 0011_rsoc_policy.sql
-- RSoC policy-risk grade of a Fresh Finds row (how much policy care its TOPIC/ANGLE
-- would demand if we build an article on it and monetise via Google RSoC).
--
-- A DIFFERENT axis from content_flag (0010): content_flag HIDES ads that break Google
-- Publisher *Policies* (prohibited). This GRADES the survivors against Google Publisher
-- *Restrictions* (limit-serving verticals) + RSoC misleading/exaggerated-claim rules, and
-- never hides anything - it only annotates. See rsoc_policy.py for the source of truth and
-- _plans/2026-07-28-rsoc-policy-column.md for why green != "safe to publish".
--
-- Three columns, all nullable:
--   rsoc_tier         green | yellow | red   (NULL = not classified yet)
--   rsoc_policy_area  a short slug naming which rule tripped (labelled in the UI)
--   rsoc_reason       a <=120-char human sentence shown in the column
--
-- NULL on all three means "not classified yet": new ads are filled by gpt_detect_rsoc_risk
-- during a scrape, existing rows by a one-off backfill_rsoc_policy.py. A failed model call
-- with no deny-list hit also leaves NULL, so a hiccup never mislabels a row. rsoc_tier is
-- CHECK-constrained so a buggy writer cannot store a junk tier; policy_area/reason are free
-- text kept honest by the shared parser in rsoc_policy.py.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.ads
    add column if not exists rsoc_tier text
        check (rsoc_tier is null or rsoc_tier in ('green', 'yellow', 'red')),
    add column if not exists rsoc_policy_area text,
    add column if not exists rsoc_reason text;

-- The column sorts and facets by tier; a partial index on the graded (non-green, non-NULL)
-- minority keeps that cheap as ads grows - the green/unclassified majority is not indexed.
create index if not exists ads_rsoc_tier_idx
    on public.ads (rsoc_tier)
 where rsoc_tier is not null and rsoc_tier <> 'green';
