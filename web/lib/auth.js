// Server-only session helpers. Role-based passcode gate:
//   DASHBOARD_PASSCODE          -> admin (full read/write)
//   DASHBOARD_VIEWER_PASSCODE   -> viewer (read-only), optional
// The session cookie stores `${role}.${hmac(role)}`, unforgeable without SESSION_SECRET.
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const ROLES = ['admin', 'viewer'];
export const SESSION_COOKIE = 'adintel_session';

function sign(role) {
  return crypto.createHmac('sha256', SECRET).update(`adintel-session-v2:${role}`).digest('hex');
}

export function makeToken(role) {
  return `${role}.${sign(role)}`;
}

// Which role a passcode grants (admin wins if both were somehow equal).
export function roleForPasscode(passcode) {
  if (!passcode) return null;
  const admin = process.env.DASHBOARD_PASSCODE;
  const viewer = process.env.DASHBOARD_VIEWER_PASSCODE;
  if (admin && passcode === admin) return 'admin';
  if (viewer && passcode === viewer) return 'viewer';
  return null;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [role, sig] = token.split('.', 2);
  if (!ROLES.includes(role) || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(role));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return role;
}

export async function getRole() {
  const jar = await cookies();
  return verify(jar.get(SESSION_COOKIE)?.value);
}

// Any valid session. Returns the role. Redirects to /login if unauthenticated.
export async function requireAuth() {
  const role = await getRole();
  if (!role) redirect('/login');
  return role;
}

// Mutation guard. Throws for viewers / unauthenticated (server actions surface this).
export async function requireAdmin() {
  const role = await getRole();
  if (role !== 'admin') throw new Error('Forbidden: admin access required');
  return role;
}
