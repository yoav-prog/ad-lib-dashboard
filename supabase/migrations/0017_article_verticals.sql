-- ═════════════════════════════════════════════════════════════════════════════
-- 0017_article_verticals.sql
-- "Do we already have our own article for this ad?" — the family-match columns.
--
-- The competitor feed lives here; the ~250k articles we publish live in a SEPARATE
-- Postgres (ARTICLES_DATABASE_URL). Nothing can join across the two, so the answer
-- has to be materialized on this side for the feed's server-side filter to use it.
--
--   article_verticals     the vertical FAMILY derived from the ad's own landing
--                         article — the verticals, drawn verbatim from our articles
--                         DB vocabulary, that this article belongs with. Derived by
--                         backfill_article_verticals.py (embedding shortlist, then
--                         gpt-4.1-mini picks the family). Domain-independent, so it
--                         is computed once and serves all 47 of our domains.
--   article_verticals_at  when that derivation ran, so a re-run can target only the
--                         rows that never got one, or refresh stale ones.
--   our_article_domains   which of OUR domains actually hold at least one article
--                         matching this ad on country + language + one of the above.
--                         A cache of the live lookup, never a second definition of
--                         it: web/lib/ourmatch.js and article_verticals.py apply the
--                         same rule, and the links a user sees are always read live.
--
-- NULL means "not derived yet" for both, exactly like brand / rsoc_tier. An empty
-- array means "derived, and the answer is nothing", which is a different fact.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.ads
    add column if not exists article_verticals text[],
    add column if not exists article_verticals_at timestamptz,
    add column if not exists our_article_domains text[];

-- The feed's "only ads we already have an article for" filter is
-- `<domain> = any(our_article_domains)`, which needs GIN to stay cheap as ads grows.
create index if not exists ads_our_article_domains_gin
    on public.ads using gin (our_article_domains);

-- The backfill's own "which rows still need work" scan, and any future per-vertical
-- reporting over the derived families.
create index if not exists ads_article_verticals_gin
    on public.ads using gin (article_verticals);
