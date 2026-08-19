// The matching rules behind "do we already have our own article for this ad, on the domain
// you picked". These are pure (lib/ourmatch.js imports nothing but lib/ui.js), so they are
// tested directly rather than through a database. article_verticals.py mirrors the locale
// rules for the Python backfill; tests/test_article_verticals.py asserts the same cases, so a
// change to one side that is not made on the other shows up as a failure here or there.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countryKey, languageKey, adLocale, isMatchable, localeKey,
  ourQueryPlan, groupOurArticles, countOurArticles,
} from '../lib/ourmatch.js';

// ── countryKey ─────────────────────────────────────────────────────────────────
test('countryKey uppercases and trims', () => {
  assert.equal(countryKey(' us '), 'US');
  assert.equal(countryKey('de'), 'DE');
});

test('countryKey maps GB to UK, the one real mismatch between the two databases', () => {
  // adintel stores GB (914 ads), our articles DB stores UK (14,573 articles). Without this
  // the strict country gate matches nothing at all for the UK.
  assert.equal(countryKey('GB'), 'UK');
  assert.equal(countryKey('gb'), 'UK');
  assert.equal(countryKey('UK'), 'UK');
});

test('countryKey returns empty for nothing usable', () => {
  for (const v of [null, undefined, '', '   ']) assert.equal(countryKey(v), '');
});

// ── languageKey ────────────────────────────────────────────────────────────────
test('languageKey turns adintel language names into the ISO codes our articles store', () => {
  assert.equal(languageKey('English'), 'en');
  assert.equal(languageKey('Spanish'), 'es');
  assert.equal(languageKey('Portuguese'), 'pt');
  assert.equal(languageKey('  German '), 'de');
});

test('languageKey passes an ISO code through unchanged', () => {
  assert.equal(languageKey('en'), 'en');
  assert.equal(languageKey('PT'), 'pt');
});

test('languageKey handles a multi-word name and an unknown value', () => {
  assert.equal(languageKey('Brazilian Portuguese'), 'pt');
  assert.equal(languageKey('Klingon'), 'kl');   // first two letters, never blank
  assert.equal(languageKey(''), '');
});

// ── adLocale ───────────────────────────────────────────────────────────────────
test('adLocale prefers the article language over the creative language', () => {
  // Deliberately the opposite of Client Kits scoreLink: that matcher pairs a link WITH a
  // creative, this one asks what market the offer is in.
  const ad = { country: 'GB', language: 'English', creative_language: 'German' };
  assert.deepEqual(adLocale(ad), { country: 'UK', language: 'en' });
});

test('adLocale falls back to the creative language when the article was never classified', () => {
  assert.deepEqual(adLocale({ country: 'MX', creative_language: 'Spanish' }), { country: 'MX', language: 'es' });
});

test('adLocale on an empty ad yields empty parts, not a crash', () => {
  assert.deepEqual(adLocale({}), { country: '', language: '' });
  assert.deepEqual(adLocale(null), { country: '', language: '' });
});

// ── isMatchable ────────────────────────────────────────────────────────────────
test('isMatchable needs a country, a language and a derived family', () => {
  const full = { country: 'US', language: 'English', article_verticals: ['Tires'] };
  assert.equal(isMatchable(full), true);
  assert.equal(isMatchable({ ...full, country: null }), false);
  assert.equal(isMatchable({ ...full, language: null, creative_language: null }), false);
  assert.equal(isMatchable({ ...full, article_verticals: [] }), false);
  assert.equal(isMatchable({ ...full, article_verticals: null }), false);
});

// ── ourQueryPlan ───────────────────────────────────────────────────────────────
test('ourQueryPlan collapses a page into one bucket per locale, unioning the verticals', () => {
  const rows = [
    { ad_archive_id: '1', country: 'US', language: 'English', article_verticals: ['Tires', 'Car Deals'] },
    { ad_archive_id: '2', country: 'US', language: 'English', article_verticals: ['Car Deals', 'Used Cars'] },
    { ad_archive_id: '3', country: 'DE', language: 'German', article_verticals: ['Tires'] },
  ];
  const plan = ourQueryPlan(rows);
  assert.equal(plan.length, 2);
  const us = plan.find((p) => p.country === 'US');
  assert.deepEqual([...us.verticals].sort(), ['Car Deals', 'Tires', 'Used Cars']);
  assert.equal(us.language, 'en');
  const de = plan.find((p) => p.country === 'DE');
  assert.deepEqual(de, { country: 'DE', language: 'de', verticals: ['Tires'] });
});

test('ourQueryPlan buckets GB and UK ads together', () => {
  const plan = ourQueryPlan([
    { ad_archive_id: '1', country: 'GB', language: 'English', article_verticals: ['Tires'] },
    { ad_archive_id: '2', country: 'UK', language: 'English', article_verticals: ['Car Deals'] },
  ]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].country, 'UK');
  assert.deepEqual(plan[0].verticals.sort(), ['Car Deals', 'Tires']);
});

test('ourQueryPlan skips rows that cannot be matched, and survives junk', () => {
  assert.deepEqual(ourQueryPlan([{ ad_archive_id: '1', country: 'US' }]), []);
  assert.deepEqual(ourQueryPlan([]), []);
  assert.deepEqual(ourQueryPlan(null), []);
});

// ── groupOurArticles ───────────────────────────────────────────────────────────
const article = (over) => ({
  id: 1, url: 'https://mytips.com/a', headline: 'A', domain: 'mytips.com',
  country: 'US', language: 'en', vertical: 'Tires', total: 1, ...over,
});

test('groupOurArticles hands each ad the articles in its own locale and family', () => {
  const rows = [
    { ad_archive_id: 'us', country: 'US', language: 'English', article_verticals: ['Tires'] },
    { ad_archive_id: 'de', country: 'DE', language: 'German', article_verticals: ['Tires'] },
  ];
  const articles = [
    article({ id: 1, url: 'https://mytips.com/us-tires' }),
    article({ id: 2, url: 'https://mytips.com/de-tires', country: 'DE', language: 'de' }),
  ];
  const byAd = groupOurArticles(rows, articles);
  assert.deepEqual(byAd.get('us').map((a) => a.id), [1]);
  assert.deepEqual(byAd.get('de').map((a) => a.id), [2]);
});

test('groupOurArticles refuses a wrong-country or wrong-language article', () => {
  // The strict gate: a US ad must never be handed an AU article, however on-topic.
  const rows = [{ ad_archive_id: 'us', country: 'US', language: 'English', article_verticals: ['Tires'] }];
  assert.equal(groupOurArticles(rows, [article({ country: 'AU' })]).size, 0);
  assert.equal(groupOurArticles(rows, [article({ language: 'es' })]).size, 0);
});

test('groupOurArticles refuses an article outside the derived family', () => {
  const rows = [{ ad_archive_id: 'us', country: 'US', language: 'English', article_verticals: ['Tires'] }];
  assert.equal(groupOurArticles(rows, [article({ vertical: 'Personal Loans' })]).size, 0);
});

test('groupOurArticles matches a GB ad against our UK articles', () => {
  const rows = [{ ad_archive_id: 'gb', country: 'GB', language: 'English', article_verticals: ['Tires'] }];
  const byAd = groupOurArticles(rows, [article({ country: 'UK' })]);
  assert.equal(byAd.get('gb').length, 1);
});

test('groupOurArticles never lists the same article twice for one ad', () => {
  // An ad can carry two verticals; an article has one, so it must appear once whichever
  // vertical found it. This guards the dedupe in the inner loop.
  const rows = [{ ad_archive_id: 'us', country: 'US', language: 'English', article_verticals: ['Tires', 'Tires'] }];
  assert.equal(groupOurArticles(rows, [article()]).get('us').length, 1);
});

test('groupOurArticles shares one article between two ads that both want it', () => {
  const rows = [
    { ad_archive_id: 'a', country: 'US', language: 'English', article_verticals: ['Tires'] },
    { ad_archive_id: 'b', country: 'US', language: 'English', article_verticals: ['Tires'] },
  ];
  const byAd = groupOurArticles(rows, [article()]);
  assert.equal(byAd.get('a').length, 1);
  assert.equal(byAd.get('b').length, 1);
});

test('groupOurArticles returns each ad its articles newest first, across verticals', () => {
  // The SQL only orders within each (country, language, vertical) partition, so an ad matching
  // several verticals receives several already-sorted runs back to back. The grid shows the
  // FIRST element as "the newest one", so the merge has to re-sort or that claim is false.
  const rows = [{ ad_archive_id: 'us', country: 'US', language: 'English', article_verticals: ['Tires', 'Car Deals'] }];
  const articles = [
    article({ id: 1, url: 'a', vertical: 'Tires', published_at: '2026-01-01T00:00:00.000Z' }),
    article({ id: 2, url: 'b', vertical: 'Car Deals', published_at: '2026-08-01T00:00:00.000Z' }),
    article({ id: 3, url: 'c', vertical: 'Car Deals', published_at: '2026-03-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(groupOurArticles(rows, articles).get('us').map((a) => a.url), ['b', 'c', 'a']);
});

test('groupOurArticles sinks undated articles and breaks ties on id', () => {
  const rows = [{ ad_archive_id: 'us', country: 'US', language: 'English', article_verticals: ['Tires'] }];
  const articles = [
    article({ id: 1, url: 'undated', published_at: null }),
    article({ id: 2, url: 'older', published_at: '2026-01-01T00:00:00.000Z' }),
    article({ id: 9, url: 'same-day-high-id', published_at: '2026-08-01T00:00:00.000Z' }),
    article({ id: 4, url: 'same-day-low-id', published_at: '2026-08-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(
    groupOurArticles(rows, articles).get('us').map((a) => a.url),
    ['same-day-high-id', 'same-day-low-id', 'older', 'undated'],
  );
});

test('groupOurArticles places a sister that carries no metadata of its own', () => {
  // The shape that made this necessary, from live data: an article cloned onto another domain
  // is routinely stored with country, language and vertical all NULL. Keyed on its own fields
  // it is unplaceable; keyed on what it was MATCHED on (its sibling's locale) it lands.
  const rows = [{ ad_archive_id: 'it', country: 'IT', language: 'Italian', article_verticals: ['Kitchen Deals'] }];
  const sister = article({
    id: 7, url: 'https://findingfrenzy.com/home-garden/modern-kitchen-it-it',
    domain: 'findingfrenzy.com', country: null, language: null, vertical: null,
    match_country: 'IT', match_language: 'it', match_vertical: 'Kitchen Deals', via_sister: true,
  });
  assert.deepEqual(groupOurArticles(rows, [sister]).get('it').map((a) => a.id), [7]);
});

test('groupOurArticles still refuses a sister matched into the wrong locale', () => {
  // match_* is authoritative, so it has to be wrong for the ad, not merely absent.
  const rows = [{ ad_archive_id: 'it', country: 'IT', language: 'Italian', article_verticals: ['Kitchen Deals'] }];
  const wrong = article({
    id: 8, country: null, language: null, vertical: null,
    match_country: 'DE', match_language: 'de', match_vertical: 'Kitchen Deals', via_sister: true,
  });
  assert.equal(groupOurArticles(rows, [wrong]).size, 0);
});

test('countOurArticles counts a sister under the vertical it was matched on', () => {
  // Its own vertical is null; without match_vertical every sister would collapse into one
  // ""-keyed bucket and the totals would be wrong.
  const hits = [
    article({ id: 1, vertical: null, match_vertical: 'Kitchen Deals', total: 12 }),
    article({ id: 2, vertical: null, match_vertical: 'Kitchen Deals', total: 12 }),
    article({ id: 3, vertical: null, match_vertical: 'Furniture', total: 4 }),
  ];
  assert.equal(countOurArticles(hits), 16);
});

test('groupOurArticles on empty input returns an empty map', () => {
  assert.equal(groupOurArticles([], []).size, 0);
  assert.equal(groupOurArticles(null, null).size, 0);
});

// ── countOurArticles ───────────────────────────────────────────────────────────
test('countOurArticles sums each vertical total once, not the fetched rows', () => {
  // The query returns at most 8 rows per vertical but carries that vertical's real count on
  // every row, so a 128-article vertical must report 128, not 8.
  const hits = [
    article({ id: 1, vertical: 'Tires', total: 128 }),
    article({ id: 2, vertical: 'Tires', total: 128 }),
    article({ id: 3, vertical: 'Car Deals', total: 12 }),
  ];
  assert.equal(countOurArticles(hits), 140);
});

test('countOurArticles falls back to counting rows when no total is carried', () => {
  const hits = [article({ id: 1, total: undefined }), article({ id: 2, total: undefined })];
  assert.equal(countOurArticles(hits), 2);
});

test('countOurArticles on nothing is zero', () => {
  assert.equal(countOurArticles([]), 0);
  assert.equal(countOurArticles(null), 0);
});

// ── localeKey ──────────────────────────────────────────────────────────────────
test('localeKey is the plain composite the index is built on', () => {
  assert.equal(localeKey('US', 'en'), 'US|en');
});
