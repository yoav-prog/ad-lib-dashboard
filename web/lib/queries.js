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
    article_content: r.article_content,
    rank: r.rank,
    language: r.language,
    country: r.country,
    vertical: r.vertical,
    first_seen_at: iso(r.first_seen_at),
    last_seen_at: iso(r.last_seen_at),
    status: r.status,
    owner: r.owner,
    linked_article_url: r.linked_article_url,
    is_saved: r.is_saved,
    tags: r.tags || [],
    notes: r.notes,
  };
}

// Only surface ads confirmed by a completed run, so a failed / mid-flight scrape
// never leaks half-enriched rows into the feed. Rows with no run association
// (e.g. a backfill) are shown as-is.
export async function getAds(limit = 500) {
  const sql = getSql();
  const rows = await sql`
    select a.* from ads a
    where (a.first_run_id is null and a.last_run_id is null)
       or a.first_run_id in (select id from runs where status = 'completed')
       or a.last_run_id in (select id from runs where status = 'completed')
    order by a.first_seen_at desc
    limit ${limit}
  `;
  return rows.map(mapAd);
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
    cadence: d.cadence,
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
