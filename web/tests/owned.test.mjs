// Unit tests for the pure "we have our own version" matching in lib/owned.js: URL
// normalization and the row-to-owned-parent matcher. Run with `npm test` (Node's built-in
// runner, no dependencies). These decide which competitor rows get badged, so they are pinned
// here rather than trusted to review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrlKey, ownedCandidateUrls, matchOwned } from '../lib/owned.js';

test('normalizeUrlKey strips scheme, www, query, fragment and trailing slash', () => {
  const k = 'castofnotes.com/de/articles/verlassene-hauser';
  assert.equal(normalizeUrlKey('https://castofnotes.com/de/articles/verlassene-hauser'), k);
  assert.equal(normalizeUrlKey('http://www.castofnotes.com/de/articles/verlassene-hauser/'), k);
  assert.equal(normalizeUrlKey('https://CastOfNotes.com/de/articles/verlassene-hauser?utm=1&x=2'), k);
  assert.equal(normalizeUrlKey('https://www.castofnotes.com/de/articles/verlassene-hauser#top'), k);
});

test('normalizeUrlKey lowercases host but preserves path case (slugs are case-sensitive)', () => {
  assert.equal(normalizeUrlKey('https://Example.com/A/B'), 'example.com/A/B');
});

test('normalizeUrlKey returns null for junk / empty / non-URL input', () => {
  for (const bad of [null, undefined, '', '   ', 'not a url', 'ftp://', '/relative/path']) {
    assert.equal(normalizeUrlKey(bad), null);
  }
});

test('ownedCandidateUrls yields resolved_url first, then each " | "-joined link_url', () => {
  const row = { resolved_url: 'https://a.com/x', link_url: 'https://b.com/y | https://c.com/z' };
  assert.deepEqual(ownedCandidateUrls(row), ['https://a.com/x', 'https://b.com/y', 'https://c.com/z']);
  assert.deepEqual(ownedCandidateUrls({ link_url: 'https://only.com/1' }), ['https://only.com/1']);
  assert.deepEqual(ownedCandidateUrls({}), []);
});

// A tiny fake index keyed by normalized parent, the shape getOwnedParentIndex builds.
const index = new Map([
  ['castofnotes.com/de/articles/verlassene-hauser', { parent_url: 'https://castofnotes.com/de/articles/verlassene-hauser', family_id: 'fam-1' }],
  ['orbitpeek.com/en/articles/breast-lift', { parent_url: 'https://orbitpeek.com/en/articles/breast-lift', family_id: 'fam-2' }],
]);

test('matchOwned hits via resolved_url (with tracking query) and via link_url', () => {
  const rows = [
    { ad_archive_id: 'ad-res', resolved_url: 'https://castofnotes.com/de/articles/verlassene-hauser?utm_source=110&campaign_id=x' },
    { ad_archive_id: 'ad-link', link_url: 'https://www.orbitpeek.com/en/articles/breast-lift/' },
  ];
  const hits = matchOwned(rows, index);
  assert.equal(hits.get('ad-res')?.family_id, 'fam-1');
  assert.equal(hits.get('ad-link')?.family_id, 'fam-2');
});

test('matchOwned prefers a candidate that matches even if another does not', () => {
  const rows = [{ ad_archive_id: 'ad-mix', resolved_url: 'https://therocketsscience.com/asrsearch?search=x', link_url: 'https://castofnotes.com/de/articles/verlassene-hauser' }];
  const hits = matchOwned(rows, index);
  assert.equal(hits.get('ad-mix')?.parent_url, 'https://castofnotes.com/de/articles/verlassene-hauser');
});

test('matchOwned returns no hit for unrelated URLs (RSOC search pages)', () => {
  const rows = [{ ad_archive_id: 'ad-rsoc', resolved_url: 'https://therocketsscience.com/asrsearch?search=becas', link_url: 'https://trk.s2sengine.com/click?id=9' }];
  assert.equal(matchOwned(rows, index).size, 0);
});

test('matchOwned is safe on an empty index or empty rows', () => {
  assert.equal(matchOwned([{ ad_archive_id: 'a', resolved_url: 'https://castofnotes.com/de/articles/verlassene-hauser' }], new Map()).size, 0);
  assert.equal(matchOwned([], index).size, 0);
  assert.equal(matchOwned(null, index).size, 0);
});
