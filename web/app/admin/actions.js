'use server';

// User management, reachable only from /admin. Every action starts with the
// same gate and every one records who did what to whom.
//
// Three classes of guard run here, and they are deliberately separate:
//   - the gate      : are you allowed to manage users at all
//   - self-harm     : you may not disable, delete, or demote yourself
//   - last admin    : enforced in lib/users.js, inside the transaction
// The last one cannot live here: a check-then-write in application code loses
// to two admins clicking at the same moment.
import { revalidatePath } from 'next/cache';
import { requireUserAdmin, emailDomainAllowed, allowedDomain, clientIp } from '@/lib/auth';
import { ROLES, overridesFor } from '@/lib/capabilities';
import {
  createUser, findUserById, findUserByEmail, changeUserRole,
  disableUser, enableUser, deleteUser, createUserToken, deleteSessionsForUser,
  logAuthEvent, normalizeEmail, INVITE_HOURS, RESET_HOURS,
} from '@/lib/users';
import { sendInviteEmail, sendResetEmail, appUrl, mailerConfigured, mailerMissing } from '@/lib/mailer';

// Resolves the acting admin, or the break-glass session (which has no user row).
async function actor() {
  const { user, viaBreakGlass } = await requireUserAdmin();
  return {
    id: user?.id ?? null,
    email: user?.email ?? null,
    label: user?.email ?? 'break-glass',
    viaBreakGlass,
  };
}

function cleanRole(role) {
  return ROLES.includes(role) ? role : 'viewer';
}

// Trust only the five known capability keys, and store only what differs from
// the role's defaults. manage_users is dropped entirely by overridesFor, so it
// can never be granted to a non-admin through this path.
function cleanCapabilities(role, desired) {
  return overridesFor(cleanRole(role), desired);
}

function mailReady() {
  return mailerConfigured() ? null : `Email is not configured. Missing: ${mailerMissing().join(', ')}`;
}

export async function inviteUser({ email, name, role, capabilities }) {
  const me = await actor();
  const ip = await clientIp();
  const addr = normalizeEmail(email);

  if (!addr) return { ok: false, error: 'Enter an email address.' };
  if (!emailDomainAllowed(addr)) {
    const d = allowedDomain();
    return {
      ok: false,
      error: d ? `Only @${d} addresses can be added.` : 'ALLOWED_EMAIL_DOMAIN is not set on the server.',
    };
  }
  const problem = mailReady();
  if (problem) return { ok: false, error: problem };

  let base;
  try {
    base = appUrl();
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }

  if (await findUserByEmail(addr)) {
    return { ok: false, error: 'That person already has an account. Resend their invite instead.' };
  }

  const r = cleanRole(role);
  const user = await createUser({
    email: addr,
    name: String(name || '').trim() || null,
    role: r,
    capabilities: cleanCapabilities(r, capabilities),
    createdBy: me.id,
  });
  // createUser returns null on a unique-index conflict, which is the race the
  // findUserByEmail check above cannot close on its own.
  if (!user) return { ok: false, error: 'That person already has an account. Resend their invite instead.' };

  try {
    const token = await createUserToken(user.id, 'invite', INVITE_HOURS);
    await sendInviteEmail({
      to: user.email, name: user.name, url: `${base}/invite/${token}`,
      invitedBy: me.email, expiresHours: INVITE_HOURS,
    });
  } catch (e) {
    // The row exists but the invite did not go out. Say so precisely: the admin
    // needs to know to hit Resend rather than to try adding them again.
    console.error('[admin] invite mail failed', { error: String(e?.message || e) });
    await logAuthEvent({ type: 'user_created', userId: user.id, email: addr, actorId: me.id, actorEmail: me.email, ip, detail: 'mail failed' });
    revalidatePath('/admin');
    return { ok: false, error: `Account created, but the invite email failed: ${String(e?.message || e)}. Use Resend.` };
  }

  await logAuthEvent({ type: 'user_created', userId: user.id, email: addr, actorId: me.id, actorEmail: me.email, ip, detail: `role=${r}` });
  await logAuthEvent({ type: 'invite_sent', userId: user.id, email: addr, actorId: me.id, actorEmail: me.email, ip });
  revalidatePath('/admin');
  return { ok: true, message: `Invite sent to ${addr}.` };
}

export async function resendInvite(userId) {
  const me = await actor();
  const ip = await clientIp();
  const problem = mailReady();
  if (problem) return { ok: false, error: problem };

  const user = await findUserById(userId);
  if (!user) return { ok: false, error: 'That account no longer exists.' };
  if (user.status === 'disabled') return { ok: false, error: 'Re-enable the account before inviting them again.' };

  let base;
  try {
    base = appUrl();
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }

  // An active user has a working password already, so the useful thing to send
  // is a reset link, not an invite.
  const purpose = user.status === 'invited' ? 'invite' : 'reset';
  const hours = purpose === 'invite' ? INVITE_HOURS : RESET_HOURS;

  try {
    const token = await createUserToken(user.id, purpose, hours);
    const url = `${base}/${purpose}/${token}`;
    if (purpose === 'invite') {
      await sendInviteEmail({ to: user.email, name: user.name, url, invitedBy: me.email, expiresHours: hours });
    } else {
      await sendResetEmail({ to: user.email, name: user.name, url, expiresHours: hours });
    }
  } catch (e) {
    return { ok: false, error: `Could not send the email: ${String(e?.message || e)}` };
  }

  await logAuthEvent({
    type: purpose === 'invite' ? 'invite_sent' : 'reset_sent',
    userId: user.id, email: user.email, actorId: me.id, actorEmail: me.email, ip, detail: 'from /admin',
  });
  revalidatePath('/admin');
  return { ok: true, message: purpose === 'invite' ? `Invite resent to ${user.email}.` : `Reset link sent to ${user.email}.` };
}

export async function updateUser(userId, { name, role, capabilities }) {
  const me = await actor();
  const ip = await clientIp();

  const user = await findUserById(userId);
  if (!user) return { ok: false, error: 'That account no longer exists.' };

  const r = cleanRole(role);

  // Self-demotion is blocked outright. The last-admin guard would catch the
  // dangerous case anyway, but this makes the rule legible: you cannot quietly
  // take your own admin rights away and then wonder why /admin is gone.
  if (me.id && me.id === user.id && r !== 'admin' && user.role === 'admin') {
    return { ok: false, error: 'You cannot remove your own admin access. Ask another admin to do it.' };
  }

  const result = await changeUserRole(userId, {
    name: String(name || '').trim() || null,
    role: r,
    capabilities: cleanCapabilities(r, capabilities),
  });
  if (!result.ok) {
    if (result.reason === 'last-admin') {
      return { ok: false, error: 'This is the only admin left. Promote someone else first.' };
    }
    return { ok: false, error: 'That account no longer exists.' };
  }

  // A demotion must not leave a wider session running: dropping the sessions
  // forces the next request to re-read the new permissions.
  if (user.role !== r) await deleteSessionsForUser(userId);

  await logAuthEvent({
    type: 'user_updated', userId, email: user.email, actorId: me.id, actorEmail: me.email, ip,
    detail: `role ${user.role} -> ${r}`,
  });
  revalidatePath('/admin');
  revalidatePath('/');
  return { ok: true, message: 'Saved.' };
}

export async function setUserDisabled(userId, disabled) {
  const me = await actor();
  const ip = await clientIp();

  const user = await findUserById(userId);
  if (!user) return { ok: false, error: 'That account no longer exists.' };
  if (me.id && me.id === user.id && disabled) {
    return { ok: false, error: 'You cannot disable your own account.' };
  }

  if (disabled) {
    const result = await disableUser(userId);
    if (!result.ok) {
      if (result.reason === 'last-admin') {
        return { ok: false, error: 'This is the only admin left. Promote someone else first.' };
      }
      if (result.reason === 'already-disabled') return { ok: true, message: 'Already disabled.' };
      return { ok: false, error: 'That account no longer exists.' };
    }
    await logAuthEvent({ type: 'user_disabled', userId, email: user.email, actorId: me.id, actorEmail: me.email, ip });
    revalidatePath('/admin');
    return { ok: true, message: `${user.email} is disabled and signed out everywhere.` };
  }

  const back = await enableUser(userId);
  if (!back) return { ok: false, error: 'That account is not disabled.' };
  await logAuthEvent({ type: 'user_enabled', userId, email: user.email, actorId: me.id, actorEmail: me.email, ip });
  revalidatePath('/admin');
  return {
    ok: true,
    message: back.status === 'invited'
      ? `${user.email} is enabled. They still need an invite to set a password.`
      : `${user.email} is enabled.`,
  };
}

// Hard delete. The audit trail survives (auth_events.user_id is set null, and
// the email was denormalised at write time), which is why this is offered at all
// alongside disable.
export async function removeUser(userId) {
  const me = await actor();
  const ip = await clientIp();

  const user = await findUserById(userId);
  if (!user) return { ok: false, error: 'That account no longer exists.' };
  if (me.id && me.id === user.id) {
    return { ok: false, error: 'You cannot delete your own account.' };
  }

  const result = await deleteUser(userId);
  if (!result.ok) {
    if (result.reason === 'last-admin') {
      return { ok: false, error: 'This is the only admin left. Promote someone else first.' };
    }
    return { ok: false, error: 'That account no longer exists.' };
  }

  await logAuthEvent({
    type: 'user_deleted', userId: null, email: user.email,
    actorId: me.id, actorEmail: me.email, ip, detail: `was ${user.role}`,
  });
  revalidatePath('/admin');
  return { ok: true, message: `${user.email} deleted.` };
}
