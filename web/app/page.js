import { requireAuth } from '@/lib/auth';
import { getAds, getReviewAds, getLastRun, getDomains, getRuns, getFeeds } from '@/lib/queries';
import { getSheetMetricsIndex, attachSheetMetrics } from '@/lib/metrics';
import Dashboard from '@/components/Dashboard';

// Always read fresh from the database on each request.
export const dynamic = 'force-dynamic';

export default async function Page() {
  const role = await requireAuth();
  const [rawAds, rawReviewAds, lastRun, domains, runs, feeds, metricsIndex] = await Promise.all([
    getAds(),
    getReviewAds(),
    getLastRun(),
    getDomains(),
    getRuns(),
    getFeeds(),
    getSheetMetricsIndex(),
  ]);
  // Join the campaign metrics (revenue, clicks, RPC, keywords) onto every ad by
  // normalized landing-page URL, so each view and export reads plain ad fields.
  const feed = attachSheetMetrics(rawAds, metricsIndex);
  const review = attachSheetMetrics(rawReviewAds, metricsIndex);
  console.info('[metrics] attach', { ads: feed.ads.length, matched: feed.matched, reviewAds: review.ads.length, reviewMatched: review.matched });
  const ads = feed.ads;
  const reviewAds = review.ads;
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
