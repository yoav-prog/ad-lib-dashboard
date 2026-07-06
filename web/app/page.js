import { getAds, getLastRun, getDomains, getRuns } from '@/lib/queries';
import Dashboard from '@/components/Dashboard';

// Always read fresh from the database on each request.
export const dynamic = 'force-dynamic';

export default async function Page() {
  const [ads, lastRun, domains, runs] = await Promise.all([
    getAds(),
    getLastRun(),
    getDomains(),
    getRuns(),
  ]);
  return (
    <Dashboard
      ads={ads}
      domains={domains}
      runs={runs}
      lastRunIso={lastRun?.finished_at ?? null}
      nowIso={new Date().toISOString()}
    />
  );
}
