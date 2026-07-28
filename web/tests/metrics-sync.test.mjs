// Unit tests for the pure mapping in lib/metrics-sync.js (metricsIndexToRows). Run with
// `npm test`. The database/sheet I/O in syncCampaignMetrics is not unit-tested (it is
// external I/O with no seam, exercised live before deploy); these pin the transform that
// turns the shared buildMetricsIndex output into campaign_metrics rows, since that is
// where a field could silently land in the wrong column or a null could become a fake 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetricsIndex } from '../lib/metrics.js';
import { metricsIndexToRows } from '../lib/metrics-sync.js';

const HEADER = ['network_normalized', 'offer', 'country', 'adtitle', 'campaign_target_url', 'revenue_prediction_finalized', 'click_count', 'RPC', 'top_10_keywords'];
const row = (network, url, revenue, clicks, rpc, kw, country = 'US') => [network, 'Offer', country, 'title', url, revenue, clicks, rpc, kw];

test('maps an index entry into a campaign_metrics row, keyed by url_key', () => {
  const idx = buildMetricsIndex([HEADER, row('facebook-rsoc', 'https://a.com/x', '100', '10', '10', 'kw1')]);
  const [r] = metricsIndexToRows(idx);
  assert.equal(r.url_key, 'a.com/x');
  assert.equal(r.revenue, 100);
  assert.equal(r.clicks, 10);
  assert.equal(r.rpc, 10);
  assert.equal(r.keywords, 'kw1');
  assert.equal(r.row_count, 1);
});

test('blank metrics stay null, never a fake zero', () => {
  const idx = buildMetricsIndex([HEADER, row('facebook-rsoc', 'https://a.com/x', '', '', 'n/a', '')]);
  const [r] = metricsIndexToRows(idx);
  assert.equal(r.revenue, null);
  assert.equal(r.clicks, null);
  assert.equal(r.rpc, null);
  assert.equal(r.keywords, null);       // '' collapses to null, not the empty string
});

test('geo_split is a JSON string when present, null when absent', () => {
  // Two countries on one URL produce a split; parse it back to check the shape.
  const idx = buildMetricsIndex([
    HEADER,
    row('facebook-rsoc', 'https://a.com/x', '90', '9', '10', 'kw', 'ES'),
    row('facebook-rsoc', 'https://a.com/x', '10', '1', '10', 'kw', 'MX'),
  ]);
  const [r] = metricsIndexToRows(idx);
  assert.equal(typeof r.geo_split, 'string');
  const parsed = JSON.parse(r.geo_split);
  assert.deepEqual(parsed.map((g) => g.country), ['ES', 'MX']);   // biggest share first
  assert.equal(r.geos, 'ES-90,MX-10');

  // A URL whose only row carried no revenue has no split.
  const idx2 = buildMetricsIndex([HEADER, row('facebook-rsoc', 'https://b.com/y', '', '', '', '')]);
  const [r2] = metricsIndexToRows(idx2);
  assert.equal(r2.geo_split, null);
  assert.equal(r2.geos, null);
});

test('carries the aggregation count so a synced row matches the in-memory aggregate', () => {
  const idx = buildMetricsIndex([
    HEADER,
    row('facebook-rsoc', 'https://a.com/x', '100', '10', '10', 'top'),
    row('facebook-rsoc', 'https://a.com/x', '300', '20', '15', 'best'),
  ]);
  const [r] = metricsIndexToRows(idx);
  assert.equal(r.row_count, 2);
  assert.equal(r.revenue, 400);         // summed
  assert.equal(r.keywords, 'best');     // from the top-revenue row
});

test('an empty index maps to no rows (the sync then leaves the table untouched)', () => {
  assert.deepEqual(metricsIndexToRows(new Map()), []);
});
