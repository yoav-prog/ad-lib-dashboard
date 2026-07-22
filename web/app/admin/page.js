import Link from 'next/link';
import { redirect } from 'next/navigation';
import { s } from '@/lib/style';
import AuthShell from '@/components/AuthShell';
import AdminView from '@/components/AdminView';
import { getCurrentUser, getCapabilities, hasBreakGlass, allowedDomain } from '@/lib/auth';
import { listUsers, recentAuthEvents } from '@/lib/users';
import { mailerConfigured, mailerMissing, appUrlConfigured } from '@/lib/mailer';

export const dynamic = 'force-dynamic';

// The gate is inlined rather than using requireUserAdmin() so a signed-in
// non-admin gets a plain "you do not have access" screen instead of an
// exception bubbling into the error boundary.
export default async function AdminPage() {
  const user = await getCurrentUser();
  const caps = await getCapabilities();
  const viaBreakGlass = caps.manage_users ? false : await hasBreakGlass();

  if (!caps.manage_users && !viaBreakGlass) {
    if (!user) redirect('/login');
    return (
      <AuthShell
        title="No access"
        subtitle="User management is limited to admins. Ask one of them if you need something changed."
      >
        <Link href="/" style={s('font-size:11.5px;color:#8A8E94;text-decoration:none')}>← Back to the dashboard</Link>
      </AuthShell>
    );
  }

  const [users, events] = await Promise.all([listUsers(), recentAuthEvents(60)]);

  // Both of these break invites silently if unset, so the page says so up front
  // rather than letting an admin discover it when nobody receives an email.
  const problems = [];
  if (!mailerConfigured()) problems.push(`Email is not configured (missing ${mailerMissing().join(', ')}).`);
  if (!appUrlConfigured()) problems.push('APP_URL is not set to a valid https URL, so invite links would be wrong.');

  return (
    <AdminView
      users={users}
      events={events}
      domain={allowedDomain()}
      mailProblem={problems.join(' ') || null}
      me={user ? { id: user.id, email: user.email } : null}
      viaBreakGlass={viaBreakGlass}
    />
  );
}
