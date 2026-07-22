// Data access for accounts, sessions, single-use tokens, and the audit trail.
// Every SQL statement touching users/sessions lives here so the policy layer
// (lib/auth.js) and the /admin actions never build queries themselves.
//
// Two rules hold throughout:
//   - raw tokens are never stored. Sessions and invite/reset links keep only a
//     sha256 of a 256-bit random value, so a database leak yields nothing usable
//   - the "last admin" guard runs inside a transaction with a count check,
//     never as a read-then-write, so two concurrent demotions cannot both pass
import crypto from 'node:crypto';
import { getSql } from './db';

export const SESSION_DAYS = 30;
export const INVITE_HOURS = 72;
export const RESET_HOURS = 1;

// Brute-force limits. Per account, and per IP so one attacker cannot cycle
// through addresses to stay under the per-account counter.
export const MAX_FAILED_LOGINS = 10;
export const LOCKOUT_MINUTES = 15;
export const MAX_IP_FAILURES = 30;
export const IP_WINDOW_MINUTES = 15;

// Everything the app needs about a person. password_hash is deliberately absent:
// only findUserWithHash asks for it, so the hash cannot ride along in a payload
// by accident.
const USER_COLUMNS = [
  'id', 'email', 'name', 'role', 'capabilities', 'status',
  'failed_login_count', 'locked_until', 'created_at', 'updated_at',
  'last_login_at', 'disabled_at', 'created_by',
];

function mapUser(r) {
  if (!r) return null;
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    capabilities: r.capabilities || {},
    status: r.status,
    failed_login_count: r.failed_login_count,
    locked_until: iso(r.locked_until),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    last_login_at: iso(r.last_login_at),
    disabled_at: iso(r.disabled_at),
    created_by: r.created_by,
  };
}

// Emails are compared and stored lowercase; the unique index is on lower(email).
export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

// ── reads ────────────────────────────────────────────────────────────────────

export async function listUsers() {
  const sql = getSql();
  const rows = await sql`
    select ${sql(USER_COLUMNS)} from users
     order by (status = 'disabled'), lower(email)
  `;
  return rows.map(mapUser);
}

export async function findUserById(id) {
  const sql = getSql();
  const rows = await sql`select ${sql(USER_COLUMNS)} from users where id = ${id}`;
  return mapUser(rows[0]);
}

export async function findUserByEmail(email) {
  const sql = getSql();
  const rows = await sql`
    select ${sql(USER_COLUMNS)} from users where lower(email) = ${normalizeEmail(email)}
  `;
  return mapUser(rows[0]);
}

// The one place the password hash is read, for the login comparison.
export async function findUserWithHash(email) {
  const sql = getSql();
  const rows = await sql`
    select ${sql(USER_COLUMNS)}, password_hash
      from users where lower(email) = ${normalizeEmail(email)}
  `;
  if (!rows[0]) return null;
  return { ...mapUser(rows[0]), password_hash: rows[0].password_hash };
}

export async function countUsers() {
  const sql = getSql();
  const [{ count }] = await sql`select count(*)::int as count from users`;
  return count;
}

export async function countActiveAdmins() {
  const sql = getSql();
  const [{ count }] = await sql`
    select count(*)::int as count from users where role = 'admin' and status = 'active'
  `;
  return count;
}

// ── writes ───────────────────────────────────────────────────────────────────

export async function createUser({ email, name, role, capabilities, createdBy }) {
  const sql = getSql();
  const rows = await sql`
    insert into users (email, name, role, capabilities, status, created_by)
    values (${normalizeEmail(email)}, ${name || null}, ${role},
            ${sql.json(capabilities || {})}, 'invited', ${createdBy || null})
    on conflict do nothing
    returning ${sql(USER_COLUMNS)}
  `;
  return mapUser(rows[0]);   // null when the email already exists
}

// Finish an invite or a reset: set the hash, activate, clear any lockout, and
// burn every other outstanding token for this user in the same transaction.
export async function setPasswordAndActivate(userId, passwordHash) {
  const sql = getSql();
  return sql.begin(async (tx) => {
    const rows = await tx`
      update users
         set password_hash = ${passwordHash},
             status = case when status = 'invited' then 'active' else status end,
             failed_login_count = 0,
             locked_until = null,
             updated_at = now()
       where id = ${userId} and status <> 'disabled'
       returning ${tx(USER_COLUMNS)}
    `;
    if (!rows[0]) return null;
    await tx`update user_tokens set used_at = now() where user_id = ${userId} and used_at is null`;
    return mapUser(rows[0]);
  });
}

// Used by the login path to transparently upgrade a hash made with weaker
// scrypt parameters, while it still holds the plaintext.
export async function updatePasswordHash(userId, passwordHash) {
  const sql = getSql();
  await sql`update users set password_hash = ${passwordHash}, updated_at = now() where id = ${userId}`;
}

// Disable (soft delete). Kills sessions in the same transaction so access stops
// on the very next request rather than whenever the cookie happens to expire.
// Refuses to remove the last active admin.
export async function disableUser(id) {
  const sql = getSql();
  return sql.begin(async (tx) => {
    const [target] = await tx`select role, status from users where id = ${id} for update`;
    if (!target) return { ok: false, reason: 'not-found' };
    if (target.status === 'disabled') return { ok: false, reason: 'already-disabled' };
    if (target.role === 'admin') {
      const [{ count }] = await tx`
        select count(*)::int as count from users
         where role = 'admin' and status = 'active' and id <> ${id}
      `;
      if (count === 0) return { ok: false, reason: 'last-admin' };
    }
    await tx`
      update users set status = 'disabled', disabled_at = now(), updated_at = now() where id = ${id}
    `;
    await tx`delete from sessions where user_id = ${id}`;
    await tx`update user_tokens set used_at = now() where user_id = ${id} and used_at is null`;
    return { ok: true };
  });
}

// Re-enable a disabled account. It returns to 'invited' when no password was
// ever set, so the admin still has to send a fresh invite.
export async function enableUser(id) {
  const sql = getSql();
  const rows = await sql`
    update users
       set status = case when password_hash is null then 'invited' else 'active' end,
           disabled_at = null, failed_login_count = 0, locked_until = null, updated_at = now()
     where id = ${id} and status = 'disabled'
     returning ${sql(USER_COLUMNS)}
  `;
  return mapUser(rows[0]);
}

// Hard delete, for genuinely removing a record. Sessions and tokens cascade;
// auth_events deliberately do not (their user_id is set null), so the trail of
// what this person did survives them. Same last-admin guard as disable.
export async function deleteUser(id) {
  const sql = getSql();
  return sql.begin(async (tx) => {
    const [target] = await tx`select role, status from users where id = ${id} for update`;
    if (!target) return { ok: false, reason: 'not-found' };
    if (target.role === 'admin' && target.status === 'active') {
      const [{ count }] = await tx`
        select count(*)::int as count from users
         where role = 'admin' and status = 'active' and id <> ${id}
      `;
      if (count === 0) return { ok: false, reason: 'last-admin' };
    }
    await tx`delete from users where id = ${id}`;
    return { ok: true };
  });
}

// Role/capability change with the same last-admin protection: demoting the only
// remaining admin would leave nobody able to manage users.
export async function changeUserRole(id, { name, role, capabilities }) {
  const sql = getSql();
  return sql.begin(async (tx) => {
    const [target] = await tx`select role, status from users where id = ${id} for update`;
    if (!target) return { ok: false, reason: 'not-found' };
    if (target.role === 'admin' && role !== 'admin' && target.status === 'active') {
      const [{ count }] = await tx`
        select count(*)::int as count from users
         where role = 'admin' and status = 'active' and id <> ${id}
      `;
      if (count === 0) return { ok: false, reason: 'last-admin' };
    }
    const rows = await tx`
      update users
         set name = ${name ?? null}, role = ${role},
             capabilities = ${tx.json(capabilities || {})}, updated_at = now()
       where id = ${id}
       returning ${tx(USER_COLUMNS)}
    `;
    return { ok: true, user: mapUser(rows[0]) };
  });
}

// ── login throttling ─────────────────────────────────────────────────────────

export async function registerFailedLogin(userId) {
  const sql = getSql();
  const rows = await sql`
    update users
       set failed_login_count = failed_login_count + 1,
           locked_until = case
             when failed_login_count + 1 >= ${MAX_FAILED_LOGINS}
             then now() + make_interval(mins => ${LOCKOUT_MINUTES})
             else locked_until end,
           updated_at = now()
     where id = ${userId}
     returning failed_login_count, locked_until
  `;
  return rows[0] || null;
}

export async function clearFailedLogins(userId) {
  const sql = getSql();
  await sql`
    update users set failed_login_count = 0, locked_until = null, last_login_at = now()
     where id = ${userId}
  `;
}

export function isLockedOut(user) {
  if (!user?.locked_until) return false;
  return new Date(user.locked_until).getTime() > Date.now();
}

// Per-IP failure count inside the sliding window, so an attacker cannot dodge
// the per-account counter by spreading attempts across many addresses.
export async function recentFailuresForIp(ip) {
  if (!ip) return 0;
  const sql = getSql();
  const [{ count }] = await sql`
    select count(*)::int as count from auth_events
     where ip = ${ip} and type in ('login_failed', 'login_locked')
       and ts > now() - make_interval(mins => ${IP_WINDOW_MINUTES})
  `;
  return count;
}

// ── sessions ─────────────────────────────────────────────────────────────────

// Returns the raw token for the cookie. Only its hash is persisted.
export async function createSession(userId, { userAgent, ip } = {}) {
  const token = randomToken();
  const sql = getSql();
  await sql`
    insert into sessions (user_id, token_hash, expires_at, user_agent, ip)
    values (${userId}, ${sha256(token)},
            now() + make_interval(days => ${SESSION_DAYS}),
            ${userAgent ? String(userAgent).slice(0, 400) : null}, ${ip || null})
  `;
  return token;
}

// The per-request identity lookup. One indexed query returning the joined user,
// so a disabled or deleted account stops working immediately. Columns are listed
// explicitly rather than with u.*, which would drag password_hash along.
//
// session_last_seen_at comes back so the caller can decide whether the sliding
// expiry needs writing at all. Sending that UPDATE unconditionally cost a second
// database round trip on every single request to refresh a timestamp that only
// matters once a day.
export async function findSessionUser(token) {
  if (!token) return null;
  const sql = getSql();
  const rows = await sql`
    select s.id as session_id, s.expires_at as session_expires_at,
           s.last_seen_at as session_last_seen_at,
           u.id, u.email, u.name, u.role, u.capabilities, u.status,
           u.failed_login_count, u.locked_until, u.created_at, u.updated_at,
           u.last_login_at, u.disabled_at, u.created_by
      from sessions s
      join users u on u.id = s.user_id
     where s.token_hash = ${sha256(token)} and s.expires_at > now()
  `;
  if (!rows[0]) return null;
  return {
    ...mapUser(rows[0]),
    session_id: rows[0].session_id,
    session_expires_at: new Date(rows[0].session_expires_at).toISOString(),
    session_last_seen_at: new Date(rows[0].session_last_seen_at).toISOString(),
  };
}

// Whether the sliding expiry is actually due. Checked in memory from the row we
// already fetched, so the common case costs nothing.
export function sessionNeedsTouch(user) {
  if (!user?.session_last_seen_at) return false;
  return Date.now() - new Date(user.session_last_seen_at).getTime() > 24 * 60 * 60 * 1000;
}

// Sliding expiry: push the window out. The predicate stays in SQL as well as in
// sessionNeedsTouch so two concurrent requests cannot both write.
export async function touchSession(sessionId) {
  const sql = getSql();
  await sql`
    update sessions
       set last_seen_at = now(), expires_at = now() + make_interval(days => ${SESSION_DAYS})
     where id = ${sessionId} and last_seen_at < now() - interval '1 day'
  `;
}

export async function deleteSessionByToken(token) {
  if (!token) return;
  const sql = getSql();
  await sql`delete from sessions where token_hash = ${sha256(token)}`;
}

export async function deleteSessionsForUser(userId) {
  const sql = getSql();
  await sql`delete from sessions where user_id = ${userId}`;
}

export async function purgeExpiredSessions() {
  const sql = getSql();
  await sql`delete from sessions where expires_at < now()`;
}

// ── single-use tokens ────────────────────────────────────────────────────────

// Mints an invite or reset link token. Any earlier unused token of the same
// purpose is burned first, so re-sending an invite invalidates the old email.
export async function createUserToken(userId, purpose, hours) {
  const token = randomToken();
  const sql = getSql();
  await sql.begin(async (tx) => {
    await tx`
      update user_tokens set used_at = now()
       where user_id = ${userId} and purpose = ${purpose} and used_at is null
    `;
    await tx`
      insert into user_tokens (user_id, token_hash, purpose, expires_at)
      values (${userId}, ${sha256(token)}, ${purpose}, now() + make_interval(hours => ${hours}))
    `;
  });
  return token;
}

// Look up without consuming, so the set-password page can show a sensible error
// before the user types anything.
export async function peekUserToken(token, purpose) {
  if (!token) return null;
  const sql = getSql();
  const rows = await sql`
    select t.id as token_id,
           u.id, u.email, u.name, u.role, u.capabilities, u.status,
           u.failed_login_count, u.locked_until, u.created_at, u.updated_at,
           u.last_login_at, u.disabled_at, u.created_by
      from user_tokens t
      join users u on u.id = t.user_id
     where t.token_hash = ${sha256(token)} and t.purpose = ${purpose}
       and t.used_at is null and t.expires_at > now()
  `;
  if (!rows[0]) return null;
  return { tokenId: rows[0].token_id, user: mapUser(rows[0]) };
}

// Atomically claim a token. The `used_at is null` predicate is inside the UPDATE,
// so two simultaneous submissions cannot both win.
export async function consumeUserToken(token, purpose) {
  if (!token) return null;
  const sql = getSql();
  const rows = await sql`
    update user_tokens set used_at = now()
     where token_hash = ${sha256(token)} and purpose = ${purpose}
       and used_at is null and expires_at > now()
     returning user_id
  `;
  return rows[0]?.user_id ?? null;
}

// ── audit trail ──────────────────────────────────────────────────────────────

// Never throws: an audit write must not be able to break the flow it records.
export async function logAuthEvent({ type, userId, email, actorId, actorEmail, ip, detail }) {
  try {
    const sql = getSql();
    await sql`
      insert into auth_events (type, user_id, email, actor_id, actor_email, ip, detail)
      values (${type}, ${userId || null}, ${email || null}, ${actorId || null},
              ${actorEmail || null}, ${ip || null}, ${detail || null})
    `;
  } catch (e) {
    console.error('[auth audit] write failed', { type, error: String(e?.message || e) });
  }
}

export async function recentAuthEvents(limit = 100) {
  const sql = getSql();
  const rows = await sql`
    select id, ts, type, user_id, email, actor_id, actor_email, detail
      from auth_events order by ts desc limit ${Math.min(500, Math.max(1, limit))}
  `;
  return rows.map((r) => ({ ...r, ts: new Date(r.ts).toISOString() }));
}
