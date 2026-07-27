import {
  clientIp, userAgent, allowedDomain, setSessionCookie,
  readOauthCookie, clearOauthCookie,
} from '@/lib/auth';
import {
  findUserByEmail, linkGoogleAccount, createSession,
  recentFailuresForIp, logAuthEvent, MAX_IP_FAILURES,
} from '@/lib/users';
import {
  googleConfigured, googleMissing, clientId, statesMatch,
  exchangeCode, decodeIdToken, validateIdTokenClaims,
} from '@/lib/google-oauth';

export const dynamic = 'force-dynamic';

// Step two: Google has sent the browser back with a one-time code. Turn that
// into a session, or turn it away.
//
// Access is invite-only, exactly as it is for passwords. A verified Google
// identity proves who someone is; it does not decide whether they are allowed
// in. That still comes from a row an admin created at /admin, so an address
// nobody invited is refused here no matter how impeccable its token.
//
// The one thing Google does settle is an outstanding invite: proving control of
// the mailbox is what the emailed link proves too, so signing in this way
// activates an 'invited' account without a password ever being set.
export async function GET(req) {
  // Whatever else happens, this attempt is over: the transaction is single-use
  // and must not survive to be replayed. Read it, then drop it immediately.
  const tx = await readOauthCookie();
  await clearOauthCookie();

  const params = new URL(req.url).searchParams;
  const ip = await clientIp();

  // Every rejection lands back on /login with a short code. The code chooses the
  // sentence shown; the reason behind it goes to the log and the audit trail and
  // never to the browser.
  const deny = async (code, detail, { userId = null, email = null, audit = true } = {}) => {
    if (audit) await logAuthEvent({ type: 'login_failed', userId, email, ip, detail: `google: ${detail}` });
    return redirectTo(`/login?e=${code}`);
  };

  if (!googleConfigured()) {
    console.error('[auth] google callback but sign-in is not configured', { missing: googleMissing() });
    return deny('google_off', 'not configured', { audit: false });
  }

  // The person hit Cancel, or Google declined to authenticate them. Not a failed
  // attempt against us, so it is not audited and does not spend throttle budget.
  const oauthError = params.get('error');
  if (oauthError) {
    const code = oauthError === 'access_denied' ? 'google_denied' : 'google_failed';
    console.info('[auth] google sign-in returned an error', { error: String(oauthError).slice(0, 64) });
    return deny(code, String(oauthError).slice(0, 64), { audit: false });
  }

  // The same per-IP throttle the password path uses, checked before any network
  // call or database write, so hammering this endpoint stays cheap for us.
  if (await recentFailuresForIp(ip) >= MAX_IP_FAILURES) {
    await logAuthEvent({ type: 'login_locked', ip, detail: 'google: ip throttle' });
    return redirectTo('/login?e=google_throttled');
  }

  // No transaction cookie: either it expired while the person sat on Google's
  // account chooser, or someone called this endpoint directly. Both retry
  // harmlessly from /login, so they get the same "start again" message.
  if (!tx) return deny('google_expired', 'no transaction cookie');

  // The CSRF check. A mismatch is not a timeout, it is someone feeding a
  // callback to a browser that never asked for one, so it is logged as such.
  if (!statesMatch(params.get('state'), tx.state)) {
    console.warn('[auth] google callback state mismatch', { ip });
    return deny('google_expired', 'state mismatch');
  }

  const code = params.get('code');
  if (!code) return deny('google_failed', 'no code');

  let idToken;
  try {
    idToken = await exchangeCode(code, tx.verifier);
  } catch (e) {
    // Almost always our configuration: a wrong secret, or a redirect URI that
    // does not match what is registered. Worth a loud log.
    console.error('[auth] google token exchange failed', { error: String(e?.message || e) });
    return deny('google_failed', 'token exchange failed');
  }

  const check = validateIdTokenClaims(decodeIdToken(idToken), {
    nonce: tx.nonce,
    expectedClientId: clientId(),
    domain: allowedDomain(),
  });
  if (!check.ok) {
    if (check.kind === 'config') {
      console.error('[auth] google claim check failed on configuration', { reason: check.reason });
      return deny('google_off', check.reason, { audit: false });
    }
    console.warn('[auth] google claim check failed', { kind: check.kind, reason: check.reason });
    return deny(check.kind === 'domain' ? 'google_domain' : 'google_failed', check.reason);
  }

  const { email, sub } = check;

  // Everything past here touches the database. Wrapped, because an unhandled
  // throw in a route handler renders the error boundary, and a dead end is a
  // poor answer to a transient blip when "try again" is the right one.
  try {
    // Invite-only. A verified identity with no account is a stranger.
    const user = await findUserByEmail(email);
    if (!user) return deny('google_unknown', 'no such user', { email });
    if (user.status === 'disabled') {
      return deny('google_disabled', 'status=disabled', { userId: user.id, email });
    }

    const link = await linkGoogleAccount(user.id, sub);
    if (!link.ok) {
      const audit = { userId: user.id, email };
      if (link.reason === 'sub-mismatch' || link.reason === 'sub-taken') {
        // The address is now a different Google identity than the one on file,
        // or that identity already belongs to another account. Either way a
        // person has to look at it, so refuse and say who to ask.
        console.warn('[auth] google identity conflict', { user: user.id, reason: link.reason });
        return deny('google_conflict', link.reason, audit);
      }
      if (link.reason === 'disabled') return deny('google_disabled', 'status=disabled', audit);
      return deny('google_failed', link.reason || 'link failed', audit);
    }

    const token = await createSession(user.id, { userAgent: await userAgent(), ip });
    await setSessionCookie(token);

    // Three separate facts, so the activity log reads as what actually happened
    // rather than as one compound event.
    if (link.activated) {
      await logAuthEvent({ type: 'invite_accepted', userId: user.id, email, ip, detail: 'via google' });
    }
    if (link.linked) {
      await logAuthEvent({ type: 'google_linked', userId: user.id, email, ip });
    }
    await logAuthEvent({ type: 'login_ok', userId: user.id, email, ip, detail: 'google' });

    return redirectTo('/');
  } catch (e) {
    // Most likely cause by far: migration 0011 has not been applied, so the
    // google_sub column does not exist. Name it in the log, since the symptom
    // on its own points nowhere useful.
    console.error('[auth] google sign-in failed after verification', {
      error: String(e?.message || e),
      hint: 'is supabase/migrations/0011_google_identity.sql applied?',
    });
    return deny('google_failed', 'database error', { email });
  }
}

// See the note in ../start/route.js: Response.redirect cannot carry the cookies
// this handler sets, and a relative Location avoids trusting the proxy's host.
function redirectTo(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}
