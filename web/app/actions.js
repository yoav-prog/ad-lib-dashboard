'use server';

import { getSql } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { getCurrentUser, requireCapability } from '@/lib/auth';
import { getAds, getAdsByIds, getReviewAds, getFilteredAds, getRejectedAds, getSecondaryCounts, bustAdsCache, getFeedPage, getFeedFacets, getFeedTicker, getFeedExport, getFeedIds, getDomainAdCounts, getAssignmentsByAdIds, getAssignmentsByCompIds, getAssignedUrlsForDomain, getTakenOurUrls, getMetaCreativesByHosts } from '@/lib/queries';
import { getSheetMetricsIndex, attachSheetMetrics, metricsStatus } from '@/lib/metrics';
import { buildSheetData, DEFAULT_SHEET_COLUMN_KEYS, KIT_COLUMNS, DEFAULT_KIT_COLUMN_KEYS, planBulkAssignment, compToSubject, COMP_KIT_COLUMNS, DEFAULT_COMP_KIT_COLUMN_KEYS, hostOf, langCode } from '@/lib/ui';
import { writeToSheet, sheetsConfigured, serviceAccountEmail } from '@/lib/sheets';
import { listOurDomains, listOurNetworks, searchOurLinks as searchArticleLinks, getCompFacets, searchCompRows, getCompRowsByIds, getSisterFamilyUrls, getSisterLinksForUrls, attachOwned, attachOurArticles, isOurDomain, articlesConfigured } from '@/lib/articles';

const AD_FIELDS = ['status', 'owner', 'notes', 'is_saved', 'linked_article_url', 'brand'];
const DOMAIN_FIELDS = ['query', 'country', 'active_status', 'max_ads', 'interval_days', 'enabled', 'feed'];

function pick(patch, allowed) {
  const set = {};
  for (const k of allowed) if (k in patch) set[k] = patch[k];
  return set;
}

// Domain ids key a uuid column and there is no uuid = text operator, so anything
// that is not a uuid is dropped rather than trusted. Deduped and capped so a bulk
// call can never smuggle in a huge or malformed id list.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanDomainIds(ids, cap = 500) {
  return Array.isArray(ids)
    ? [...new Set(ids.map(String).filter((x) => UUID_RE.test(x)))].slice(0, cap)
    : [];
}

// The feed ships every ad WITHOUT its landing-article body (the bodies dwarf
// everything else combined), so the Detail view fetches the one it shows here.
// Read-only, so any signed-in account may call it, whatever their permissions.
export async function getAdArticle(adId) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  const sql = getSql();
  const rows = await sql`
    select article_title, article_content from ads where ad_archive_id = ${String(adId)}
  `;
  if (!rows.length) return { ok: false, reason: 'not-found' };
  console.info('[detail article] served', { adId: String(adId), chars: (rows[0].article_content || '').length });
  return { ok: true, article_title: rows[0].article_title, article_content: rows[0].article_content };
}

// The Review, Filtered and Rejected tabs, fetched when one is first opened
// rather than shipped with every page render. Together they were about 5.5 MB
// of a 12.9 MB payload, for views most people never open.
//
// Read-only, so the gate matches the feed itself: any signed-in account. The
// rows carry the same campaign metrics the server attaches to Fresh Finds, so a
// lazily-loaded tab is indistinguishable from an eagerly-loaded one.
const SECONDARY_TABS = {
  review: getReviewAds,
  filtered: getFilteredAds,
  rejected: getRejectedAds,
};

export async function loadSecondaryTab(tab) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  const fetchTab = SECONDARY_TABS[tab];
  if (!fetchTab) return { ok: false, reason: 'unknown-tab' };

  const [rows, metricsIndex] = await Promise.all([fetchTab(), getSheetMetricsIndex()]);
  const { ads, matched } = attachSheetMetrics(rows, metricsIndex);
  console.info('[tab load]', { tab, rows: ads.length, matched });
  return { ok: true, ads };
}

// Badge counts on their own, so a decision can refresh the numbers without
// re-fetching whole tabs.
export async function refreshSecondaryCounts() {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  return getSecondaryCounts();
}

// ── Server-side Fresh Finds (Phase 2b): the feed's data, one page at a time ────
// These wrap the query engine (lib/queries getFeed*) so the Dashboard can filter, sort,
// search and page against the database instead of holding the whole feed. Read-only, so the
// gate matches the feed itself - any signed-in account. The rows already carry their campaign
// metrics inline (the SQL join), so a page here is the same shape the old all-rows path built.
export async function loadFeedPage(params) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  // The domain reaches SQL (the "only ads we have an article for" filter) and the articles DB,
  // so it is validated against the real list of our domains rather than trusted. An unknown
  // value is dropped entirely: the page then renders with no our-articles enrichment and no
  // filter, which is the same thing the user sees before they pick a domain.
  const clean = await withCleanDomain(params);
  const ourDomain = clean.filters.ourDomain;
  const { rows, total, page, pageSize } = await getFeedPage(clean);
  // Badge the rows we already have our own article for (best-effort; never blocks the feed).
  // attachOwned is the exact-clone lineage signal; attachOurArticles is the domain-scoped
  // country+language+vertical match the rail's domain picker drives.
  const owned = await attachOwned(rows);
  const enriched = await attachOurArticles(owned, ourDomain);
  return { ok: true, rows: enriched, total, page, pageSize };
}

// One place decides whether a client-supplied domain is one of ours, so the page, the id list
// and the export can never disagree about which rows the "only ads we have an article for"
// filter keeps. Returns the same params with `filters.ourDomain` either a real domain of ours
// or null - an unknown value is dropped rather than queried for, and an unreachable articles DB
// degrades to "no domain chosen" instead of breaking the feed. Never throws.
async function withCleanDomain(params) {
  const p = params || {};
  const dom = String(p.filters?.ourDomain || '').trim();
  const ok = dom && articlesConfigured() && await isOurDomain(dom);
  return { ...p, filters: { ...(p.filters || {}), ourDomain: ok ? dom : null } };
}

// The panel behind an owned row: our own articles made from this competitor URL. Loaded on
// demand when a flagged ad's Detail opens (the family can be large, so it is never shipped with
// the feed). parent_url is the exact article_lineage parent this ad matched (server-attached),
// so the lookup is a precise sister-family read, not a guess. Signed-in gate, like the feed.
export async function loadOwnedSisters(parentUrl) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  const url = String(parentUrl || '').trim();
  if (!url) return { ok: true, sisters: [] };
  try {
    const map = await getSisterLinksForUrls([url], null);
    const sisters = map[url] || [];
    console.info('[owned sisters] fetched', { parent: url.slice(0, 80), count: sisters.length });
    return { ok: true, sisters };
  } catch (e) {
    console.error('[owned sisters] failed', String(e?.message || e));
    return { ok: false, error: 'Could not load our versions', sisters: [] };
  }
}

export async function loadFeedFacets(selectedFeeds) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  return { ok: true, facets: await getFeedFacets(Array.isArray(selectedFeeds) ? selectedFeeds : []) };
}

export async function loadFeedTicker() {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  return { ok: true, ticker: await getFeedTicker() };
}

// Every row matching the current filter set - or an explicit id list (a selection) - for
// the CSV download. Signed-in is the gate, not export_data: the CSV button has always been
// available to every account (the data used to sit in their browser wholesale), and
// loadSecondaryTab/loadFullFeed already hand full row sets to any signed-in user. Pushing
// to Google Sheets stays behind export_data (exportToSheet below).
export async function loadFeedExport(params) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  const clean = await withCleanDomain(params);
  const rows = await getFeedExport(clean);
  // The CSV carries the same Our Articles columns the table shows, so a download is not a
  // downgrade of what is on screen.
  const enriched = await attachOurArticles(rows, clean.filters.ourDomain);
  console.info('[feed export action]', { rows: enriched.length });
  return { ok: true, rows: enriched };
}

// The id list matching the current filter set, in sort order, optionally capped - what
// "select all matching" and "select first N" read when the rows live server-side. Ids only,
// so the payload stays small at any feed size. Read-only: any signed-in account.
export async function loadFeedIds(params) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  const ids = await getFeedIds(await withCleanDomain(params));
  return { ok: true, ids };
}

// The whole feed with metrics attached - what the page itself shipped on every load before
// the server-side feed. The Competitors, Trends and Pipeline views still analyse every ad
// in the browser, so they fetch this once, on first open, the way the secondary tabs do.
// Read-only, so the gate matches the feed: any signed-in account.
export async function loadFullFeed() {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  const [rows, metricsIndex] = await Promise.all([getAds(), getSheetMetricsIndex()]);
  const { ads, matched } = attachSheetMetrics(rows, metricsIndex);
  console.info('[full feed]', { rows: ads.length, matched });
  return { ok: true, ads };
}

// Ads held per tracked domain, for Control Room's Held column - counted in the database
// now that the page no longer ships every ad. Read-only: any signed-in account.
export async function loadDomainAdCounts() {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  return { ok: true, counts: await getDomainAdCounts() };
}

export async function updateAdWorkflow(adId, patch) {
  await requireCapability('edit_ads');
  const set = pick(patch, AD_FIELDS);
  if (!Object.keys(set).length) return;
  const sql = getSql();
  await sql`update ads set ${sql(set)} where ad_archive_id = ${adId}`;
  bustAdsCache();
  revalidatePath('/');
}

// Decide review-queue ads: approve moves them into the feed, reject keeps the
// row (so the scraper's dedup never re-imports the ad) but hides it for good.
// Scoped to pending rows so a stale tab can never flip an ad someone else
// already decided on.
export async function reviewAds(ids, decision) {
  await requireCapability('edit_ads');
  if (!Array.isArray(ids) || !ids.length) return { ok: false, reason: 'no-ids' };
  if (!['approved', 'rejected'].includes(decision)) return { ok: false, reason: 'bad-decision' };
  const clean = [...new Set(ids.map(String))].slice(0, 1000);
  const sql = getSql();
  const rows = await sql`
    update ads set review_status = ${decision}
    where ad_archive_id = any(${clean}) and review_status = 'pending'
    returning ad_archive_id
  `;
  console.info('[review decide]', { decision, requested: clean.length, updated: rows.length });
  bustAdsCache();
  revalidatePath('/');
  return { ok: true, updated: rows.length };
}

// Clear a prohibited-content flag: a human in the Filtered view says an ad the model
// hid is actually fine, so we set content_flag = 'none', which returns it to the feed.
// Scoped to currently-flagged rows so a stale tab can't re-open something already
// cleared, and a re-scrape never re-hides it (content_flag is insert-only in the
// scraper's upsert - see db._UPDATE_COLUMNS). We only ever clear TO 'none' here; the
// model is the only thing that sets a category, so this cannot mislabel an ad.
export async function clearContentFlag(ids) {
  await requireCapability('edit_ads');
  if (!Array.isArray(ids) || !ids.length) return { ok: false, reason: 'no-ids' };
  const clean = [...new Set(ids.map(String))].slice(0, 1000);
  const sql = getSql();
  const rows = await sql`
    update ads set content_flag = 'none'
    where ad_archive_id = any(${clean})
      and content_flag is not null and content_flag <> 'none'
    returning ad_archive_id
  `;
  console.info('[content-flag clear]', { requested: clean.length, updated: rows.length });
  bustAdsCache();
  revalidatePath('/');
  return { ok: true, updated: rows.length };
}

// Restore rejected ads to the feed: a human in the Rejected list wants one back, so we
// flip review_status 'rejected' -> 'approved'. Scoped to currently-rejected rows so a
// stale tab can't re-decide an ad someone else already handled. Restoring to 'approved'
// sticks - the scraper's resurface path only reopens 'rejected' rows, never 'approved'
// ones - so a later sighting won't quietly undo the restore.
export async function restoreRejectedAds(ids) {
  await requireCapability('edit_ads');
  if (!Array.isArray(ids) || !ids.length) return { ok: false, reason: 'no-ids' };
  const clean = [...new Set(ids.map(String))].slice(0, 1000);
  const sql = getSql();
  const rows = await sql`
    update ads set review_status = 'approved'
    where ad_archive_id = any(${clean}) and review_status = 'rejected'
    returning ad_archive_id
  `;
  console.info('[rejected restore]', { requested: clean.length, updated: rows.length });
  bustAdsCache();
  revalidatePath('/');
  return { ok: true, updated: rows.length };
}

export async function deleteAds(ids) {
  await requireCapability('edit_ads');
  if (!Array.isArray(ids) || !ids.length) return;
  const sql = getSql();
  await sql`delete from ads where ad_archive_id = any(${ids})`;
  bustAdsCache();
  revalidatePath('/');
}

export async function bulkUpdateAds(ids, patch) {
  await requireCapability('edit_ads');
  if (!Array.isArray(ids) || !ids.length) return;
  const set = pick(patch, AD_FIELDS);
  if (!Object.keys(set).length) return;
  const sql = getSql();
  await sql`update ads set ${sql(set)} where ad_archive_id = any(${ids})`;
  bustAdsCache();
  revalidatePath('/');
}

// Re-scrape the domains behind the given ads so their rank / last_seen refresh.
// The pipeline is per-query, so this marks the matching tracked domains due (and
// dispatches the workflow if configured); the scrape then upserts fresh data.
export async function refreshAds(ids) {
  await requireCapability('run_scrapes');
  if (!Array.isArray(ids) || !ids.length) return { ok: false, matched: 0 };
  const sql = getSql();
  const rows = await sql`select distinct domain from ads where ad_archive_id = any(${ids}) and domain is not null`;
  const doms = rows.map((r) => r.domain);
  if (!doms.length) return { ok: false, matched: 0, reason: 'no-domain' };
  // Mark already-tracked domains due (re-enabling any that were paused).
  const bumped = await sql`
    update domains set next_run_at = now(), enabled = true
    where query = any(${doms}) returning query
  `;
  const tracked = new Set(bumped.map((r) => r.query));

  // Auto-track any domain not yet in Control Room, so refresh always works.
  let added = 0;
  for (const d of doms) {
    if (tracked.has(d)) continue;
    const ins = await sql`
      insert into domains (query, country, active_status, max_ads, interval_days, next_run_at)
      values (${d}, 'ALL', 'active', 100, 3, now())
      on conflict (query, country) do update set next_run_at = now(), enabled = true
      returning id
    `;
    if (ins.length) added += 1;
  }
  revalidatePath('/');

  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO;
  let dispatched = false;
  if (token && repo) {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/scrape.yml/dispatches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ ref: 'main' }),
      });
      dispatched = r.ok;
    } catch {
      // ignore
    }
  }
  return { ok: true, matched: tracked.size + added, added, dispatched, doms };
}

export async function addDomain(data) {
  await requireCapability('manage_domains');
  const sql = getSql();
  await sql`
    insert into domains (query, country, active_status, max_ads, interval_days, feed)
    values (${data.query}, ${data.country || 'ALL'}, ${data.active_status || 'active'},
            ${data.max_ads || 100}, ${clampDays(data.interval_days, 3)}, ${data.feed || null})
    on conflict (query, country) do nothing
  `;
  revalidatePath('/');
}

// Clamp an incoming interval to the DB's 1..365 CHECK so a bad value fails safe in
// the app rather than at the database. Falls back to `dflt` when absent/unparseable.
function clampDays(v, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(365, Math.max(1, n));
}

// Keep a bulk-set Max Ads sane (1..1000) so one fat-fingered value can't blow up a
// scrape's scope across many rows at once.
function clampMaxAds(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 100;
  return Math.min(1000, Math.max(1, n));
}

export async function updateDomain(id, patch) {
  await requireCapability('manage_domains');
  const set = pick(patch, DOMAIN_FIELDS);
  if (!Object.keys(set).length) return;
  const sql = getSql();
  // Changing the frequency also re-spaces the next run from the last one, so
  // "Next Due" reflects the new interval immediately instead of on the next scrape.
  // Any other fields in the same patch are written first with the normal helper.
  if ('interval_days' in set) {
    const days = clampDays(set.interval_days, 3);
    delete set.interval_days;
    if (Object.keys(set).length) await sql`update domains set ${sql(set)} where id = ${id}`;
    await sql`update domains
                 set interval_days = ${days},
                     next_run_at = coalesce(last_run_at, now()) + make_interval(days => ${days})
               where id = ${id}`;
    revalidatePath('/');
    return;
  }
  await sql`update domains set ${sql(set)} where id = ${id}`;
  revalidatePath('/');
}

export async function deleteDomain(id) {
  await requireCapability('manage_domains');
  const sql = getSql();
  await sql`delete from domains where id = ${id}`;
  revalidatePath('/');
}

// Apply one change (status, feed, max ads, or cadence) to many tracked rows at
// once. Mirrors updateDomain's rules: fields are restricted to DOMAIN_FIELDS,
// max_ads/interval_days are clamped, and an interval change re-spaces next_run_at
// so "Next Due" reflects the new cadence immediately.
export async function bulkUpdateDomains(ids, patch) {
  await requireCapability('manage_domains');
  const clean = cleanDomainIds(ids);
  if (!clean.length) return;
  const set = pick(patch, DOMAIN_FIELDS);
  if ('max_ads' in set) set.max_ads = clampMaxAds(set.max_ads);
  if (!Object.keys(set).length) return;
  const sql = getSql();
  if ('interval_days' in set) {
    const days = clampDays(set.interval_days, 3);
    delete set.interval_days;
    if (Object.keys(set).length) await sql`update domains set ${sql(set)} where id = any(${clean}::uuid[])`;
    await sql`update domains
                 set interval_days = ${days},
                     next_run_at = coalesce(last_run_at, now()) + make_interval(days => ${days})
               where id = any(${clean}::uuid[])`;
    revalidatePath('/');
    return;
  }
  await sql`update domains set ${sql(set)} where id = any(${clean}::uuid[])`;
  revalidatePath('/');
}

export async function deleteDomains(ids) {
  await requireCapability('manage_domains');
  const clean = cleanDomainIds(ids);
  if (!clean.length) return;
  const sql = getSql();
  await sql`delete from domains where id = any(${clean}::uuid[])`;
  revalidatePath('/');
}

export async function addFeed(name) {
  await requireCapability('manage_domains');
  const n = String(name || '').trim();
  if (!n) return;
  const sql = getSql();
  await sql`insert into feeds (name) values (${n}) on conflict (name) do nothing`;
  revalidatePath('/');
}

export async function deleteFeed(id) {
  await requireCapability('manage_domains');
  const sql = getSql();
  await sql`delete from feeds where id = ${id}`;
  revalidatePath('/');
}

// Manual "Run now": make every enabled domain due immediately, then (if a
// GitHub dispatch token is configured) kick the scrape workflow so it runs at
// once. Without the token it still marks them due for the next scheduled tick.
export async function triggerScrape() {
  await requireCapability('run_scrapes');
  const sql = getSql();
  await sql`update domains set next_run_at = now() where enabled`;
  revalidatePath('/');

  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO; // e.g. "yoav-prog/ad-lib-dashboard"
  if (!token || !repo) {
    return { ok: true, dispatched: false, reason: 'no-dispatch-token' };
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/scrape.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    return { ok: r.ok, dispatched: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, dispatched: false, reason: String(e) };
  }
}

// Targeted "Run selected": scrape exactly the given tracked rows (one or many),
// each with its own settings, in isolation from the rest. Dispatches the scrape
// workflow with the selected domain ids so the runner scrapes only those and
// advances only their schedules. Without a dispatch token (or if the workflow on
// main does not yet declare the domain_ids input, e.g. before this branch merges)
// we fall back to marking just those rows due; the scheduled runner then picks
// them up on its next tick, alongside anything else already due. Returns what it
// did so the UI can report honestly. Capped at 50 rows per targeted run.
export async function runDomains(ids) {
  await requireCapability('run_scrapes');
  const clean = cleanDomainIds(ids, 50);
  if (!clean.length) return { ok: false, reason: 'no-ids' };

  const sql = getSql();
  const markDue = async () => {
    // Cast to uuid[]: id is a uuid column and there is no uuid = text operator.
    await sql`update domains set next_run_at = now(), enabled = true where id = any(${clean}::uuid[])`;
    revalidatePath('/');
  };

  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO;
  if (!token || !repo) {
    await markDue();
    return { ok: true, dispatched: false, count: clean.length, reason: 'no-dispatch-token' };
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/scrape.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ ref: 'main', inputs: { domain_ids: clean.join(',') } }),
    });
    if (r.ok) return { ok: true, dispatched: true, count: clean.length, status: r.status };
    // Non-ok (e.g. 422 when main has not merged the domain_ids input yet): degrade
    // to marking due so the click is never a no-op.
    await markDue();
    return { ok: true, dispatched: false, count: clean.length, reason: 'dispatch-failed', status: r.status };
  } catch (e) {
    await markDue();
    return { ok: true, dispatched: false, count: clean.length, reason: String(e) };
  }
}

// Stop the current scrape: mark any running run as stopped (frees the run-lock
// and clears the dashboard) and cancel in-progress / queued GitHub workflow runs
// so the runner actually halts, even a background job the dashboard never saw
// claim a run (e.g. one still spinning up). A local CLI run is not killed by
// this; use Ctrl-C. Returns exactly what it stopped so the UI can report it:
//   cleared      - running DB runs marked failed (the visible run, if any)
//   cancelled    - GitHub workflow runs cancelled (the background job)
//   ghConfigured - whether we could reach GitHub to cancel at all
export async function stopRun() {
  await requireCapability('run_scrapes');
  const sql = getSql();
  const clearedRows = await sql`
    update runs set status = 'failed', finished_at = now(),
           error_detail = coalesce(error_detail, 'Stopped from dashboard')
     where status = 'running'
     returning id
  `;
  const cleared = clearedRows.length;
  revalidatePath('/');

  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO;
  const ghConfigured = Boolean(token && repo);
  let cancelled = 0;
  if (ghConfigured) {
    const gh = (path, method = 'GET') => fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    try {
      const res = await gh('/actions/workflows/scrape.yml/runs?per_page=15');
      if (res.ok) {
        const data = await res.json();
        for (const run of data.workflow_runs || []) {
          if (run.status === 'in_progress' || run.status === 'queued' || run.status === 'waiting') {
            const c = await gh(`/actions/runs/${run.id}/cancel`, 'POST');
            if (c.ok) cancelled += 1;
          }
        }
      }
    } catch {
      // ignore; the DB status flip already stopped the dashboard/lock
    }
  }
  return { ok: true, cancelled, cleared, ghConfigured };
}

// Mark a stalled run as failed from the dashboard, used when the heartbeat has
// gone silent. Scoped to status='running' so it can never clobber a run that
// completed on its own in the meantime.
export async function markRunFailed(runId) {
  await requireCapability('run_scrapes');
  const sql = getSql();
  await sql`
    update runs
       set status = 'failed', finished_at = now(),
           error_detail = coalesce(error_detail, 'Marked failed from dashboard (stalled: no heartbeat for 90s+)')
     where id = ${runId} and status = 'running'
  `;
  revalidatePath('/');
}

// Manual "refresh metrics": re-read the campaign metrics sheet right now,
// bypassing the 10-minute cache, then revalidate so every open view re-renders
// with the fresh numbers. The regular path needs no button - each page render
// joins the (cached) sheet automatically - this exists for "the sheet just
// changed, show me now".
export async function refreshMetrics() {
  await requireCapability('export_data');
  await getSheetMetricsIndex(Date.now(), { force: true });
  const status = metricsStatus();
  console.info('[metrics] manual refresh', status);
  revalidatePath('/');
  return { ok: !status.error, campaigns: status.campaigns, error: status.error };
}

// Push the current Fresh Finds view to a Google Sheet the caller names by id + tab,
// exporting only the columns they picked. The client sends the ad ids for the whole
// filtered view and the chosen column keys; the rows are re-read from the DB here so
// the payload is small and the exported data is server-authoritative. New rows are
// appended and ones already in the tab (matched by Ad ID, when that column is included)
// are skipped. Auth is the project's existing service account (see lib/sheets). Returns
// a summary, or an { ok:false } with a reason the modal turns into a clear message.
// No row cap: the entire filtered view exports (deduped by id). The request-body limit
// in next.config bounds the raw id payload, and lib/sheets chunks the write so a large
// export never rides in one oversized Sheets request.
const SHEET_ID_RE = /^[a-zA-Z0-9-_]{20,}$/;

export async function exportToSheet({ spreadsheetId, tabName, adIds, columnKeys, mode, ourDomain } = {}) {
  await requireCapability('export_data');
  const id = String(spreadsheetId || '').trim();
  const tab = String(tabName || '').trim();
  const saEmail = serviceAccountEmail();
  if (!SHEET_ID_RE.test(id)) return { ok: false, reason: 'bad-id', saEmail };
  if (!tab) return { ok: false, reason: 'no-tab', saEmail };
  if (!Array.isArray(adIds) || !adIds.length) return { ok: false, reason: 'no-rows', saEmail };
  if (!sheetsConfigured()) return { ok: false, reason: 'not-configured', saEmail };

  // Trust only known column keys; fall back to the full set. Preserves canonical order.
  const allowed = new Set(DEFAULT_SHEET_COLUMN_KEYS);
  const keys = Array.isArray(columnKeys) ? columnKeys.filter((k) => allowed.has(k)) : [];
  if (Array.isArray(columnKeys) && !keys.length) return { ok: false, reason: 'no-columns', saEmail };
  const writeMode = mode === 'replace' ? 'replace' : 'append';

  const ids = [...new Set(adIds.map(String))];
  const rows0 = await getAdsByIds(ids);
  if (!rows0.length) return { ok: false, reason: 'no-rows', saEmail };
  // The DB rows carry no campaign metrics; re-attach them here so the exported
  // Revenue/Clicks/RPC/Keywords columns match what the table showed.
  const { ads } = attachSheetMetrics(rows0, await getSheetMetricsIndex());
  // Same for our own articles: the Our Articles / Our Article URL / Our Headline columns are
  // built from a live lookup, so an exported sheet says what the table said. Validated the
  // same way the feed validates it - an unknown domain leaves the columns blank.
  const { filters: exportFilters } = await withCleanDomain({ filters: { ourDomain } });
  const enriched = await attachOurArticles(ads, exportFilters.ourDomain);

  const { columns, rows } = buildSheetData(enriched, Date.now(), keys.length ? keys : DEFAULT_SHEET_COLUMN_KEYS);
  try {
    const result = await writeToSheet({ spreadsheetId: id, tabName: tab, columns, rows, mode: writeMode }, Date.now());
    return { ok: true, saEmail, sheetUrl: `https://docs.google.com/spreadsheets/d/${id}`, ...result };
  } catch (e) {
    return { ok: false, reason: e.code === 'PERMISSION' ? 'permission' : 'error', message: String(e.message || e), saEmail };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENT KITS - assign our own article links to competitor ads, export client-safe
// ═══════════════════════════════════════════════════════════════════════════════
// Our links live in a separate, read-only articles DB (lib/articles); the assignment
// ledger lives here in the adintel DB (link_assignments). "Available" means a link's URL
// is not yet in the ledger. Reads require a signed-in session (like the feed); the two
// mutations require export_data (the same gate that guards pushing data to a sheet).

// Our publishing domains, most links first, for the assign panel's domain dropdown.
export async function loadOurDomains() {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  if (!articlesConfigured()) return { ok: false, reason: 'not-configured' };
  try {
    return { ok: true, domains: await listOurDomains() };
  } catch (e) {
    console.error('[kit domains] failed', e);
    return { ok: false, reason: 'error', message: String(e.message || e) };
  }
}

// Our publishing networks (Tonic, System1, ...), for the assign panel's network filter.
export async function loadOurNetworks() {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  if (!articlesConfigured()) return { ok: false, reason: 'not-configured' };
  try {
    return { ok: true, networks: await listOurNetworks() };
  } catch (e) {
    console.error('[kit networks] failed', e);
    return { ok: false, reason: 'error', message: String(e.message || e) };
  }
}

// Available links on one of our domains, ranked best-first for the given ad and with
// already-assigned URLs removed. The ranking is done client-side (pure ui.rankLinks) so
// this stays a thin read; the DB narrows by domain / network / language / country / search.
export async function searchOurLinks({ domain, network, language, country, search } = {}) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  if (!articlesConfigured()) return { ok: false, reason: 'not-configured' };
  const dom = String(domain || '').trim();
  if (!dom) return { ok: false, reason: 'no-domain' };
  try {
    const assigned = await getAssignedUrlsForDomain(dom);
    const links = await searchArticleLinks({
      domain: dom,
      network: network || null,
      language: language || null,
      country: country || null,
      search: search || null,
      excludeUrls: assigned,
      limit: 200,
    });
    return { ok: true, links };
  } catch (e) {
    console.error('[kit search] failed', e);
    return { ok: false, reason: 'error', message: String(e.message || e) };
  }
}

// The our-link assignments for a set of competitor ads, keyed by ad_archive_id.
export async function loadKitAssignments(adIds) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  if (!Array.isArray(adIds) || !adIds.length) return { ok: true, assignments: {} };
  const ids = [...new Set(adIds.map(String))].slice(0, 2000);
  return { ok: true, assignments: await getAssignmentsByAdIds(ids) };
}

const KIT_URL_RE = /^https?:\/\/.+/i;

// Assign one of our links to a competitor ad. Replaces any prior assignment for that ad
// (freeing its old link back to available), then inserts, both in one transaction. A
// unique violation on our_url means the link was taken in the meantime - surfaced as a
// clean 'taken' reason rather than a 500.
export async function assignOurLink({ adId, url, domain, headline, articleId } = {}) {
  await requireCapability('export_data');
  const ad = String(adId || '').trim();
  const u = String(url || '').trim();
  const dom = String(domain || '').trim().slice(0, 255);
  if (!ad) return { ok: false, reason: 'no-ad' };
  if (!KIT_URL_RE.test(u) || u.length > 2048) return { ok: false, reason: 'bad-url' };
  if (!dom) return { ok: false, reason: 'no-domain' };
  const head = headline ? String(headline).slice(0, 500) : null;
  const artId = Number.isFinite(Number(articleId)) ? Math.trunc(Number(articleId)) : null;
  const by = (await getCurrentUser())?.email || null;
  const sql = getSql();
  try {
    await sql.begin(async (tx) => {
      await tx`delete from link_assignments where ad_archive_id = ${ad}`;
      await tx`
        insert into link_assignments (ad_archive_id, our_url, our_domain, our_headline, our_article_id, assigned_by)
        values (${ad}, ${u}, ${dom}, ${head}, ${artId}, ${by})
      `;
    });
  } catch (e) {
    if (e.code === '23505' || String(e.message || e).toLowerCase().includes('unique')) {
      console.warn('[kit assign] link already taken', { adId: ad, domain: dom });
      return { ok: false, reason: 'taken' };
    }
    console.error('[kit assign] failed', e);
    return { ok: false, reason: 'error', message: String(e.message || e) };
  }
  console.info('[kit assign]', { adId: ad, domain: dom, articleId: artId });
  revalidatePath('/');
  return { ok: true };
}

// Assign our links to a batch of subjects, drawing each subject's link from a pool SCOPED
// to that subject's own country+language (when matchByAd is on). Grouping by locale and
// pre-filtering the article query at the DB is what guarantees a be/fr ad only ever sees
// be/fr links - the pool literally cannot contain a France or Dutch article - while a
// shared `used` set keeps every link distinct across the whole batch. The old single
// domain-wide pool (newest 1000, no country filter) could miss a locale's links entirely
// and then drift onto whatever same-language link was free, which is how a Belgian ad ended
// up on a France (and even a Dutch) article. Each subject exposes { country, language | creative_language };
// returns { assigned, unassigned } exactly like planBulkAssignment. With matchByAd off it
// falls back to one un-scoped pool (legacy "any link" behavior).
async function assignLinksScoped(subjects, { domain, network, taken = [], matchByAd = true } = {}) {
  const groups = new Map();
  for (const s of subjects) {
    const country = matchByAd ? String(s.country || '').toUpperCase() : '';
    const language = matchByAd ? langCode(s.creative_language || s.language) : '';
    const key = `${country}|${language}`;
    if (!groups.has(key)) groups.set(key, { country, language, subjects: [] });
    groups.get(key).subjects.push(s);
  }
  const used = new Set((taken || []).map(String));
  const assigned = [];
  const unassigned = [];
  for (const g of groups.values()) {
    const pool = await searchArticleLinks({
      domain, network: network || null,
      country: g.country || null, language: g.language || null,
      excludeUrls: [...used], limit: 500,
    });
    const r = planBulkAssignment(g.subjects, pool, { taken: [...used], requireLangMatch: matchByAd, requireCountryMatch: matchByAd });
    for (const x of r.assigned) used.add(String(x.link.url));
    assigned.push(...r.assigned);
    unassigned.push(...r.unassigned);
  }
  return { assigned, unassigned };
}

// Assign our links to many competitor ads at once: for each SELECTED ad still without an
// assignment, pick the best available link on the chosen domain, never repeating a link
// within the batch. Ads that already have a link are left untouched; ads with no eligible
// link on that domain are reported so the UI can say so. Capped so one click can't fan out
// unbounded work. Returns the assignments that landed (same shape as loadKitAssignments)
// for an in-place UI update.
export async function bulkAssignOurLinks({ adIds, domain, network, matchByAd = true } = {}) {
  await requireCapability('export_data');
  if (!articlesConfigured()) return { ok: false, reason: 'not-configured' };
  const dom = String(domain || '').trim();
  if (!dom) return { ok: false, reason: 'no-domain' };
  if (!Array.isArray(adIds) || !adIds.length) return { ok: false, reason: 'no-rows' };
  const ids = [...new Set(adIds.map(String))].slice(0, 200);
  const by = (await getCurrentUser())?.email || null;

  try {
    const [ads, existing, taken] = await Promise.all([
      getAdsByIds(ids),                    // preserves the caller's order, so top rows pick first
      getAssignmentsByAdIds(ids),
      getAssignedUrlsForDomain(dom),
    ]);
    const targets = ads.filter((a) => !existing[a.ad_archive_id]);
    const alreadyHad = ads.length - targets.length;
    if (!targets.length) return { ok: true, assigned: {}, matched: 0, noLink: [], alreadyHad };

    // Each ad draws from a pool scoped to its own country+language, so a be/fr ad is only
    // ever offered be/fr links (never France, never Dutch); vertical ranks within that and
    // links stay distinct across the batch and against what's globally taken. A network
    // filter still keeps a Tonic kit to Tonic links.
    const { assigned, unassigned } = await assignLinksScoped(targets, { domain: dom, network, taken, matchByAd });
    if (!assigned.length) {
      return { ok: true, assigned: {}, matched: 0, noLink: unassigned.map((a) => a.ad_archive_id), alreadyHad };
    }

    const sql = getSql();
    await sql.begin(async (tx) => {
      for (const { ad, link } of assigned) {
        await tx`
          insert into link_assignments (ad_archive_id, our_url, our_domain, our_headline, our_article_id, assigned_by)
          values (${ad.ad_archive_id}, ${link.url}, ${link.domain || dom}, ${link.headline || null},
                  ${Number.isFinite(Number(link.id)) ? Math.trunc(Number(link.id)) : null}, ${by})
          on conflict (our_url) do nothing
        `;
      }
    });

    // Re-read to reflect exactly what landed (a concurrent grab could skip one via on-conflict).
    const fresh = await getAssignmentsByAdIds(assigned.map(({ ad }) => ad.ad_archive_id));
    console.info('[kit bulk assign]', { domain: dom, requested: ids.length, targets: targets.length, matched: Object.keys(fresh).length, noLink: unassigned.length, alreadyHad });
    revalidatePath('/');
    return { ok: true, assigned: fresh, matched: Object.keys(fresh).length, noLink: unassigned.map((a) => a.ad_archive_id), alreadyHad };
  } catch (e) {
    console.error('[kit bulk assign] failed', e);
    return { ok: false, reason: 'error', message: String(e.message || e) };
  }
}

// Remove a competitor ad's our-link assignment, freeing that link back to available.
export async function unassignOurLink({ adId } = {}) {
  await requireCapability('export_data');
  const ad = String(adId || '').trim();
  if (!ad) return { ok: false, reason: 'no-ad' };
  const sql = getSql();
  const rows = await sql`delete from link_assignments where ad_archive_id = ${ad} returning our_url`;
  console.info('[kit unassign]', { adId: ad, removed: rows.length });
  revalidatePath('/');
  return { ok: true, removed: rows.length };
}

// Export a client kit to a Google Sheet: each competitor ad's creative beside OUR
// assigned link, the competitor's own link/slug/query columns omitted by construction
// (KIT_COLUMNS). Only ads that HAVE an assignment are written, so a kit never ships with a
// blank Our Link. Mirrors exportToSheet's gate, validation and server-authoritative read.
export async function exportKitToSheet({ spreadsheetId, tabName, adIds, columnKeys, mode } = {}) {
  await requireCapability('export_data');
  const id = String(spreadsheetId || '').trim();
  const tab = String(tabName || '').trim();
  const saEmail = serviceAccountEmail();
  if (!SHEET_ID_RE.test(id)) return { ok: false, reason: 'bad-id', saEmail };
  if (!tab) return { ok: false, reason: 'no-tab', saEmail };
  if (!Array.isArray(adIds) || !adIds.length) return { ok: false, reason: 'no-rows', saEmail };
  if (!sheetsConfigured()) return { ok: false, reason: 'not-configured', saEmail };

  const allowed = new Set(DEFAULT_KIT_COLUMN_KEYS);
  const keys = Array.isArray(columnKeys) ? columnKeys.filter((k) => allowed.has(k)) : [];
  if (Array.isArray(columnKeys) && !keys.length) return { ok: false, reason: 'no-columns', saEmail };
  const writeMode = mode === 'replace' ? 'replace' : 'append';

  const ids = [...new Set(adIds.map(String))];
  const rows0 = await getAdsByIds(ids);
  if (!rows0.length) return { ok: false, reason: 'no-rows', saEmail };
  const assignments = await getAssignmentsByAdIds(ids);
  // Join our-link onto each ad; keep only ads that actually have an assignment.
  const joined = rows0
    .map((a) => {
      const asg = assignments[a.ad_archive_id];
      return asg ? { ...a, our_url: asg.our_url, our_domain: asg.our_domain, our_headline: asg.our_headline } : null;
    })
    .filter(Boolean);
  if (!joined.length) return { ok: false, reason: 'no-assignments', saEmail };
  const { ads } = attachSheetMetrics(joined, await getSheetMetricsIndex());

  const { columns, rows } = buildSheetData(ads, Date.now(), keys.length ? keys : DEFAULT_KIT_COLUMN_KEYS, KIT_COLUMNS);
  try {
    const result = await writeToSheet({ spreadsheetId: id, tabName: tab, columns, rows, mode: writeMode }, Date.now());
    console.info('[kit export]', { rows: rows.length, tab, mode: writeMode });
    return { ok: true, saEmail, sheetUrl: `https://docs.google.com/spreadsheets/d/${id}`, ...result };
  } catch (e) {
    return { ok: false, reason: e.code === 'PERMISSION' ? 'permission' : 'error', message: String(e.message || e), saEmail };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENT KITS - RSOC competitor source (ref_comp_rows)
// ═══════════════════════════════════════════════════════════════════════════════
// The competitor data Maya's workflow actually uses: RSOC rows (network/vertical/geo/
// adtitle/revenue/RPC/keywords), our own domains excluded. Assignments key on comp_row_id
// (source='rsoc'); global link availability (unique our_url) is shared with the Meta source.

export async function loadCompFacets() {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  if (!articlesConfigured()) return { ok: false, reason: 'not-configured' };
  try {
    return { ok: true, facets: await getCompFacets() };
  } catch (e) {
    console.error('[kit comp facets] failed', e);
    return { ok: false, reason: 'error', message: String(e.message || e) };
  }
}

export async function loadCompRows({ network, vertical, geo, search } = {}) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  if (!articlesConfigured()) return { ok: false, reason: 'not-configured' };
  try {
    const rows = await searchCompRows({
      network: network || null, vertical: vertical || null, geo: geo || null, search: search || null, limit: 200,
    });
    // Best-effort: attach a Meta creative (image + description) to each comp row whose landing
    // host also appears in the adintel ads (a coarse host match, ~1/3 of rows; the rest keep
    // just their title). Gives the RSOC deliverable the image + description Meta ads carry.
    const hosts = [...new Set(rows.map((r) => hostOf(r.url)).filter(Boolean))];
    let creatives = {};
    try { creatives = hosts.length ? await getMetaCreativesByHosts(hosts) : {}; }
    catch (e) { console.warn('[kit comp creative] lookup failed (rows still returned)', String(e.message || e)); }
    // Flag rows that have an exact sister family (we cloned this competitor's article), so the
    // UI can badge them and offer the precise "assign sister" path.
    let sisterUrls = new Set();
    try { sisterUrls = new Set(await getSisterFamilyUrls(rows.map((r) => r.url))); }
    catch (e) { console.warn('[kit comp sisters] flag lookup failed', String(e.message || e)); }
    const enriched = rows.map((r) => {
      const c = creatives[hostOf(r.url)];
      return { ...r, thumb: c?.thumb || null, meta_body: c?.body || null, has_sister: sisterUrls.has(r.url) };
    });
    console.info('[kit comp rows]', { returned: enriched.length, creatives: Object.keys(creatives).length, sisters: sisterUrls.size });
    return { ok: true, rows: enriched };
  } catch (e) {
    console.error('[kit comp rows] failed', e);
    return { ok: false, reason: 'error', message: String(e.message || e) };
  }
}

export async function loadCompAssignments(compRowIds) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  if (!Array.isArray(compRowIds) || !compRowIds.length) return { ok: true, assignments: {} };
  return { ok: true, assignments: await getAssignmentsByCompIds(compRowIds.slice(0, 2000)) };
}

// Every link assignment (both sources), newest first, each enriched with the competitor it
// points at - the Meta ad's headline/creative or the RSOC comp row's title/network/vertical
// /geo. This is the "where did everything I chose go" view. Read-only, signed-in. A subject
// that was since deleted still shows the saved link, marked so.
export async function loadAllAssignments() {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  const sql = getSql();
  const rows = await sql`
    select ad_archive_id, comp_row_id, source, our_url, our_domain, our_headline, assigned_by, assigned_at
    from link_assignments
    order by assigned_at desc nulls last
    limit 2000
  `;
  const adIds = rows.filter((r) => r.ad_archive_id).map((r) => r.ad_archive_id);
  const compIds = rows.filter((r) => r.comp_row_id != null).map((r) => r.comp_row_id);
  const [ads, comps] = await Promise.all([
    adIds.length ? getAdsByIds(adIds) : [],
    compIds.length && articlesConfigured() ? getCompRowsByIds(compIds) : [],
  ]);
  const adById = new Map(ads.map((a) => [a.ad_archive_id, a]));
  const compById = new Map(comps.map((c) => [c.id, c]));

  const items = rows.map((r) => {
    const base = {
      source: r.source || (r.comp_row_id != null ? 'rsoc' : 'meta'),
      our_url: r.our_url,
      our_domain: r.our_domain,
      our_headline: r.our_headline,
      assigned_by: r.assigned_by,
      assigned_at: r.assigned_at ? new Date(r.assigned_at).toISOString() : null,
    };
    if (r.ad_archive_id) {
      const a = adById.get(r.ad_archive_id);
      return {
        ...base, ref: r.ad_archive_id,
        subject: a ? (a.title || a.caption || a.body_text || '(untitled ad)') : '(ad removed)',
        subjectMeta: a ? [a.domain, a.country, a.vertical].filter(Boolean).join(' · ') : '',
        thumb: a ? (a.original_image_urls?.[0] || a.video_preview_url || null) : null,
      };
    }
    const c = compById.get(r.comp_row_id);
    return {
      ...base, ref: r.comp_row_id,
      subject: c ? (c.adtitle || '(untitled)') : '(row removed)',
      subjectMeta: c ? [c.network, c.vertical, c.geo].filter(Boolean).join(' · ') : '',
      thumb: null,
    };
  });
  console.info('[kit saved] loaded', { total: items.length, meta: adIds.length, rsoc: compIds.length });
  return { ok: true, items };
}

// Assign our link to one RSOC comp row (replaces any prior assignment for that row).
export async function assignOurLinkToComp({ compRowId, url, domain, headline, articleId } = {}) {
  await requireCapability('export_data');
  const cid = Math.trunc(Number(compRowId));
  const u = String(url || '').trim();
  const dom = String(domain || '').trim().slice(0, 255);
  if (!Number.isFinite(cid)) return { ok: false, reason: 'no-ad' };
  if (!KIT_URL_RE.test(u) || u.length > 2048) return { ok: false, reason: 'bad-url' };
  if (!dom) return { ok: false, reason: 'no-domain' };
  const head = headline ? String(headline).slice(0, 500) : null;
  const artId = Number.isFinite(Number(articleId)) ? Math.trunc(Number(articleId)) : null;
  const by = (await getCurrentUser())?.email || null;
  const sql = getSql();
  try {
    await sql.begin(async (tx) => {
      await tx`delete from link_assignments where comp_row_id = ${cid}`;
      await tx`
        insert into link_assignments (comp_row_id, source, our_url, our_domain, our_headline, our_article_id, assigned_by)
        values (${cid}, 'rsoc', ${u}, ${dom}, ${head}, ${artId}, ${by})
      `;
    });
  } catch (e) {
    if (e.code === '23505' || String(e.message || e).toLowerCase().includes('unique')) {
      console.warn('[kit comp assign] link already taken', { compRowId: cid, domain: dom });
      return { ok: false, reason: 'taken' };
    }
    console.error('[kit comp assign] failed', e);
    return { ok: false, reason: 'error', message: String(e.message || e) };
  }
  console.info('[kit comp assign]', { compRowId: cid, domain: dom, articleId: artId });
  revalidatePath('/');
  return { ok: true };
}

export async function unassignFromComp({ compRowId } = {}) {
  await requireCapability('export_data');
  const cid = Math.trunc(Number(compRowId));
  if (!Number.isFinite(cid)) return { ok: false, reason: 'no-ad' };
  const sql = getSql();
  const rows = await sql`delete from link_assignments where comp_row_id = ${cid} returning our_url`;
  console.info('[kit comp unassign]', { compRowId: cid, removed: rows.length });
  revalidatePath('/');
  return { ok: true, removed: rows.length };
}

// Bulk-assign our links to many RSOC comp rows. Comp rows are re-read server-side by id, so
// matching (via geo->language) and the persisted values never trust client fields. Highest-
// revenue rows should be sent first so they pick the best links.
export async function bulkAssignToComp({ compRowIds, domain, network, matchByAd = true } = {}) {
  await requireCapability('export_data');
  if (!articlesConfigured()) return { ok: false, reason: 'not-configured' };
  const dom = String(domain || '').trim();
  if (!dom) return { ok: false, reason: 'no-domain' };
  const ids = [...new Set((Array.isArray(compRowIds) ? compRowIds : []).map((x) => Math.trunc(Number(x))).filter((n) => Number.isFinite(n)))].slice(0, 200);
  if (!ids.length) return { ok: false, reason: 'no-rows' };
  const by = (await getCurrentUser())?.email || null;

  try {
    const [rows, existing, taken] = await Promise.all([
      getCompRowsByIds(ids),          // server-authoritative, in the given (revenue) order
      getAssignmentsByCompIds(ids),
      getAssignedUrlsForDomain(dom),
    ]);
    const targets = rows.filter((r) => !existing[r.id]);
    const alreadyHad = rows.length - targets.length;
    if (!targets.length) return { ok: true, assigned: {}, matched: 0, noLink: [], alreadyHad };

    // Adapt comp rows to the { language, country, vertical } shape the matcher understands,
    // then draw each subject's link from a pool scoped to its own country+language.
    const subjects = targets.map((r) => ({ ...compToSubject(r), _compId: r.id }));
    const { assigned, unassigned } = await assignLinksScoped(subjects, { domain: dom, network, taken, matchByAd });
    if (!assigned.length) {
      return { ok: true, assigned: {}, matched: 0, noLink: unassigned.map((a) => a._compId), alreadyHad };
    }

    const sql = getSql();
    await sql.begin(async (tx) => {
      for (const { ad, link } of assigned) {
        await tx`
          insert into link_assignments (comp_row_id, source, our_url, our_domain, our_headline, our_article_id, assigned_by)
          values (${ad._compId}, 'rsoc', ${link.url}, ${link.domain || dom}, ${link.headline || null},
                  ${Number.isFinite(Number(link.id)) ? Math.trunc(Number(link.id)) : null}, ${by})
          on conflict (our_url) do nothing
        `;
      }
    });
    const fresh = await getAssignmentsByCompIds(assigned.map(({ ad }) => ad._compId));
    console.info('[kit comp bulk]', { domain: dom, network: network || null, targets: targets.length, matched: Object.keys(fresh).length, noLink: unassigned.length, alreadyHad });
    revalidatePath('/');
    return { ok: true, assigned: fresh, matched: Object.keys(fresh).length, noLink: unassigned.map((a) => a._compId), alreadyHad };
  } catch (e) {
    console.error('[kit comp bulk] failed', e);
    return { ok: false, reason: 'error', message: String(e.message || e) };
  }
}

// Export an RSOC client kit: each competitor comp row beside OUR assigned link, the
// competitor's own URL omitted by construction (COMP_KIT_COLUMNS). Only rows that HAVE an
// assignment are written.
export async function exportCompKitToSheet({ spreadsheetId, tabName, compRowIds, columnKeys, mode } = {}) {
  await requireCapability('export_data');
  const id = String(spreadsheetId || '').trim();
  const tab = String(tabName || '').trim();
  const saEmail = serviceAccountEmail();
  if (!SHEET_ID_RE.test(id)) return { ok: false, reason: 'bad-id', saEmail };
  if (!tab) return { ok: false, reason: 'no-tab', saEmail };
  if (!Array.isArray(compRowIds) || !compRowIds.length) return { ok: false, reason: 'no-rows', saEmail };
  if (!sheetsConfigured()) return { ok: false, reason: 'not-configured', saEmail };

  const allowed = new Set(DEFAULT_COMP_KIT_COLUMN_KEYS);
  const keys = Array.isArray(columnKeys) ? columnKeys.filter((k) => allowed.has(k)) : [];
  if (Array.isArray(columnKeys) && !keys.length) return { ok: false, reason: 'no-columns', saEmail };
  const writeMode = mode === 'replace' ? 'replace' : 'append';

  const ids = [...new Set(compRowIds.map((x) => Math.trunc(Number(x))).filter((n) => Number.isFinite(n)))];
  const rows0 = await getCompRowsByIds(ids);
  if (!rows0.length) return { ok: false, reason: 'no-rows', saEmail };
  const assignments = await getAssignmentsByCompIds(ids);
  let joined = rows0
    .map((r) => {
      const asg = assignments[r.id];
      return asg ? { ...r, our_url: asg.our_url, our_domain: asg.our_domain, our_headline: asg.our_headline } : null;
    })
    .filter(Boolean);
  if (!joined.length) return { ok: false, reason: 'no-assignments', saEmail };

  // Enrich with the matched Meta creative (image + description) so the exported kit carries
  // the competitor image and description where one exists, same as the on-screen RSOC view.
  try {
    const hosts = [...new Set(joined.map((r) => hostOf(r.url)).filter(Boolean))];
    const creatives = hosts.length ? await getMetaCreativesByHosts(hosts) : {};
    joined = joined.map((r) => { const c = creatives[hostOf(r.url)]; return { ...r, thumb: c?.thumb || null, meta_body: c?.body || null }; });
  } catch (e) { console.warn('[kit comp export creative] lookup failed', String(e.message || e)); }

  const { columns, rows } = buildSheetData(joined, Date.now(), keys.length ? keys : DEFAULT_COMP_KIT_COLUMN_KEYS, COMP_KIT_COLUMNS);
  try {
    const result = await writeToSheet({ spreadsheetId: id, tabName: tab, columns, rows, mode: writeMode }, Date.now());
    console.info('[kit comp export]', { rows: rows.length, tab, mode: writeMode });
    return { ok: true, saEmail, sheetUrl: `https://docs.google.com/spreadsheets/d/${id}`, ...result };
  } catch (e) {
    return { ok: false, reason: e.code === 'PERMISSION' ? 'permission' : 'error', message: String(e.message || e), saEmail };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENT KITS - sister-family matching (article_lineage)
// ═══════════════════════════════════════════════════════════════════════════════
// The precise match: a competitor URL we have cloned has a sister family, and our articles
// in that family are the exact sister versions. Works for both sources (the competitor URL
// is a comp row's url or a Meta ad's resolved_url).

// Our available sister links for one competitor URL, ranked (family order), taken removed.
export async function searchSisterLinks({ competitorUrl, network } = {}) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  if (!articlesConfigured()) return { ok: false, reason: 'not-configured' };
  const url = String(competitorUrl || '').trim();
  if (!url) return { ok: true, links: [] };
  try {
    const map = await getSisterLinksForUrls([url], network || null);
    const cand = map[url] || [];
    if (!cand.length) return { ok: true, links: [] };
    const taken = new Set(await getTakenOurUrls(cand.map((l) => l.url)));
    // Cap what the panel shows - a sister family can be thousands of articles.
    return { ok: true, links: cand.filter((l) => !taken.has(l.url)).slice(0, 200) };
  } catch (e) {
    console.error('[kit sisters] search failed', e);
    return { ok: false, reason: 'error', message: String(e.message || e) };
  }
}

// Bulk-assign the sister article to each selected row (Meta ads or RSOC comp rows). For each
// target still without a link, pick an available sister of its competitor URL (network-
// filtered), never repeating one. Ignores the domain picker on purpose - a sister lives on
// whatever domain we published it. Reports rows that already had a link or have no sister.
export async function bulkAssignSisters({ source, ids, network } = {}) {
  await requireCapability('export_data');
  if (!articlesConfigured()) return { ok: false, reason: 'not-configured' };
  const src = source === 'rsoc' ? 'rsoc' : 'meta';
  const clean = src === 'rsoc'
    ? [...new Set((Array.isArray(ids) ? ids : []).map((x) => Math.trunc(Number(x))).filter((n) => Number.isFinite(n)))].slice(0, 200)
    : [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 200);
  if (!clean.length) return { ok: false, reason: 'no-rows' };
  const by = (await getCurrentUser())?.email || null;

  try {
    let subjects;
    let existing;
    if (src === 'rsoc') {
      const rows = await getCompRowsByIds(clean);
      subjects = rows.map((r) => ({ ref: r.id, url: r.url }));
      existing = await getAssignmentsByCompIds(clean);
    } else {
      const rows = await getAdsByIds(clean);
      subjects = rows.map((a) => ({ ref: a.ad_archive_id, url: a.resolved_url || a.link_url }));
      existing = await getAssignmentsByAdIds(clean);
    }
    const alreadyHad = subjects.filter((sub) => existing[sub.ref]).length;
    const targets = subjects.filter((sub) => !existing[sub.ref] && sub.url);
    if (!targets.length) return { ok: true, assigned: {}, matched: 0, noSister: [], alreadyHad };

    const sisterMap = await getSisterLinksForUrls(targets.map((sub) => sub.url), network || null);
    const takenSet = new Set(await getTakenOurUrls(Object.values(sisterMap).flat().map((l) => l.url)));
    const used = new Set(takenSet);
    const toInsert = [];
    const noSister = [];
    for (const sub of targets) {
      const pick = (sisterMap[sub.url] || []).find((l) => !used.has(l.url));
      if (pick) { used.add(pick.url); toInsert.push({ ref: sub.ref, link: pick }); }
      else noSister.push(sub.ref);
    }
    if (!toInsert.length) return { ok: true, assigned: {}, matched: 0, noSister, alreadyHad };

    const sql = getSql();
    await sql.begin(async (tx) => {
      for (const { ref, link } of toInsert) {
        const artId = Number.isFinite(Number(link.id)) ? Math.trunc(Number(link.id)) : null;
        if (src === 'rsoc') {
          await tx`insert into link_assignments (comp_row_id, source, our_url, our_domain, our_headline, our_article_id, assigned_by)
                   values (${ref}, 'rsoc', ${link.url}, ${link.domain}, ${link.headline || null}, ${artId}, ${by})
                   on conflict (our_url) do nothing`;
        } else {
          await tx`insert into link_assignments (ad_archive_id, source, our_url, our_domain, our_headline, our_article_id, assigned_by)
                   values (${ref}, 'meta', ${link.url}, ${link.domain}, ${link.headline || null}, ${artId}, ${by})
                   on conflict (our_url) do nothing`;
        }
      }
    });
    const refs = toInsert.map((t) => t.ref);
    const fresh = src === 'rsoc' ? await getAssignmentsByCompIds(refs) : await getAssignmentsByAdIds(refs);
    console.info('[kit sisters bulk]', { source: src, targets: targets.length, matched: Object.keys(fresh).length, noSister: noSister.length, alreadyHad });
    revalidatePath('/');
    return { ok: true, assigned: fresh, matched: Object.keys(fresh).length, noSister, alreadyHad };
  } catch (e) {
    console.error('[kit sisters bulk] failed', e);
    return { ok: false, reason: 'error', message: String(e.message || e) };
  }
}
