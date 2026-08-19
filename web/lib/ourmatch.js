// Pure matching rules for "do we already have our own article for this ad, on the domain the
// user picked?". No database or driver imports live here on purpose, so the rules can be
// unit-tested with Node's built-in runner and no dependencies (like lib/owned.js and lib/ui.js).
// The database side - fetching our articles and hanging them on the feed rows - stays in
// lib/articles.js, the single articles-DB boundary. article_verticals.py mirrors these same
// rules for the Python backfill, so the live path and the backfill cannot drift.
//
// A match is country AND language AND one of the ad's derived verticals. All three are hard
// gates, deliberately: a US ad must never be offered an Australian article, and an article in
// the wrong language is unusable whatever its topic. This is the same strictness Client Kits'
// planBulkAssignment applies (see lib/ui.js), for the same reason.
import { langCode } from './ui.js';

// The two databases spell one country differently: our articles DB stores UK (14,573 rows),
// while adintel stores the ISO code GB (914 ads). Left alone, every UK ad matches nothing at
// all. GB is the only such alias across all 84 country codes adintel carries, so this map is a
// map of one rather than a general ISO-3166 exception table - add to it only when a second
// genuine mismatch is found in the data.
const COUNTRY_ALIASES = { GB: 'UK' };

export function countryKey(country) {
  const c = String(country || '').trim().toUpperCase();
  if (!c) return '';
  return COUNTRY_ALIASES[c] || c;
}

// adintel stores a language NAME ("English"), our articles store an ISO code ("en"). langCode
// already converts a name and returns it uppercased for the country-code-sized badge it was
// written for; articles are lowercase, so both sides land in lowercase here. A value that is
// already a code passes through langCode unchanged (it falls back to the first two letters).
export function languageKey(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  return langCode(v).toLowerCase();
}

// The locale we match an ad on. `language` comes first here, unlike Client Kits' scoreLink
// which prefers `creative_language`: that matcher is picking a link to pair WITH a creative,
// so the creative's own language wins, while this one is asking "what market is this offer
// in", which is the language of the landing article. creative_language is the fallback for
// ads whose article was never classified.
export function adLocale(ad) {
  return {
    country: countryKey(ad && ad.country),
    language: languageKey(ad && (ad.language || ad.creative_language)),
  };
}

// An ad can be matched only once it has all three parts. Ads with no derived family (never
// backfilled, or backfilled to nothing) and ads missing a country or language are skipped
// rather than matched loosely - a loose match here would put a wrong-market link in front of
// someone as if it were checked.
export function isMatchable(ad) {
  const { country, language } = adLocale(ad);
  return Boolean(country && language && Array.isArray(ad && ad.article_verticals) && ad.article_verticals.length);
}

export const localeKey = (country, language) => `${country}|${language}`;

// What an article was matched ON. lib/articles.js sets match_* on every row it returns; the
// article's own field is the fallback so these stay usable for a plain article object (and so
// the tests can pass one). See groupOurArticles for why the distinction matters.
const matchCountry = (a) => (a && a.match_country != null ? a.match_country : (a && a.country));
const matchLanguage = (a) => (a && a.match_language != null ? a.match_language : (a && a.language));
const matchVertical = (a) => String((a && a.match_vertical != null ? a.match_vertical : (a && a.vertical)) || '');

// Collapse a page of feed rows into the smallest query that can answer all of them: one
// bucket per locale, each carrying the union of that locale's verticals. A page of 100 ads is
// typically 5-15 locales, so this turns 100 lookups into one IN-list per locale rather than
// one query per ad. Pure, so the shape of the query is testable without a database.
export function ourQueryPlan(rows) {
  const byLocale = new Map();
  for (const r of rows || []) {
    if (!isMatchable(r)) continue;
    const { country, language } = adLocale(r);
    const key = localeKey(country, language);
    let bucket = byLocale.get(key);
    if (!bucket) { bucket = { country, language, verticals: new Set() }; byLocale.set(key, bucket); }
    for (const v of r.article_verticals) if (v) bucket.verticals.add(String(v));
  }
  return [...byLocale.values()].map((b) => ({ country: b.country, language: b.language, verticals: [...b.verticals] }));
}

// How many articles we actually have for an ad, as opposed to how many were fetched. The
// query returns only the newest few per vertical (so a page never drags thousands of rows
// across the wire) but carries that vertical's real total on every row. An article has exactly
// one vertical, so summing each distinct vertical's total once is the true figure and cannot
// double-count. Falls back to counting the rows themselves if a caller passes plain articles.
export function countOurArticles(hits) {
  const totals = new Map();
  for (const h of hits || []) {
    const v = matchVertical(h);
    if (!totals.has(v)) totals.set(v, Number.isFinite(h.total) ? h.total : (hits || []).filter((x) => matchVertical(x) === v).length);
  }
  let n = 0;
  for (const t of totals.values()) n += t;
  return n;
}

// Bucket the fetched articles back onto the ads that asked for them. `articles` is whatever
// the locale queries returned, so an article may satisfy several ads (a shared vertical) and
// an ad may collect articles from more than one of its verticals. Order is preserved from the
// query (newest first), so slicing the head in the UI shows the freshest matches.
export function groupOurArticles(rows, articles) {
  const byAd = new Map();
  if (!Array.isArray(rows) || !Array.isArray(articles) || !articles.length) return byAd;

  // Index our articles by locale + vertical once, so each ad is a handful of map reads
  // rather than a scan of the whole result set.
  //
  // Keyed on what the article was MATCHED on, not on its own fields. For a direct hit the two
  // are the same. For one reached through its sister family they are not: a sister is very
  // often stored with country, language and vertical all NULL, and the locale it belongs to is
  // the one its matched sibling carries. Reading a.country here would drop exactly the rows the
  // sister chain exists to find.
  const index = new Map();
  for (const a of articles) {
    const key = `${localeKey(countryKey(matchCountry(a)), languageKey(matchLanguage(a)))}|${String(matchVertical(a))}`;
    const list = index.get(key);
    if (list) list.push(a); else index.set(key, [a]);
  }

  for (const r of rows) {
    if (!isMatchable(r)) continue;
    const { country, language } = adLocale(r);
    const seen = new Set();
    const hits = [];
    for (const v of r.article_verticals) {
      for (const a of index.get(`${localeKey(country, language)}|${String(v || '')}`) || []) {
        if (seen.has(a.url)) continue;   // the same article can sit under two of the ad's verticals
        seen.add(a.url);
        hits.push(a);
      }
    }
    if (hits.length) byAd.set(r.ad_archive_id, hits.sort(newestFirst));
  }
  return byAd;
}

// Newest first, mirroring the SQL's `published_at desc nulls last, id desc`.
//
// The query only orders WITHIN each (country, language, vertical) partition - that is what the
// row_number() is for - and the outer statement has no global order at all. An ad that matches
// several verticals therefore collects several already-sorted runs, one after another, so the
// first element was the newest of whichever vertical came back first, not the newest overall.
// The grid shows exactly that first element, so this sort is what makes "the newest one" true.
function newestFirst(x, y) {
  const a = x.published_at || '';
  const b = y.published_at || '';
  if (a !== b) {
    if (!a) return 1;          // undated sinks, like `nulls last`
    if (!b) return -1;
    return b.localeCompare(a); // ISO strings sort lexicographically
  }
  return (y.id ?? 0) - (x.id ?? 0);
}
