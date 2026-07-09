// Unit tests for the pure campaign-metrics helpers in lib/metrics.js: URL
// normalization, sheet parsing (header mapping, facebook-rsoc filter,
// duplicate-URL aggregation), and the ad join. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrlKey, adUrlKeys, buildMetricsIndex, attachSheetMetrics } from '../lib/metrics.js';

// ── normalizeUrlKey ───────────────────────────────────────────────────────────

test('normalizeUrlKey strips tracking params (the spec example)', () => {
  assert.equal(
    normalizeUrlKey('https://glossingrey.com/en/articles/illinois-state-surplus-equipment-usco?dest=MGQyN2hjLnZmc2t6cWIuY29t&network=facebook&site=direct&ad_id={{ad.id}}'),
    'glossingrey.com/en/articles/illinois-state-surplus-equipment-usco',
  );
});

test('normalizeUrlKey ignores scheme, www, host case, fragments, and trailing slashes', () => {
  const want = 'castofnotes.com/en/articles/x';
  assert.equal(normalizeUrlKey('http://castofnotes.com/en/articles/x'), want);
  assert.equal(normalizeUrlKey('https://WWW.CastOfNotes.com/en/articles/x/'), want);
  assert.equal(normalizeUrlKey('castofnotes.com/en/articles/x#section'), want);
  assert.equal(normalizeUrlKey('  https://castofnotes.com/en/articles/x?utm=1  '), want);
});

test('normalizeUrlKey keeps a bare domain and drops non-http values', () => {
  assert.equal(normalizeUrlKey('https://castofnotes.com/'), 'castofnotes.com');
  assert.equal(normalizeUrlKey(''), '');
  assert.equal(normalizeUrlKey(null), '');
  assert.equal(normalizeUrlKey('mailto:x@y.com'), '');
});

test('adUrlKeys splits pipe-joined DCO destinations and dedupes', () => {
  assert.deepEqual(
    adUrlKeys('https://a.com/x?p=1 | https://www.a.com/x | https://b.com/y'),
    ['a.com/x', 'b.com/y'],
  );
  assert.deepEqual(adUrlKeys(''), []);
  assert.deepEqual(adUrlKeys(null), []);
});

// ── buildMetricsIndex ─────────────────────────────────────────────────────────

const HEADER = ['network_normalized', 'offer', 'country', 'adtitle', 'campaign_target_url', 'revenue_prediction_finalized', 'click_count', 'RPC', 'top_10_keywords'];
const row = (network, url, revenue, clicks, rpc, kw) => [network, 'Offer', 'US', 'title', url, revenue, clicks, rpc, kw];

test('buildMetricsIndex keeps only facebook-rsoc rows', () => {
  const idx = buildMetricsIndex([
    HEADER,
    row('facebook-rsoc', 'https://a.com/x', '100', '10', '10', 'kw1'),
    row('mgid-rsoc', 'https://b.com/y', '200', '20', '10', 'kw2'),
    row('outbrain-rsoc', 'https://c.com/z', '300', '30', '10', 'kw3'),
    row(' FACEBOOK-RSOC ', 'https://d.com/w', '400', '40', '10', 'kw4'), // case/space tolerant
  ]);
  assert.deepEqual([...idx.keys()].sort(), ['a.com/x', 'd.com/w']);
});

test('buildMetricsIndex keys rows by normalized URL and parses formatted numbers', () => {
  const idx = buildMetricsIndex([
    HEADER,
    row('facebook-rsoc', 'https://www.a.com/x/?utm=9', '11,947.19693', '4,883', '2.446839428', 'online diploma, adults'),
  ]);
  const m = idx.get('a.com/x');
  assert.ok(m);
  assert.equal(m.revenue, 11947.19693);
  assert.equal(m.clicks, 4883);
  assert.equal(m.rpc, 2.446839428);
  assert.equal(m.keywords, 'online diploma, adults');
  assert.equal(m.rows, 1);
});

test('buildMetricsIndex aggregates duplicate URLs: sums + weighted RPC + top row keywords', () => {
  const idx = buildMetricsIndex([
    HEADER,
    row('facebook-rsoc', 'https://a.com/x', '100', '50', '2', 'small row kws'),
    row('facebook-rsoc', 'https://a.com/x?src=2', '300', '50', '6', 'big row kws'),
  ]);
  const m = idx.get('a.com/x');
  assert.equal(m.rows, 2);
  assert.equal(m.revenue, 400);
  assert.equal(m.clicks, 100);
  assert.equal(m.rpc, 4);                    // 400 / 100, not an average of 2 and 6
  assert.equal(m.keywords, 'big row kws');   // from the higher-revenue row
});

test('buildMetricsIndex finds the revenue column by prefix when the exact header moved', () => {
  const header = [...HEADER];
  header[5] = 'revenue_prediction';
  const idx = buildMetricsIndex([header, row('facebook-rsoc', 'https://a.com/x', '5', '1', '5', '')]);
  assert.equal(idx.get('a.com/x').revenue, 5);
});

test('buildMetricsIndex treats blanks as null, never zero', () => {
  const idx = buildMetricsIndex([HEADER, row('facebook-rsoc', 'https://a.com/x', '', '', 'n/a', '')]);
  const m = idx.get('a.com/x');
  assert.equal(m.revenue, null);
  assert.equal(m.clicks, null);
  assert.equal(m.rpc, null);
});

test('buildMetricsIndex yields an empty map for unusable input', () => {
  assert.equal(buildMetricsIndex(null).size, 0);
  assert.equal(buildMetricsIndex([]).size, 0);
  assert.equal(buildMetricsIndex([HEADER]).size, 0);                                    // header only
  assert.equal(buildMetricsIndex([['foo', 'bar'], ['facebook-rsoc', 'x']]).size, 0);    // headers missing
});

// ── attachSheetMetrics ────────────────────────────────────────────────────────

const index = buildMetricsIndex([
  HEADER,
  row('facebook-rsoc', 'https://glossingrey.com/en/articles/illinois-state-surplus-equipment-usco', '1500.5', '300', '5.0016', 'surplus, equipment'),
]);

test('attachSheetMetrics matches a TONIC RSOC ad whose link carries tracking params', () => {
  const ad = { ad_archive_id: '1', feed: 'TONIC RSOC', link_url: 'https://glossingrey.com/en/articles/illinois-state-surplus-equipment-usco?dest=MGQy&network=facebook&ad_id={{ad.id}}' };
  const { ads, matched } = attachSheetMetrics([ad], index);
  assert.equal(matched, 1);
  assert.equal(ads[0].sheet_revenue, 1500.5);
  assert.equal(ads[0].sheet_clicks, 300);
  assert.equal(ads[0].sheet_rpc, 5.0016);
  assert.equal(ads[0].sheet_keywords, 'surplus, equipment');
});

test('attachSheetMetrics matches via any pipe-joined DCO destination', () => {
  const ad = { ad_archive_id: '2', feed: 'Tonic RSOC', link_url: 'https://other.com/z | https://www.glossingrey.com/en/articles/illinois-state-surplus-equipment-usco/' };
  const { ads, matched } = attachSheetMetrics([ad], index);
  assert.equal(matched, 1);
  assert.equal(ads[0].sheet_revenue, 1500.5);
});

test('attachSheetMetrics never matches ads outside the TONIC RSOC feed', () => {
  const matchingUrl = 'https://glossingrey.com/en/articles/illinois-state-surplus-equipment-usco';
  const { ads, matched } = attachSheetMetrics([
    { ad_archive_id: 't1', feed: 'Tarzo', link_url: matchingUrl },
    { ad_archive_id: 't2', feed: null, link_url: matchingUrl },
  ], index);
  assert.equal(matched, 0);
  assert.equal(ads[0].sheet_revenue, null);
  assert.equal(ads[1].sheet_revenue, null);
});

test('attachSheetMetrics leaves unmatched and linkless ads with nulls', () => {
  const { ads, matched } = attachSheetMetrics([
    { ad_archive_id: '3', feed: 'TONIC RSOC', link_url: 'https://nomatch.com/a' },
    { ad_archive_id: '4', feed: 'TONIC RSOC', link_url: '' },
  ], index);
  assert.equal(matched, 0);
  for (const a of ads) {
    assert.equal(a.sheet_revenue, null);
    assert.equal(a.sheet_clicks, null);
    assert.equal(a.sheet_rpc, null);
    assert.equal(a.sheet_keywords, null);
  }
});

test('attachSheetMetrics survives a null index (Sheets outage) and empty input', () => {
  const { ads, matched } = attachSheetMetrics([{ ad_archive_id: '5', feed: 'TONIC RSOC', link_url: 'https://a.com/x' }], null);
  assert.equal(matched, 0);
  assert.equal(ads[0].sheet_revenue, null);
  assert.deepEqual(attachSheetMetrics([], index).ads, []);
  assert.deepEqual(attachSheetMetrics(null, index).ads, []);
});
