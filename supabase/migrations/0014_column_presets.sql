-- ═════════════════════════════════════════════════════════════════════════════
-- 0014_column_presets.sql
-- Per-account saved column layouts for the dashboard's data tables (Fresh Finds,
-- Review, Filtered, Rejected). Each preset is a named order + hidden set for one
-- table, owned by one user, so a person's column choices follow their account across
-- devices instead of living only in one browser's localStorage.
--
-- The layout itself is jsonb ({ "order": [keys...], "hidden": [keys...] }); the app
-- (web/lib/columns.js) is the single source of truth for which keys a table has and
-- validates every write against that catalog, so this column never needs a CHECK on
-- its shape. Deleting a user cascades their presets away.
--
-- Exactly one preset per (user, table) may be the default, enforced by a partial
-- unique index rather than app logic, so two tabs racing to "set default" can't both
-- win. table_key is constrained to the four known tables so a typo fails at the
-- database, not silently.
-- ═════════════════════════════════════════════════════════════════════════════

create table if not exists public.column_presets (
    id          uuid        primary key default gen_random_uuid(),
    user_id     uuid        not null references public.users (id) on delete cascade,
    table_key   text        not null
                  check (table_key in ('freshfinds', 'review', 'filtered', 'rejected')),
    name        text        not null check (length(name) between 1 and 60),
    layout      jsonb       not null,
    is_default  boolean     not null default false,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- One preset name per user per table (case-insensitive), so "Revenue" and "revenue"
-- don't both exist and confuse the picker.
create unique index if not exists column_presets_user_table_name_key
    on public.column_presets (user_id, table_key, lower(name));

-- At most one default per (user, table).
create unique index if not exists column_presets_one_default_key
    on public.column_presets (user_id, table_key)
 where is_default;

-- The common read: every preset for the signed-in user, grouped by table.
create index if not exists column_presets_user_idx
    on public.column_presets (user_id, table_key);
