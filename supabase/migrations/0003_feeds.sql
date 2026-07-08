-- Managed list of content feeds. A domain can be assigned a feed; the dashboard
-- offers these as a dropdown and lets an admin add new ones.
create table if not exists public.feeds (
    id         uuid primary key default gen_random_uuid(),
    name       text not null unique,
    created_at timestamptz not null default now()
);

alter table public.feeds enable row level security;

create policy "team full access" on public.feeds
    for all to authenticated using (true) with check (true);
