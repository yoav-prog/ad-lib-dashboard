import { getSql } from './db';

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
    article_title: r.article_title,
    resolved_url: r.resolved_url,
    article_content: r.article_content ?? null,
    has_article: r.has_article ?? (r.article_content != null && r.article_content !== ''),
    rank: r.rank,
    language: r.language,
    country: r.country,
    vertical: r.vertical,
    brand: r.brand,
    creative_language: r.creative_language,
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

// Every ad column the feed ships to the browser. article_content is deliberately
// absent: the landing-article bodies dwarf every other field combined (tens of MB
// across a few thousand ads) and only the Detail view reads them, so it fetches
// the one it needs on demand (getAdArticle) guided by the has_article flag.
const FEED_COLUMNS = [
  'ad_archive_id', 'page_id', 'page_name', 'domain', 'feed', 'caption', 'cta_text',
  'body_text', 'cta_type', 'title', 'link_description', 'link_url', 'display_format',
  'extra_texts', 'original_image_urls', 'video_hd_url', 'video_preview_url',
  'extra_image_urls', 'extra_video_urls', 'publisher_platform', 'start_date',
  'total_active_time', 'article_title', 'resolved_url', 'rank', 'language', 'country', 'vertical',
  'brand', 'creative_language', 'first_seen_at', 'last_seen_at', 'status', 'owner', 'linked_article_url',
  'is_saved', 'tags', 'notes', 'review_status',
];

// Only surface ads confirmed by a completed run, so a failed / mid-flight scrape
// never leaks half-enriched rows into the feed. Rows with no run association
// (e.g. a backfill) are shown as-is. Only approved ads reach the feed - pending
// ones live in the Review tab (getReviewAds); rejected ones stay hidden until a
// scrape sees Meta still running them, which reopens them as pending. No row
// cap: every eligible ad ships, and the client paginates the rendering - a
// LIMIT here silently hid everything past the newest N.
export async function getAds() {
  const sql = getSql();
  const rows = await sql`
    select ${sql(FEED_COLUMNS)},
           (article_content is not null and article_content <> '') as has_article
    from ads a
    where a.review_status = 'approved'
      and ((a.first_run_id is null and a.last_run_id is null)
       or a.first_run_id in (select id from runs where status = 'completed')
       or a.last_run_id in (select id from runs where status = 'completed'))
    order by a.last_seen_at desc nulls last
  `;
  return rows.map(mapAd);
}

// The review queue: ads whose destination did not match their tracked domain,
// awaiting a human approve/reject. Same completed-run guard (and same no-cap,
// no-article-body rule) as the feed.
export async function getReviewAds() {
  const sql = getSql();
  const rows = await sql`
    select ${sql(FEED_COLUMNS)},
           (article_content is not null and article_content <> '') as has_article
    from ads a
    where a.review_status = 'pending'
      and ((a.first_run_id is null and a.last_run_id is null)
       or a.first_run_id in (select id from runs where status = 'completed')
       or a.last_run_id in (select id from runs where status = 'completed'))
    order by a.last_seen_at desc nulls last
  `;
  return rows.map(mapAd);
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
