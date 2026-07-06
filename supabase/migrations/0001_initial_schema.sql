-- ═════════════════════════════════════════════════════════════════════════════
-- 0001_initial_schema.sql
-- Competitor Ad Intelligence Dashboard - initial schema.
--
-- Three tables:
--   runs     one row per scrape run; also the concurrency lock and the
--            integrity boundary (a failed run's partial data is identifiable)
--   domains  the management-zone config: what to scrape, how many, how often
--   ads      one row per competitor ad, keyed on ad_archive_id (native dedup)
--
-- The scraper writes through the Supabase transaction pooler as the privileged
-- role (which bypasses RLS). The dashboard reads/writes as authenticated team
-- members, gated by the RLS policies at the bottom.
-- ═════════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ── runs ─────────────────────────────────────────────────────────────────────
create table if not exists public.runs (
    id             uuid primary key default gen_random_uuid(),
    status         text        not null default 'running'
                     check (status in ('running', 'completed', 'failed')),
    trigger_source text        not null default 'schedule'
                     check (trigger_source in ('schedule', 'manual')),
    started_at     timestamptz not null default now(),
    finished_at    timestamptz,
    ads_found      integer     not null default 0,
    ads_new        integer     not null default 0,
    errors         integer     not null default 0,
    error_detail   text
);

-- The concurrency lock: at most one run may be 'running' at any instant.
-- A second concurrent claim hits this index and fails fast (see db.claim_run).
create unique index if not exists runs_single_active
    on public.runs (status) where status = 'running';

create index if not exists runs_started_idx on public.runs (started_at desc);

-- ── domains (management-zone config) ─────────────────────────────────────────
create table if not exists public.domains (
    id            uuid        primary key default gen_random_uuid(),
    query         text        not null,               -- search term / competitor
    country       text        not null default 'ALL',
    active_status text        not null default 'active',
    max_ads       integer     not null default 100
                    check (max_ads between 1 and 1000),
    cadence       text        not null default 'daily'
                    check (cadence in ('hourly', 'daily', 'weekly', 'paused')),
    enabled       boolean     not null default true,
    next_run_at   timestamptz not null default now(),
    last_run_at   timestamptz,
    created_at    timestamptz not null default now(),
    unique (query, country)
);

create index if not exists domains_due_idx
    on public.domains (next_run_at) where enabled and cadence <> 'paused';

-- ── ads ──────────────────────────────────────────────────────────────────────
create table if not exists public.ads (
    ad_archive_id       text primary key,             -- dedup key

    -- identity / source
    page_id             text,
    page_name           text,
    domain              text,
    feed                text,

    -- ad copy
    caption             text,
    cta_text            text,
    body_text           text,
    cta_type            text,
    title               text,
    link_description    text,
    link_url            text,
    display_format      text,
    extra_texts         text,

    -- creative (permanent GCS URLs, not Facebook CDN links)
    original_image_urls text[]      not null default '{}',
    video_hd_url        text,
    video_preview_url   text,
    extra_image_urls    text[]      not null default '{}',
    extra_video_urls    text[]      not null default '{}',

    -- reach / platform
    publisher_platform  text[]      not null default '{}',
    start_date          timestamptz,
    total_active_time   text,

    -- scraped landing page + GPT enrichment
    article_title       text,
    article_content     text,
    rank                integer,
    language            text,
    country             text,
    vertical            text,

    -- provenance / freshness (drives "fresh finds")
    first_seen_at       timestamptz not null default now(),
    last_seen_at        timestamptz not null default now(),
    first_run_id        uuid references public.runs (id),
    last_run_id         uuid references public.runs (id),

    -- content pipeline (Phase 2 - columns present now to avoid a later migration)
    status              text        not null default 'new'
                          check (status in ('new', 'idea', 'drafting',
                                            'published', 'archived')),
    owner               text,
    linked_article_url  text,
    is_saved            boolean     not null default false,
    tags                text[]      not null default '{}',
    notes               text
);

create index if not exists ads_first_seen_idx on public.ads (first_seen_at desc);
create index if not exists ads_last_run_idx    on public.ads (last_run_id);
create index if not exists ads_domain_idx      on public.ads (domain);
create index if not exists ads_vertical_idx    on public.ads (vertical);
create index if not exists ads_status_idx      on public.ads (status);
create index if not exists ads_saved_idx       on public.ads (is_saved) where is_saved;

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Internal tool: every authenticated team member has full read/write. The
-- scraper connects via the pooler as the privileged role and bypasses RLS.
alter table public.runs    enable row level security;
alter table public.domains enable row level security;
alter table public.ads     enable row level security;

create policy "team full access" on public.runs
    for all to authenticated using (true) with check (true);

create policy "team full access" on public.domains
    for all to authenticated using (true) with check (true);

create policy "team full access" on public.ads
    for all to authenticated using (true) with check (true);

-- ═════════════════════════════════════════════════════════════════════════════
-- "Fresh finds" note:
--   The most recent run with status='completed' is the baseline. Fresh ads are
--   those with first_seen_at >= that run's started_at. Because ads are only
--   surfaced against a COMPLETED run, a run that dies mid-way never becomes the
--   baseline, so partial/half-enriched rows are not shown as "fresh".
-- ═════════════════════════════════════════════════════════════════════════════
