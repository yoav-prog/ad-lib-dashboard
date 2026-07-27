-- ═════════════════════════════════════════════════════════════════════════════
-- 0011_google_identity.sql
-- "Continue with Google" alongside the existing email + password sign-in.
--
-- Nothing here widens who may sign in. Access is still granted by an admin
-- invite; Google is only a second way for an already-invited person to prove
-- they are who the invite was addressed to. See web/lib/google-oauth.js.
--
--   users.google_sub        Google's stable, never-reused subject identifier
--   users.google_linked_at  when that identity was first attached
--
-- The subject is stored, rather than trusting the email alone, so that an
-- address recycled to a different person (a leaver's mailbox reissued in
-- Workspace) cannot quietly inherit the old account's role. A mismatch is
-- refused and an admin has to unlink it deliberately from /admin.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.users
    add column if not exists google_sub       text,
    add column if not exists google_linked_at timestamptz;

-- One Google identity maps to at most one account. Partial, because the column
-- is null for everyone who only ever uses a password, and those are not "equal".
create unique index if not exists users_google_sub_key
    on public.users (google_sub) where google_sub is not null;

-- ── audit vocabulary ─────────────────────────────────────────────────────────
-- auth_events.type is a closed set, so the two new events have to be added to
-- the constraint. Recreated in full rather than patched, so the list in the
-- database always reads as the complete vocabulary.
alter table public.auth_events drop constraint if exists auth_events_type_check;

alter table public.auth_events add constraint auth_events_type_check
    check (type in ('login_ok', 'login_failed', 'login_locked',
                    'logout', 'invite_sent', 'invite_accepted',
                    'reset_sent', 'reset_done',
                    'user_created', 'user_updated',
                    'user_disabled', 'user_enabled', 'user_deleted',
                    'break_glass',
                    'google_linked', 'google_unlinked'));
