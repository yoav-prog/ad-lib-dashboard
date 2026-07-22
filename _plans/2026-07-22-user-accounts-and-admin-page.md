# User accounts, invites, and an /admin page

Date: 2026-07-22
Area: web dashboard (auth), Supabase schema, transactional email
Status: approved, not yet implemented
Replaces: the shared-passcode gate in `web/lib/auth.js`

---

## Goal

Retire the two shared passcodes (`DASHBOARD_PASSCODE`, `DASHBOARD_VIEWER_PASSCODE`)
and replace them with real user accounts. An admin manages people from a dedicated
`/admin` page: invite a user, remove a user, and grant or revoke specific
permissions per person.

Success looks like: nobody shares a secret in Slack any more, every action in the
dashboard is attributable to a person, and taking someone's access away actually
takes it away, immediately.

## Decisions taken (2026-07-22)

| Question | Decision |
|---|---|
| How users log in | Password, set through an emailed invite link |
| Permission granularity | Three roles as defaults, plus per-user capability overrides |
| Email domain restriction | Hard lock to `ALLOWED_EMAIL_DOMAIN`, no exceptions |

## Constraints

- Deploy target is Vercel (see the comment in `web/next.config.mjs`). Serverless,
  so no in-process state survives between requests. Anything stateful (rate limit
  counters, sessions) has to live in Postgres.
- The app talks to Postgres directly through the `postgres` npm client and the
  Supabase transaction pooler. It does not use `supabase-js`. That stays true.
- Scale is roughly 5 to 15 internal users. Every design call below optimises for
  correctness and small surface area over throughput.
- Team size means email volume is a handful of messages per person per year.
- No new paid service. See Cost.

## What was verified before writing this

Per the "verify, do not guess" rule, these were checked rather than assumed:

- **The new env vars are not referenced anywhere.** Grepped the whole repo for
  `SMTP_*`, `EMAIL_FROM`, `ADMIN_EMAIL`, `ALLOWED_EMAIL_DOMAIN`: zero hits outside
  `.env.local`. No mail library is in `web/package.json`. No users table exists in
  any of the 8 migrations. The vars are intent, not a partial build.
- **`.env.local` is not tracked by git.** `git check-ignore -v` resolves it to the
  `.env.*` rule and `git ls-files` lists only `.env.example`.
- **Vercel does not block outbound SMTP except port 25.** Confirmed from Vercel's
  own knowledge base, not a blog post. Port 465 is fine.
- **The configured Gmail credentials actually authenticate.** Ran a direct TLS
  probe against `smtp.gmail.com:465` doing `AUTH LOGIN`; the server returned
  `235 2.7.0 Accepted`. This matters because several 2026 sources claim Google
  Workspace accounts lost app-password SMTP in May 2025. For this account they
  did not. Worth re-testing if login mail ever stops arriving.
- **scrypt cost at OWASP parameters.** Benchmarked locally on Node v24: both
  `N=2^17,r=8,p=1` and `N=2^16,r=8,p=2` take about 210 ms. Expect roughly 2x that
  on Vercel's slower cores, which is acceptable for a login.
- **OWASP Password Storage Cheat Sheet, current text.** Argon2id preferred;
  scrypt acceptable at `N=2^17,r=8,p=1` minimum, with `N=2^16,r=8,p=2` listed as
  an equivalent alternative.

## Env vars

### Already present and correct

`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `ADMIN_EMAIL`,
`ALLOWED_EMAIL_DOMAIN`, `SESSION_SECRET`.

### Must be added before this ships

- `APP_URL` (mandatory). Invite and reset emails need an absolute link. Vercel's
  auto-injected URL vars are per-deployment, so relying on them points invite
  links at preview builds. Set this to the stable production domain.
- `BREAK_GLASS_PASSCODE` (recommended). See Break-glass access below.

### Removed by this work

`DASHBOARD_PASSCODE`, `DASHBOARD_VIEWER_PASSCODE`.

## Chosen approach

### Schema: migration `0009_users_and_sessions.sql`

Four tables, all with RLS consistent with the existing migrations.

**`users`**: `id`, `email`, `name`, `role` (check: admin / editor / viewer),
`capabilities` jsonb (sparse overrides only), `password_hash`, `status`
(check: invited / active / disabled), `failed_login_count`, `locked_until`,
`created_at`, `updated_at`, `last_login_at`, `created_by`.

Uniqueness is a unique index on `lower(email)` rather than the `citext` type, so
no new Postgres extension is needed. Emails are normalised to lowercase in the app.

**`user_tokens`**: single-use invite and reset tokens. Stores `token_hash`
(sha256 of the raw token) and never the raw value, so a database leak does not
hand over live invite links. Has `purpose`, `expires_at`, `used_at`.

**`sessions`**: `id`, `user_id`, `token_hash`, `created_at`, `expires_at`,
`last_seen_at`, `user_agent`, `ip`.

**`login_attempts`**: IP-keyed counters for throttling, since serverless cannot
hold a rate limiter in memory.

### Why sessions live in the database

The current cookie is a self-contained `role.hmac(role)`, which means the server
never consults storage to decide who you are. That is fast, and it is also why
"remove a user" would be a lie: a stateless cookie stays valid until it expires,
so a removed person keeps full access for up to 30 days.

Removing access instantly is an explicit requirement here, so sessions become
database rows. The cookie carries an opaque 32-byte random token; the server
stores only its sha256. Disabling or deleting a user deletes their session rows
and the next request logs them out.

The cost is one indexed lookup per request. Every page render already issues
several queries, so this is noise. Calls are wrapped in React's `cache()` so
repeated `getSession()` calls inside one render hit the database once.

### Password hashing

`node:crypto` scrypt at `N=2^16, r=8, p=2` (64 MiB, an OWASP-listed
configuration), with `maxmem` raised explicitly because Node's 32 MiB default
would otherwise throw.

Chosen over Argon2id purely to avoid a native dependency on serverless. Argon2id
is the stronger algorithm and OWASP's first choice, but `@node-rs/argon2` is a
platform-specific binary and a deployment failure there breaks login for
everybody. scrypt ships in Node, is memory-hard, and is explicitly OWASP
acceptable. That trade is worth it here.

Same measured cost as the `N=2^17` row but half the peak memory, which matters
more on a serverless function than the extra headroom does.

Hashes are stored as `scrypt$N$r$p$salt$hash` so parameters can be raised later,
with transparent rehash-on-successful-login when the stored parameters differ
from current.

### Roles and capabilities

Five capabilities, chosen because they map exactly onto the existing gates in
`web/app/actions.js` rather than inventing new concepts:

| Capability | Covers |
|---|---|
| `edit_ads` | Ad status, owner, notes, starring, bulk edits, deletes, review decisions |
| `manage_domains` | Tracked-domain and feed create / edit / delete |
| `run_scrapes` | Run now, run selected, stop, mark failed, read run logs |
| `export_data` | Google Sheets export, metrics refresh |
| `manage_users` | The `/admin` page itself |

Role defaults:

- **admin**: all five
- **editor**: `edit_ads`, `export_data`
- **viewer**: none

The `capabilities` jsonb holds only explicit overrides, so an editor who also
needs to kick off scrapes gets `{"run_scrapes": true}` and nothing else. Effective
capability is the role default with any override applied on top. That resolution
lives in a pure function in `web/lib/capabilities.js` with unit tests, because
getting it wrong is a security bug and it is trivially testable.

`requireAdmin()` at its 20 call sites becomes `requireCapability('edit_ads')` and
friends. The single `canEdit` boolean threaded through the UI becomes a
capabilities object.

### Flows

**Invite.** Admin fills in email, name, role, and any overrides at `/admin`. The
server rejects any address outside `ALLOWED_EMAIL_DOMAIN`, creates the user as
`invited` with a null password hash, mints a 32-byte token valid 72 hours, and
emails `${APP_URL}/invite/<token>`. The user picks a password (minimum 12
characters, rejected against a small list of obvious ones), which activates the
account.

**Login.** Email plus password at `/login`. On an unknown email the server still
runs a dummy scrypt comparison so response timing does not reveal who has an
account. Lockout after 10 failures within 15 minutes, per user and per IP.

**Forgot password.** Same token machinery, `purpose='reset'`, 1 hour expiry. The
response is identical whether or not the address exists. Admins can also force a
reset from `/admin`.

**Bootstrap.** A `/setup` route that works only while the users table is empty.
It emails an invite to `ADMIN_EMAIL` and nothing else, so it cannot be pointed at
an attacker-supplied address, and it stops working permanently once the first
admin exists.

### Guardrails on /admin

These prevent the obvious ways an admin locks everyone out or escalates:

- You cannot delete or disable your own account.
- You cannot demote yourself.
- The last remaining active admin cannot be removed, disabled, or demoted,
  enforced inside a transaction with a count check rather than a read-then-write.
- Only an admin can change roles or capabilities.
- Deleting or disabling a user deletes their sessions in the same transaction.

### Break-glass access

`BREAK_GLASS_PASSCODE` stays as a last resort for the case where the sole admin
forgets their password and SMTP is also down. It is deliberately weaker than what
it replaces: it grants a session that can reach `/admin` only, not the ad data, so
a leaked value cannot exfiltrate competitor intelligence. Every use is logged
loudly. It is optional; leave it unset and the feature is off.

This is a compromise. A permanent shared secret is exactly what this project is
removing, and keeping one is a real if small risk. The alternative is a genuine
lockout with no recovery path short of editing the database by hand.

## Alternatives rejected

**Magic links instead of passwords.** Less code, no hashing, no reset flow, and
nothing password-shaped to leak. Rejected because it makes every single login
depend on email delivery, so an SMTP outage locks out the whole team rather than
just blocking new invites. With passwords, email is only on the critical path for
onboarding and recovery.

**Supabase Auth.** Mature, and would bring MFA cheaply later. Rejected because the
dashboard does not use `supabase-js` at all; adopting it means adding
`@supabase/ssr`, a service-role key, and a second session model alongside the
direct-Postgres data layer. Permissions would still need their own table. That is
a large change to replace 58 lines.

**Roles with no per-user overrides.** Simplest option and close to a drop-in for
today's `canEdit` boolean. Rejected because it does not answer "this person may
review ads but must never trigger a scrape", which is the case that motivated
asking for permissions in the first place.

**Stateless signed session cookies.** One less query per request. Rejected for the
revocation reason above.

**Argon2id via `@node-rs/argon2`.** Stronger and OWASP's first pick. Rejected on
deployment risk; see Password hashing.

## Security

- **Sensitive data**: password hashes, session tokens, invite and reset tokens,
  user email addresses. Behind those, the competitor ad intelligence itself.
- **Attack surface**: `/login`, `/setup`, `/invite/<token>`, `/reset/<token>`, and
  `/forgot` are the only unauthenticated routes. Everything else requires a
  session.
- **Secrets**: all from env, none in source. Tokens are stored hashed, never raw.
- **Input validation at the boundary**: email normalised and domain-checked on
  invite, on acceptance, and again on login. Three independent checks, because a
  single check is a single bug away from being bypassed.
- **Fail closed**: if `ALLOWED_EMAIL_DOMAIN` is unset the app refuses all logins
  rather than allowing all of them. If `SESSION_SECRET` is unset it refuses to
  start rather than falling back to the current `'dev-insecure-secret-change-me'`
  default, which today silently makes every cookie forgeable.
- **Enumeration**: identical responses and comparable timing for unknown versus
  known addresses on both login and forgot-password.
- **Brute force**: per-user lockout plus per-IP throttling, both in Postgres.
- **Logging**: log user id, action, and outcome. Never log passwords, tokens,
  session values, or full email addresses at info level.
- **Cookies**: httpOnly, `secure` in production, `sameSite: lax`, path `/`.

### Pre-existing issue found while surveying, not caused by this work

`.env.local` currently holds a live GitHub PAT, the OpenAI key, the ScrapingBee
key, a GCS private key, and the Supabase database password in plaintext, and the
file's own header records that these were exposed in source once already. The
file is correctly gitignored today. Rotating those credentials is out of scope
here but is a larger risk than anything this plan addresses.

## Cost

No new paid service.

- `nodemailer`: free, MIT licensed.
- SMTP: uses the existing Google Workspace subscription. Volume is a few messages
  per user per year, far below any sending limit.
- Supabase: four small tables, negligible against the existing ad data.
- Vercel: unchanged.

Net new spend: $0.

## Files

**New**
- `supabase/migrations/0009_users_and_sessions.sql`
- `web/lib/capabilities.js` (pure resolution logic)
- `web/lib/password.js` (scrypt hash and verify)
- `web/lib/mailer.js` (nodemailer transport and templates)
- `web/lib/users.js` (user, session, and token queries)
- `web/app/admin/page.js`, `web/app/admin/actions.js`
- `web/components/AdminView.jsx`
- `web/app/invite/[token]/page.js`, `web/app/reset/[token]/page.js`
- `web/app/forgot/page.js`, `web/app/setup/page.js`
- `web/tests/capabilities.test.mjs`, `web/tests/password.test.mjs`

**Modified**
- `web/lib/auth.js` (session lookup, `requireCapability`)
- `web/app/actions.js` (20 gate call sites)
- `web/app/page.js`, `web/components/Dashboard.jsx`, `ControlRoom.jsx`,
  `ReviewView.jsx` (capabilities instead of `canEdit`)
- `web/app/login/page.js`, `web/app/api/login/route.js`, `web/app/api/logout/route.js`
- `web/app/api/run-status/route.js`, `web/app/api/run-logs/route.js`,
  `web/app/api/draft/route.js`
- `web/package.json` (add `nodemailer`)
- `.env.example`, `SETUP.md`

## Order of work

1. Migration `0009`, applied to Supabase first.
2. `capabilities.js` and `password.js` with tests. Pure, no I/O, verifiable alone.
3. `users.js`, `mailer.js`, rewritten `auth.js`.
4. Login, invite, reset, forgot, setup routes.
5. `/admin` page.
6. Swap the 20 gate call sites and thread capabilities through the UI.
7. Remove the passcode path, update `.env.example` and `SETUP.md`.
8. Full QA pass: golden path, edge cases, error paths, lockout scenarios.

The migration goes in before the app deploy. Between the two, the running app is
unaffected because it does not read the new tables.

## Deployment notes

- Everyone is signed out the moment this deploys. The old cookie format no longer
  verifies, so every open session lands on `/login`. Expected, worth announcing.
- `APP_URL` must be set in Vercel before the first invite is sent, or the links in
  those emails will be wrong.
- Visit `/setup` once after deploying to bootstrap the first admin.

## Resolved during implementation

1. **Session lifetime**: 30 days, sliding. The expiry only rewrites once a day so
   a busy tab does not write on every request.
2. **Removing someone**: soft delete. `status='disabled'` keeps the row and the
   history and kills their sessions immediately. Hard delete stays available as a
   separate explicit action, and the `auth_events` trail survives it.
3. **Editors on day one**: yes, so the editor role ships with real defaults
   (edit ads and export, no scrapes or domain changes) rather than as a stub.
4. **`SESSION_SECRET` scope**: sessions turned out not to need it once they became
   database-backed opaque tokens, so it is now required only alongside
   `BREAK_GLASS_PASSCODE`, which it signs. Missing either one turns emergency
   access off rather than throwing inside `/admin`.

## Verification performed

- Unit: 93 tests (`npm test`), 28 of them new, covering capability resolution and
  password hashing including every fail-closed path.
- Integration against the live database: 40 checks covering token single-use,
  session revocation, the last-admin guard in all three directions plus its
  re-arming, and audit rows surviving a hard delete.
- End to end over HTTP against a running server: 30 checks covering the invite
  link, sign-in, viewer containment, immediate revocation, sign-out, and password
  change invalidating other sessions.
- All test rows were removed afterwards; the four new tables are empty.

## Still unverified

A real invite email has not been sent. SMTP authentication was confirmed against
`smtp.gmail.com:465` with a live `AUTH LOGIN` probe (`235 2.7.0 Accepted`), and
Vercel does not block that port, but the first actual send will be the `/setup`
bootstrap. If it does not arrive, check `APP_URL` and the spam folder first.
