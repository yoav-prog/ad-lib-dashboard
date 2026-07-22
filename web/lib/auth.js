// Server-only session and permission policy.
//
// Identity is a database-backed session: the cookie holds an opaque 256-bit
// random token and the server looks up the matching row on each request. That
// costs one indexed query, and it buys immediate revocation, which a
// self-contained signed cookie cannot give: disabling someone has to take their
// access away now, not whenever their cookie happens to expire.
//
// Permissions resolve through lib/capabilities.js. This module only decides who
// you are and whether to let you past; the rules themselves are pure and tested.
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import crypto from 'node:crypto';
import { resolveCapabilities, CAPABILITY_KEYS } from './capabilities';
import { findSessionUser, touchSession, sessionNeedsTouch, deleteSessionByToken, normalizeEmail } from './users';

export const SESSION_COOKIE = 'adintel_session';
export const BREAK_GLASS_COOKIE = 'adintel_breakglass';

const SESSION_DAYS = 30;
const BREAK_GLASS_MINUTES = 30;

// ── environment policy ───────────────────────────────────────────────────────
// Both of these fail CLOSED. The old gate fell back to a hardcoded development
// secret when SESSION_SECRET was absent, which silently made every cookie
// forgeable by anyone who could read this repository. There is no fallback now.
//
// Sessions themselves no longer need this secret (they are opaque random tokens
// checked against the database), so it is required only by the break-glass
// cookie, which is stateless by design.

function sessionSecretOrNull() {
  const s = process.env.SESSION_SECRET;
  return s && s.length >= 32 ? s : null;
}

function sessionSecret() {
  const s = sessionSecretOrNull();
  if (!s) throw new Error('SESSION_SECRET is missing or too short (need 32+ chars)');
  return s;
}

// The company domain lock. Unset means nobody can sign in, rather than everybody:
// a deploy that forgets this variable should break loudly, not open the door.
export function emailDomainAllowed(email) {
  const domain = String(process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase();
  if (!domain) {
    console.error('[auth] ALLOWED_EMAIL_DOMAIN is not set; refusing all sign-ins');
    return false;
  }
  const addr = normalizeEmail(email);
  // Exactly one @, and the part after it must equal the configured domain.
  // Substring matching would accept "evil-aporianetworks.com" or an address
  // whose display part merely contains the domain.
  const at = addr.indexOf('@');
  if (at < 1 || addr.indexOf('@', at + 1) !== -1) return false;
  return addr.slice(at + 1) === domain;
}

export function allowedDomain() {
  return String(process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase() || null;
}

// ── request context ──────────────────────────────────────────────────────────

// Behind Vercel the socket address is a proxy, so the client IP comes from
// x-forwarded-for. Only the first hop is trusted, and only for throttling and
// audit, never for authorisation.
export async function clientIp() {
  const h = await headers();
  const fwd = h.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim().slice(0, 64);
  return h.get('x-real-ip')?.slice(0, 64) || null;
}

export async function userAgent() {
  const h = await headers();
  return h.get('user-agent') || null;
}

// ── who is this ──────────────────────────────────────────────────────────────

// Memoised for the lifetime of one request, so a page that calls this from the
// layout, the page, and three server actions still issues a single query.
export const getCurrentUser = cache(async () => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const user = await findSessionUser(token);
  if (!user) return null;

  // A session row can outlive the account's usefulness (disabled between
  // requests). resolveCapabilities already returns nothing for a non-active
  // user, but refusing the session outright is clearer and stops the redirect
  // loop of "authenticated but allowed to do nothing".
  if (user.status !== 'active') return null;

  // Sliding expiry, but only when it is actually due. Checked against the row we
  // already have, so on all but one request a day this costs no query at all.
  if (sessionNeedsTouch(user)) {
    touchSession(user.session_id).catch(() => { /* never block a read on this */ });
  }
  return user;
});

// Is there a session cookie at all? A string check, no database work, so a
// signed-out request can be turned away before anything expensive starts.
export async function hasSessionCookie() {
  const jar = await cookies();
  return Boolean(jar.get(SESSION_COOKIE)?.value);
}

// The current user's effective permissions, or all-false when signed out.
export const getCapabilities = cache(async () => {
  const user = await getCurrentUser();
  return resolveCapabilities(user);
});

// ── break-glass ──────────────────────────────────────────────────────────────
// A last resort for "the only admin forgot their password and email is down".
// Deliberately weaker than what it replaces: it is short-lived, it grants ONLY
// user management (never the ad data), and every use is logged. Unset the env
// var and the whole path is off.

// Needs both halves: the passcode to check against, and the secret that signs
// the resulting cookie. Missing either turns the whole path off rather than
// throwing somewhere deeper, so a half-configured deploy fails closed and /admin
// still renders for a normal admin.
export function breakGlassConfigured() {
  const v = process.env.BREAK_GLASS_PASSCODE;
  return Boolean(v && v.length >= 16 && sessionSecretOrNull());
}

export function checkBreakGlassPasscode(input) {
  if (!breakGlassConfigured()) return false;
  const expected = Buffer.from(process.env.BREAK_GLASS_PASSCODE);
  const got = Buffer.from(String(input ?? ''));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

function signBreakGlass(issuedAt) {
  return crypto.createHmac('sha256', sessionSecret())
    .update(`adintel-breakglass-v1:${issuedAt}`)
    .digest('hex');
}

export function makeBreakGlassToken() {
  const issuedAt = Date.now();
  return `${issuedAt}.${signBreakGlass(issuedAt)}`;
}

// Stateless on purpose: this path has to work when the users table is the very
// thing that is broken.
export const hasBreakGlass = cache(async () => {
  const jar = await cookies();
  const raw = jar.get(BREAK_GLASS_COOKIE)?.value;
  if (!raw || !breakGlassConfigured()) return false;
  const [issuedAt, sig] = raw.split('.', 2);
  if (!issuedAt || !sig) return false;
  const age = Date.now() - Number(issuedAt);
  if (!Number.isFinite(age) || age < 0 || age > BREAK_GLASS_MINUTES * 60 * 1000) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(signBreakGlass(issuedAt));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
});

// ── cookie helpers ───────────────────────────────────────────────────────────

const baseCookie = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
};

export async function setSessionCookie(token) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, { ...baseCookie, maxAge: 60 * 60 * 24 * SESSION_DAYS });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await deleteSessionByToken(token);
  jar.delete(SESSION_COOKIE);
}

export async function setBreakGlassCookie() {
  const jar = await cookies();
  jar.set(BREAK_GLASS_COOKIE, makeBreakGlassToken(), {
    ...baseCookie,
    maxAge: 60 * BREAK_GLASS_MINUTES,
    path: '/admin',   // never sent to the rest of the app
  });
}

export async function clearBreakGlassCookie() {
  const jar = await cookies();
  jar.delete({ name: BREAK_GLASS_COOKIE, path: '/admin' });
}

// ── gates ────────────────────────────────────────────────────────────────────

// Any signed-in, active user. Returns the user row. Redirects to /login otherwise.
export async function requireAuth() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

// The mutation guard. Server actions surface the thrown error; the UI hides the
// controls anyway, so reaching this means a stale tab or a crafted request.
export async function requireCapability(capability) {
  if (!CAPABILITY_KEYS.includes(capability)) {
    throw new Error(`Unknown capability: ${capability}`);
  }
  const user = await getCurrentUser();
  const caps = resolveCapabilities(user);
  if (!caps[capability]) {
    console.warn('[auth] denied', { capability, user: user?.id ?? 'anonymous' });
    throw new Error('Forbidden: you do not have permission to do that');
  }
  return user;
}

// /admin's own gate. Accepts a real admin session or an active break-glass
// cookie, and reports which, so the page can show a warning banner in the
// second case.
export async function requireUserAdmin() {
  const user = await getCurrentUser();
  if (resolveCapabilities(user).manage_users) return { user, viaBreakGlass: false };
  if (await hasBreakGlass()) return { user: null, viaBreakGlass: true };
  if (!user) redirect('/login');
  throw new Error('Forbidden: user management requires an admin account');
}
