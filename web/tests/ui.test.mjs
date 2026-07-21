// Unit tests for the pure export helpers in lib/ui.js. Run with `npm test` (Node's
// built-in runner, no dependencies). The media-URL cases pin the fix for video ads:
// exports must carry the watchable video link, not the poster image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isVideo, thumbOf, mediaUrlOf, buildCsv, buildSheetData, SHEET_COLUMNS, parseSheetId, hostOf, filterReviewAds, reviewDestOf, sanitizeColumnKeys, fmtInt, fmtDec, geoCountries, isPredicto, predictoQuery, brandLabel, brandColor, BRAND_OPTIONS, filterFlaggedAds, contentFlagLabel, CONTENT_FLAG_OPTIONS } from '../lib/ui.js';

const NOW = Date.UTC(2026, 6, 9);

const imageAd = {
  ad_archive_id: 'img-1',
  display_format: 'IMAGE',
  original_image_urls: ['https://cdn.example.com/creative.jpg'],
  video_hd_url: null,
  video_preview_url: null,
};

const videoAd = {
  ad_archive_id: 'vid-1',
  display_format: 'VIDEO',
  original_image_urls: [],
  video_hd_url: 'https://cdn.example.com/creative.mp4',
  video_preview_url: 'https://cdn.example.com/poster.jpg',
};

// A video ad the scraper stored without an HD rendition; only the poster survives.
const posterOnlyVideoAd = { ...videoAd, ad_archive_id: 'vid-2', video_hd_url: null };

test('mediaUrlOf returns the image for image ads', () => {
  assert.equal(mediaUrlOf(imageAd), 'https://cdn.example.com/creative.jpg');
});

test('mediaUrlOf returns the video link, not the poster, for video ads', () => {
  assert.equal(mediaUrlOf(videoAd), 'https://cdn.example.com/creative.mp4');
});

test('mediaUrlOf falls back to the poster when a video has no HD url', () => {
  assert.equal(mediaUrlOf(posterOnlyVideoAd), 'https://cdn.example.com/poster.jpg');
});

test('mediaUrlOf returns null when the ad has no media at all', () => {
  assert.equal(mediaUrlOf({}), null);
});

test('thumbOf still returns the poster image for video ads (previews stay images)', () => {
  assert.equal(thumbOf(videoAd), 'https://cdn.example.com/poster.jpg');
});

test('isVideo detects by display_format or by the presence of a video url', () => {
  assert.equal(isVideo(videoAd), true);
  assert.equal(isVideo({ video_hd_url: 'https://x.example/v.mp4' }), true);
  assert.equal(isVideo(imageAd), false);
});

test('hostOf extracts the bare lowercase host for the Review tab', () => {
  assert.equal(hostOf('https://www.temu.com/motorcycle.com-box.html'), 'temu.com');
  assert.equal(hostOf('HTTPS://Go.CastOfNotes.COM/x?y=1'), 'go.castofnotes.com');
  assert.equal(hostOf('castofnotes.com/path'), 'castofnotes.com');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(null), '');
});

// Review-queue triage: the facet filter must slice exactly the rows the bulk
// buttons will decide on (e.g. every ad that leads to alibaba.com -> reject).
const reviewAds = [
  { ad_archive_id: 'r1', domain: 'brim-b.com', page_name: 'Alibaba.com', title: 'Custom caps', link_url: 'https://www.alibaba.com/x | https://www.alibaba.com/y' },
  { ad_archive_id: 'r2', domain: 'tractor.com', page_name: 'Flipkart', title: 'Hydraulic jack', link_url: 'https://www.flipkart.com/z' },
  { ad_archive_id: 'r3', domain: 'motorcycle.com', page_name: 'Devine Studio', title: 'Chat with us', link_url: '' },
];

test('reviewDestOf yields the first destination host, with a label for linkless ads', () => {
  assert.equal(reviewDestOf(reviewAds[0]), 'alibaba.com');
  assert.equal(reviewDestOf(reviewAds[2]), '(no link)');
});

test('filterReviewAds slices by destination host facet', () => {
  const out = filterReviewAds(reviewAds, '', { dest: ['alibaba.com'] });
  assert.deepEqual(out.map((a) => a.ad_archive_id), ['r1']);
});

test('filterReviewAds combines facets and search tokens (all must match)', () => {
  assert.deepEqual(filterReviewAds(reviewAds, 'jack', { domain: ['tractor.com'] }).map((a) => a.ad_archive_id), ['r2']);
  assert.deepEqual(filterReviewAds(reviewAds, 'jack', { domain: ['brim-b.com'] }), []);
});

test('filterReviewAds with no query and no facets returns everything', () => {
  assert.equal(filterReviewAds(reviewAds, '', {}).length, 3);
  assert.equal(filterReviewAds(reviewAds, '  ', undefined).length, 3);
});

test('filterReviewAds matches the (no link) facet for linkless ads', () => {
  assert.deepEqual(filterReviewAds(reviewAds, '', { dest: ['(no link)'] }).map((a) => a.ad_archive_id), ['r3']);
});

test('buildSheetData: the Media URL cell of a video row holds the video link', () => {
  const { columns, rows } = buildSheetData([videoAd, imageAd], NOW, ['preview', 'image_url', 'ad_id']);
  const mediaCol = columns.findIndex((c) => c.header === 'Media URL');
  assert.notEqual(mediaCol, -1);
  assert.deepEqual(rows[0].cells[mediaCol], { kind: 'link', value: 'https://cdn.example.com/creative.mp4' });
  assert.deepEqual(rows[1].cells[mediaCol], { kind: 'link', value: 'https://cdn.example.com/creative.jpg' });
});

test('buildSheetData: the Preview cell of a video row keeps the poster image', () => {
  const { columns, rows } = buildSheetData([videoAd], NOW, ['preview', 'image_url']);
  const previewCol = columns.findIndex((c) => c.header === 'Preview');
  assert.deepEqual(rows[0].cells[previewCol], { kind: 'image', value: 'https://cdn.example.com/poster.jpg' });
});

test('buildSheetData keeps canonical column order and drops unknown keys', () => {
  const { columns } = buildSheetData([], NOW, ['ad_id', 'image_url', 'nope']);
  assert.deepEqual(columns.map((c) => c.key), ['image_url', 'ad_id']);
});

test('buildSheetData with no selection exports every column', () => {
  const { columns } = buildSheetData([], NOW, []);
  assert.equal(columns.length, SHEET_COLUMNS.length);
});

test('buildCsv carries the video link and omits the image-preview column', () => {
  const csv = buildCsv([videoAd], NOW);
  const [header, row] = csv.split('\r\n');
  assert.ok(header.includes('"Media URL"'));
  assert.ok(!header.includes('"Preview"'));
  assert.ok(row.includes('"https://cdn.example.com/creative.mp4"'));
  assert.ok(!row.includes('poster.jpg'));
});

test('buildCsv escapes quotes, commas, and newlines in ad copy', () => {
  const tricky = { ...imageAd, body_text: 'He said "buy now",\ntoday' };
  const csv = buildCsv([tricky], NOW);
  assert.ok(csv.includes('"He said ""buy now"",\ntoday"'));
});

test('parseSheetId accepts a bare id or a full URL', () => {
  assert.equal(parseSheetId('abc-123_XYZ'), 'abc-123_XYZ');
  assert.equal(parseSheetId('https://docs.google.com/spreadsheets/d/abc-123_XYZ/edit#gid=0'), 'abc-123_XYZ');
});

// Campaign metrics joined from the team's sheet ride along in both exports.
const metricAd = { ...imageAd, sheet_revenue: 11947.19693, sheet_clicks: 4883, sheet_rpc: 2.446839428, sheet_geos: 'ES-90,MX-10', sheet_keywords: 'online diploma, adults' };

test('buildSheetData carries the five sheet-metric columns', () => {
  const { columns, rows } = buildSheetData([metricAd], NOW, ['revenue', 'clicks', 'rpc', 'geos', 'keywords']);
  assert.deepEqual(columns.map((c) => c.header), ['Revenue Prediction', 'Clicks', 'RPC', 'GEOS', 'Top Keywords']);
  assert.deepEqual(rows[0].cells.map((c) => c.value), ['11947.20', '4883', '2.45', 'ES-90,MX-10', 'online diploma, adults']);
});

test('buildSheetData exports empty metric cells (not zeros) for unmatched ads', () => {
  const { rows } = buildSheetData([imageAd], NOW, ['revenue', 'clicks', 'rpc', 'geos', 'keywords']);
  assert.deepEqual(rows[0].cells.map((c) => c.value), ['', '', '', '', '']);
});

test('buildCsv includes the metric columns', () => {
  const [header, row] = buildCsv([metricAd], NOW).split('\r\n');
  assert.ok(header.includes('"Revenue Prediction"') && header.includes('"RPC"') && header.includes('"Top Keywords"'));
  assert.ok(row.includes('"11947.20"') && row.includes('"4883"') && row.includes('"2.45"'));
});

// Brand classification: the DB stores a compact key; the UI + exports show the
// human label, and an unknown/absent key must never render a stray word.
test('brandLabel maps the three keys to readable labels and blanks the rest', () => {
  assert.equal(brandLabel('none'), 'No brand');
  assert.equal(brandLabel('brand'), 'Brand');
  assert.equal(brandLabel('car_brand'), 'Car brand');
  assert.equal(brandLabel(null), '');
  assert.equal(brandLabel('bogus'), '');
});

test('brandColor gives every option a color and a safe default', () => {
  for (const o of BRAND_OPTIONS) assert.match(brandColor(o.key), /^#[0-9A-Fa-f]{6}$/);
  assert.match(brandColor(undefined), /^#[0-9A-Fa-f]{6}$/);
});

test('exports carry a Brand column with the readable label', () => {
  const { columns, rows } = buildSheetData([{ ...imageAd, brand: 'car_brand' }], NOW, ['ad_id', 'brand']);
  const brandCol = columns.findIndex((c) => c.header === 'Brand');
  assert.notEqual(brandCol, -1);
  assert.equal(rows[0].cells[brandCol].value, 'Car brand');
  const [header, row] = buildCsv([{ ...imageAd, brand: 'brand' }], NOW).split('\r\n');
  assert.ok(header.includes('"Brand"'));
  assert.ok(row.includes('"Brand"'));
});

test('exports carry a Creative Language column as an ISO code', () => {
  const { columns, rows } = buildSheetData([{ ...imageAd, creative_language: 'Portuguese' }], NOW, ['ad_id', 'creative_language']);
  const col = columns.findIndex((c) => c.header === 'Creative Language');
  assert.notEqual(col, -1);
  assert.equal(rows[0].cells[col].value, 'PT');
  // Empty (no readable text on the creative) exports as an empty cell, not a guess.
  const { rows: r2 } = buildSheetData([{ ...imageAd, creative_language: '' }], NOW, ['creative_language']);
  assert.equal(r2[0].cells[0].value, '');
});

test('geoCountries lists the countries in a GEOS split, in order', () => {
  assert.deepEqual(geoCountries('ES-90,MX-10'), ['ES', 'MX']);
  assert.deepEqual(geoCountries('US-100'), ['US']);
  assert.deepEqual(geoCountries(null), []);
  assert.deepEqual(geoCountries(''), []);
});

test('fmtInt and fmtDec render numbers for reading and stay empty on null', () => {
  assert.equal(fmtInt(11947.19693), '11,947');
  assert.equal(fmtInt(null), '');
  assert.equal(fmtDec(2.446839428), '2.45');
  assert.equal(fmtDec(''), '');
  assert.equal(fmtDec('abc'), '');
});

// The tables' COLUMNS picker: stored selections survive only for keys the
// table still knows; anything unusable falls back to the caller's defaults.
const pickerDefs = [{ key: 'a', label: 'A', w: 1 }, { key: 'b', label: 'B', w: 1 }];

test('sanitizeColumnKeys drops unknown keys and keeps known ones', () => {
  assert.deepEqual(sanitizeColumnKeys(['b', 'zombie', 'a'], pickerDefs), ['b', 'a']);
});

test('sanitizeColumnKeys keeps a legitimate empty selection', () => {
  assert.deepEqual(sanitizeColumnKeys([], pickerDefs), []);
});

test('sanitizeColumnKeys returns null for unusable stored values', () => {
  assert.equal(sanitizeColumnKeys(null, pickerDefs), null);
  assert.equal(sanitizeColumnKeys('a,b', pickerDefs), null);
  assert.equal(sanitizeColumnKeys(undefined, pickerDefs), null);
});

// Predicto feed: the searched phrase is pulled from the landing link. Format A
// (direct) has ?search= in link_url; Format B (a 302 tracker) only exposes it in
// the post-redirect resolved_url the scraper stores. Real examples from the wild.
const predictoDirect = {
  ad_archive_id: 'p-a', feed: 'Predicto',
  link_url: 'https://tunefulsoul.com/asrsearch?search=understanding-bladder-cancer-surgery-a-comprehensive-guide-to-the-procedure-and-recovery-process-c29903&trackingId=38523',
  resolved_url: null,
};
const predictoRedirect = {
  ad_archive_id: 'p-b', feed: 'Predicto',
  link_url: 'https://wildflares.com/teleport?dspAdId=%7B%7Bad.id%7D%7D&dspName=facebook',
  resolved_url: 'https://searchpredictor.com/asrsearch/?search=Startup+Grants+Guide+2026+en&source=facebook&lang=en',
};

test('predictoQuery: direct format keeps the hyphen slug and strips the 6-hex id', () => {
  assert.equal(predictoQuery(predictoDirect),
    'understanding-bladder-cancer-surgery-a-comprehensive-guide-to-the-procedure-and-recovery-process');
});

// The trailing tracking id is a 6-char hex string with at least one digit (real
// values from the data). Strip those; leave everything else, including short
// ids, years, and real all-letter words that happen to be hex.
test('predictoQuery: strips assorted real 6-hex ids, keeps meaningful hyphen parts', () => {
  const q = (search) => predictoQuery({ feed: 'Predicto', link_url: `https://tunefulsoul.com/asrsearch?search=${search}` });
  assert.equal(q('wear-perfume-7a075c'), 'wear-perfume');
  assert.equal(q('family-meals-cf4572'), 'family-meals');
  assert.equal(q('hairstyles-e4dc10'), 'hairstyles');
  assert.equal(q('broadband-internet-d87a56'), 'broadband-internet');
  assert.equal(q('plastic-solutions-494e69'), 'plastic-solutions');
  // Keeps a meaningful hex-looking segment that is not the trailing id (chevy c10).
  assert.equal(q('the-ultimate-buyers-guide-to-the-classic-chevy-c10-e672e2'),
    'the-ultimate-buyers-guide-to-the-classic-chevy-c10');
});

test('predictoQuery: does NOT strip all-letter hex words, years, or non-6-char ids', () => {
  const q = (search) => predictoQuery({ feed: 'Predicto', link_url: `https://tunefulsoul.com/asrsearch?search=${search}` });
  assert.equal(q('the-lost-decade'), 'the-lost-decade');      // 'decade' is 6 hex but all letters, no digit
  assert.equal(q('best-cars-of-2026'), 'best-cars-of-2026');  // '2026' is only 4 chars
  assert.equal(q('debt-lawyer-no-en-69ff'), 'debt-lawyer-no-en-69ff'); // '69ff' is only 4 chars
});

test('predictoQuery: redirect format reads the phrase from resolved_url, + as spaces', () => {
  assert.equal(predictoQuery(predictoRedirect), 'Startup Grants Guide 2026 en');
});

test('predictoQuery: resolved_url wins over link_url when both carry a search param', () => {
  const ad = { feed: 'predicto', link_url: 'https://x.com/asrsearch?search=old-slug', resolved_url: 'https://searchpredictor.com/asrsearch/?search=New+Phrase' };
  assert.equal(predictoQuery(ad), 'New Phrase');
});

test('predictoQuery: uses the first destination of a DCO pipe-joined link_url', () => {
  const ad = { feed: 'Predicto', link_url: 'https://tunefulsoul.com/asrsearch?search=first-one-a1b2c3 | https://tunefulsoul.com/asrsearch?search=second-two-d4e5f6' };
  assert.equal(predictoQuery(ad), 'first-one');
});

test('predictoQuery: blank (never a guess) when a Predicto link exposes no phrase', () => {
  // Format B not yet backfilled: the tracker link has no ?search= and resolved_url is empty.
  assert.equal(predictoQuery({ feed: 'Predicto', link_url: 'https://wildflares.com/teleport?dspName=facebook', resolved_url: '' }), '');
  assert.equal(predictoQuery({ feed: 'Predicto', link_url: 'not a url', resolved_url: null }), '');
  assert.equal(predictoQuery({ feed: 'Predicto', link_url: '', resolved_url: '' }), '');
});

test('predictoQuery: only the Predicto feed gets a query (gated by feed, case-insensitive)', () => {
  assert.equal(isPredicto({ feed: 'Predicto' }), true);
  assert.equal(isPredicto({ feed: 'Tarzo' }), false);
  // A non-Predicto ad with a coincidental search param stays blank.
  assert.equal(predictoQuery({ feed: 'Tarzo', link_url: 'https://x.com/y?search=nope' }), '');
});

test('the Search Query column flows through buildSheetData and buildCsv', () => {
  const { columns, rows } = buildSheetData([predictoDirect, imageAd], NOW, ['query']);
  assert.deepEqual(columns.map((c) => c.header), ['Search Query']);
  assert.equal(rows[0].cells[0].value,
    'understanding-bladder-cancer-surgery-a-comprehensive-guide-to-the-procedure-and-recovery-process');
  assert.equal(rows[1].cells[0].value, ''); // non-Predicto ad -> empty cell

  const [header, row] = buildCsv([predictoRedirect], NOW).split('\r\n');
  assert.ok(header.includes('"Search Query"'));
  assert.ok(row.includes('"Startup Grants Guide 2026 en"'));
});

// ── prohibited-content: the Filtered view's queue filter + label map ───────────
const flaggedAds = [
  { ad_archive_id: 'f1', content_flag: 'gambling', domain: 'bet.com', page_name: 'Bet', body_text: 'win big' },
  { ad_archive_id: 'f2', content_flag: 'adult', domain: 'x.com', page_name: 'X', body_text: 'nsfw' },
  { ad_archive_id: 'f3', content_flag: 'gambling', domain: 'casino.com', page_name: 'Casino', body_text: 'jackpot' },
];

test('filterFlaggedAds narrows by category facet', () => {
  const only = filterFlaggedAds(flaggedAds, '', { category: ['gambling'] });
  assert.deepEqual(only.map((a) => a.ad_archive_id), ['f1', 'f3']);
});

test('filterFlaggedAds narrows by domain facet', () => {
  const only = filterFlaggedAds(flaggedAds, '', { domain: ['x.com'] });
  assert.deepEqual(only.map((a) => a.ad_archive_id), ['f2']);
});

test('filterFlaggedAds honors the text query across page/copy/domain', () => {
  assert.deepEqual(filterFlaggedAds(flaggedAds, 'jackpot', {}).map((a) => a.ad_archive_id), ['f3']);
  assert.deepEqual(filterFlaggedAds(flaggedAds, 'casino', {}).map((a) => a.ad_archive_id), ['f3']);
  assert.equal(filterFlaggedAds(flaggedAds, 'nothingmatches', {}).length, 0);
});

test('contentFlagLabel reads every category and falls back to the raw key', () => {
  for (const o of CONTENT_FLAG_OPTIONS) assert.equal(contentFlagLabel(o.key), o.label);
  // A value the UI does not know yet (server added a category first) still renders.
  assert.equal(contentFlagLabel('brand_new_category'), 'brand_new_category');
  assert.equal(contentFlagLabel(''), '');
});

// ── rule-20 guard: the queries must keep hiding prohibited ads ─────────────────
// A source-level check, so removing the filter from the feed (or the review queue,
// or the Filtered view) fails the build instead of silently leaking hidden ads back.
test('the feed and review queries exclude prohibited ads; the Filtered query selects them', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/queries.js', import.meta.url)), 'utf8');
  // The shared fragments still exist and encode the exact rule.
  assert.ok(src.includes("a.content_flag is null or a.content_flag = 'none'"), 'notProhibited fragment');
  assert.ok(src.includes("a.content_flag is not null and a.content_flag <> 'none'"), 'isProhibited fragment');
  // The feed and the review queue both apply the exclusion.
  const getAds = src.slice(src.indexOf('export async function getAds'), src.indexOf('export async function getReviewAds'));
  const getReview = src.slice(src.indexOf('export async function getReviewAds'), src.indexOf('export async function getFilteredAds'));
  const getFiltered = src.slice(src.indexOf('export async function getFilteredAds'), src.indexOf('export async function getRejectedAds'));
  const getRejected = src.slice(src.indexOf('export async function getRejectedAds'), src.indexOf('export async function getAdsByIds'));
  assert.ok(getAds.includes('notProhibited(sql)'), 'feed must exclude prohibited');
  assert.ok(getReview.includes('notProhibited(sql)'), 'review queue must exclude prohibited');
  assert.ok(getFiltered.includes('isProhibited(sql)'), 'Filtered view must select prohibited');
  // The Rejected view lists rejected ads but still lets prohibited win (excluded here).
  assert.ok(getRejected.includes("a.review_status = 'rejected'"), 'Rejected view must target rejected ads');
  assert.ok(getRejected.includes('notProhibited(sql)'), 'Rejected view must exclude prohibited');
});
