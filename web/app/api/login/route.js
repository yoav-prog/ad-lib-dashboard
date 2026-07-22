import {
  clientIp, userAgent, emailDomainAllowed, setSessionCookie,
} from '@/lib/auth';
import {
  findUserWithHash, createSession, registerFailedLogin, clearFailedLogins,
  updatePasswordHash, isLockedOut, recentFailuresForIp, logAuthEvent, normalizeEmail,
  MAX_IP_FAILURES, LOCKOUT_MINUTES,
} from '@/lib/users';
import { verifyPassword, fakeVerify, needsRehash, hashPassword } from '@/lib/password';

export const dynamic = 'force-dynamic';

// Every rejection returns this same text. The only exception is the lockout
// message below: after 10 failures it does confirm the account exists, which is
// a deliberate trade. The addresses an attacker could probe are already limited
// to one company domain, the per-IP throttle caps probing at roughly three
// accounts per 15 minutes, and telling a locked-out colleague why they cannot
// get in beats leaving them to retry a password that would never work.
const GENERIC = 'That email and password combination did not work.';

export async function POST(req) {
  let email = '';
  let password = '';
  try {
    ({ email, password } = await req.json());
  } catch {
    // malformed body falls through to the generic rejection
  }

  const ip = await clientIp();
  const addr = normalizeEmail(email);

  // Per-IP throttle first, before any database work or password hashing, so a
  // flood costs us one indexed count rather than a 200 ms scrypt each.
  if (await recentFailuresForIp(ip) >= MAX_IP_FAILURES) {
    await logAuthEvent({ type: 'login_locked', email: addr, ip, detail: 'ip throttle' });
    return Response.json(
      { ok: false, error: 'Too many attempts from this network. Wait 15 minutes and try again.' },
      { status: 429 },
    );
  }

  const fail = async (detail, type = 'login_failed', userId = null) => {
    await logAuthEvent({ type, userId, email: addr, ip, detail });
    return Response.json({ ok: false, error: GENERIC }, { status: 401 });
  };

  if (!addr || !password) return fail('missing credentials');

  // The domain lock, checked here as well as at invite time and at invite
  // acceptance. Three independent checks, because one is a single bug away from
  // being no check at all.
  if (!emailDomainAllowed(addr)) return fail('domain not allowed');

  const user = await findUserWithHash(addr);

  // Unknown address, or a real one that never finished its invite. Burn a
  // comparable amount of CPU either way so response timing does not answer
  // "does this account exist".
  if (!user || !user.password_hash) {
    await fakeVerify();
    return fail(user ? 'no password set' : 'no such user', 'login_failed', user?.id ?? null);
  }

  if (user.status !== 'active') {
    await fakeVerify();
    return fail(`status=${user.status}`, 'login_failed', user.id);
  }

  if (isLockedOut(user)) {
    await logAuthEvent({ type: 'login_locked', userId: user.id, email: addr, ip, detail: 'account locked' });
    const mins = Math.max(1, Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000));
    return Response.json(
      { ok: false, error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` },
      { status: 429 },
    );
  }

  if (!await verifyPassword(password, user.password_hash)) {
    const after = await registerFailedLogin(user.id);
    const locked = after?.locked_until && new Date(after.locked_until).getTime() > Date.now();
    await logAuthEvent({
      type: 'login_failed', userId: user.id, email: addr, ip,
      detail: `attempt ${after?.failed_login_count ?? '?'}${locked ? ', now locked' : ''}`,
    });
    if (locked) {
      return Response.json(
        { ok: false, error: `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.` },
        { status: 429 },
      );
    }
    return Response.json({ ok: false, error: GENERIC }, { status: 401 });
  }

  // Correct password. Upgrade the stored hash if it predates the current work
  // factor, while we still hold the plaintext to do it with.
  if (needsRehash(user.password_hash)) {
    try {
      await updatePasswordHash(user.id, await hashPassword(password));
      console.info('[auth] rehashed password to current parameters', { user: user.id });
    } catch (e) {
      console.error('[auth] rehash failed', { user: user.id, error: String(e?.message || e) });
    }
  }

  await clearFailedLogins(user.id);
  const token = await createSession(user.id, { userAgent: await userAgent(), ip });
  await setSessionCookie(token);
  await logAuthEvent({ type: 'login_ok', userId: user.id, email: addr, ip });

  return Response.json({ ok: true });
}
