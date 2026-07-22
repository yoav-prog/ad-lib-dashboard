import { requireAuth, getCapabilities } from '@/lib/auth';
import { getAds, getReviewAds, getFilteredAds, getRejectedAds, getLastRun, getDomains, getRuns, getFeeds } from '@/lib/queries';
import { getSheetMetricsIndex, attachSheetMetrics } from '@/lib/metrics';
import Dashboard from '@/components/Dashboard';

// Always read fresh from the database on each request.
export const dynamic = 'force-dynamic';

export default async function Page() {
  const user = await requireAuth();
  const caps = await getCapabilities();
  const [rawAds, rawReviewAds, rawFilteredAds, rawRejectedAds, lastRun, domains, runs, feeds, metricsIndex] = await Promise.all([
    getAds(),
    getReviewAds(),
    getFilteredAds(),
    getRejectedAds(),
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
  const filtered = attachSheetMetrics(rawFilteredAds, metricsIndex);
  const rejected = attachSheetMetrics(rawRejectedAds, metricsIndex);
  console.info('[metrics] attach', { ads: feed.ads.length, matched: feed.matched, reviewAds: review.ads.length, reviewMatched: review.matched, filteredAds: filtered.ads.length, rejectedAds: rejected.ads.length });
  const ads = feed.ads;
  const reviewAds = review.ads;
  const filteredAds = filtered.ads;
  const rejectedAds = rejected.ads;
  return (
    <Dashboard
      ads={ads}
      reviewAds={reviewAds}
      filteredAds={filteredAds}
      rejectedAds={rejectedAds}
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
