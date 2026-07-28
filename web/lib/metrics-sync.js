// Materialise the Google Sheet metrics into the campaign_metrics table (migration
// 0012). This is the write side of the read that web/lib/metrics.js does per render:
// the same sheet, parsed by the same buildMetricsIndex (so there is one source of the
// parsing rules), landed in Postgres so the feed can eventually sort and filter by
// revenue / RPC / GEOS in the database instead of in the browser.
//
// Never import this from a client component: it touches the sheet and the database.
import { getSql } from './db.js';
import { loadMetricsIndexFresh } from './metrics.js';

// The table columns written on every sync, in order. updated_at is set by SQL (now()),
// not carried here.
const SYNC_COLUMNS = ['url_key', 'revenue', 'clicks', 'rpc', 'geos', 'geo_split', 'keywords', 'row_count'];

// Pure: turn the buildMetricsIndex map (url_key -> aggregated metrics) into the row
// objects the upsert writes. Kept separate from the I/O so it is unit-testable without
// the sheet or the database. geo_split is stored as a JSON string (the column is text -
// see migration 0012); a null split stays null rather than the string "null". A blank
// metric stays null, never a fake 0, exactly as the in-memory attach treats it.
export function metricsIndexToRows(index) {
  const rows = [];
  for (const [urlKey, m] of index.entries()) {
    rows.push({
      url_key: urlKey,
      revenue: m.revenue ?? null,
      clicks: m.clicks ?? null,
      rpc: m.rpc ?? null,
      geos: m.geos ?? null,
      geo_split: m.geoSplit ? JSON.stringify(m.geoSplit) : null,
      keywords: m.keywords || null,
      row_count: m.rows ?? 1,
    });
  }
  return rows;
}

// Read the sheet fresh and reconcile campaign_metrics to match it: upsert every current
// campaign, then delete rows whose url_key is no longer in the sheet. Returns a small
// stats object for the caller to log / return.
//
// Failure handling is deliberate (rule: fail safe). loadMetricsIndexFresh throws if the
// Sheets read fails, so a transient outage aborts here and the table keeps its last good
// data. And the prune only runs when the fresh read returned at least one row: an empty
// result is treated as suspicious (a wiped or mis-shared sheet) and leaves existing rows
// in place rather than emptying the table.
export async function syncCampaignMetrics(nowMs = Date.now()) {
  const t0 = Date.now();
  const index = await loadMetricsIndexFresh(nowMs);
  const rows = metricsIndexToRows(index);
  const sql = getSql();

  if (rows.length) {
    await sql`
      insert into campaign_metrics ${sql(rows, SYNC_COLUMNS)}
      on conflict (url_key) do update set
        revenue    = excluded.revenue,
        clicks     = excluded.clicks,
        rpc        = excluded.rpc,
        geos       = excluded.geos,
        geo_split  = excluded.geo_split,
        keywords   = excluded.keywords,
        row_count  = excluded.row_count,
        updated_at = now()
    `;
    // Upsert first, then prune, so there is never a window with fewer rows than the sheet.
    const [{ pruned }] = await sql`
      with gone as (
        delete from campaign_metrics
        where url_key <> all(${rows.map((r) => r.url_key)})
        returning 1
      )
      select count(*)::int as pruned from gone
    `;
    const stats = { upserted: rows.length, pruned, ms: Date.now() - t0 };
    console.info('[metrics sync]', stats);
    return stats;
  }

  // Empty read: keep whatever is there, do not prune to nothing.
  const stats = { upserted: 0, pruned: 0, skipped: 'empty-read', ms: Date.now() - t0 };
  console.warn('[metrics sync] sheet returned no campaigns; left campaign_metrics untouched', stats);
  return stats;
}
