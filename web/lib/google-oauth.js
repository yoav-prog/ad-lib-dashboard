// "Continue with Google", built directly on Google's OAuth 2.0 / OpenID Connect
// endpoints. No new dependency: the flow is three HTTP interactions and a set of
// claim checks, and an auth library would want to own session management, which
// this app deliberately keeps in the database (see lib/auth.js).
//
// The shape is the standard server-side authorization-code flow, with PKCE:
//
//   1. /api/auth/google/start    mints state + nonce + a PKCE verifier, puts
//                                them in a short-lived httpOnly cookie, and
//                                sends the browser to Google
//   2. Google                    authenticates the person and redirects back
//                                with ?code and ?state
//   3. /api/auth/google/callback matches state against the cookie, swaps the
//                                code for an ID token over a direct HTTPS call,
//                                and checks the claims below
//
// The ID token's signature is not verified against Google's JWKS, and does not
// need to be: it arrives on our own back-channel request to Google's token
// endpoint over TLS, never through the browser. Google's guidance is explicit
// that a token obtained this way can be trusted without local validation. Every
// claim we actually rely on is still checked, because "trusted sender" is not
// the same as "says what we assume it says".
//
// This module holds no session logic and touches no database. It answers one
// question: which verified Google identity, if any, is this callback carrying.
import crypto from 'node:crypto';
import { appUrl, appUrlConfigured } from './mailer.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// Google may issue either form of the issuer claim; both are documented.
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// Tolerance on exp, for ordinary clock drift between Google and the runtime.
const CLOCK_SKEW_SECONDS = 60;

// The transaction cookie has to survive a person taking their time on Google's
// account chooser, without staying replayable for long afterwards.
export const OAUTH_TRANSACTION_MINUTES = 10;

const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

// ── configuration ────────────────────────────────────────────────────────────
// Fails closed, like every other gate in this app: anything missing means the
// button does not render and the routes refuse, rather than a half-wired flow
// that fails somewhere less obvious.

export function googleMissing() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  // The redirect URI is derived from APP_URL and has to match what is registered
  // in the Google Cloud console, so an unset APP_URL is a misconfiguration here
  // just as much as it is for invite links.
  if (!appUrlConfigured()) missing.push('APP_URL');
  // The domain lock is what makes this safe to expose at all.
  if (!String(process.env.ALLOWED_EMAIL_DOMAIN || '').trim()) missing.push('ALLOWED_EMAIL_DOMAIN');
  return missing;
}

export function googleConfigured() {
  return googleMissing().length === 0;
}

export function clientId() {
  return String(process.env.GOOGLE_CLIENT_ID || '').trim();
}

// Registered verbatim in the Google Cloud console under "Authorized redirect
// URIs". Google compares it byte for byte, so it is built from APP_URL rather
// than from the incoming request, which an attacker could influence.
export function redirectUri() {
  return `${appUrl()}/api/auth/google/callback`;
}

// ── the outbound half ────────────────────────────────────────────────────────

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// One sign-in attempt's worth of one-time secrets.
//   state     ties the callback to the browser that started it (CSRF)
//   nonce     ties the returned ID token to this attempt (replay)
//   verifier  PKCE; the code is useless to anyone who intercepts it without this
export function newTransaction() {
  const verifier = b64url(crypto.randomBytes(32));
  return {
    state: b64url(crypto.randomBytes(32)),
    nonce: b64url(crypto.randomBytes(32)),
    verifier,
    challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
  };
}

export function authorizeUrl({ state, nonce, challenge }) {
  const domain = String(process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase();
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Skips the "choose an account" step for people with several Google
    // accounts signed in. A hint to Google's UI only, never a security control:
    // the hd *claim* is checked on the way back, which is what actually counts.
    hd: domain,
    // Sign-in only. No refresh token, nothing to store, nothing to leak: the ID
    // token is used once to establish who this is and then discarded.
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

// Constant-time comparison for the state parameter, which is attacker-supplied.
export function statesMatch(fromGoogle, fromCookie) {
  const a = Buffer.from(String(fromGoogle ?? ''));
  const b = Buffer.from(String(fromCookie ?? ''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── the inbound half ─────────────────────────────────────────────────────────

// Swap the one-time code for tokens. Server to server, so the client secret and
// the resulting ID token never touch the browser.
export async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: String(process.env.GOOGLE_CLIENT_SECRET || ''),
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    // A wedged call here would otherwise hang the sign-in until the platform
    // kills the function.
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    // Google returns { error, error_description }. The description is safe to
    // log (it describes our configuration, not the person) but never surfaces
    // to the browser.
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      if (err?.error) detail = `${err.error}: ${err.error_description || ''}`.trim();
    } catch { /* keep the status-only detail */ }
    throw new Error(`Google token exchange failed (${detail})`);
  }

  const json = await res.json();
  if (!json?.id_token) throw new Error('Google token exchange returned no id_token');
  return json.id_token;
}

// Read a JWT's payload without verifying its signature. Safe only because of
// where this token came from (see the file header). Written defensively anyway:
// malformed input returns null rather than throwing into the request.
export function decodeIdToken(jwt) {
  const parts = String(jwt ?? '').split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  // A Google ID token payload is a few hundred bytes. Anything near this bound
  // is not one, and is not worth parsing.
  if (parts[1].length > 8192) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
    return claims;
  } catch {
    return null;
  }
}

// Every check that stands between a stranger and a session, in one pure
// function so the whole set can be unit-tested without a network or a database.
//
// Returns { ok: true, email, sub, name }, or { ok: false, kind, reason }. The
// reason is for our logs; the kind picks which of three things to tell the
// person, and is a field rather than a parsed string so the caller never has to
// pattern-match on prose:
//
//   'config'  this deployment is wired up wrong
//   'domain'  a real Google account, but not one allowed to sign in here
//   'token'   the token itself did not hold up; retry, and if it persists, look
export function validateIdTokenClaims(claims, { nonce, expectedClientId, domain, now = Date.now() }) {
  const bad = (kind, reason) => ({ ok: false, kind, reason });

  if (!claims || typeof claims !== 'object') return bad('token', 'no claims');

  const expectedDomain = String(domain || '').trim().toLowerCase();
  if (!expectedDomain) return bad('config', 'ALLOWED_EMAIL_DOMAIN not set');
  if (!expectedClientId) return bad('config', 'GOOGLE_CLIENT_ID not set');

  if (!ISSUERS.includes(claims.iss)) return bad('token', `bad iss: ${String(claims.iss).slice(0, 64)}`);

  // aud must be exactly our client. Google sends a string here; an array would
  // mean a token minted for someone else's app too.
  if (typeof claims.aud !== 'string' || claims.aud !== expectedClientId) {
    return bad('token', 'aud does not match this client');
  }

  const exp = Number(claims.exp);
  if (!Number.isFinite(exp)) return bad('token', 'no exp');
  if (exp * 1000 + CLOCK_SKEW_SECONDS * 1000 < now) return bad('token', 'expired');

  // Binds this token to the redirect we started. Without it, a token captured
  // from another sign-in of the same person could be replayed here.
  if (!nonce || claims.nonce !== nonce) return bad('token', 'nonce mismatch');

  const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!sub) return bad('token', 'no sub');

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) return bad('token', 'no email');

  // Google sends this as a real boolean, but tolerate the string form rather
  // than treating it as verified by accident.
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!verified) return bad('domain', 'email not verified');

  // The Workspace domain claim. Present only for accounts managed by a Google
  // Workspace organisation, which is exactly the population allowed here: a
  // consumer Google account that happens to hold a company address would not
  // carry it, and must not get in.
  const hd = typeof claims.hd === 'string' ? claims.hd.trim().toLowerCase() : '';
  if (hd !== expectedDomain) {
    return bad('domain', hd ? `hd=${hd.slice(0, 64)}` : 'no hd (not a Workspace account)');
  }

  // And the address itself, independently of hd. Exactly one @, and everything
  // after it equal to the configured domain; a substring test would accept
  // "evil-aporianetworks.com".
  const at = email.indexOf('@');
  if (at < 1 || email.indexOf('@', at + 1) !== -1 || email.slice(at + 1) !== expectedDomain) {
    return bad('domain', 'email outside the allowed domain');
  }

  const name = typeof claims.name === 'string' ? claims.name.trim().slice(0, 120) : '';
  return { ok: true, email, sub, name: name || null };
}
