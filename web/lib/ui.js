// Shared, pure UI helpers used across the dashboard views.
export const A = '#E8A33D'; // the single signal accent
export const MONO = "ui-monospace,'SF Mono','JetBrains Mono',monospace";

export const hoursSince = (iso, now) => (iso ? (now - new Date(iso).getTime()) / 3.6e6 : Infinity);

export const daysRunning = (ad, now) =>
  ad.start_date ? Math.max(1, Math.round((now - new Date(ad.start_date).getTime()) / 8.64e7)) : 0;

export const isVideo = (ad) => ad.display_format === 'VIDEO' || !!ad.video_hd_url;
export const thumbOf = (ad) => ad.original_image_urls?.[0] || ad.video_preview_url || null;

// An ad's landing page. link_url may pack several DCO destinations pipe-joined
// ("a | b | c"); the first is the canonical article the creative points to.
export const firstUrl = (linkUrl) => (linkUrl ? String(linkUrl).split(' | ')[0].trim() : '');

// The Tarzo feed only. Their landing pages look like
// https://<domain>/dcg/<id>/<slug>?<params>; pull just the readable <slug>,
// keyed off the /dcg/<id>/ path so it works for any Tarzo domain. Returns ''
// when the link isn't a Tarzo article (e.g. a bare social-profile URL).
export const isTarzo = (ad) => (ad.feed || '').toLowerCase() === 'tarzo';
export function tarzoSlug(ad) {
  const m = firstUrl(ad.link_url).match(/\/dcg\/\d+\/([^/?#]+)/);
  return m ? m[1] : '';
}

export const titleCase = (v) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : v);
export const pad = (n, w = 2) => String(n).padStart(w, '0');

// The scraper stores a language NAME ("Spanish", "Portuguese"). For the compact
// badge we want the ISO 639-1 code (ES, PT), so it reads as a real language code
// and lines up with the two-letter country above it. Multi-word names ("Brazilian
// Portuguese") match on the language word; anything unknown falls back to its first
// two letters, so a value never renders blank.
const LANG_CODES = {
  english: 'en', spanish: 'es', portuguese: 'pt', french: 'fr', german: 'de',
  italian: 'it', dutch: 'nl', hungarian: 'hu', polish: 'pl', romanian: 'ro',
  turkish: 'tr', arabic: 'ar', russian: 'ru', ukrainian: 'uk', greek: 'el',
  czech: 'cs', slovak: 'sk', swedish: 'sv', norwegian: 'no', danish: 'da',
  finnish: 'fi', japanese: 'ja', chinese: 'zh', korean: 'ko', hindi: 'hi',
  thai: 'th', vietnamese: 'vi', indonesian: 'id', hebrew: 'he', catalan: 'ca',
};
export function langCode(name) {
  const w = String(name || '').trim().toLowerCase();
  if (!w) return '';
  if (LANG_CODES[w]) return LANG_CODES[w].toUpperCase();
  for (const key in LANG_CODES) if (w.includes(key)) return LANG_CODES[key].toUpperCase();
  return w.slice(0, 2).toUpperCase();
}

export function tint(seed) {
  let h = 0;
  const str = String(seed || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h},6%,13%), hsl(${(h + 40) % 360},7%,9%))`;
}

export function paras(text) {
  if (!text) return [];
  return String(text).split(/\n+/).map((p) => p.trim()).filter(Boolean);
}

export function relTime(ms) {
  if (ms == null || !isFinite(ms)) return 'never';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Compact absolute date, e.g. "Jul 8, 26". Full ISO stays available for tooltips.
export function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${String(d.getFullYear()).slice(2)}`;
}

// The one column set shared by every Fresh Finds export (CSV download and Google
// Sheet). Each entry is [header, (ad, now) => value]. Keep this list as the single
// source of truth so the CSV and the Sheet never drift apart. Dates go out as
// YYYY-MM-DD so they sort correctly in a spreadsheet.
export const EXPORT_COLUMNS = [
  ['Page', (a) => a.page_name],
  ['Domain', (a) => a.domain],
  ['Headline', (a) => a.title || a.caption || a.body_text],
  ['Body', (a) => a.body_text],
  ['Caption', (a) => a.caption],
  ['CTA', (a) => a.cta_text],
  ['Link', (a) => a.link_url],
  ['Slug', (a) => tarzoSlug(a)],
  ['Format', (a) => a.display_format],
  ['Rank', (a) => (a.rank != null ? a.rank : '')],
  ['Days Running', (a, now) => daysRunning(a, now)],
  ['First Added Date', (a) => (a.first_seen_at ? a.first_seen_at.slice(0, 10) : '')],
  ['Last Seen', (a) => (a.last_seen_at ? a.last_seen_at.slice(0, 10) : '')],
  ['Vertical', (a) => a.vertical],
  ['Country', (a) => a.country],
  ['Language', (a) => a.language],
  ['Feed', (a) => a.feed],
  ['Status', (a) => a.status],
  ['Ad ID', (a) => a.ad_archive_id],
];

// Build a CSV string from ad rows. Every field is quoted and inner quotes doubled,
// so commas, quotes, and newlines in ad copy never break the layout.
export function buildCsv(rows, now) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [EXPORT_COLUMNS.map((c) => esc(c[0])).join(',')];
  for (const a of rows) lines.push(EXPORT_COLUMNS.map((c) => esc(c[1](a, now))).join(','));
  return lines.join('\r\n');
}

// Same columns as the CSV, shaped for the Google Sheets API: a header row plus a 2D
// array of stringified cell values (the API takes strings; nulls become '').
export function buildSheetValues(rows, now) {
  const header = EXPORT_COLUMNS.map((c) => c[0]);
  const values = rows.map((a) => EXPORT_COLUMNS.map((c) => {
    const v = c[1](a, now);
    return v == null ? '' : String(v);
  }));
  return { header, values };
}

// Accept either a bare spreadsheet id or a full Google Sheets URL and return the id.
export function parseSheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}

export const STATUSES = ['new', 'idea', 'drafting', 'published'];
