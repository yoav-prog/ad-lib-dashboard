// Unit tests for the pure A1-notation helper in lib/sheets.js. Pins the fix for
// tab names that look like cell references: unquoted, "DB2" is read by the
// Sheets API as column DB row 2 on the first sheet ("Range exceeds grid
// limits"), not as a tab name. Quoting is always legal, so a1Tab always quotes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { a1Tab } from '../lib/sheets.js';

test('a1Tab quotes a tab name that looks like a cell reference', () => {
  assert.equal(a1Tab('DB2'), "'DB2'");
  assert.equal(a1Tab('A1'), "'A1'");
});

test('a1Tab quotes plain and multi-word titles alike', () => {
  assert.equal(a1Tab('KWSDB'), "'KWSDB'");
  assert.equal(a1Tab('Fresh Finds'), "'Fresh Finds'");
});

test('a1Tab doubles internal single quotes', () => {
  assert.equal(a1Tab("Bob's tab"), "'Bob''s tab'");
});
