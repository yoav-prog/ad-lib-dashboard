# Sign in with Google

Date: 2026-07-27
Branch: `lazy-load-secondary-tabs`
Status: built, pending migration + Google Cloud console setup

## Goal

Add "Continue with Google" to the dashboard sign-in, so people at the company can
get in with one click instead of remembering a password.

## Decisions

Two questions shaped the work. Both were answered before any code was written.

**Provisioning: invite-only.** Google proves identity; it does not grant access.
An address with no row in `users` is refused, and no account is ever created
automatically. The alternative (auto-provision anyone at `ALLOWED_EMAIL_DOMAIN`
as a viewer) was rejected: it would silently widen access to everyone Workspace
adds later, and the dashboard holds competitor intelligence.

**Passwords stay.** The Google button sits above the existing email and password
form, not in place of it. A misconfigured OAuth client, an expired secret, or a
Google outage must not be able to lock the team out, and the only alternative
route in today is a 30-minute break-glass cookie that deliberately cannot reach
the ad data.

## Approach

Hand-rolled OAuth 2.0 authorization code flow with PKCE, against Google's
endpoints directly. No new npm dependency.

The alternative was Auth.js / NextAuth. Rejected because it wants to own session
management, and this app's sessions are deliberately database-backed rows rather
than self-contained cookies, so that removing someone takes effect on their next
request instead of whenever their cookie happens to expire. Bridging Auth.js back
to that would have been more code than the flow itself, and more places to get it
wrong. Supabase Auth was rejected for the same reason plus a second identity
store.

Flow:

1. `/api/auth/google/start` mints `state`, `nonce`, and a PKCE verifier, stores
   them in an httpOnly cookie scoped to `/api/auth/google`, and redirects to
   Google.
2. Google authenticates and redirects back with `?code` and `?state`.
3. `/api/auth/google/callback` matches state, swaps the code for an ID token on a
   direct server-to-server HTTPS call, checks the claims, resolves the account,
   and issues an ordinary session through the existing `createSession`.

The ID token's signature is not checked against Google's JWKS, and does not need
to be: it never passes through the browser. Google's OpenID Connect
documentation states that a token fetched directly from the token endpoint over
an intermediary-free HTTPS channel can be trusted without local validation. Every
claim actually relied on is still checked.

## Security

Checked on every callback, in `validateIdTokenClaims`:

- `iss` is Google, `aud` is exactly our client ID (an array is refused, not
  searched)
- `exp` in the future, with 60 seconds of clock skew
- `nonce` matches the transaction that started this sign-in (replay)
- `email_verified` is true
- `hd` equals `ALLOWED_EMAIL_DOMAIN`, so the account must be managed by the
  Workspace organisation; a consumer account holding a company address is refused
- the address itself is in the domain, parsed rather than substring-matched, so
  `evil-aporianetworks.com` cannot pass

Around it:

- `state` compared in constant time, CSRF
- PKCE S256, so an intercepted code is useless without the verifier
- the transaction cookie is single-use, 10 minutes, `SameSite=Lax`, path-scoped
  to the two OAuth routes
- the same per-IP throttle the password path uses, checked before any network or
  database work; a cancelled sign-in does not spend throttle budget
- every refusal writes an `auth_events` row with the real reason; the browser only
  ever sees a short code mapped to a sentence
- fails closed: any missing variable means the button does not render and the
  routes refuse

`users.google_sub` records Google's stable subject on first use. If an address is
later reissued to a different person in Workspace, the mismatch is refused rather
than inheriting the old account's role. Recovery is the **UNLINK** action on the
`/admin` row, which also drops that account's sessions.

## Cost

Nothing. This uses Google's plain OAuth 2.0 / OpenID Connect endpoints, which
carry no per-user or per-request charge. Google Cloud Identity Platform is the
paid product with a similar name and is not involved.

## Files

New:

- `supabase/migrations/0011_google_identity.sql`
- `web/lib/google-oauth.js`
- `web/app/api/auth/google/start/route.js`
- `web/app/api/auth/google/callback/route.js`
- `web/components/LoginForm.jsx` (the client half split out of the login page)
- `web/tests/google-oauth.test.mjs` (27 tests, weighted to the refusals)

Changed:

- `web/lib/users.js` - `google_sub` / `google_linked_at` columns,
  `linkGoogleAccount`, `unlinkGoogleAccount`
- `web/lib/auth.js` - OAuth transaction cookie helpers
- `web/app/login/page.js` - now a server component: Google button, error copy
- `web/app/invite/[token]/page.js` - Google finishes an invite
- `web/components/AuthShell.jsx` - shared `GoogleButton` and `AuthDivider`
- `web/app/admin/actions.js`, `web/components/AdminView.jsx` - GOOGLE chip,
  UNLINK action, two new activity-log labels
- `web/lib/mailer.js` and its four callers - the invite email describes both ways
  in, when Google is on
- `.env.example`, `SETUP.md`

## Activation (config, not code)

1. Apply `supabase/migrations/0011_google_identity.sql` to prod **before**
   deploying: `USER_COLUMNS` selects `google_sub`, so an un-migrated database
   breaks `/admin` and the session lookup.
2. Google Cloud console: OAuth consent screen set to **Internal**, then an OAuth
   client ID of type Web application, with redirect URIs
   `https://<APP_URL>/api/auth/google/callback` and the localhost equivalent.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Vercel and `.env.local`.

Until step 3 the button does not appear and nothing else changes.

## Open questions

- Whether to eventually let an admin require Google for a given person (drop
  their password). Not built: no one has asked, and it removes a fallback.
