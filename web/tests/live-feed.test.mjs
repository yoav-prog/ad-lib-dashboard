// Unit tests for the live feed rules in lib/live-feed.js. Run with `npm test`. These pin
// when Fresh Finds re-reads itself during a scrape: only when ads actually landed, never
// more than once per gap, never under someone reading elsewhere, and always once at the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextLiveFeedStep, EMPTY_LIVE_FEED, LIVE_FEED_MIN_GAP_MS } from '../lib/live-feed.js';

const NOW = 1_000_000;
const watching = (seen, reloadedAt = 0) => ({ runId: 'run-a', seen, reloadedAt });
const run = (count, id = 'run-a') => ({ id, ads_found_so_far: count });
const step = (prev, active, opts = {}) => nextLiveFeedStep(prev, active, { now: NOW, canShow: true, ...opts });

test('idle stays idle', () => {
  const r = step(EMPTY_LIVE_FEED, null);
  assert.equal(r.reload, 'none');
  assert.equal(r.state.runId, null);
});

test('opening the page mid-run starts watching without a redundant reload', () => {
  const r = step(EMPTY_LIVE_FEED, run(40));
  assert.equal(r.reload, 'none');
  assert.deepEqual(r.state, { runId: 'run-a', seen: 40, reloadedAt: 0 });
});

test('more ads trigger a live reload and record the new count', () => {
  const r = step(watching(10), run(20));
  assert.equal(r.reload, 'live');
  assert.deepEqual(r.state, { runId: 'run-a', seen: 20, reloadedAt: NOW });
});

test('no new ads means no reload', () => {
  assert.equal(step(watching(10), run(10)).reload, 'none');
});

test('reloads are throttled, and the update stays owed', () => {
  const prev = watching(10, NOW - LIVE_FEED_MIN_GAP_MS + 1);
  const r = step(prev, run(20));
  assert.equal(r.reload, 'none');
  assert.equal(r.state, prev);
  assert.equal(step(r.state, run(20), { now: NOW + 1 }).reload, 'live');
});

test('a viewer who cannot see new rows waits, then gets them', () => {
  const r = step(watching(10), run(20), { canShow: false });
  assert.equal(r.reload, 'none');
  assert.equal(step(r.state, run(20)).reload, 'live');
});

test('a run ending or being stopped reloads once, even when canShow is false', () => {
  const r = step(watching(10), null, { canShow: false });
  assert.equal(r.reload, 'final');
  assert.equal(r.state.runId, null);
  assert.equal(step(r.state, null).reload, 'none');
});

test('one run replacing another counts as the first one ending', () => {
  const r = step(watching(10), run(0, 'run-b'));
  assert.equal(r.reload, 'final');
  assert.deepEqual(r.state, { runId: 'run-b', seen: 0, reloadedAt: 0 });
});

test('a missing count is treated as zero', () => {
  assert.equal(step(watching(0), run(null)).reload, 'none');
});
