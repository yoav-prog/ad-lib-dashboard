import Link from 'next/link';
import { s } from '@/lib/style';
import AuthShell from '@/components/AuthShell';
import SetPasswordForm from '@/components/SetPasswordForm';
import { peekUserToken, RESET_HOURS } from '@/lib/users';
import { MIN_PASSWORD_LENGTH } from '@/lib/password';

export const dynamic = 'force-dynamic';

// The link from a password-reset email. Same shape as the invite page; the
// wording and the token purpose are what differ.
export default async function ResetPage({ params }) {
  const { token } = await params;
  const found = await peekUserToken(token, 'reset');

  if (!found) {
    return (
      <AuthShell
        title="This link is no longer valid"
        subtitle={`Reset links work once and expire after ${RESET_HOURS} hour. Request a new one and it will arrive in a moment.`}
      >
        <Link href="/forgot" style={s('font-size:11.5px;color:#8A8E94;text-decoration:none')}>Request a new link</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="This signs you out everywhere else.">
      <SetPasswordForm
        token={token}
        purpose="reset"
        email={found.user.email}
        minLength={MIN_PASSWORD_LENGTH}
      />
    </AuthShell>
  );
}
