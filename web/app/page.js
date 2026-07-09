import { requireAuth } from '@/lib/auth';
import { getAds, getReviewAds, getLastRun, getDomains, getRuns, getFeeds } from '@/lib/queries';
import Dashboard from '@/components/Dashboard';

// Always read fresh from the database on each request.
export const dynamic = 'force-dynamic';

export default async function Page() {
  const role = await requireAuth();
  const [ads, reviewAds, lastRun, domains, runs, feeds] = await Promise.all([
    getAds(),
    getReviewAds(),
    getLastRun(),
    getDomains(),
    getRuns(),
    getFeeds(),
  ]);
  return (
    <Dashboard
      ads={ads}
      reviewAds={reviewAds}
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
