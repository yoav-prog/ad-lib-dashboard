import { redirect } from 'next/navigation';
import { requireAuth, getCapabilities, hasSessionCookie } from '@/lib/auth';
import { getAds, getSecondaryCounts, getLastRun, getDomains, getRuns, getFeeds, getFeedPage, getFeedTicker, getFeedFacets } from '@/lib/queries';
import { getSheetMetricsIndex, attachSheetMetrics } from '@/lib/metrics';
import { attachOwned, articlesConfigured, listOurDomains } from '@/lib/articles';
import Dashboard from '@/components/Dashboard';

// Server-side feed, ON by default since the Phase 3 cutover: the page ships one page plus
// the ticker counts instead of the whole ~28 MB feed, and the Dashboard drives filtering,
// sorting, search, paging, selection and export against the database. The filter rail's facets
// and our-domains list ARE server-rendered (see railPromise below); leaving them to the browser
// meant a second request paying its own connection setup while the rail showed a spinner.
// SERVER_SIDE_FEED=0 restores the old all-rows client path (the rollback lever).
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

  // The filter rail's two inputs, fetched HERE rather than from the browser after hydration.
  // They used to be skipped on the grounds that the Dashboard fetches them on mount anyway, so
  // shipping them was double work - but that reasoning missed what the round trip costs. The
  // queries themselves are trivial (169 ms for all nine facets server-side, 19 ms for geos);
  // what hurt was a fresh request paying its own connection setup, ~2.2 s cold, while the rail
  // sat on "LOADING FILTERS...". Here they ride along with the feed query on a connection that
  // is being opened regardless, so the rail arrives populated and the browser waits for
  // nothing. Both are best-effort: a failure yields null and the Dashboard falls back to
  // fetching them itself, exactly as before.
  const railPromise = Promise.all([
    getFeedFacets([]).catch((e) => { console.warn('[facets] server-side prefetch failed', String(e?.message || e)); return null; }),
    articlesConfigured()
      ? listOurDomains().catch((e) => { console.warn('[our articles] domain prefetch failed', String(e?.message || e)); return null; })
      : Promise.resolve([]),
  ]);

  const user = await requireAuth();
  const caps = await getCapabilities();
  const [secondaryCounts, lastRun, domains, runs, feeds] = await commonPromise;
  const [initialFacets, initialOurDomains] = await railPromise;

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
      initialFacets={initialFacets}
      initialOurDomains={initialOurDomains}
    />
  );
}
