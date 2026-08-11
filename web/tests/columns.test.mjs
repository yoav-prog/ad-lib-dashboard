// Unit tests for the pure column-layout logic in lib/columns.js. Run with `npm test`.
// These pin the reconciliation rules a saved preset relies on: new columns appear,
// removed columns drop, pinned/auto columns can never be hidden, and legacy
// localStorage values migrate cleanly.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TABLE_KEYS, COLUMN_CATALOGS, catalogKeys, hideableKeys, resolveLayout, visibleSet,
  serializeLayout, defaultLayout, migrateLegacyHidden, validateLayout, catalogFor,
} from '../lib/columns.js';

const fresh = COLUMN_CATALOGS.freshfinds;

test('every table key has a catalog and vice versa', () => {
  assert.deepEqual(TABLE_KEYS.slice().sort(), Object.keys(COLUMN_CATALOGS).sort());
  for (const k of TABLE_KEYS) assert.ok(catalogFor(k).length > 0);
});

test('each catalog has exactly one pinned Headline column', () => {
  for (const k of TABLE_KEYS) {
    const pinned = COLUMN_CATALOGS[k].filter((c) => c.pinned);
    assert.equal(pinned.length, 1, `${k} should pin exactly one column`);
    assert.equal(pinned[0].key, 'headline');
  }
});

test('hideableKeys excludes pinned and auto columns', () => {
  const h = new Set(hideableKeys(fresh));
  assert.ok(!h.has('headline'), 'headline is pinned, not hideable');
  assert.ok(!h.has('slug') && !h.has('query'), 'auto columns are not hideable');
  assert.ok(h.has('page') && h.has('ad_id'));
});

test('resolveLayout keeps saved order then appends missing catalog keys', () => {
  const layout = { order: ['ad_id', 'page'], hidden: [] };
  const { order } = resolveLayout(fresh, layout);
  assert.deepEqual(order.slice(0, 2), ['ad_id', 'page']);
  // everything else follows, in catalog order, with no key lost or duplicated
  assert.equal(order.length, fresh.length);
  assert.equal(new Set(order).size, order.length);
  for (const k of catalogKeys(fresh)) assert.ok(order.includes(k));
});

test('resolveLayout drops unknown keys and de-dupes', () => {
  const { order } = resolveLayout(fresh, { order: ['page', 'page', 'bogus', 'domain'], hidden: [] });
  assert.equal(order.filter((k) => k === 'page').length, 1);
  assert.ok(!order.includes('bogus'));
});

test('resolveLayout refuses to hide a pinned or auto column', () => {
  const { hidden } = resolveLayout(fresh, { order: [], hidden: ['headline', 'slug', 'page'] });
  assert.ok(!hidden.has('headline'));
  assert.ok(!hidden.has('slug'));
  assert.ok(hidden.has('page'));
});

test('visibleSet reflects hide choices but keeps pinned/auto visible', () => {
  const vis = visibleSet(fresh, { order: [], hidden: ['page', 'domain'] });
  assert.ok(!vis.has('page') && !vis.has('domain'));
  assert.ok(vis.has('headline') && vis.has('slug') && vis.has('ad_id'));
});

test('serializeLayout round-trips through resolveLayout and clamps hidden', () => {
  const order = ['ad_id', 'page', 'domain'];
  const hidden = new Set(['domain', 'headline', 'query']); // pinned + auto get dropped
  const layout = serializeLayout(fresh, order, hidden);
  assert.deepEqual(layout.hidden, ['domain']);
  assert.deepEqual(layout.order.slice(0, 3), ['ad_id', 'page', 'domain']);
});

test('defaultLayout is catalog order with nothing hidden', () => {
  const d = defaultLayout(fresh);
  assert.deepEqual(d.order, catalogKeys(fresh));
  assert.deepEqual(d.hidden, []);
});

test('migrateLegacyHidden reads the { h: [...] } format and clamps it', () => {
  const m = migrateLegacyHidden(fresh, { h: ['page', 'headline', 'nope'] });
  assert.deepEqual(m.order, catalogKeys(fresh));
  assert.deepEqual(m.hidden, ['page']); // headline pinned, nope unknown
});

test('migrateLegacyHidden treats a bare array as show-everything', () => {
  assert.deepEqual(migrateLegacyHidden(fresh, ['page', 'domain']).hidden, []);
});

test('validateLayout fails closed on an unknown table and normalizes a known one', () => {
  assert.equal(validateLayout('bogus', { order: ['page'] }), null);
  const v = validateLayout('review', { order: ['ad_id'], hidden: ['headline', 'page'] });
  assert.ok(Array.isArray(v.order) && v.order[0] === 'ad_id');
  assert.ok(!v.hidden.includes('headline'));
  assert.ok(v.hidden.includes('page'));
});
