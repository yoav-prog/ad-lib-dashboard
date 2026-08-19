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
    // The vertical family derived from this ad's own landing article (see migration 0017).
    // lib/ourmatch.js needs it on the row to build the articles-DB lookup for the page.
    article_verticals: r.article_verticals || [],
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
  'is_saved', 'tags', 'notes', 'review_status', 'article_verticals',
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
// The base (unfiltered) feed total is the same for everyone and the one expensive count
// (~14k rows), so it is cached like the feed itself. Filtered counts are smaller and
// computed live. Held here so bustAdsCache clears it alongside the feed.
const baseCountCache = createTtlCache(FEED_CACHE_TTL_MS);
// The feed-independent facets (every group except the feed-scoped Domain) are the same for
// everyone and change slowly, so they are cached too - the first facet load computes them, the
// rest are instant. Domain is computed live per selected feed. A longer TTL than the feed
// because filter option lists shift far more slowly than the rows, and any ad edit busts it
// anyway; the cost is ~12 grouped scans, worth paying rarely.
const FACET_CACHE_TTL_MS = 5 * 60 * 1000;
const facetCache = createTtlCache(FACET_CACHE_TTL_MS);

// Drop the cached feed, base count and facets so the next read rebuilds from the database.
// Called by every server action that changes what the feed would show.
export function bustAdsCache() {
  feedCache.bust();
  baseCountCache.bust();
  facetCache.bust();
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
// `ids` scopes the query to an explicit id list (a selection export) on top of the base
// predicate, so a selected row still has to be feed-eligible to come back.
function feedConditions(sql, { filters = {}, dateRange = 'all', search = '', ids = null } = {}) {
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

  // "Have" / "Missing" an article on the domain picked in the rail. The articles themselves
  // live in a different Postgres, so this reads the materialized answer written by
  // backfill_article_verticals.py (migration 0017) - the one thing that lets the question be
  // asked in SQL at all, and therefore survive server-side paging. The counts and links the
  // page displays are still read live from the articles DB, so a stale backfill can leave a row
  // out of the filter but can never invent a count. GIN-indexed, so it stays cheap.
  //
  // "Missing" is deliberately NOT the plain negation. It additionally requires
  // article_verticals is not null, i.e. the backfill has actually looked at this ad. A newly
  // scraped ad has no family yet, and "we have not checked" is not "we have nothing" - listing
  // it as a gap would send someone off to write an article we may well already own. Rows the
  // backfill has looked at and found nothing for carry an empty array, which this keeps: the
  // coalesce is what makes `not (dom = any('{}'))` true rather than NULL.
  if (f.ourDomain && f.ourArticle === 'have') {
    conds.push(sql`${String(f.ourDomain)} = any(a.our_article_domains)`);
  } else if (f.ourDomain && f.ourArticle === 'missing') {
    conds.push(sql`a.article_verticals is not null
      and not coalesce(${String(f.ourDomain)} = any(a.our_article_domains), false)`);
  }

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

  if (Array.isArray(ids) && ids.length) conds.push(sql`a.ad_archive_id = any(${ids.map(String)})`);

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
  const conds = feedConditions(sql, { filters, dateRange, search });
  const where = andAll(sql, conds);
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
  // A base feed (only the 3 base conditions, no user filter) always counts the same ~14k
  // rows, so serve that one expensive count from cache; a filtered feed counts its smaller set.
  const total = await feedTotal(sql, where, conds.length === 3);
  console.info('[feed page]', { sort, dir, page: pg, size, rows: rows.length, total, ms: Date.now() - t0 });
  return { rows: rows.map(mapFeedRow), total, page: pg, pageSize: size };
}

// The total for a feed WHERE. Caches only the base (unfiltered) count, which is the same for
// everyone and the one that scans the whole feed; filtered counts run live.
async function feedTotal(sql, where, isBase) {
  if (isBase) {
    const cached = baseCountCache.peek();
    if (cached) return cached.value;
  }
  const [{ total }] = await sql`
    select count(*)::int as total
    from ads a left join campaign_metrics cm on cm.url_key = a.campaign_url_key
    where ${where}
  `;
  if (isBase) baseCountCache.fill(total);
  return total;
}

// Filter facets: for each filter column, the distinct values present in the base feed and how
// many ads carry each. Computed over the WHOLE feed (not the active filter set), matching the
// client, so a facet count answers "how many ads have this value" regardless of other filters.
// Only the Domain facet narrows - to the selected feed(s) - because that is how the client
// scopes it. The client keeps the ordering, labels and hide-when-empty rules; this returns raw
// { value, count } lists so those stay in one place (Dashboard). geos comes from the joined
// campaign metrics, one country per ad that earns there.
// One single-column facet: the distinct non-null values and their ad counts under a WHERE.
async function facetColumn(sql, colExpr, whereFrag) {
  const rows = await sql`
    select ${colExpr} as value, count(*)::int as count
    from ads a
    where ${whereFrag} and ${colExpr} is not null
    group by ${colExpr}
  `;
  return rows.map((r) => ({ value: r.value, count: r.count }));
}

// The feed-independent facets (everything but Domain), computed over the base feed. Run
// SEQUENTIALLY on purpose: firing them all at once overwhelms the Supabase transaction pooler
// and stalls. They are cached, so this cost is paid once per TTL, not per request.
async function computeBaseFacets(sql) {
  const base = andAll(sql, feedConditions(sql, {}));
  const t0 = Date.now();
  const out = {
    feed: await facetColumn(sql, sql`a.feed`, base),
    vertical: await facetColumn(sql, sql`a.vertical`, base),
    country: await facetColumn(sql, sql`a.country`, base),
    language: await facetColumn(sql, sql`a.language`, base),
    creative_language: await facetColumn(sql, sql`a.creative_language`, base),
    brand: await facetColumn(sql, sql`a.brand`, base),
    rsoc: await facetColumn(sql, sql`a.rsoc_tier`, base),
    format: await facetColumn(sql, sql`a.display_format`, base),
    status: await facetColumn(sql, sql`a.status`, base),
  };
  // GEOS: split each ad's "CC-pct,CC-pct" into its countries and count ads per country
  // (busiest first). Inner join drops ads with no matched campaign.
  const geos = await sql`
    select split_part(g, '-', 1) as value, count(*)::int as count
    from ads a
    join campaign_metrics cm on cm.url_key = a.campaign_url_key,
         lateral unnest(string_to_array(cm.geos, ',')) as g
    where ${base} and cm.geos is not null and split_part(g, '-', 1) <> ''
    group by 1
    order by count desc
  `;
  out.geos = geos.map((r) => ({ value: r.value, count: r.count }));
  console.info('[feed facets] base computed', { groups: Object.keys(out).length, ms: Date.now() - t0 });
  return out;
}

export async function getFeedFacets(selectedFeeds = []) {
  const sql = getSql();
  // Domain is scoped to the selected feed(s), so it is always live; the rest are cached.
  const domain = await facetColumn(sql, sql`a.domain`, andAll(sql, feedConditions(sql, { filters: { feed: selectedFeeds } })));
  const cached = facetCache.peek();
  if (cached) return { domain, ...cached.value };
  const rest = await computeBaseFacets(sql);
  facetCache.fill(rest);
  return { domain, ...rest };
}

// The headline ticker counts over the base feed, in one round trip: total tracked, "seen this
// scrape / fresh 24h", new in 7 days, and 60-day proven winners. Freshness keys off the latest
// completed run's start (falling back to a 24h window before the first run), exactly like the
// client's isFresh.
export async function getFeedTicker() {
  const sql = getSql();
  const base = andAll(sql, feedConditions(sql, {}));
  const [row] = await sql`
    select
      count(*)::int as total,
      count(*) filter (
        where coalesce(a.last_seen_at, a.first_seen_at) >=
              coalesce((select started_at from runs where status = 'completed' order by finished_at desc nulls last limit 1),
                       now() - interval '24 hours')
      )::int as fresh,
      count(*) filter (where a.first_seen_at >= now() - interval '168 hours')::int as new7,
      count(*) filter (where ${daysRunningSql(sql)} >= 60)::int as winners
    from ads a
    where ${base}
  `;
  return { total: row.total, fresh: row.fresh, new7: row.new7, winners: row.winners };
}

// Every row matching a filter set - or an explicit id list (a selection) - in sort order,
// with no pagination: what an export ships. Same predicate, join and sort as getFeedPage; the
// caller (export action) turns these into CSV or a sheet. Can be large by design (a full
// unfiltered export is the whole feed).
export async function getFeedExport({ filters = {}, dateRange = 'all', search = '', sort = 'fresh', dir = 'desc', ids = null } = {}) {
  const sql = getSql();
  const where = andAll(sql, feedConditions(sql, { filters, dateRange, search, ids }));
  const order = feedOrder(sql, sort, dir);
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
  `;
  console.info('[feed export]', { rows: rows.length, ms: Date.now() - t0 });
  return rows.map(mapFeedRow);
}

// Only the ids matching a filter set, in sort order, optionally capped - what "select all
// matching" and "select first N" read when the rows live server-side. The metrics join stays
// because the sort key and the GEOS/search conditions can reference it; the payload is ids
// only, so even the whole feed's list is a few hundred KB, not tens of MB.
export async function getFeedIds({ filters = {}, dateRange = 'all', search = '', sort = 'fresh', dir = 'desc', limit = null } = {}) {
  const sql = getSql();
  const where = andAll(sql, feedConditions(sql, { filters, dateRange, search }));
  const order = feedOrder(sql, sort, dir);
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : null;
  const t0 = Date.now();
  const rows = await sql`
    select a.ad_archive_id
    from ads a
    left join campaign_metrics cm on cm.url_key = a.campaign_url_key
    where ${where}
    order by ${order}
    ${cap != null ? sql`limit ${cap}` : sql``}
  `;
  console.info('[feed ids]', { rows: rows.length, limit: cap, ms: Date.now() - t0 });
  return rows.map((r) => r.ad_archive_id);
}

// Ads held per tracked domain, under the same base predicate as the feed, so Control Room's
// "Held" column matches what counting the shipped array used to say - the page no longer
// ships every ad for the browser to count.
export async function getDomainAdCounts() {
  const sql = getSql();
  const base = andAll(sql, feedConditions(sql, {}));
  const rows = await sql`
    select a.domain, count(*)::int as count
    from ads a
    where ${base} and a.domain is not null
    group by a.domain
  `;
  return Object.fromEntries(rows.map((r) => [r.domain, r.count]));
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

// Client Kits: the our-link assignment for each of the given competitor ads. Keyed by
// ad_archive_id so the kit view and export can attach "our link" to a competitor ad.
// One assignment per ad in practice (assigning replaces the prior one), so the latest
// wins if a stray duplicate ever exists.
export async function getAssignmentsByAdIds(adIds) {
  if (!Array.isArray(adIds) || !adIds.length) return {};
  const clean = [...new Set(adIds.map(String))];
  const sql = getSql();
  const rows = await sql`
    select ad_archive_id, our_url, our_domain, our_headline, our_article_id, assigned_by, assigned_at
    from link_assignments
    where ad_archive_id = any(${clean})
    order by assigned_at asc
  `;
  const byAd = {};
  for (const r of rows) {
    byAd[r.ad_archive_id] = {
      ad_archive_id: r.ad_archive_id,
      our_url: r.our_url,
      our_domain: r.our_domain,
      our_headline: r.our_headline,
      our_article_id: r.our_article_id,
      assigned_by: r.assigned_by,
      assigned_at: iso(r.assigned_at),
    };
  }
  return byAd;
}

// Client Kits (RSOC source): the our-link assignment for each of the given competitor
// comp rows (ref_comp_rows ids), keyed by comp_row_id. Same shape as the Meta version.
export async function getAssignmentsByCompIds(compIds) {
  const clean = (Array.isArray(compIds) ? compIds : [])
    .map((x) => Math.trunc(Number(x)))
    .filter((n) => Number.isFinite(n));
  if (!clean.length) return {};
  const ids = [...new Set(clean)];
  const sql = getSql();
  const rows = await sql`
    select comp_row_id, our_url, our_domain, our_headline, our_article_id, assigned_by, assigned_at
    from link_assignments
    where comp_row_id = any(${ids})
    order by assigned_at asc
  `;
  const byComp = {};
  for (const r of rows) {
    byComp[r.comp_row_id] = {
      comp_row_id: r.comp_row_id,
      our_url: r.our_url,
      our_domain: r.our_domain,
      our_headline: r.our_headline,
      our_article_id: r.our_article_id,
      assigned_by: r.assigned_by,
      assigned_at: iso(r.assigned_at),
    };
  }
  return byComp;
}

// Which of the given our-link URLs are already assigned (to any ad or comp row). Used by
// the sister flow, whose candidate links span domains, so the per-domain helper below does
// not fit - availability there is checked against this explicit URL set instead.
export async function getTakenOurUrls(urls) {
  const clean = [...new Set((Array.isArray(urls) ? urls : []).map(String).filter(Boolean))];
  if (!clean.length) return [];
  const sql = getSql();
  const rows = await sql`select our_url from link_assignments where our_url = any(${clean})`;
  return rows.map((r) => r.our_url);
}

// The our-link URLs already handed out on a given domain, so the articles-DB search can
// exclude them and only ever offer links that are still available. Scoped to one domain
// keeps the excluded array small even as the ledger grows.
export async function getAssignedUrlsForDomain(domain) {
  const dom = String(domain || '').trim();
  if (!dom) return [];
  const sql = getSql();
  const rows = await sql`select our_url from link_assignments where our_domain = ${dom}`;
  return rows.map((r) => r.our_url);
}

// Best-effort Meta creative per competitor host, for the RSOC kit view: given a set of
// landing hosts, return one representative creative (newest ad on that host) - its thumbnail
// AND its body/description - keyed by host. The RSOC comp rows and the Meta ads share no id,
// so this is a coarse host-level match: it enriches roughly a third of comp rows with an
// image + description and leaves the rest with their title only, so it is a bonus, never a
// requirement. Picks the newest ad that has a thumbnail (the description rides along).
export async function getMetaCreativesByHosts(hosts) {
  const clean = [...new Set((Array.isArray(hosts) ? hosts : []).map((h) => String(h || '').toLowerCase()).filter(Boolean))].slice(0, 500);
  if (!clean.length) return {};
  const sql = getSql();
  const rows = await sql`
    select distinct on (host) host, thumb, body from (
      select lower(regexp_replace(substring(resolved_url from '://([^/]+)'), '^www\\.', '')) as host,
             coalesce(original_image_urls[1], video_preview_url) as thumb,
             body_text as body,
             last_seen_at
      from ads
      where resolved_url like 'http%'
    ) t
    where host = any(${clean}) and thumb is not null
    order by host, last_seen_at desc nulls last
  `;
  const byHost = {};
  for (const r of rows) byHost[r.host] = { thumb: r.thumb, body: r.body || null };
  return byHost;
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
