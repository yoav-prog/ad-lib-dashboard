// Server-only session helpers. A shared passcode gate: on login we set an
// HTTP-only cookie whose value is an HMAC of a fixed marker keyed by
// SESSION_SECRET, so it cannot be forged without the secret.
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const MARK = 'adintel-session-v1';
export const SESSION_COOKIE = 'adintel_session';

export function makeToken() {
  return crypto.createHmac('sha256', SECRET).update(MARK).digest('hex');
}

export function checkToken(token) {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(makeToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function isAuthed() {
  const jar = await cookies();
  return checkToken(jar.get(SESSION_COOKIE)?.value);
}

// Redirects unauthenticated requests to the login screen.
export async function requireAuth() {
  if (!(await isAuthed())) redirect('/login');
}
