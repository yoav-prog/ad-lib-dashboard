import { getSql } from './db.js';
import { createTtlCache } from './ttl-cache.js';

const iso = (d) => (d ? new Date(d).toISOString() : null);

function mapAd(r) {
  return {
    ad_archive_id: r.ad_archive_id,
    page_id: r.page_id,
    page_name: r.page_name,
    domain: r.domain,
    feed: r.feed,
    caption: r.caption,
    cta_text: r.cta_text,
    body_text: r.body_text,
    cta_type: r.cta_type,
    title: r.title,
    link_description: r.link_description,
    link_url: r.link_url,
    display_format: r.display_format,
    extra_texts: r.extra_texts,
    original_image_urls: r.original_image_urls || [],
    video_hd_url: r.video_hd_url,
    video_preview_url: r.video_preview_url,
    extra_image_urls: r.extra_image_urls || [],
    extra_video_urls: r.extra_video_urls || [],
    publisher_platform: r.publisher_platform || [],
    start_date: iso(r.start_date),
    total_active_time: r.total_active_time,
    resolved_url: r.resolved_url,
    article_content: r.article_content ?? null,
    has_article: r.has_article ?? (r.article_content != null && r.article_content !== ''),
    rank: r.rank,
    language: r.language,
    country: r.country,
    vertical: r.vertical,
    brand: r.brand,
    creative_language: r.creative_language,
    content_flag: r.content_flag,
    rsoc_tier: r.rsoc_tier,
    rsoc_policy_area: r.rsoc_policy_area,
    rsoc_reason: r.rsoc_reason,
    first_seen_at: iso(r.first_seen_at),
    last_seen_at: iso(r.last_seen_at),
    status: r.status,
    owner: r.owner,
    linked_article_url: r.linked_article_url,
    is_saved: r.is_saved,
    tags: r.tags || [],
    notes: r.notes,
    review_status: r.review_status,
  };
}

// Every ad column the feed ships to the browser. article_content and article_title
// are deliberately absent: the landing-article bodies dwarf every other field
// combined (tens of MB across a few thousand ads) and only the Detail view reads
// them, so it fetches both on demand (getAdArticle) guided by the has_article flag.
// article_title rode along in the feed for a while at ~5% of the payload for a field
// nothing but the Detail heading shows; it now loads with its body instead.
const FEED_COLUMNS = [
  'ad_archive_id', 'page_id', 'page_name', 'domain', 'feed', 'caption', 'cta_text',
  'body_text', 'cta_type', 'title', 'link_description', 'link_url', 'display_format',
  'extra_texts', 'original_image_urls', 'video_hd_url', 'video_preview_url',
  'extra_image_urls', 'extra_video_urls', 'publisher_platform', 'start_date',
  'total_active_time', 'resolved_url', 'rank', 'language', 'country', 'vertical',
  'brand', 'creative_language', 'content_flag', 'rsoc_tier', 'rsoc_policy_area', 'rsoc_reason',
  'first_seen_at', 'last_seen_at', 'status', 'owner', 'linked_article_url',
  'is_saved', 'tags', 'notes', 'review_status',
];

// A row is prohibited-content when its content_flag is a real category (anything but
// 'none'). NULL (not classified yet) and 'none' (classified clean) stay visible, so
// the feed is never blanked before the backfill runs. These two fragments are the one
// place the rule lives: the feed and the review queue exclude prohibited rows, the
// Filtered view selects exactly them, and all three read the same definition (alias a).
const notProhibited = (sql) => sql`(a.content_flag is null or a.content_flag = 'none')`;
const isProhibited = (sql) => sql`(a.content_flag is not null and a.content_flag <> 'none')`;

// The feed is identical for every viewer and costs ~1.3s to query and serialize
// (~14k wide rows), yet it was rebuilt on every navigation because the page renders
// dynamically for auth. Hold it in memory for a short window instead: a warm instance
// serves repeat loads and concurrent viewers straight from this cache. Ad edits bust
// it at once (bustAdsCache, called from the mutation actions), so the change is visible
// on the next render; the TTL is the backstop for rows a scrape writes straight to the
// database, which never call those actions. See lib/ttl-cache.js for why this is an
// in-memory cache and not Next's Data Cache.
const FEED_CACHE_TTL_MS = 60 * 1000;
const feedCache = createTtlCache(FEED_CACHE_TTL_MS);

// Drop the cached feed so the next getAds() rebuilds it from the database. Called by
// every server action that changes what the feed would show.
export function bustAdsCache() {
  feedCache.bust();
}

// Only surface ads confirmed by a completed run, so a failed / mid-flight scrape
// never leaks half-enriched rows into the feed. Rows with no run association
// (e.g. a backfill) are shown as-is. Only approved ads reach the feed - pending
// ones live in the Review tab (getReviewAds); rejected ones stay hidden until a
// scrape sees Meta still running them, which reopens them as pending. No row
// cap: every eligible ad ships, and the client paginates the rendering - a
// LIMIT here silently hid everything past the newest N.
export async function getAds() {
  const cached = feedCache.peek();
  if (cached) {
    console.info('[feed cache] hit', { rows: cached.value.length, ageMs: cached.ageMs });
    return cached.value;
  }
  const sql = getSql();
  const t0 = Date.now();
  const rows = await sql`
    select ${sql(FEED_COLUMNS)},
           (article_content is not null and article_content <> '') as has_article
    from ads a
    where a.review_status = 'approved'
      and ${notProhibited(sql)}
      and ((a.first_run_id is null and a.last_run_id is null)
       or a.first_run_id in (select id from runs where status = 'completed')
       or a.last_run_id in (select id from runs where status = 'completed'))
    order by a.last_seen_at desc nulls last
  `;
  const ads = rows.map(mapAd);
  feedCache.fill(ads);
  console.info('[feed cache] miss - rebuilt from db', { rows: ads.length, ms: Date.now() - t0 });
  return ads;
}

// ── Server-side feed (Phase 2): one page from the database ────────────────────
// getAds ships the whole feed and the browser filters, sorts and paginates it. getFeedPage
// is the database-side equivalent: it applies the SAME base predicate, filters, search and
// sort the client does today (see Dashboard's `filtered`), joins the campaign metrics by the
// resolved campaign_url_key so revenue / RPC / GEOS sort and filter in SQL, and returns one
// page plus the total. It lives beside getAds during the cutover, guarded by a parity check,
// so the client model is retired only once the two agree.

// daysRunning(ad) from lib/ui, in SQL: whole days since start_date, at least 1, or 0 with no
// start_date. Kept byte-for-byte in intent so the days filter and sort match the client.
const daysRunningSql = (sql) =>
  sql`(case when a.start_date is not null then greatest(1, round(extract(epoch from (now() - a.start_date)) / 86400.0)) else 0 end)`;

// The same text the client search scans (Dashboard searchIndex), concatenated and lowered.
// concat_ws skips nulls like the client's filter(Boolean); cm.keywords is the joined sheet
// keywords; tags is an array. brand is the raw key here rather than its label - a small, rare
// difference from the client's brandLabel(brand) that only shows on brand-word searches.
const feedHaystackSql = (sql) =>
  sql`lower(concat_ws(' ', a.title, a.page_name, a.domain, a.vertical, a.country, a.language,
    a.creative_language, a.brand, a.body_text, a.caption, a.cta_text, a.cta_type, a.link_url,
    a.notes, cm.keywords, array_to_string(a.tags, ' ')))`;

// Combine condition fragments with AND (the list always has the base predicate, so it is
// never empty).
const andAll = (sql, conds) => conds.reduce((acc, c) => sql`${acc} and ${c}`);

// The WHERE conditions for a feed query, from the same inputs the client filter reads. Every
// value is a bound parameter (postgres.js), so nothing here interpolates client text into SQL.
function feedConditions(sql, { filters = {}, dateRange = 'all', search = '' } = {}) {
  const f = filters || {};
  const conds = [
    sql`a.review_status = 'approved'`,
    notProhibited(sql),
    sql`((a.first_run_id is null and a.last_run_id is null)
      or a.first_run_id in (select id from runs where status = 'completed')
      or a.last_run_id in (select id from runs where status = 'completed'))`,
  ];

  const inList = (frag, vals) => { if (Array.isArray(vals) && vals.length) conds.push(frag(vals)); };
  inList((v) => sql`a.domain = any(${v})`, f.domain);
  inList((v) => sql`a.feed = any(${v})`, f.feed);
  inList((v) => sql`a.vertical = any(${v})`, f.vertical);
  inList((v) => sql`a.country = any(${v})`, f.country);
  inList((v) => sql`a.language = any(${v})`, f.language);
  inList((v) => sql`a.creative_language = any(${v})`, f.creative_language);
  inList((v) => sql`a.brand = any(${v})`, f.brand);
  inList((v) => sql`a.display_format = any(${v})`, f.format);
  inList((v) => sql`a.status = any(${v})`, f.status);
  inList((v) => sql`a.rsoc_tier = any(${v})`, f.rsoc);

  // GEOS: cm.geos is "CC-pct,CC-pct"; keep a row if any selected country appears as a token.
  if (Array.isArray(f.geos) && f.geos.length) {
    const geo = f.geos.map((c) => sql`cm.geos ~ ${'(^|,)' + String(c) + '-'}`).reduce((a, c) => sql`${a} or ${c}`);
    conds.push(sql`(${geo})`);
  }

  const num = (v) => (v !== '' && v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const daysMin = num(f.daysMin), daysMax = num(f.daysMax);
  if (daysMin != null) conds.push(sql`${daysRunningSql(sql)} >= ${daysMin}`);
  if (daysMax != null) conds.push(sql`${daysRunningSql(sql)} <= ${daysMax}`);

  // The client sinks null-rank ads whenever either rank bound is set, then applies the bounds.
  const rankMin = num(f.rankMin), rankMax = num(f.rankMax);
  if (rankMin != null || rankMax != null) conds.push(sql`a.rank is not null`);
  if (rankMin != null) conds.push(sql`a.rank >= ${rankMin}`);
  if (rankMax != null) conds.push(sql`a.rank <= ${rankMax}`);

  const hours = dateRange === '24h' ? 24 : dateRange === '7d' ? 168 : dateRange === '30d' ? 720 : null;
  if (hours != null) conds.push(sql`a.first_seen_at >= now() - (${hours} * interval '1 hour')`);

  for (const t of String(search || '').trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    conds.push(sql`${feedHaystackSql(sql)} like ${'%' + t + '%'}`);
  }

  return conds;
}

// ORDER BY for a feed query, from the same sort keys + direction the client uses, each ending
// with a stable ad_archive_id tiebreak so paging is deterministic. rank and the sheet metrics
// always sink their nulls to the bottom, matching the client; an unknown key falls back to
// freshness (the client's default branch).
function feedOrder(sql, sort, dir) {
  const desc = dir !== 'asc';                 // the client default is desc
  const d = desc ? sql`desc` : sql`asc`;
  const tie = sql`a.ad_archive_id desc`;
  switch (sort) {
    case 'days':     return sql`${daysRunningSql(sql)} ${d} nulls last, ${tie}`;
    case 'rank':     return sql`a.rank ${desc ? sql`asc` : sql`desc`} nulls last, ${tie}`; // rank 1 first on desc
    case 'revenue':  return sql`cm.revenue ${d} nulls last, ${tie}`;
    case 'rpc':      return sql`cm.rpc ${d} nulls last, ${tie}`;
    case 'page':     return sql`coalesce(a.page_name, '') ${d}, ${tie}`;
    case 'domain':   return sql`coalesce(a.domain, '') ${d}, ${tie}`;
    case 'vertical': return sql`coalesce(a.vertical, '') ${d}, ${tie}`;
    default:         return sql`coalesce(a.last_seen_at, a.first_seen_at) ${d} nulls last, ${tie}`;
  }
}

// A feed row carries the campaign metrics inline (from the join) in the same shape
// attachSheetMetrics produces, so a caller reads plain sheet_* fields either way. geo_split is
// stored as JSON text (migration 0012), parsed back here for the breakdown popup.
function mapFeedRow(r) {
  return {
    ...mapAd(r),
    sheet_revenue: r.sheet_revenue ?? null,
    sheet_clicks: r.sheet_clicks ?? null,
    sheet_rpc: r.sheet_rpc ?? null,
    sheet_geos: r.sheet_geos ?? null,
    sheet_geo_split: r.sheet_geo_split ? JSON.parse(r.sheet_geo_split) : null,
    sheet_keywords: r.sheet_keywords ?? null,
  };
}

// One page of the feed plus the total for the same filter set. `page` is zero-based. The
// metrics join is a LEFT JOIN, so an ad with no campaign keeps its row with null metrics.
export async function getFeedPage({ filters = {}, dateRange = 'all', search = '', sort = 'fresh', dir = 'desc', page = 0, pageSize = 100 } = {}) {
  const sql = getSql();
  const where = andAll(sql, feedConditions(sql, { filters, dateRange, search }));
  const order = feedOrder(sql, sort, dir);
  const size = Math.max(1, Math.min(500, Number(pageSize) || 100));
  const pg = Math.max(0, Number(page) || 0);
  const t0 = Date.now();
  const rows = await sql`
    select ${sql(FEED_COLUMNS)},
           (a.article_content is not null and a.article_content <> '') as has_article,
           cm.revenue as sheet_revenue, cm.clicks as sheet_clicks, cm.rpc as sheet_rpc,
           cm.geos as sheet_geos, cm.geo_split as sheet_geo_split, cm.keywords as sheet_keywords
    from ads a
    left join campaign_metrics cm on cm.url_key = a.campaign_url_key
    where ${where}
    order by ${order}
    limit ${size} offset ${pg * size}
  `;
  const [{ total }] = await sql`
    select count(*)::int as total
    from ads a
    left join campaign_metrics cm on cm.url_key = a.campaign_url_key
    where ${where}
  `;
  console.info('[feed page]', { sort, dir, page: pg, size, rows: rows.length, total, ms: Date.now() - t0 });
  return { rows: rows.map(mapFeedRow), total, page: pg, pageSize: size };
}

// The review queue: ads whose destination did not match their tracked domain,
// awaiting a human approve/reject. Same completed-run guard (and same no-cap,
// no-article-body rule) as the feed. Prohibited-content wins over the relevance
// review: a flagged ad is hidden here too and shows only in the Filtered view, so a
// policy-violating ad can never sit in someone's approve/reject queue.
export async function getReviewAds() {
  const sql = getSql();
  const rows = await sql`
    select ${sql(FEED_COLUMNS)},
           (article_content is not null and article_content <> '') as has_article
    from ads a
    where a.review_status = 'pending'
      and ${notProhibited(sql)}
      and ((a.first_run_id is null and a.last_run_id is null)
       or a.first_run_id in (select id from runs where status = 'completed')
       or a.last_run_id in (select id from runs where status = 'completed'))
    order by a.last_seen_at desc nulls last
  `;
  return rows.map(mapAd);
}

// The Filtered view: ads hidden from the feed because the prohibited-content screen
// flagged them (any content_flag but 'none'), regardless of review_status - this is a
// hard compliance filter that outranks the relevance review. Kept, not deleted, so a
// human can spot-check the model and clear a false positive (clearContentFlag), which
// returns the ad to the feed. Same completed-run guard as the feed.
export async function getFilteredAds() {
  const sql = getSql();
  const rows = await sql`
    select ${sql(FEED_COLUMNS)},
           (article_content is not null and article_content <> '') as has_article
    from ads a
    where ${isProhibited(sql)}
      and ((a.first_run_id is null and a.last_run_id is null)
       or a.first_run_id in (select id from runs where status = 'completed')
       or a.last_run_id in (select id from runs where status = 'completed'))
    order by a.last_seen_at desc nulls last
  `;
  return rows.map(mapAd);
}

// The Rejected list: ads a human rejected in the review queue. The row is KEPT (never
// deleted) so the scraper's dedup never re-imports the ad - which also means we can
// restore one to the feed on demand (restoreRejectedAds). Prohibited-content still
// wins (a flagged ad shows only in Filtered), so this applies the same notProhibited
// exclusion as the feed and review queue. Same completed-run guard.
export async function getRejectedAds() {
  const sql = getSql();
  const rows = await sql`
    select ${sql(FEED_COLUMNS)},
           (article_content is not null and article_content <> '') as has_article
    from ads a
    where a.review_status = 'rejected'
      and ${notProhibited(sql)}
      and ((a.first_run_id is null and a.last_run_id is null)
       or a.first_run_id in (select id from runs where status = 'completed')
       or a.last_run_id in (select id from runs where status = 'completed'))
    order by a.last_seen_at desc nulls last
  `;
  return rows.map(mapAd);
}

// Row counts for the three secondary tabs, in one round trip.
//
// Those tabs are loaded on demand rather than shipped with the page: together
// they were about 5.5 MB of every render, for views most people never open. The
// badges still need exact numbers though, so this counts what the tabs would
// return without materialising a single ad row. The run-completed predicate
// matches the tab queries above, so a badge can never promise rows the tab will
// not show.
export async function getSecondaryCounts() {
  const sql = getSql();
  const [row] = await sql`
    select
      count(*) filter (where a.review_status = 'pending'  and ${notProhibited(sql)})::int as review,
      count(*) filter (where ${isProhibited(sql)})::int                                   as filtered,
      count(*) filter (where a.review_status = 'rejected' and ${notProhibited(sql)})::int as rejected
    from ads a
    where ((a.first_run_id is null and a.last_run_id is null)
       or a.first_run_id in (select id from runs where status = 'completed')
       or a.last_run_id in (select id from runs where status = 'completed'))
  `;
  return { review: row.review, filtered: row.filtered, rejected: row.rejected };
}

// Ads for an explicit id list, returned in the given id order (so an export matches
// the on-screen ordering). Reuses the same row shape as getAds - article bodies
// excluded here too, since no export column carries them and an id list can span
// thousands of rows. Used by the "export to sheet" action, which sends only the
// ids on screen.
export async function getAdsByIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const sql = getSql();
  const rows = await sql`select ${sql(FEED_COLUMNS)} from ads where ad_archive_id = any(${ids})`;
  const byId = new Map(rows.map((r) => [r.ad_archive_id, mapAd(r)]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export async function getLastRun() {
  const sql = getSql();
  const rows = await sql`
    select started_at, finished_at, ads_new, ads_found
    from runs
    where status = 'completed'
    order by finished_at desc nulls last
    limit 1
  `;
  const r = rows[0];
  return r
    ? { started_at: iso(r.started_at), finished_at: iso(r.finished_at), ads_new: r.ads_new, ads_found: r.ads_found }
    : null;
}

export async function getDomains() {
  const sql = getSql();
  const rows = await sql`select * from domains order by created_at asc`;
  return rows.map((d) => ({
    id: d.id,
    query: d.query,
    country: d.country,
    active_status: d.active_status,
    max_ads: d.max_ads,
    interval_days: d.interval_days,
    enabled: d.enabled,
    feed: d.feed,
    next_run_at: iso(d.next_run_at),
    last_run_at: iso(d.last_run_at),
  }));
}

export async function getRuns(limit = 10) {
  const sql = getSql();
  const rows = await sql`
    select id, status, trigger_source, started_at, finished_at, ads_found, ads_new, errors
    from runs order by started_at desc limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    trigger_source: r.trigger_source,
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    ads_found: r.ads_found,
    ads_new: r.ads_new,
    errors: r.errors,
  }));
}

export async function getFeeds() {
  const sql = getSql();
  const rows = await sql`select id, name from feeds order by name asc`;
  return rows.map((f) => ({ id: f.id, name: f.name }));
}

// The run currently in flight, plus a DB-computed `stale` flag. Liveness is judged
// from last_heartbeat_at on the database clock (falling back to started_at before
// the first heartbeat), never from `status` alone - a crashed run keeps status
// 'running', so trusting it would make the banner lie for up to 30 minutes.
export async function getActiveRun() {
  const sql = getSql();
  const rows = await sql`
    select id, status, trigger_source, started_at, current_domain,
           domains_total, domains_done, ads_found_so_far,
           extract(epoch from (now() - started_at)) as elapsed_seconds,
           coalesce(last_heartbeat_at, started_at) < now() - interval '90 seconds' as stale
    from runs
    where status = 'running'
    order by started_at desc
    limit 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    trigger_source: r.trigger_source,
    started_at: iso(r.started_at),
    current_domain: r.current_domain,
    domains_total: r.domains_total,
    domains_done: r.domains_done,
    ads_found_so_far: r.ads_found_so_far,
    elapsed_seconds: Math.max(0, Math.floor(Number(r.elapsed_seconds) || 0)),
    stale: r.stale === true,
  };
}

// The most recently finished run (completed or failed), for the "just finished"
// prompt and the head of the history list.
export async function getLatestFinishedRun() {
  const sql = getSql();
  const rows = await sql`
    select id, status, trigger_source, started_at, finished_at,
           ads_found, ads_new, errors, error_detail
    from runs
    where finished_at is not null
    order by finished_at desc
    limit 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    trigger_source: r.trigger_source,
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    ads_found: r.ads_found,
    ads_new: r.ads_new,
    errors: r.errors,
    error_detail: r.error_detail,
  };
}

// Stored log lines for a run after a cursor id. bigserial ids are monotonic, so
// `id > since` is a reliable incremental cursor. Works for failed runs too - their
// logs are the whole point when debugging a failure.
export async function getRunLogs(runId, since = 0) {
  if (!runId) return [];
  const sql = getSql();
  const rows = await sql`
    select id, ts, level, message
    from run_logs
    where run_id = ${runId} and id > ${since}
    order by id asc
    limit 1000
  `;
  return rows.map((r) => ({ id: Number(r.id), ts: iso(r.ts), level: r.level, message: r.message }));
}
