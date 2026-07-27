import Link from 'next/link';
import { s } from '@/lib/style';
import AuthShell, { GoogleButton, AuthDivider, authError } from '@/components/AuthShell';
import LoginForm from '@/components/LoginForm';
import { allowedDomain } from '@/lib/auth';
import { googleConfigured } from '@/lib/google-oauth';

export const dynamic = 'force-dynamic';

// A failed Google round trip comes back here as a short ?e= code. The codes are
// deliberately coarse: each one maps to a sentence that tells the person what to
// do next, and the specific reason stays in the server log and the audit trail.
// Nothing here confirms whether an address has an account.
function googleErrorMessage(code, domain) {
  const at = domain ? `@${domain}` : 'work';
  switch (code) {
    case 'google_off':
      return 'Google sign-in is not set up on this server yet. Use your email and password.';
    case 'google_denied':
      return 'Google sign-in was cancelled. Nothing has changed.';
    case 'google_expired':
      return 'That sign-in was interrupted or took too long. Start it again.';
    case 'google_domain':
      return `That is not a ${at} Google account. Switch accounts and try again.`;
    case 'google_unknown':
      return 'That account has not been added yet. Ask an admin to invite you.';
    case 'google_disabled':
      return 'That account has been disabled. Contact your admin.';
    case 'google_conflict':
      return 'This account is linked to a different Google account. Ask an admin to unlink it first.';
    case 'google_throttled':
      return 'Too many attempts from this network. Wait 15 minutes and try again.';
    case 'google_failed':
      return 'Google sign-in did not work. Try again, or use your email and password below.';
    default:
      return '';
  }
}

export default async function LoginPage({ searchParams }) {
  const { e } = await searchParams;
  const domain = allowedDomain();
  const google = googleConfigured();
  const message = googleErrorMessage(Array.isArray(e) ? e[0] : e, domain);

  const subtitle = google
    ? 'Continue with your work Google account, or use the password you set from your invite.'
    : 'Use your work email and the password you set from your invite.';

  return (
    <AuthShell title="Sign in" subtitle={subtitle}>
      {/* Sits above the Google button because that is what it is about. */}
      {message && (
        <div style={{ ...authError, marginTop: 0, marginBottom: '16px' }} role="alert">{message}</div>
      )}

      {google && (
        <>
          <GoogleButton />
          <AuthDivider />
        </>
      )}

      <LoginForm />

      <div style={s('margin-top:16px;text-align:center')}>
        <Link href="/forgot" style={s('font-size:11.5px;color:#8A8E94;text-decoration:none')}>
          Forgot your password?
        </Link>
      </div>
    </AuthShell>
  );
}
