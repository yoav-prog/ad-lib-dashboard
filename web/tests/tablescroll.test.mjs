// Unit tests for the pure scroll-math helpers in lib/tablescroll.js. Run with
// `npm test`. The DOM behaviour of TableScroll (bar sync, ResizeObserver) is
// browser-only and covered by manual QA, not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { needsScroll, pageStep, clampScrollLeft } from '../lib/tablescroll.js';

test('needsScroll: content wider than the viewport wants scrollbars', () => {
  assert.equal(needsScroll(1400, 900), true);
  assert.equal(needsScroll(900, 900), false);
  assert.equal(needsScroll(901, 900), false); // within the 1px tolerance
  assert.equal(needsScroll(902, 900), true);
});

test('pageStep: most of a screen, with a floor', () => {
  assert.equal(pageStep(1000), 850);
  assert.equal(pageStep(1000, 0.5), 500);
  assert.equal(pageStep(100), 120);   // floor beats the tiny viewport
  assert.equal(pageStep(0), 240);     // unusable width falls back to a default
  assert.equal(pageStep(NaN), 240);
});

test('clampScrollLeft: never negative, never past the end', () => {
  // max scrollable = scrollWidth - clientWidth = 500
  assert.equal(clampScrollLeft(-50, 1400, 900), 0);
  assert.equal(clampScrollLeft(300, 1400, 900), 300);
  assert.equal(clampScrollLeft(9999, 1400, 900), 500);
  assert.equal(clampScrollLeft(500, 1400, 900), 500);
});

test('clampScrollLeft: a table that fits has a single valid offset of 0', () => {
  assert.equal(clampScrollLeft(120, 800, 900), 0);
});
