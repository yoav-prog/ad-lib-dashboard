-- ═════════════════════════════════════════════════════════════════════════════
-- 0002_feed_and_verticals.sql
-- Move the last two Google Sheets lookups into the database:
--   * per-domain "feed" value (was the Websites sheet mapping) -> domains.feed
--   * the vertical/offer taxonomy (was the Offer Naming sheet) -> verticals table
-- After this, the scraper needs no Google Sheets access at all.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.domains add column if not exists feed text;

create table if not exists public.verticals (
    id   integer generated always as identity primary key,
    name text not null unique
);

alter table public.verticals enable row level security;

drop policy if exists "team full access" on public.verticals;
create policy "team full access" on public.verticals
    for all to authenticated using (true) with check (true);
