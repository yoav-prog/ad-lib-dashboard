// Campaign performance metrics from the team's Google Sheet: one row per
// campaign with network, target URL, predicted revenue, click count, RPC, and
// top keywords. Only the sheet's facebook-rsoc rows and only AdIntel's
// TONIC RSOC feed take part - that feed is what the sheet tracks. An ad and a
// sheet row are the same campaign when their landing-page URLs match once the
// tracking parameters are stripped from both sides.
//
// The pure helpers up top are unit-tested (web/tests/metrics.test.mjs); only
// getSheetMetricsIndex at the bottom touches the network, riding on lib/sheets'
// service-account auth. Never import this module from a client component.
import { readSheetTab, sheetsConfigured } from './sheets.js';

// Defaults point at the sheet the team maintains ("Comp Test" / DB2). The id
// alone grants no access - the sheet must also be shared with the service
// account. Override via env if the data ever moves.
const SPREADSHEET_ID = process.env.METRICS_SPREADSHEET_ID || '1ErBMP6TNNjNDBJg9qTIQOAkaO0fzpaOIDZ_BakphM-g';
const TAB_NAME = process.env.METRICS_SHEET_TAB || 'DB2';
const NETWORK = 'facebook-rsoc';
const FEED = 'tonic rsoc'; // only ads in this AdIntel feed carry sheet metrics
const CACHE_TTL_MS = 10 * 60 * 1000;

// Reduce a URL to the key both sides are matched on: bare lowercase host (no
// www.) plus the path with any trailing slash trimmed. Query string, fragment,
// and scheme are dropped - ad links carry per-campaign tracking params
// (?dest=...&network=...) that the sheet's target URLs lack. '' when the value
// is not an http(s) URL at all.
export function normalizeUrlKey(url) {
  const t = String(url || '').trim();
  if (!t) return '';
  // Only scheme-less values get https:// prepended; anything with its own
  // non-http scheme (mailto:, tel:, ...) is not a landing page.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(t);
  if (hasScheme && !/^https?:\/\//i.test(t)) return '';
  try {
    const u = new URL(hasScheme ? t : `https://${t}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!host) return '';
    return host + u.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

// Every URL key an ad can be matched by. link_url may pack several DCO
// destinations pipe-joined ("a | b | c"); any of them counts as a match.
export function adUrlKeys(linkUrl) {
  if (!linkUrl) return [];
  return [...new Set(String(linkUrl).split(' | ').map(normalizeUrlKey).filter(Boolean))];
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

// Numbers arrive as sheet-formatted strings; tolerate thousands separators and
// stray spaces. null (never 0) for blank or unparseable cells, so a missing
// value can't masquerade as a real zero.
function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Columns are located by header name, never by position, so the sheet can be
// reordered without breaking the import. revenue_prediction_finalized gets a
// prefix fallback because that header has shifted names before.
function headerIndexes(headerRow) {
  const heads = (headerRow || []).map(norm);
  const find = (name) => heads.indexOf(name);
  const idx = {
    network: find('network_normalized'),
    url: find('campaign_target_url'),
    country: find('country'),
    revenue: find('revenue_prediction_finalized'),
    clicks: find('click_count'),
    rpc: find('rpc'),
    keywords: find('top_10_keywords'),
  };
  if (idx.revenue < 0) idx.revenue = heads.findIndex((h) => h.startsWith('revenue_prediction'));
  return idx;
}

const addNullable = (a, b) => (a == null && b == null ? null : (a || 0) + (b || 0));

// The GEOS breakdown: how a URL's revenue splits across the sheet's countries.
// Two forms from one computation: `geos`, the compact "CC-<percent>" string
// sorted biggest-first ("ES-90,MX-10") that the column, exports, and facet
// filter use; and `geoSplit`, the exact per-country revenue rows the breakdown
// popup shows. The sheet team picks a country per campaign without knowing
// AdIntel's country, so this is what tells a reader WHERE an article actually
// earns - regardless of what AdIntel's own Country column guessed. Both are
// null when no row carried revenue.
function geoBreakdown(perCountry) {
  const entries = [...perCountry.entries()].filter(([, v]) => v > 0);
  const total = entries.reduce((n, [, v]) => n + v, 0);
  if (!total) return { geos: null, geoSplit: null };
  const geoSplit = entries
    .sort((x, y) => y[1] - x[1])
    .map(([country, revenue]) => ({ country, revenue, share: revenue / total }));
  return { geos: geoSplit.map((g) => `${g.country}-${Math.round(g.share * 100)}`).join(','), geoSplit };
}

// Raw tab values (header row first) -> Map of urlKey -> { revenue, clicks,
// rpc, keywords, geos, rows }. Only facebook-rsoc rows enter. The sheet holds
// one row per campaign and several campaigns can target the same URL (usually
// one per country, sometimes several), so duplicates aggregate: revenue and
// clicks are summed, RPC is recomputed as summed revenue / summed clicks (the
// click-weighted average), the keywords come from the highest-revenue row, and
// the per-country split is kept as GEOS. An unusable tab (no network/url
// headers) yields an empty map, never a throw.
export function buildMetricsIndex(values) {
  const index = new Map();
  if (!Array.isArray(values) || values.length < 2) return index;
  const idx = headerIndexes(values[0]);
  if (idx.network < 0 || idx.url < 0) return index;

  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    if (norm(row[idx.network]) !== NETWORK) continue;
    const key = normalizeUrlKey(row[idx.url]);
    if (!key) continue;
    const country = idx.country >= 0 ? String(row[idx.country] ?? '').trim().toUpperCase() : '';
    const revenue = idx.revenue >= 0 ? toNum(row[idx.revenue]) : null;
    const clicks = idx.clicks >= 0 ? toNum(row[idx.clicks]) : null;
    const rpc = idx.rpc >= 0 ? toNum(row[idx.rpc]) : null;
    const keywords = idx.keywords >= 0 ? String(row[idx.keywords] ?? '').trim() : '';

    let cur = index.get(key);
    if (!cur) {
      cur = { revenue, clicks, rpc, keywords, geos: null, geoSplit: null, rows: 1, _topRev: revenue ?? -Infinity, _geo: new Map() };
      index.set(key, cur);
    } else {
      cur.revenue = addNullable(cur.revenue, revenue);
      cur.clicks = addNullable(cur.clicks, clicks);
      cur.rows += 1;
      if ((revenue ?? -Infinity) > cur._topRev) {
        cur._topRev = revenue ?? -Infinity;
        cur.rpc = rpc;                            // fallback if the weighted RPC can't be computed
        if (keywords) cur.keywords = keywords;
      }
    }
    if (country && revenue != null) cur._geo.set(country, (cur._geo.get(country) || 0) + revenue);
  }
  for (const e of index.values()) {
    if (e.rows > 1 && e.revenue != null && e.clicks > 0) e.rpc = e.revenue / e.clicks;
    const { geos, geoSplit } = geoBreakdown(e._geo);
    e.geos = geos;
    e.geoSplit = geoSplit;
    delete e._topRev;
    delete e._geo;
  }
  return index;
}

// Copy ads with the four sheet fields attached (null when nothing matched, so
// the UI shows dashes and exports stay empty rather than fake zeros). Only
// TONIC RSOC ads are matched at all - the sheet tracks that feed's campaigns,
// and gating by feed means another feed's ad can never pick up someone else's
// numbers through a coincidental URL. The first matching DCO destination wins.
// Works with a null/empty index - a Sheets outage degrades to blank metric
// columns, never a broken page.
export function attachSheetMetrics(ads, index) {
  let matched = 0;
  const out = (ads || []).map((a) => {
    let m = null;
    if (index && index.size && norm(a.feed) === FEED) {
      for (const key of adUrlKeys(a.link_url)) {
        m = index.get(key);
        if (m) break;
      }
    }
    if (m) matched += 1;
    return {
      ...a,
      sheet_revenue: m ? m.revenue : null,
      sheet_clicks: m ? m.clicks : null,
      sheet_rpc: m ? m.rpc : null,
      sheet_geos: m ? m.geos : null,
      sheet_geo_split: m ? m.geoSplit : null,
      sheet_keywords: m && m.keywords ? m.keywords : null,
    };
  });
  return { ads: out, matched };
}

// One index is shared for its TTL across every page render on a warm instance,
// so the Sheets API sees at most a few reads per hour. Failures serve the last
// good index (metrics a few minutes stale beat four empty columns) and still
// refresh the timestamp, so a dead sheet is retried once per TTL, not per view.
let cache = null;     // { index: Map|null, at: number(ms) }
let lastError = null; // message of the most recent failed load, null when healthy

export async function getSheetMetricsIndex(nowMs = Date.now(), { force = false } = {}) {
  if (!force && cache && nowMs - cache.at < CACHE_TTL_MS) return cache.index;
  if (!sheetsConfigured()) {
    console.info('[metrics] skipped - Google service-account credentials are not configured');
    lastError = 'Google service-account credentials are not configured on the server.';
    cache = { index: cache ? cache.index : null, at: nowMs };
    return cache.index;
  }
  const t0 = Date.now();
  try {
    const values = await readSheetTab({ spreadsheetId: SPREADSHEET_ID, tabName: TAB_NAME }, nowMs);
    const index = buildMetricsIndex(values);
    console.info('[metrics] loaded', { tab: TAB_NAME, rows: Math.max(0, values.length - 1), urls: index.size, ms: Date.now() - t0 });
    cache = { index, at: nowMs };
    lastError = null;
  } catch (e) {
    console.error('[metrics] failed', { message: String(e?.message || e), servingStale: Boolean(cache?.index) });
    lastError = String(e?.message || e);
    cache = { index: cache ? cache.index : null, at: nowMs };
  }
  return cache.index;
}

// Health of the most recent load, for the manual-refresh button's feedback.
export function metricsStatus() {
  return { campaigns: cache?.index ? cache.index.size : 0, error: lastError };
}
