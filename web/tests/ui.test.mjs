// Unit tests for the pure export helpers in lib/ui.js. Run with `npm test` (Node's
// built-in runner, no dependencies). The media-URL cases pin the fix for video ads:
// exports must carry the watchable video link, not the poster image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isVideo, thumbOf, mediaUrlOf, buildCsv, buildSheetData, SHEET_COLUMNS, parseSheetId, hostOf, filterReviewAds, reviewDestOf, columnVisibility, columnPrefValue, fmtInt, fmtDec, geoCountries, isPredicto, predictoQuery, isVisymo, visymoQuery, searchQuery, brandLabel, brandColor, BRAND_OPTIONS, filterFlaggedAds, contentFlagLabel, CONTENT_FLAG_OPTIONS, rsocTierLabel, rsocTierColor, rsocAreaLabel, RSOC_TIER_META, RSOC_TIER_ORDER, RSOC_POLICY_AREAS } from '../lib/ui.js';

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

test('exports carry a Policy column with the RSoC tier and area', () => {
  const graded = { ...imageAd, rsoc_tier: 'red', rsoc_policy_area: 'supplements', rsoc_reason: 'keto gummies angle' };
  const { columns, rows } = buildSheetData([graded], NOW, ['ad_id', 'policy']);
  const col = columns.findIndex((c) => c.header === 'Policy');
  assert.notEqual(col, -1);
  assert.equal(rows[0].cells[col].value, 'Red - Unapproved supplements');
  // Green shows just the tier (its area is 'none', not appended).
  const { rows: r2 } = buildSheetData([{ ...imageAd, rsoc_tier: 'green', rsoc_policy_area: 'none' }], NOW, ['policy']);
  assert.equal(r2[0].cells[0].value, 'Green');
  // An ungraded ad exports an empty cell, never a fake grade.
  const { rows: r3 } = buildSheetData([imageAd], NOW, ['policy']);
  assert.equal(r3[0].cells[0].value, '');
  // And it rides the CSV too.
  const [header, row] = buildCsv([graded], NOW).split('\r\n');
  assert.ok(header.includes('"Policy"'));
  assert.ok(row.includes('"Red - Unapproved supplements"'));
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

// The tables' COLUMNS picker persists the HIDDEN keys, so a column added to the catalog after
// a selection was saved stays visible instead of being hidden by a stale list.
const pickerDefs = [{ key: 'a', label: 'A', w: 1 }, { key: 'b', label: 'B', w: 1 }, { key: 'c', label: 'C', w: 1 }];

test('columnVisibility hides exactly the keys in the stored hidden list', () => {
  assert.deepEqual(columnVisibility({ h: ['b'] }, pickerDefs), ['a', 'c']);
  assert.deepEqual(columnVisibility({ h: [] }, pickerDefs), ['a', 'b', 'c']);
});

test('columnVisibility keeps a newly added column visible (the Policy-column bug)', () => {
  // A selection saved when the catalog was [a, b] (user hid b). 'c' was added later; because we
  // store hidden keys, 'c' is not in the hidden list and therefore shows by default.
  assert.deepEqual(columnVisibility({ h: ['b'] }, pickerDefs), ['a', 'c']);
});

test('columnVisibility ignores stale hidden keys no longer in the catalog', () => {
  assert.deepEqual(columnVisibility({ h: ['b', 'zombie'] }, pickerDefs), ['a', 'c']);
});

test('columnVisibility treats the legacy visible-array format as show-everything', () => {
  // Old format stored VISIBLE keys; we cannot tell a hidden column from one that did not exist
  // yet, so we reset to all columns once rather than leave a new column hidden.
  assert.deepEqual(columnVisibility(['a'], pickerDefs), ['a', 'b', 'c']);
  assert.deepEqual(columnVisibility(['a', 'b'], pickerDefs), ['a', 'b', 'c']);
});

test('columnVisibility shows everything on first visit or garbage', () => {
  assert.deepEqual(columnVisibility(null, pickerDefs), ['a', 'b', 'c']);
  assert.deepEqual(columnVisibility('nonsense', pickerDefs), ['a', 'b', 'c']);
  assert.deepEqual(columnVisibility({ nope: 1 }, pickerDefs), ['a', 'b', 'c']);
});

test('columnPrefValue stores the hidden keys, tagged, and round-trips', () => {
  assert.deepEqual(columnPrefValue(new Set(['a', 'c']), pickerDefs), { h: ['b'] });
  assert.deepEqual(columnPrefValue(new Set(['a', 'b', 'c']), pickerDefs), { h: [] });
  // Persisting a selection and reading it back yields the same visible set.
  assert.deepEqual(columnVisibility(columnPrefValue(new Set(['b']), pickerDefs), pickerDefs), ['b']);
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

// ── Visymo: the searched phrase sits in the link_url `q` param (no redirect) ────
const visymoAd = {
  ad_archive_id: 'v-a', feed: 'Visymo',
  link_url: 'https://www.clueblog.com/dsr?ctid=krd-97badd33&q=cirug%C3%ADa%20para%20eliminar%20la%20papada&asid=a2_ch59&de=m&rac=Lee%20m%C3%A1s%20sobre%20cirug%C3%ADa%20para%20eliminar%20la%20papada&pub=fb&tv=dark&locale=es_ES',
};

test('visymoQuery: decodes the q param (accents + spaces), ignores the other params', () => {
  assert.equal(visymoQuery(visymoAd), 'cirugía para eliminar la papada');
});

test('visymoQuery: handles + as space and leaves casing as-is; no id-suffix stripping', () => {
  assert.equal(visymoQuery({ feed: 'Visymo', link_url: 'https://x.com/dsr?q=Best+VPN+Deals+2026' }), 'Best VPN Deals 2026');
  // Unlike Predicto, a trailing hex-looking token is NOT stripped (Visymo has no id suffix).
  assert.equal(visymoQuery({ feed: 'Visymo', link_url: 'https://x.com/dsr?q=wear-perfume-7a075c' }), 'wear-perfume-7a075c');
});

test('visymoQuery: uses the first destination of a DCO pipe-joined link_url', () => {
  const ad = { feed: 'Visymo', link_url: 'https://a.com/dsr?q=first+one | https://b.com/dsr?q=second+two' };
  assert.equal(visymoQuery(ad), 'first one');
});

test('visymoQuery: blank (never a guess) when a Visymo link exposes no q', () => {
  assert.equal(visymoQuery({ feed: 'Visymo', link_url: 'https://www.clueblog.com/dsr?ctid=krd-97badd33&asid=a2_ch59' }), '');
  assert.equal(visymoQuery({ feed: 'Visymo', link_url: 'not a url' }), '');
  assert.equal(visymoQuery({ feed: 'Visymo', link_url: '' }), '');
});

test('visymoQuery: only the Visymo feed gets a query (gated by feed, case-insensitive)', () => {
  assert.equal(isVisymo({ feed: 'visymo' }), true);
  assert.equal(isVisymo({ feed: 'Predicto' }), false);
  // A non-Visymo ad with a coincidental q param stays blank.
  assert.equal(visymoQuery({ feed: 'Tarzo', link_url: 'https://x.com/y?q=nope' }), '');
});

// searchQuery is the per-feed dispatcher the shared "Query" column renders.
test('searchQuery: dispatches to each feed rule and blanks every other feed', () => {
  assert.equal(searchQuery(visymoAd), 'cirugía para eliminar la papada');
  assert.equal(searchQuery(predictoRedirect), 'Startup Grants Guide 2026 en');
  assert.equal(searchQuery({ feed: 'Tarzo', link_url: 'https://x.com/dcg/1/some-slug?q=nope&search=nope' }), '');
});

test('the shared Query column flows through buildSheetData and buildCsv for both feeds', () => {
  const { columns, rows } = buildSheetData([predictoDirect, visymoAd, imageAd], NOW, ['query']);
  assert.deepEqual(columns.map((c) => c.header), ['Query']);
  assert.equal(rows[0].cells[0].value,
    'understanding-bladder-cancer-surgery-a-comprehensive-guide-to-the-procedure-and-recovery-process');
  assert.equal(rows[1].cells[0].value, 'cirugía para eliminar la papada'); // Visymo shares the same column
  assert.equal(rows[2].cells[0].value, ''); // non-arbitrage ad -> empty cell

  const [header, row] = buildCsv([visymoAd], NOW).split('\r\n');
  assert.ok(header.includes('"Query"'));
  assert.ok(row.includes('"cirugía para eliminar la papada"'));
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

// ── payload guard: article_title stays OUT of the feed, the Detail fetch keeps it ──
// article_title is ~5% of the feed payload for a field only the Detail heading shows,
// so getAds must not select it (re-adding it silently re-bloats every page load), while
// getAdArticle must still fetch it (or the Detail heading silently goes blank). Both
// article bodies (title + content) ride the same on-demand fetch.
test('the feed omits article_title/article_content but the Detail fetch still returns them', () => {
  const queries = readFileSync(fileURLToPath(new URL('../lib/queries.js', import.meta.url)), 'utf8');
  const start = queries.indexOf('const FEED_COLUMNS');
  const feedCols = queries.slice(start, queries.indexOf('];', start));
  assert.ok(!feedCols.includes("'article_title'"), 'FEED_COLUMNS must not ship article_title');
  assert.ok(!feedCols.includes("'article_content'"), 'FEED_COLUMNS must not ship article_content');

  const actions = readFileSync(fileURLToPath(new URL('../app/actions.js', import.meta.url)), 'utf8');
  const getAdArticle = actions.slice(
    actions.indexOf('export async function getAdArticle'),
    actions.indexOf('export async function loadSecondaryTab'),
  );
  assert.match(getAdArticle, /select[\s\S]*article_title[\s\S]*article_content[\s\S]*from ads/, 'getAdArticle must still fetch the article title and body');
});

// ── RSoC policy grade: the Fresh Finds "Policy" column label + color maps ───────
test('rsocTierLabel and rsocTierColor cover the three tiers and default safely', () => {
  for (const t of RSOC_TIER_ORDER) {
    assert.equal(rsocTierLabel(t), RSOC_TIER_META[t].label);
    assert.match(rsocTierColor(t), /^#[0-9A-Fa-f]{6}$/);
  }
  // An unknown/absent tier must render blank + a neutral color, never a stray word.
  assert.equal(rsocTierLabel(null), '');
  assert.equal(rsocTierLabel('bogus'), '');
  assert.match(rsocTierColor(undefined), /^#[0-9A-Fa-f]{6}$/);
});

test('RSOC_TIER_ORDER is most-severe first and lists exactly the three tiers', () => {
  assert.deepEqual(RSOC_TIER_ORDER, ['red', 'yellow', 'green']);
  assert.deepEqual(Object.keys(RSOC_TIER_META).sort(), ['green', 'red', 'yellow']);
});

test('rsocAreaLabel maps known slugs and falls back to the raw key', () => {
  assert.equal(rsocAreaLabel('supplements'), 'Unapproved supplements');
  assert.equal(rsocAreaLabel('none'), 'Clear');
  // A slug the UI does not know yet (server added one first) still renders, never blank-swallowed.
  assert.equal(rsocAreaLabel('brand_new_area'), 'brand_new_area');
  assert.equal(rsocAreaLabel(''), '');
});

// The web label map must stay in sync with the Python source of truth
// (rsoc_policy.POLICY_AREA_LABELS). A drift here means the column shows a raw slug.
test('RSOC_POLICY_AREAS matches the Python POLICY_AREA_LABELS keys', () => {
  const py = readFileSync(fileURLToPath(new URL('../../rsoc_policy.py', import.meta.url)), 'utf8');
  const block = py.slice(py.indexOf('POLICY_AREA_LABELS = {'), py.indexOf('}', py.indexOf('POLICY_AREA_LABELS = {')));
  const pyKeys = [...block.matchAll(/'([a-z_]+)':/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(RSOC_POLICY_AREAS).sort(), pyKeys);
});

// ── rule-20 guard: the feed must actually ship the rsoc_* fields to the browser ─
// The Policy column reads a.rsoc_tier / a.rsoc_policy_area / a.rsoc_reason, so if the feed
// query stops selecting them (or mapAd stops mapping them) the column silently goes blank.
test('the feed query selects the rsoc columns and mapAd maps them', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/queries.js', import.meta.url)), 'utf8');
  for (const col of ['rsoc_tier', 'rsoc_policy_area', 'rsoc_reason']) {
    assert.ok(src.includes(`'${col}'`), `FEED_COLUMNS must select ${col}`);
    assert.ok(src.includes(`${col}: r.${col}`), `mapAd must map ${col}`);
  }
});
