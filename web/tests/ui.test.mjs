// Unit tests for the pure export helpers in lib/ui.js. Run with `npm test` (Node's
// built-in runner, no dependencies). The media-URL cases pin the fix for video ads:
// exports must carry the watchable video link, not the poster image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isVideo, thumbOf, mediaUrlOf, buildCsv, buildSheetData, SHEET_COLUMNS, parseSheetId } from '../lib/ui.js';

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
