import { redirect } from 'next/navigation';
import { requireAuth, getCapabilities, hasSessionCookie } from '@/lib/auth';
import { getAds, getSecondaryCounts, getLastRun, getDomains, getRuns, getFeeds } from '@/lib/queries';
import { getSheetMetricsIndex, attachSheetMetrics } from '@/lib/metrics';
import Dashboard from '@/components/Dashboard';

// Always read fresh from the database on each request.
export const dynamic = 'force-dynamic';

export default async function Page() {
  // No cookie means signed out for certain, so turn the request away before any
  // query runs. This is a string check, not a database call.
  if (!await hasSessionCookie()) redirect('/login');

  // Start the data fetch and the session lookup together. They hit the same
  // pooler, and awaiting auth first put a full round trip in front of every
  // page load for no benefit: the queries below are the same either way, and
  // nothing is rendered until requireAuth() has had its say.
  // Only Fresh Finds is fetched here. Review, Filtered and Rejected are loaded
  // when their tab is first opened: together they were ~5.5 MB of every render
  // for views most people never open. Their badges come from one COUNT query
  // (~13 ms of database work) instead of from materialising the rows.
  const dataPromise = Promise.all([
    getAds(),
    getSecondaryCounts(),
    getLastRun(),
    getDomains(),
    getRuns(),
    getFeeds(),
    getSheetMetricsIndex(),
  ]);
  // If the session turns out to be invalid we redirect and never read this, so
  // make sure a rejection cannot surface as an unhandled one.
  dataPromise.catch(() => {});

  const user = await requireAuth();
  const caps = await getCapabilities();
  const [rawAds, secondaryCounts, lastRun, domains, runs, feeds, metricsIndex] = await dataPromise;
  // Join the campaign metrics (revenue, clicks, RPC, keywords) onto every ad by
  // normalized landing-page URL, so each view and export reads plain ad fields.
  const feed = attachSheetMetrics(rawAds, metricsIndex);
  console.info('[metrics] attach', { ads: feed.ads.length, matched: feed.matched, secondary: secondaryCounts });
  const ads = feed.ads;
  return (
    <Dashboard
      ads={ads}
      secondaryCounts={secondaryCounts}
      domains={domains}
      runs={runs}
      feeds={feeds}
      lastRunIso={lastRun?.finished_at ?? null}
      lastRunStartIso={lastRun?.started_at ?? null}
      nowIso={new Date().toISOString()}
      caps={caps}
      me={{ email: user.email, name: user.name }}
      exportSaEmail={caps.export_data ? (process.env.GCS_CLIENT_EMAIL ?? null) : null}
    />
  );
}
