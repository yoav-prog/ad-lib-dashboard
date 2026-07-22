-- ═════════════════════════════════════════════════════════════════════════════
-- 0009_users_and_sessions.sql
-- Real user accounts, replacing the shared DASHBOARD_PASSCODE gate.
--
--   users         one row per person; role sets defaults, capabilities override
--   user_tokens   single-use invite / reset links (stored hashed, never raw)
--   sessions      server-side sessions, so removing access is immediate
--   auth_events   append-only audit trail; also backs per-IP login throttling
--
-- Sessions live here rather than in a self-contained signed cookie because
-- "remove a user" has to take effect now: a stateless cookie stays valid until
-- it expires, so a removed person would keep access for up to 30 days.
--
-- Nothing here is readable by the `authenticated` Supabase role. RLS is enabled
-- with NO policies, which denies everything by default; only the dashboard's
-- privileged pooler connection (which bypasses RLS) touches these tables. That
-- matters most for users.password_hash and the *_hash token columns.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── users ────────────────────────────────────────────────────────────────────
create table if not exists public.users (
    id                 uuid        primary key default gen_random_uuid(),
    email              text        not null,
    name               text,

    -- Role sets the capability defaults; `capabilities` holds only explicit
    -- per-user overrides (see web/lib/capabilities.js for resolution).
    role               text        not null default 'viewer'
                         check (role in ('admin', 'editor', 'viewer')),
    capabilities       jsonb       not null default '{}'::jsonb,

    -- Null until the invite is accepted. Format: scrypt$N$r$p$salt$hash
    password_hash      text,

    -- Soft delete: disabled rows are retained for audit. A hard delete is a
    -- separate, explicit admin action.
    status             text        not null default 'invited'
                         check (status in ('invited', 'active', 'disabled')),

    -- Brute-force throttle, per account (per-IP lives in auth_events).
    failed_login_count integer     not null default 0,
    locked_until       timestamptz,

    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    last_login_at      timestamptz,
    disabled_at        timestamptz,
    created_by         uuid        references public.users (id) on delete set null
);

-- Case-insensitive uniqueness without needing the citext extension. The app
-- normalises to lowercase on the way in; this is the backstop.
create unique index if not exists users_email_key on public.users (lower(email));
create index if not exists users_status_idx on public.users (status);

-- ── user_tokens ──────────────────────────────────────────────────────────────
-- Invite and password-reset links. Only the sha256 of the token is stored, so a
-- database leak does not hand over working links. Single use: `used_at` is
-- stamped on redemption and checked on every lookup.
create table if not exists public.user_tokens (
    id         uuid        primary key default gen_random_uuid(),
    user_id    uuid        not null references public.users (id) on delete cascade,
    token_hash text        not null unique,
    purpose    text        not null check (purpose in ('invite', 'reset')),
    expires_at timestamptz not null,
    used_at    timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists user_tokens_user_idx on public.user_tokens (user_id, purpose);

-- ── sessions ─────────────────────────────────────────────────────────────────
-- The cookie carries a random 32-byte token; only its sha256 is stored here.
-- Deleting a user's rows logs them out on their very next request.
create table if not exists public.sessions (
    id           uuid        primary key default gen_random_uuid(),
    user_id      uuid        not null references public.users (id) on delete cascade,
    token_hash   text        not null unique,
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null,
    last_seen_at timestamptz not null default now(),
    user_agent   text,
    ip           text
);

create index if not exists sessions_user_idx    on public.sessions (user_id);
create index if not exists sessions_expires_idx on public.sessions (expires_at);

-- ── auth_events ──────────────────────────────────────────────────────────────
-- Append-only. Two jobs: the audit trail ("who removed whom, when") and the
-- per-IP login throttle (count login_failed rows for an IP inside a window).
--
-- user_id is nullable and set null on delete, and `email` is denormalised, so
-- the trail survives a hard delete of the account it describes.
create table if not exists public.auth_events (
    id         bigserial   primary key,
    ts         timestamptz not null default now(),
    type       text        not null
                 check (type in ('login_ok', 'login_failed', 'login_locked',
                                 'logout', 'invite_sent', 'invite_accepted',
                                 'reset_sent', 'reset_done',
                                 'user_created', 'user_updated',
                                 'user_disabled', 'user_enabled', 'user_deleted',
                                 'break_glass')),
    user_id    uuid        references public.users (id) on delete set null,
    email      text,
    actor_id   uuid        references public.users (id) on delete set null,
    actor_email text,
    ip         text,
    detail     text
);

-- The throttle's only read pattern: recent failures for one IP.
create index if not exists auth_events_ip_idx   on public.auth_events (ip, type, ts desc);
create index if not exists auth_events_user_idx on public.auth_events (user_id, ts desc);
create index if not exists auth_events_ts_idx   on public.auth_events (ts desc);

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Deliberately enabled with NO policies: deny-all for every non-privileged
-- role. Unlike runs/domains/ads, these tables hold credentials and must never
-- be reachable by the `authenticated` role even if a client key leaks.
alter table public.users       enable row level security;
alter table public.user_tokens enable row level security;
alter table public.sessions    enable row level security;
alter table public.auth_events enable row level security;
