import { requireAuth } from '@/lib/auth';
import { getAds, getLastRun, getDomains, getRuns, getFeeds } from '@/lib/queries';
import Dashboard from '@/components/Dashboard';

// Always read fresh from the database on each request.
export const dynamic = 'force-dynamic';

export default async function Page() {
  const role = await requireAuth();
  const [ads, lastRun, domains, runs, feeds] = await Promise.all([
    getAds(),
    getLastRun(),
    getDomains(),
    getRuns(),
    getFeeds(),
  ]);
  return (
    <Dashboard
      ads={ads}
      domains={domains}
      runs={runs}
      feeds={feeds}
      lastRunIso={lastRun?.finished_at ?? null}
      lastRunStartIso={lastRun?.started_at ?? null}
      nowIso={new Date().toISOString()}
      canEdit={role === 'admin'}
      exportSaEmail={role === 'admin' ? (process.env.GCS_CLIENT_EMAIL ?? null) : null}
    />
  );
}
