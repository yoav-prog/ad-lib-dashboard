import Link from 'next/link';
import { s } from '@/lib/style';
import AuthShell from '@/components/AuthShell';
import SetupButton from '@/components/SetupButton';
import { countUsers } from '@/lib/users';
import { allowedDomain } from '@/lib/auth';
import { mailerConfigured, mailerMissing, appUrlConfigured } from '@/lib/mailer';

export const dynamic = 'force-dynamic';

// First-run bootstrap, reachable without a session. It is safe to leave exposed
// because it does exactly one thing: while the users table is empty, mail an
// invite to ADMIN_EMAIL. It never accepts an address from the caller, and it
// stops working the moment an account exists.
export default async function SetupPage() {
  const users = await countUsers();

  if (users > 0) {
    return (
      <AuthShell title="Setup is already done" subtitle="This dashboard already has accounts, so setup is closed.">
        <Link href="/login" style={s('font-size:11.5px;color:#8A8E94;text-decoration:none')}>Go to sign in</Link>
      </AuthShell>
    );
  }

  // Surface every missing piece at once, so a half-configured deploy is one fix
  // away instead of five reloads away.
  const problems = [];
  if (!allowedDomain()) problems.push('ALLOWED_EMAIL_DOMAIN is not set');
  if (!process.env.ADMIN_EMAIL) problems.push('ADMIN_EMAIL is not set');
  if (!appUrlConfigured()) problems.push('APP_URL is not set to a valid https URL');
  if (!mailerConfigured()) problems.push(`email is not configured (missing ${mailerMissing().join(', ')})`);

  if (problems.length) {
    return (
      <AuthShell
        title="Almost ready"
        subtitle="Set these environment variables on the server, then reload this page."
        width={440}
      >
        <ul style={s('margin:0;padding-left:18px;font-size:12px;line-height:1.9;color:#ff8a80')}>
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create the first admin"
      subtitle={`This sends a one-time setup link to ${process.env.ADMIN_EMAIL}. It is the only address it will ever mail, and this page closes for good once that account exists.`}
      width={440}
    >
      <SetupButton />
    </AuthShell>
  );
}
