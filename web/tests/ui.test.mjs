// Unit tests for the pure export helpers in lib/ui.js. Run with `npm test` (Node's
// built-in runner, no dependencies). The media-URL cases pin the fix for video ads:
// exports must carry the watchable video link, not the poster image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isVideo, thumbOf, mediaUrlOf, buildCsv, buildSheetData, SHEET_COLUMNS, parseSheetId, hostOf, filterReviewAds, reviewDestOf, sanitizeColumnKeys, fmtInt, fmtDec } from '../lib/ui.js';

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
