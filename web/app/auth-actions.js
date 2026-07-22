'use server';

// Server actions for the signed-out flows: forgotten password, redeeming an
// invite or reset link, and bootstrapping the very first admin.
//
// Account management by an admin lives in app/admin/actions.js instead. These
// are the ones reachable without a session, so each is written to give away as
// little as possible about which addresses exist.
import {
  clientIp, userAgent, emailDomainAllowed, setSessionCookie,
  checkBreakGlassPasscode, breakGlassConfigured, setBreakGlassCookie,
} from '@/lib/auth';
import {
  findUserByEmail, createUser, createUserToken, peekUserToken, consumeUserToken,
  setPasswordAndActivate, deleteSessionsForUser, createSession, countUsers,
  logAuthEvent, normalizeEmail, RESET_HOURS, INVITE_HOURS,
} from '@/lib/users';
import { hashPassword, validatePassword } from '@/lib/password';
import { sendInviteEmail, sendResetEmail, appUrl, mailerConfigured, mailerMissing } from '@/lib/mailer';

// Deliberately identical whether or not the address exists, whether or not it
// is in the allowed domain, and whether or not mail actually went out.
const RESET_ACK = 'If that email has an account, a reset link is on its way. Check your inbox.';

export async function requestPasswordReset(email) {
  const addr = normalizeEmail(email);
  const ip = await clientIp();

  // Everything below is best-effort and silent. The caller always sees RESET_ACK.
  try {
    if (!addr || !emailDomainAllowed(addr)) return { ok: true, message: RESET_ACK };

    const user = await findUserByEmail(addr);
    if (!user || user.status === 'disabled') return { ok: true, message: RESET_ACK };

    // An invited user who never set a password gets another invite rather than a
    // reset, so the wording matches what they actually need to do.
    const purpose = user.status === 'invited' ? 'invite' : 'reset';
    const hours = purpose === 'invite' ? INVITE_HOURS : RESET_HOURS;
    const token = await createUserToken(user.id, purpose, hours);
    const url = `${appUrl()}/${purpose}/${token}`;

    if (purpose === 'invite') {
      await sendInviteEmail({ to: user.email, name: user.name, url, expiresHours: hours });
    } else {
      await sendResetEmail({ to: user.email, name: user.name, url, expiresHours: hours });
    }
    await logAuthEvent({ type: 'reset_sent', userId: user.id, email: addr, ip, detail: purpose });
  } catch (e) {
    // Log for us, stay silent to the caller: a mail outage must not become an
    // account-existence oracle.
    console.error('[auth] reset request failed', { error: String(e?.message || e) });
  }

  return { ok: true, message: RESET_ACK };
}

// Redeem an invite or reset link and sign the person in. `purpose` comes from
// the route, not from the client.
export async function setPasswordWithToken(token, purpose, password) {
  if (purpose !== 'invite' && purpose !== 'reset') {
    return { ok: false, error: 'That link is not valid.' };
  }
  const ip = await clientIp();

  const peeked = await peekUserToken(token, purpose);
  if (!peeked) {
    return { ok: false, error: 'That link has expired or has already been used. Ask for a new one.' };
  }
  const { user } = peeked;

  // The domain lock again, at redemption. An address could have been invited
  // before the policy changed, or the policy could have changed since.
  if (!emailDomainAllowed(user.email)) {
    return { ok: false, error: 'That account is not allowed to sign in. Contact your admin.' };
  }
  if (user.status === 'disabled') {
    return { ok: false, error: 'That account has been disabled. Contact your admin.' };
  }

  const problem = validatePassword(password, { email: user.email });
  if (problem) return { ok: false, error: problem };

  const hash = await hashPassword(password);

  // Claim the token only now. The predicate lives inside the UPDATE, so a
  // double submit cannot set the password twice.
  const claimedUserId = await consumeUserToken(token, purpose);
  if (!claimedUserId || claimedUserId !== user.id) {
    return { ok: false, error: 'That link has expired or has already been used. Ask for a new one.' };
  }

  const updated = await setPasswordAndActivate(user.id, hash);
  if (!updated) {
    return { ok: false, error: 'That account can no longer be set up. Contact your admin.' };
  }

  // A password change signs out every other device. Then sign this one in, so
  // finishing the form drops you straight into the dashboard.
  await deleteSessionsForUser(user.id);
  const session = await createSession(user.id, { userAgent: await userAgent(), ip });
  await setSessionCookie(session);
  await logAuthEvent({
    type: purpose === 'invite' ? 'invite_accepted' : 'reset_done',
    userId: user.id, email: user.email, ip,
  });

  return { ok: true };
}

// First-run bootstrap. Only works while the users table is completely empty, and
// only ever mails ADMIN_EMAIL, so it cannot be pointed at an attacker's address.
// Once one account exists this is permanently inert.
export async function bootstrapFirstAdmin() {
  const ip = await clientIp();

  if (await countUsers() > 0) {
    return { ok: false, error: 'Setup has already been completed. Sign in instead.' };
  }
  if (!mailerConfigured()) {
    return { ok: false, error: `Email is not configured yet. Missing: ${mailerMissing().join(', ')}` };
  }

  const addr = normalizeEmail(process.env.ADMIN_EMAIL);
  if (!addr) return { ok: false, error: 'ADMIN_EMAIL is not set on the server.' };
  if (!emailDomainAllowed(addr)) {
    return { ok: false, error: 'ADMIN_EMAIL is outside ALLOWED_EMAIL_DOMAIN. Fix the server settings first.' };
  }

  let base;
  try {
    base = appUrl();
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }

  const user = await createUser({ email: addr, name: null, role: 'admin', capabilities: {}, createdBy: null });
  if (!user) return { ok: false, error: 'That account already exists. Sign in instead.' };

  try {
    const token = await createUserToken(user.id, 'invite', INVITE_HOURS);
    await sendInviteEmail({
      to: user.email, name: null, url: `${base}/invite/${token}`, expiresHours: INVITE_HOURS,
    });
  } catch (e) {
    console.error('[auth] bootstrap mail failed', { error: String(e?.message || e) });
    return { ok: false, error: `The account was created but the email failed to send: ${String(e?.message || e)}` };
  }

  await logAuthEvent({ type: 'user_created', userId: user.id, email: addr, ip, detail: 'bootstrap admin' });
  await logAuthEvent({ type: 'invite_sent', userId: user.id, email: addr, ip, detail: 'bootstrap' });
  return { ok: true, email: addr };
}

// The emergency door: the sole admin has lost their password and email is also
// down. Grants a 30-minute cookie scoped to /admin and nothing else, so a leaked
// passcode cannot reach the competitor data. Always logged, whether it worked or
// not, because a failed attempt here is worth knowing about.
export async function breakGlassLogin(passcode) {
  const ip = await clientIp();

  if (!breakGlassConfigured()) {
    return { ok: false, error: 'Emergency access is not enabled on this server.' };
  }
  if (!checkBreakGlassPasscode(passcode)) {
    await logAuthEvent({ type: 'break_glass', ip, detail: 'rejected' });
    console.warn('[auth] break-glass attempt rejected', { ip });
    return { ok: false, error: 'That passcode is not correct.' };
  }

  await setBreakGlassCookie();
  await logAuthEvent({ type: 'break_glass', ip, detail: 'granted, 30 min, /admin only' });
  console.warn('[auth] BREAK-GLASS ACCESS GRANTED', { ip });
  return { ok: true };
}
