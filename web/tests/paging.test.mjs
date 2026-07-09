// Unit tests for the pure paging math in lib/paging.js. Run with `npm test`
// (Node's built-in runner, no dependencies). These pin the fix for the 500-row
// cap: the tables now page through every row instead of hiding the tail, so the
// slice/clamp math must hold at every edge (empty list, exact multiples,
// out-of-range pages, the 'all' size, junk localStorage values).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, parsePageSize, pageCount, clampPage, pageSlice, pageRange } from '../lib/paging.js';

const list = (n) => Array.from({ length: n }, (_, i) => i);

test('PAGE_SIZES offers several options and contains the default', () => {
  assert.ok(PAGE_SIZES.length >= 3);
  assert.ok(PAGE_SIZES.includes(DEFAULT_PAGE_SIZE));
  assert.ok(PAGE_SIZES.includes('all'));
});

test('parsePageSize accepts known sizes, as strings too (localStorage)', () => {
  assert.equal(parsePageSize('100'), 100);
  assert.equal(parsePageSize(250), 250);
  assert.equal(parsePageSize('all'), 'all');
});

test('parsePageSize rejects junk and unknown numbers', () => {
  assert.equal(parsePageSize(null), null);
  assert.equal(parsePageSize(''), null);
  assert.equal(parsePageSize('999'), null);
  assert.equal(parsePageSize('banana'), null);
});

test('pageCount rounds up and never drops below one page', () => {
  assert.equal(pageCount(0, 100), 1);
  assert.equal(pageCount(1, 100), 1);
  assert.equal(pageCount(100, 100), 1);
  assert.equal(pageCount(101, 100), 2);
  assert.equal(pageCount(1800, 100), 18);
  assert.equal(pageCount(1800, 'all'), 1);
});

test('clampPage keeps the page inside the valid range', () => {
  assert.equal(clampPage(0, 1800, 100), 0);
  assert.equal(clampPage(17, 1800, 100), 17);
  assert.equal(clampPage(99, 1800, 100), 17);   // past the end: last page
  assert.equal(clampPage(-3, 1800, 100), 0);    // below the start: first page
  assert.equal(clampPage(5, 0, 100), 0);        // empty list: page one
  assert.equal(clampPage(5, 1800, 'all'), 0);   // 'all' is always one page
});

test('pageSlice returns the requested window of rows', () => {
  assert.deepEqual(pageSlice(list(10), 0, 4), [0, 1, 2, 3]);
  assert.deepEqual(pageSlice(list(10), 1, 4), [4, 5, 6, 7]);
  assert.deepEqual(pageSlice(list(10), 2, 4), [8, 9]);   // partial last page
});

test('pageSlice clamps an out-of-range page instead of returning nothing', () => {
  assert.deepEqual(pageSlice(list(10), 7, 4), [8, 9]);
  assert.deepEqual(pageSlice([], 3, 50), []);
});

test('pageSlice with "all" returns every row on one page', () => {
  const l = list(1800);
  assert.equal(pageSlice(l, 0, 'all').length, 1800);
  assert.equal(pageSlice(l, 5, 'all').length, 1800);
});

test('pageRange reports the human-readable row window', () => {
  assert.deepEqual(pageRange(1800, 0, 100), { from: 1, to: 100 });
  assert.deepEqual(pageRange(1800, 17, 100), { from: 1701, to: 1800 });
  assert.deepEqual(pageRange(1843, 18, 100), { from: 1801, to: 1843 }); // partial last page
  assert.deepEqual(pageRange(0, 0, 100), { from: 0, to: 0 });           // empty list
  assert.deepEqual(pageRange(1800, 0, 'all'), { from: 1, to: 1800 });
  assert.deepEqual(pageRange(1800, 40, 100), { from: 1701, to: 1800 }); // clamped page
});
