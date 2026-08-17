import { redirect } from 'next/navigation';
import { requireAuth, getCapabilities, hasSessionCookie } from '@/lib/auth';
import { getAds, getSecondaryCounts, getLastRun, getDomains, getRuns, getFeeds, getFeedPage, getFeedTicker } from '@/lib/queries';
import { getSheetMetricsIndex, attachSheetMetrics } from '@/lib/metrics';
import { attachOwned, articlesConfigured } from '@/lib/articles';
import Dashboard from '@/components/Dashboard';

// Server-side feed, ON by default since the Phase 3 cutover: the page ships one page plus
// the ticker counts instead of the whole ~28 MB feed, and the Dashboard drives filtering,
// sorting, search, paging, selection and export against the database. Facets are not
// server-rendered - the Dashboard fetches them on mount anyway, so shipping them here was
// double work. SERVER_SIDE_FEED=0 restores the old all-rows client path (the rollback lever).
const SERVER_FEED = process.env.SERVER_SIDE_FEED !== '0';
const INITIAL_PAGE_SIZE = 100;

// The page renders per request (it reads the auth cookie), so it is never statically
// cached. The feed itself is the heavy part - getAds holds it in a short-lived
// in-memory cache (see lib/queries.js) so navigations and concurrent viewers do not
// each rebuild ~14k rows; edits bust that cache at once.
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
  // Data both feed modes need.
  const commonPromise = Promise.all([getSecondaryCounts(), getLastRun(), getDomains(), getRuns(), getFeeds()]);
  commonPromise.catch(() => {});

  // The feed itself. Server mode (default): one page + ticker. Client mode (flag off): the
  // whole feed, with metrics joined in memory (the pre-Phase-2 path). Only one of these runs.
  const feedPromise = SERVER_FEED
    ? Promise.all([getFeedPage({ pageSize: INITIAL_PAGE_SIZE }), getFeedTicker()])
    : Promise.all([getAds(), getSheetMetricsIndex()]);
  // If the session turns out to be invalid we redirect and never read these, so make sure a
  // rejection cannot surface as an unhandled one.
  feedPromise.catch(() => {});

  const user = await requireAuth();
  const caps = await getCapabilities();
  const [secondaryCounts, lastRun, domains, runs, feeds] = await commonPromise;

  let ads;
  let initialFeed = null;
  let ticker = null;
  if (SERVER_FEED) {
    [initialFeed, ticker] = await feedPromise;
    // Flag rows we already have our own article for (article_lineage), so the feed badges them
    // on first paint - later pages get the same treatment in loadFeedPage.
    initialFeed.rows = await attachOwned(initialFeed.rows);
    ads = initialFeed.rows;  // the first page, so the client has something to render immediately
    console.info('[feed] server-side first page', { rows: initialFeed.rows.length, total: initialFeed.total });
  } else {
    const [rawAds, metricsIndex] = await feedPromise;
    // Join the campaign metrics (revenue, clicks, RPC, keywords) onto every ad by normalized
    // landing-page URL, so each view and export reads plain ad fields.
    const feed = attachSheetMetrics(rawAds, metricsIndex);
    console.info('[metrics] attach', { ads: feed.ads.length, matched: feed.matched, secondary: secondaryCounts });
    ads = await attachOwned(feed.ads);
  }

  return (
    <Dashboard
      ads={ads}
      serverFeed={SERVER_FEED}
      initialFeed={initialFeed}
      ticker={ticker}
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
      articlesConfigured={articlesConfigured()}
    />
  );
}
