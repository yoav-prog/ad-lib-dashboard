import Link from 'next/link';
import { s } from '@/lib/style';
import AuthShell from '@/components/AuthShell';
import RescueForm from '@/components/RescueForm';
import { breakGlassConfigured } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Emergency entry to /admin, for the case where the only admin cannot sign in
// and email is down too. Lives under /admin so the cookie it sets (path=/admin)
// is never sent anywhere else in the app.
export default function RescuePage() {
  if (!breakGlassConfigured()) {
    return (
      <AuthShell
        title="Emergency access is off"
        subtitle="BREAK_GLASS_PASSCODE is not set on this server, so there is no emergency route in. Recovering access means editing the database directly."
      >
        <Link href="/login" style={s('font-size:11.5px;color:#8A8E94;text-decoration:none')}>Back to sign in</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Emergency access"
      subtitle="This grants user management only, for 30 minutes, and never reaches the ad data. Every attempt is logged. Use it to fix an admin account, then sign in normally."
      width={400}
    >
      <RescueForm />
    </AuthShell>
  );
}
