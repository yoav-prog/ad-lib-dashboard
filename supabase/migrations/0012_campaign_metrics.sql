-- ═════════════════════════════════════════════════════════════════════════════
-- 0012_campaign_metrics.sql
-- The team's campaign-performance numbers (revenue, clicks, RPC, GEO split, top
-- keywords), materialised into Postgres from the Google Sheet they live in.
--
-- Why this table exists: the Fresh Finds feed lets a viewer sort by revenue / RPC and
-- filter by GEOS, but those values were only ever joined onto ads in memory per render
-- (web/lib/metrics.js attachSheetMetrics), reading the sheet each time. That is fine
-- while the whole feed sits in the browser, but it makes server-side sort/filter by
-- those columns impossible: Postgres cannot order or filter by a number it has never
-- seen. Landing them here, keyed the same way the in-memory join matches, is the
-- prerequisite for paginating and sorting the feed in the database (see
-- _plans/2026-07-28-fresh-finds-performance.md, Phase 1).
--
-- The Google Sheet stays the source of truth; this table is a cache refreshed on a
-- schedule (a Vercel Cron hitting /api/sync-metrics) and after each scrape. `updated_at`
-- records when a row was last written so the UI can show how fresh the numbers are.
--
-- url_key is the normalized landing-page key both sides match on: bare lowercase host
-- (no www.) + path, no query/fragment (web/lib/metrics.js normalizeUrlKey). One row per
-- key: the sheet's several campaigns per URL are already aggregated into it by
-- buildMetricsIndex before they reach this table (revenue/clicks summed, RPC recomputed,
-- keywords from the top-revenue row, the per-country split kept as geos/geo_split).
-- Nullable metric columns: a blank sheet cell stays NULL here (never a fake 0), exactly
-- as the in-memory path treats it.
-- ═════════════════════════════════════════════════════════════════════════════

-- geo_split holds the per-country revenue breakdown as a JSON string (the array of
-- { country, revenue, share } the GEOS popup shows). It is stored as text, not jsonb,
-- deliberately: nothing ever queries inside it - the feed filters on the compact `geos`
-- string and only displays geo_split - so text keeps the bulk upsert unambiguous and
-- the reader just JSON.parses it.
create table if not exists public.campaign_metrics (
    url_key      text primary key,
    revenue      numeric,
    clicks       numeric,
    rpc          numeric,
    geos         text,
    geo_split    text,
    keywords     text,
    row_count    integer     not null default 1,
    updated_at   timestamptz not null default now()
);
