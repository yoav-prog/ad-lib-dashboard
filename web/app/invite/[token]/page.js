import Link from 'next/link';
import { s } from '@/lib/style';
import AuthShell from '@/components/AuthShell';
import SetPasswordForm from '@/components/SetPasswordForm';
import { peekUserToken, INVITE_HOURS } from '@/lib/users';
import { MIN_PASSWORD_LENGTH } from '@/lib/password';

export const dynamic = 'force-dynamic';

// The link from an invite email. Validated on the server before anything
// renders, so an expired or spent link says so plainly instead of failing only
// after the person has picked a password.
export default async function InvitePage({ params }) {
  const { token } = await params;
  const found = await peekUserToken(token, 'invite');

  if (!found) {
    return (
      <AuthShell
        title="This link is no longer valid"
        subtitle={`Invite links work once and expire after ${INVITE_HOURS} hours. Ask whoever invited you to send a new one.`}
      >
        <Link href="/login" style={s('font-size:11.5px;color:#8A8E94;text-decoration:none')}>Back to sign in</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Welcome to AdIntel" subtitle="Pick a password and you are in.">
      <SetPasswordForm
        token={token}
        purpose="invite"
        email={found.user.email}
        minLength={MIN_PASSWORD_LENGTH}
      />
    </AuthShell>
  );
}
