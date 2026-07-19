// Shared, pure UI helpers used across the dashboard views.
export const A = '#E8A33D'; // the single signal accent
export const MONO = "ui-monospace,'SF Mono','JetBrains Mono',monospace";

export const hoursSince = (iso, now) => (iso ? (now - new Date(iso).getTime()) / 3.6e6 : Infinity);

export const daysRunning = (ad, now) =>
  ad.start_date ? Math.max(1, Math.round((now - new Date(ad.start_date).getTime()) / 8.64e7)) : 0;

export const isVideo = (ad) => ad.display_format === 'VIDEO' || !!ad.video_hd_url;
export const thumbOf = (ad) => ad.original_image_urls?.[0] || ad.video_preview_url || null;

// The creative asset itself: the video for a video ad, the image otherwise. Exports
// use this (not thumbOf) so a video row carries the watchable link, not its poster.
export const mediaUrlOf = (ad) => ad.video_hd_url || thumbOf(ad);

// An ad's landing page. link_url may pack several DCO destinations pipe-joined
// ("a | b | c"); the first is the canonical article the creative points to.
export const firstUrl = (linkUrl) => (linkUrl ? String(linkUrl).split(' | ')[0].trim() : '');

// The bare lowercase host of a URL ('' when unparseable). The Review tab uses it
// to show WHERE a queued ad actually leads next to the domain that was searched.
export function hostOf(url) {
  const t = String(url || '').trim();
  if (!t) return '';
  try {
    const host = new URL(t.includes('://') ? t : `https://${t}`).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return '';
  }
}

// Review-queue facets. The destination host doubles as a filter value, so ads
// with no destination need a stable non-empty label to group and filter by.
export const reviewDestOf = (ad) => hostOf(firstUrl(ad.link_url)) || '(no link)';
export const reviewPageOf = (ad) => ad.page_name || '(unknown)';

// The Review tab's combined filter: facet selections (searched domain,
// destination host, page) AND every search token must match. Pure so the
// "select all -> bulk reject" flow can be tested without a browser.
export function filterReviewAds(ads, query, filters = {}) {
  const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const { domain = [], dest = [], page = [] } = filters;
  return ads.filter((a) => {
    if (domain.length && !domain.includes(a.domain)) return false;
    if (dest.length && !dest.includes(reviewDestOf(a))) return false;
    if (page.length && !page.includes(reviewPageOf(a))) return false;
    if (tokens.length) {
      const hay = [a.page_name, a.domain, a.title, a.caption, a.body_text, a.link_url]
        .filter(Boolean).join(' ').toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
}

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

// Brand classification (see brand.py). The DB stores a compact key; the UI shows a
// readable label and picks a color, and exports carry the same words so a sheet reads
// on its own. Car brands are their own bucket (a lighter compliance category).
export const BRAND_OPTIONS = [
  { key: 'none',      label: 'No brand',  color: '#6C7076' },
  { key: 'brand',     label: 'Brand',     color: '#E8A33D' },
  { key: 'car_brand', label: 'Car brand', color: '#6FA8DC' },
];
const BRAND_BY_KEY = Object.fromEntries(BRAND_OPTIONS.map((o) => [o.key, o]));
export const brandLabel = (key) => BRAND_BY_KEY[key]?.label || '';
export const brandColor = (key) => BRAND_BY_KEY[key]?.color || '#45484D';

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

// Numeric formats for the sheet-metrics columns. null/'' stay '' so an ad with
// no sheet match renders a dash on screen and an empty cell in exports, never a
// fake zero. fmtInt is for reading (thousands separators); fmtDec is for
// exports and per-click money, where plain digits sort correctly in a sheet.
export const fmtInt = (v) => (v == null || v === '' || !isFinite(Number(v)) ? '' : Math.round(Number(v)).toLocaleString('en-US'));
export const fmtDec = (v, d = 2) => (v == null || v === '' || !isFinite(Number(v)) ? '' : Number(v).toFixed(d));

// The master catalog of columns available to the Fresh Finds export, in canonical
// order. Each column has a kind ('text' plain string, 'image' rendered preview,
// 'link' clickable URL), a pure `get(ad, now)` accessor, and Google-Sheet layout
// hints (pixel width, horizontal alignment, whether long copy wraps). The Sheet
// export and the CSV both read this list, so the two never drift. Language goes out
// as an ISO code (langCode), and dates as YYYY-MM-DD so a spreadsheet sorts them.
export const SHEET_COLUMNS = [
  { key: 'preview',   header: 'Preview',          kind: 'image', get: (a) => thumbOf(a),                                            width: 130, align: 'CENTER', wrap: false },
  { key: 'image_url', header: 'Media URL',        kind: 'link',  get: (a) => mediaUrlOf(a),                                         width: 230, align: 'LEFT',   wrap: false },
  { key: 'page',      header: 'Page',             kind: 'text',  get: (a) => a.page_name,                                           width: 130, align: 'LEFT',   wrap: false },
  { key: 'domain',    header: 'Domain',           kind: 'text',  get: (a) => a.domain,                                              width: 140, align: 'LEFT',   wrap: false },
  { key: 'headline',  header: 'Headline',         kind: 'text',  get: (a) => a.title || a.caption || a.body_text,                   width: 260, align: 'LEFT',   wrap: true  },
  { key: 'body',      header: 'Body',             kind: 'text',  get: (a) => a.body_text,                                           width: 300, align: 'LEFT',   wrap: true  },
  { key: 'caption',   header: 'Caption',          kind: 'text',  get: (a) => a.caption,                                             width: 180, align: 'LEFT',   wrap: true  },
  { key: 'cta',       header: 'CTA',              kind: 'text',  get: (a) => a.cta_text,                                            width: 90,  align: 'LEFT',   wrap: false },
  { key: 'link',      header: 'Link',             kind: 'text',  get: (a) => a.link_url,                                            width: 170, align: 'LEFT',   wrap: false },
  { key: 'slug',      header: 'Slug',             kind: 'text',  get: (a) => tarzoSlug(a),                                          width: 150, align: 'LEFT',   wrap: false },
  { key: 'revenue',   header: 'Revenue Prediction', kind: 'text', get: (a) => fmtDec(a.sheet_revenue),                              width: 110, align: 'RIGHT',  wrap: false },
  { key: 'clicks',    header: 'Clicks',           kind: 'text',  get: (a) => (a.sheet_clicks != null ? a.sheet_clicks : ''),        width: 70,  align: 'RIGHT',  wrap: false },
  { key: 'rpc',       header: 'RPC',              kind: 'text',  get: (a) => fmtDec(a.sheet_rpc),                                   width: 65,  align: 'RIGHT',  wrap: false },
  { key: 'geos',      header: 'GEOS',             kind: 'text',  get: (a) => a.sheet_geos,                                          width: 130, align: 'LEFT',   wrap: false },
  { key: 'keywords',  header: 'Top Keywords',     kind: 'text',  get: (a) => a.sheet_keywords,                                      width: 260, align: 'LEFT',   wrap: true  },
  { key: 'format',    header: 'Format',           kind: 'text',  get: (a) => a.display_format,                                      width: 70,  align: 'CENTER', wrap: false },
  { key: 'rank',      header: 'Rank',             kind: 'text',  get: (a) => (a.rank != null ? a.rank : ''),                        width: 55,  align: 'CENTER', wrap: false },
  { key: 'days',      header: 'Days Running',     kind: 'text',  get: (a, now) => daysRunning(a, now),                              width: 80,  align: 'CENTER', wrap: false },
  { key: 'added',     header: 'First Added Date', kind: 'text',  get: (a) => (a.first_seen_at ? a.first_seen_at.slice(0, 10) : ''),  width: 100, align: 'CENTER', wrap: false },
  { key: 'last_seen', header: 'Last Seen',        kind: 'text',  get: (a) => (a.last_seen_at ? a.last_seen_at.slice(0, 10) : ''),    width: 100, align: 'CENTER', wrap: false },
  { key: 'vertical',  header: 'Vertical',         kind: 'text',  get: (a) => a.vertical,                                            width: 130, align: 'LEFT',   wrap: false },
  { key: 'country',   header: 'Country',          kind: 'text',  get: (a) => a.country,                                             width: 70,  align: 'CENTER', wrap: false },
  { key: 'language',  header: 'Language',         kind: 'text',  get: (a) => langCode(a.language),                                  width: 80,  align: 'CENTER', wrap: false },
  { key: 'brand',     header: 'Brand',            kind: 'text',  get: (a) => brandLabel(a.brand),                                   width: 90,  align: 'LEFT',   wrap: false },
  { key: 'feed',      header: 'Feed',             kind: 'text',  get: (a) => a.feed,                                                width: 90,  align: 'LEFT',   wrap: false },
  { key: 'status',    header: 'Status',           kind: 'text',  get: (a) => a.status,                                              width: 80,  align: 'CENTER', wrap: false },
  { key: 'ad_id',     header: 'Ad ID',            kind: 'text',  get: (a) => a.ad_archive_id,                                       width: 150, align: 'LEFT',   wrap: false },
];

// Column keys + headers for the export picker (no functions, safe to pass to the client).
export const SHEET_COLUMN_META = SHEET_COLUMNS.map(({ key, header }) => ({ key, header }));
export const DEFAULT_SHEET_COLUMN_KEYS = SHEET_COLUMNS.map((c) => c.key);

const cellText = (c, a, now) => { const v = c.get(a, now); return v == null ? '' : String(v); };

// Build a CSV string from ad rows. Uses the same catalog as the Sheet, minus the
// image-preview column (a CSV can't render an image; the Media URL column carries the
// link). Every field is quoted and inner quotes doubled so commas, quotes, and
// newlines in ad copy never break the layout.
export function buildCsv(rows, now) {
  const cols = SHEET_COLUMNS.filter((c) => c.kind !== 'image');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.map((c) => esc(c.header)).join(',')];
  for (const a of rows) lines.push(cols.map((c) => esc(cellText(c, a, now))).join(','));
  return lines.join('\r\n');
}

// Presentation-neutral data for the Sheet export: the selected columns (canonical
// order) plus each row's cells tagged by kind, so the Sheets layer can render text,
// an in-cell image, or a link without knowing the ad shape. `selectedKeys` may arrive
// unordered or partial; unknown keys are ignored and canonical order is preserved.
export function buildSheetData(ads, now, selectedKeys) {
  const want = new Set(selectedKeys && selectedKeys.length ? selectedKeys : DEFAULT_SHEET_COLUMN_KEYS);
  const cols = SHEET_COLUMNS.filter((c) => want.has(c.key));
  const columns = cols.map((c) => ({ key: c.key, header: c.header, kind: c.kind, width: c.width, align: c.align, wrap: c.wrap }));
  const rows = ads.map((a) => ({
    cells: cols.map((c) => {
      if (c.kind === 'image' || c.kind === 'link') return { kind: c.kind, value: c.get(a, now) || '' };
      return { kind: 'text', value: cellText(c, a, now) };
    }),
  }));
  return { columns, rows };
}

// Country codes present in a GEOS revenue split ("ES-90,MX-10" -> ['ES','MX']).
// The Fresh Finds GEOS facet uses this to filter ads by where they earn.
export function geoCountries(geos) {
  if (!geos) return [];
  return String(geos).split(',').map((p) => p.split('-')[0].trim()).filter(Boolean);
}

// Table column picker: keep only keys the table still knows from a stored
// selection. null when the stored value is unusable (first visit, corrupt
// JSON), so callers fall back to their defaults; an empty array is a
// legitimate choice (only the fixed columns stay visible).
export function sanitizeColumnKeys(stored, defs) {
  if (!Array.isArray(stored)) return null;
  const known = new Set(defs.map((d) => d.key));
  return stored.filter((k) => known.has(k));
}

// Accept either a bare spreadsheet id or a full Google Sheets URL and return the id.
export function parseSheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}

export const STATUSES = ['new', 'idea', 'drafting', 'published'];
