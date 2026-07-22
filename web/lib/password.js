// Password hashing for the dashboard's user accounts. Run with node:crypto's
// scrypt, so there is no native dependency to fail at deploy time on Vercel.
//
// Parameters are OWASP's listed scrypt configuration N=2^16, r=8, p=2 (64 MiB).
// That is the same measured cost as their N=2^17,r=8,p=1 row but half the peak
// memory, which matters more inside a serverless function than the extra
// headroom does. Node's default maxmem is 32 MiB and would reject these, so it
// is raised explicitly.
//
// Argon2id is OWASP's first choice and is stronger. It is not used here because
// the available bindings are platform-specific native binaries, and a binary
// that fails to load on Vercel locks every user out of the dashboard.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const PARAMS = { N: 2 ** 16, r: 8, p: 2 };
const KEY_LEN = 32;
const SALT_LEN = 16;
const MAXMEM = 192 * 1024 * 1024;   // headroom over the ~64 MiB these params need

// Stored as scrypt$N$r$p$salt$hash (both base64) so the work factor can be
// raised later without invalidating existing hashes: verify reads the params
// out of the stored string, and needsRehash spots the stale ones.
const PREFIX = 'scrypt';

export const MIN_PASSWORD_LENGTH = 12;

// Deliberately short. A long deny-list is security theatre next to a length
// floor, but these specific strings are what people actually type when told to
// pick a password for an internal tool.
const OBVIOUS = [
  'password', 'passw0rd', 'password1', '123456789', '1234567890',
  'qwertyuiop', 'letmein', 'welcome', 'admin', 'adintel', 'changeme',
  'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'sunshine',
];

// Returns null when acceptable, or a human-readable reason when not. The
// message is shown verbatim to the user, so it says what to do, not what failed.
export function validatePassword(pw, { email } = {}) {
  const s = typeof pw === 'string' ? pw : '';
  if (s.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (s.length > 200) {
    return 'That is too long. Keep it under 200 characters.';
  }
  const lower = s.toLowerCase();
  if (OBVIOUS.some((bad) => lower === bad || lower.startsWith(bad))) {
    return 'That password is too easy to guess. Pick something less common.';
  }
  if (/^(.)\1+$/.test(s)) {
    return 'That is a single repeated character. Pick something less predictable.';
  }
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 3 && lower.includes(local)) {
    return 'Do not use your email address in your password.';
  }
  return null;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const { N, r, p } = PARAMS;
  const key = await scrypt(norm(password), salt, KEY_LEN, { N, r, p, maxmem: MAXMEM });
  return [PREFIX, N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

// Constant-time compare against a stored hash. Returns false (never throws) for
// a malformed or missing stored value, so a half-written row cannot crash login.
export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const { N, r, p, salt, hash } = parsed;
  let key;
  try {
    key = await scrypt(norm(password), salt, hash.length, { N, r, p, maxmem: MAXMEM });
  } catch {
    return false;   // absurd stored params (a tampered row) must not throw
  }
  return key.length === hash.length && crypto.timingSafeEqual(key, hash);
}

// True when a stored hash was made with weaker parameters than we now use, so
// login can transparently upgrade it while it holds the plaintext.
export function needsRehash(stored) {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return parsed.N !== PARAMS.N || parsed.r !== PARAMS.r || parsed.p !== PARAMS.p;
}

// Burn a comparable amount of CPU when the email is unknown, so response timing
// does not reveal which addresses have accounts. Called by the login path on the
// no-such-user branch.
export async function fakeVerify() {
  const { N, r, p } = PARAMS;
  try {
    await scrypt('no-such-user', DUMMY_SALT, KEY_LEN, { N, r, p, maxmem: MAXMEM });
  } catch {
    // never surfaces; this exists only to spend time
  }
  return false;
}

const DUMMY_SALT = crypto.randomBytes(SALT_LEN);

// Unicode-normalise so a password typed on a different keyboard layout or OS
// still matches the one that was set (NFKC folds compatibility variants).
function norm(password) {
  return String(password ?? '').normalize('NFKC');
}

function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!isPow2(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (r < 1 || p < 1 || N < 2) return null;
  // Refuse to even attempt an allocation a tampered row asks for.
  if (128 * N * r > MAXMEM) return null;
  let salt;
  let hash;
  try {
    salt = Buffer.from(parts[4], 'base64');
    hash = Buffer.from(parts[5], 'base64');
  } catch {
    return null;
  }
  if (!salt.length || !hash.length) return null;
  return { N, r, p, salt, hash };
}

function isPow2(n) {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}
