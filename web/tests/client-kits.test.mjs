// Unit tests for the pure Client Kits helpers in lib/ui.js: the auto-suggest scorer,
// the ranking, the availability filter, and the KIT_COLUMNS export shape. Run with
// `npm test` (Node's built-in runner, no dependencies). These are the pieces that decide
// what link a client sees, so they are pinned here rather than trusted to review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreLink, rankLinks, availableLinks, buildSheetData, KIT_COLUMNS, KIT_COLUMN_META, DEFAULT_KIT_COLUMN_KEYS } from '../lib/ui.js';

const NOW = Date.UTC(2026, 7, 13);

const ad = { ad_archive_id: 'ad-1', creative_language: 'en', language: 'en', country: 'US', vertical: 'Home & Garden' };

const perfect = { id: 1, url: 'https://mytips.com/a', headline: 'Heat pumps', domain: 'mytips.com', language: 'en', country: 'US', vertical: 'Home & Garden', category: null, published_at: '2026-08-10T00:00:00Z' };
const langOnly = { id: 2, url: 'https://mytips.com/b', headline: 'Cars', domain: 'mytips.com', language: 'en', country: 'DE', vertical: 'Autos', category: null, published_at: '2026-08-11T00:00:00Z' };
const noMatch = { id: 3, url: 'https://mytips.com/c', headline: 'Nada', domain: 'mytips.com', language: 'de', country: 'DE', vertical: 'Finance', category: null, published_at: '2026-08-12T00:00:00Z' };

test('scoreLink weights language and country over vertical', () => {
  assert.equal(scoreLink(ad, perfect), 5 + 3 + 2);       // lang + country + vertical
  assert.equal(scoreLink(ad, langOnly), 5);              // language only
  assert.equal(scoreLink(ad, noMatch), 0);               // nothing matches
});

test('scoreLink is null-safe', () => {
  assert.equal(scoreLink(null, perfect), 0);
  assert.equal(scoreLink(ad, null), 0);
  assert.equal(scoreLink({}, {}), 0);
});

test('rankLinks orders by score, then newest, without mutating input', () => {
  const input = [noMatch, langOnly, perfect];
  const ranked = rankLinks(ad, input);
  assert.deepEqual(ranked.map((l) => l.id), [1, 2, 3]);  // perfect, langOnly, noMatch
  assert.equal(input[0].id, 3);                          // original array untouched
  assert.ok(!('score' in input[0]));                     // originals not tagged
});

test('rankLinks breaks score ties by published_at desc', () => {
  const older = { ...noMatch, id: 10, published_at: '2026-01-01T00:00:00Z' };
  const newer = { ...noMatch, id: 11, published_at: '2026-08-01T00:00:00Z' };
  const ranked = rankLinks(ad, [older, newer]);
  assert.deepEqual(ranked.map((l) => l.id), [11, 10]);
});

test('availableLinks drops URLs that are already assigned', () => {
  const links = [perfect, langOnly, noMatch];
  const out = availableLinks(links, ['https://mytips.com/b']);
  assert.deepEqual(out.map((l) => l.id), [1, 3]);
  assert.equal(availableLinks(links, []).length, 3);
  assert.equal(availableLinks(links, null).length, 3);
});

test('KIT_COLUMNS never leaks a competitor URL and always carries our link', () => {
  const headers = KIT_COLUMN_META.map((m) => m.header);
  // The competitor's own destination columns are dropped by construction.
  for (const banned of ['Link', 'Slug', 'Query']) assert.ok(!headers.includes(banned), `KIT must not include ${banned}`);
  // Our-link columns are present.
  for (const need of ['Our Domain', 'Our Link', 'Our Headline']) assert.ok(headers.includes(need), `KIT must include ${need}`);
  // Ad ID stays, so the append-mode sheet dedupe still works.
  assert.ok(headers.includes('Ad ID'));
});

test('buildSheetData(KIT_COLUMNS) populates our-link cells from the joined ad', () => {
  const joined = { ...ad, title: 'Competitor headline', domain: 'rival.com', link_url: 'https://rival.com/secret', our_url: 'https://mytips.com/a', our_domain: 'mytips.com', our_headline: 'Heat pumps' };
  const { columns, rows } = buildSheetData([joined], NOW, DEFAULT_KIT_COLUMN_KEYS, KIT_COLUMNS);
  const idx = (h) => columns.findIndex((c) => c.header === h);
  const cell = (h) => rows[0].cells[idx(h)];
  assert.equal(cell('Our Link').value, 'https://mytips.com/a');
  assert.equal(cell('Our Link').kind, 'link');
  assert.equal(cell('Our Domain').value, 'mytips.com');
  assert.equal(cell('Our Headline').value, 'Heat pumps');
  // The competitor's link is nowhere in the exported cells.
  const flat = JSON.stringify(rows[0].cells);
  assert.ok(!flat.includes('rival.com/secret'), 'competitor URL must not appear in a kit export');
});
