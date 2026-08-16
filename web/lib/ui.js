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

// The Predicto feed only. Their landing links carry the searched phrase in a
// `search` query param — either directly (…/asrsearch?search=<slug>-c29903&…) or
// behind a server 302 to searchpredictor.com (…/teleport -> …/asrsearch/?search=
// Some+Words). The scraper stores the post-redirect URL in resolved_url; we read
// `search` from there and fall back to the raw link_url for the direct format.
export const isPredicto = (ad) => (ad.feed || '').toLowerCase() === 'predicto';

// The decoded value of a URL's query param `name` (default `search`; '' when
// absent or unparseable). URLSearchParams turns '+' into a space and undoes %xx,
// so Predicto's "Startup+Grants+Guide+2026+en" and Visymo's
// "cirug%C3%ADa%20para%20eliminar%20la%20papada" both read as plain words.
function searchParam(url, name = 'search') {
  const t = String(url || '').trim();
  if (!t) return '';
  try {
    return new URL(t.includes('://') ? t : `https://${t}`).searchParams.get(name) || '';
  } catch {
    return '';
  }
}

// The clean searched phrase for a Predicto ad ('' for any other feed, or when
// nothing resolves — never a guess). Drops the trailing 6-hex tracking id these
// links carry (-7a075c, -c29903, -e4dc10, -04a1b6); casing and interior hyphens
// are left as the user asked (A stays a slug, B reads as words). The digit guard
// leaves real all-letter words alone (…-decade, …-facade); every real id in the
// data carries at least one digit, and the fixed 6-char length spares years
// like …-2026. A shorter/longer id (rare) simply stays visible rather than risk
// eating a real word.
export function predictoQuery(ad) {
  if (!isPredicto(ad)) return '';
  const raw = searchParam(ad.resolved_url) || searchParam(firstUrl(ad.link_url));
  return raw.replace(/-[0-9a-f]{6}$/i, (m) => (/\d/.test(m) ? '' : m)).replace(/\s+/g, ' ').trim();
}

// The Visymo feed only. Their landing links carry the searched phrase in a `q`
// query param (…/dsr?ctid=…&q=cirug%C3%ADa%20para%20eliminar%20la%20papada&…).
// URLSearchParams undoes the %xx (and any '+') encoding, so it reads as plain
// words. No tracking-id suffix to strip (unlike Predicto); casing is left as-is.
// '' for any other feed, or when the link exposes no q (never a guess).
export const isVisymo = (ad) => (ad.feed || '').toLowerCase() === 'visymo';
export function visymoQuery(ad) {
  if (!isVisymo(ad)) return '';
  return searchParam(firstUrl(ad.link_url), 'q').replace(/\s+/g, ' ').trim();
}

// The searched phrase behind a search-arbitrage ad, dispatched to each feed's own
// rule (Predicto reads `search` + strips its id; Visymo reads `q`). One shared
// "Query" column renders this, so a mixed Fresh Finds view shows every ad its own
// query. An ad is only ever one feed, so the two helpers never both fire; every
// other feed yields '' (blank cell, NULL in exports).
export const searchQuery = (ad) => predictoQuery(ad) || visymoQuery(ad);

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

// Prohibited-content classification (see content_flag.py). The DB stores a compact
// category key; the Filtered view shows a readable label. Every key but 'none' is a
// hidden category. 'none' means classified-clean (and NULL, not-yet-classified, never
// reaches the Filtered view). Kept in sync with content_flag.CONTENT_FLAG_VALUES.
export const CONTENT_FLAG_OPTIONS = [
  { key: 'adult',        label: 'Adult / sexual' },
  { key: 'weapons',      label: 'Weapons / violence' },
  { key: 'gambling',     label: 'Gambling' },
  { key: 'political',    label: 'Political' },
  { key: 'hate',         label: 'Hate / discrimination' },
  { key: 'dangerous',    label: 'Dangerous products' },
  { key: 'before_after', label: 'Before / after' },
  { key: 'drugs',        label: 'Drugs' },
  { key: 'egg_donation', label: 'Egg donation' },
  { key: 'policy_other', label: 'Other policy' },
];
const CONTENT_FLAG_BY_KEY = Object.fromEntries(CONTENT_FLAG_OPTIONS.map((o) => [o.key, o]));
// A hidden ad always carries a real category; fall back to the raw key so an
// unexpected value (e.g. a new category added server-side first) still reads.
export const contentFlagLabel = (key) => CONTENT_FLAG_BY_KEY[key]?.label || key || '';

// RSoC policy-risk grade (see rsoc_policy.py). A Fresh Finds row's topic/angle graded
// green/yellow/red against Google Publisher Restrictions + RSoC misleading-claim rules. A
// DIFFERENT axis from content_flag: it never hides a row, it only annotates how much policy
// care the topic would need before we build an article on it. 'green' means "no known
// restriction on this topic", NOT "safe to publish" - the article still needs its own check.
// RSOC_POLICY_AREAS is kept in sync with rsoc_policy.POLICY_AREA_LABELS.
export const RSOC_TIER_META = {
  red:    { label: 'Red',    color: '#E5575B', hint: 'Restricted vertical or prohibited angle - building this risks RSoC strikes' },
  yellow: { label: 'Yellow', color: '#E8A33D', hint: 'Sensitive topic - buildable with care, needs a human look' },
  green:  { label: 'Green',  color: '#57A65B', hint: 'No known RSoC restriction on this topic (not a guarantee the article is safe)' },
};
export const RSOC_TIER_ORDER = ['red', 'yellow', 'green'];
export const RSOC_POLICY_AREAS = {
  none: 'Clear', health_claims: 'Health / medical claims', supplements: 'Unapproved supplements',
  prescription: 'Prescription drugs', weight_loss: 'Weight-loss / before-after', financial: 'Financial / get-rich',
  gambling: 'Online gambling', alcohol: 'Alcohol', tobacco: 'Tobacco / vaping', drugs: 'Recreational drugs / CBD',
  weapons: 'Weapons', adult: 'Sexual / suggestive', shocking: 'Shocking content', political: 'Political / sensitive',
  misleading: 'Misleading / clickbait', other: 'Other policy',
};
export const rsocTierColor = (tier) => RSOC_TIER_META[tier]?.color || '#45484D';
export const rsocTierLabel = (tier) => RSOC_TIER_META[tier]?.label || '';
export const rsocTierHint = (tier) => RSOC_TIER_META[tier]?.hint || '';
export const rsocAreaLabel = (area) => RSOC_POLICY_AREAS[area] || area || '';
// The Policy column's export/CSV value: the tier with its area, e.g. "Red - Unapproved
// supplements". Green shows just the tier (its area is 'none'); an unclassified ad exports ''
// so a sheet cell is blank rather than a fake grade, matching the other enrichment columns.
export const rsocPolicyText = (a) => {
  if (!a || !a.rsoc_tier) return '';
  const area = a.rsoc_policy_area && a.rsoc_policy_area !== 'none' ? ` - ${rsocAreaLabel(a.rsoc_policy_area)}` : '';
  return rsocTierLabel(a.rsoc_tier) + area;
};

// The Filtered view's queue filter: text search plus category / domain / page facets.
// Mirrors filterReviewAds but keys the primary facet on the content_flag category.
export function filterFlaggedAds(ads, query, filters = {}) {
  const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const { category = [], domain = [], page = [] } = filters;
  return ads.filter((a) => {
    if (category.length && !category.includes(a.content_flag)) return false;
    if (domain.length && !domain.includes(a.domain)) return false;
    if (page.length && !page.includes(reviewPageOf(a))) return false;
    if (tokens.length) {
      const hay = [a.page_name, a.domain, a.title, a.caption, a.body_text, a.link_url]
        .filter(Boolean).join(' ').toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
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
  { key: 'query',     header: 'Query',            kind: 'text',  get: (a) => searchQuery(a),                                        width: 260, align: 'LEFT',   wrap: true  },
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
  { key: 'creative_language', header: 'Creative Language', kind: 'text', get: (a) => langCode(a.creative_language),                    width: 110, align: 'CENTER', wrap: false },
  { key: 'policy',    header: 'Policy',           kind: 'text',  get: (a) => rsocPolicyText(a),                                     width: 150, align: 'LEFT',   wrap: false },
  { key: 'brand',     header: 'Brand',            kind: 'text',  get: (a) => brandLabel(a.brand),                                   width: 90,  align: 'LEFT',   wrap: false },
  { key: 'feed',      header: 'Feed',             kind: 'text',  get: (a) => a.feed,                                                width: 90,  align: 'LEFT',   wrap: false },
  { key: 'status',    header: 'Status',           kind: 'text',  get: (a) => a.status,                                              width: 80,  align: 'CENTER', wrap: false },
  { key: 'ad_id',     header: 'Ad ID',            kind: 'text',  get: (a) => a.ad_archive_id,                                       width: 150, align: 'LEFT',   wrap: false },
];

// Column keys + headers for the export picker (no functions, safe to pass to the client).
export const SHEET_COLUMN_META = SHEET_COLUMNS.map(({ key, header }) => ({ key, header }));
export const DEFAULT_SHEET_COLUMN_KEYS = SHEET_COLUMNS.map((c) => c.key);

// The Client Kits export catalog. The competitor side REUSES SHEET_COLUMNS defs (so the
// creative and metric columns never drift from the main export), minus every column that
// would leak the competitor's own destination: 'link', 'slug' and 'query' are omitted by
// construction, so a kit can never expose a competitor URL. Our-link columns are appended
// and read from the assignment joined onto the ad (a.our_domain / a.our_url /
// a.our_headline), so the client sees the creative beside OUR link.
const KIT_COMPETITOR_KEYS = ['preview', 'image_url', 'page', 'domain', 'headline', 'body', 'cta', 'vertical', 'country', 'language', 'format', 'days', 'revenue', 'rpc', 'keywords', 'ad_id'];
const OUR_LINK_COLUMNS = [
  { key: 'our_domain',   header: 'Our Domain',   kind: 'text', get: (a) => a.our_domain,   width: 150, align: 'LEFT', wrap: false },
  { key: 'our_link',     header: 'Our Link',     kind: 'link', get: (a) => a.our_url,       width: 300, align: 'LEFT', wrap: false },
  { key: 'our_headline', header: 'Our Headline', kind: 'text', get: (a) => a.our_headline,  width: 260, align: 'LEFT', wrap: true  },
];
export const KIT_COLUMNS = [
  ...KIT_COMPETITOR_KEYS.map((k) => SHEET_COLUMNS.find((c) => c.key === k)).filter(Boolean),
  ...OUR_LINK_COLUMNS,
];
export const KIT_COLUMN_META = KIT_COLUMNS.map(({ key, header }) => ({ key, header }));
export const DEFAULT_KIT_COLUMN_KEYS = KIT_COLUMNS.map((c) => c.key);

// ── Auto-suggest: how well one of our links fits a competitor ad ───────────────
// Higher is better. Language and country are strong signals (a client's audience has to
// match), so they carry the most weight; vertical/category is a softer token overlap
// because the two databases use different taxonomies. Pure and deterministic, so the view
// can rank the available list and pick a top match, and it is unit-tested without a DB.
const kitTokens = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
const norm = (s) => String(s || '').trim().toLowerCase();

// Graded vertical fit: an EXACT vertical/category match is worth clearly more than a loose
// token overlap, so "Dental Implants" prefers a Dental Implants article over a "Dental Care"
// one. The two DBs use different taxonomies, hence the partial fallback rather than an
// all-or-nothing exact test.
function verticalScore(adVert, linkVert, linkCat) {
  const a = norm(adVert);
  if (!a) return 0;
  if (a === norm(linkVert) || a === norm(linkCat)) return 4;
  const set = new Set(kitTokens(adVert));
  if (!set.size) return 0;
  for (const t of [...kitTokens(linkVert), ...kitTokens(linkCat)]) if (set.has(t)) return 2;
  return 0;
}

// A light relevance nudge: a shared meaningful word (>=4 chars, so stopwords don't count)
// between the competitor's headline and our article's headline/keyword. Breaks ties toward
// an on-topic link when vertical/language/country are equal.
function textOverlap(title, headline, keyword) {
  const set = new Set(kitTokens(title).filter((t) => t.length >= 4));
  if (!set.size) return 0;
  for (const t of [...kitTokens(headline), ...kitTokens(keyword)]) if (t.length >= 4 && set.has(t)) return 1;
  return 0;
}

export function scoreLink(ad, link) {
  if (!ad || !link) return 0;
  let score = 0;
  const adLang = langCode(ad.creative_language || ad.language);
  const linkLang = langCode(link.language);
  if (adLang && linkLang && adLang === linkLang) score += 5;      // language: strongest
  const adCountry = String(ad.country || '').toUpperCase();
  const linkCountry = String(link.country || '').toUpperCase();
  if (adCountry && linkCountry && adCountry === linkCountry) score += 3;   // country
  score += verticalScore(ad.vertical, link.vertical, link.category);        // vertical: 4 exact / 2 partial
  score += textOverlap(ad.title, link.headline, link.keyword);             // topic tiebreak: +1
  return score;
}

// Our links ranked best-first for an ad: highest score, then newest. Returns a new
// array of copies tagged with their `score` (never mutates the input).
export function rankLinks(ad, links) {
  return (links || [])
    .map((link) => ({ ...link, score: scoreLink(ad, link) }))
    .sort((x, y) => y.score - x.score || String(y.published_at || '').localeCompare(String(x.published_at || '')));
}

// The availability filter: drop candidate links whose URL is already assigned. Pure, so
// the view and the tests share one definition of "available".
export function availableLinks(links, assignedUrls) {
  const taken = new Set((assignedUrls || []).map(String));
  return (links || []).filter((l) => !taken.has(String(l.url)));
}

// Identity of a competitor creative, for the "unique creatives" toggle: image + title +
// body, so byte-identical creatives collapse to one regardless of country/vertical (which
// is what Maya asked - dedupe by identical creative only). Pure and shared with tests.
export function creativeKey(ad) {
  const img = thumbOf(ad) || mediaUrlOf(ad) || '';
  const title = ad.title || ad.caption || '';
  const body = ad.body_text || '';
  return `${img}${title}${body}`.trim().toLowerCase();
}

// Keep the first row for each distinct key, preserving order (so a revenue-sorted list keeps
// the highest-revenue instance of each creative). Pure.
export function dedupeBy(rows, keyFn) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const k = keyFn(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// Plan a bulk assignment: give each ad its best available link from a shared pool, never
// handing the same link to two ads in the batch. Pure, so the greedy allocation is
// testable without a DB. `taken` seeds URLs already used elsewhere (globally assigned on
// the domain). With strict matching on (the default for both `requireLangMatch` and
// `requireCountryMatch`), an ad is only ever given a link in its OWN language AND its OWN
// country - a Belgian French ad gets a be/fr link, never a France one, and never a Dutch
// one - with vertical still ranking within that scope so an on-topic link wins. This is a
// hard gate, not a soft nudge: once the correct-language/country links run out, an ad is
// left in `unassigned` rather than forced onto a wrong-country or wrong-language link (the
// exact "headline is Belgium, link is France" mismatch Maya reported). Callers guarantee
// "nothing empty" by scoping the pool to the ad's locale, where our supply is ample.
export function planBulkAssignment(ads, links, { taken = [], requireLangMatch = true, requireCountryMatch = true } = {}) {
  const used = new Set((taken || []).map(String));
  const assigned = [];
  const unassigned = [];
  for (const ad of ads || []) {
    const adLang = langCode(ad.creative_language || ad.language);
    const adCountry = String(ad.country || '').toUpperCase();
    const pool = (links || []).filter((l) => {
      if (used.has(String(l.url))) return false;
      // Hard gates, but only on attributes the ad actually carries: a be/fr ad must get a
      // be/fr link, yet an ad with no known country isn't starved to nothing over it.
      if (requireLangMatch && adLang && langCode(l.language) !== adLang) return false;
      if (requireCountryMatch && adCountry && String(l.country || '').toUpperCase() !== adCountry) return false;
      return true;
    });
    const pick = rankLinks(ad, pool)[0];
    if (pick) { used.add(String(pick.url)); assigned.push({ ad, link: pick }); }
    else unassigned.push(ad);
  }
  return { assigned, unassigned };
}

// ── RSOC competitor rows → our-link matching ───────────────────────────────────
// RSOC comp rows (ref_comp_rows) carry a geo but no language. We infer the language two
// ways, best first: the /xx/ segment many of our-style landing URLs carry, then a geo→
// language fallback. Kept small and pure so the matcher and tests can share it.
const GEO_LANG = {
  US: 'en', GB: 'en', UK: 'en', CA: 'en', AU: 'en', IE: 'en', NZ: 'en', ZA: 'en', IN: 'en', AE: 'en',
  DE: 'de', AT: 'de', CH: 'de',
  FR: 'fr', BE: 'fr',
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es',
  IT: 'it', NL: 'nl', PT: 'pt', BR: 'pt', PL: 'pl', SE: 'sv', NO: 'no', DK: 'da', FI: 'fi',
  CZ: 'cs', JP: 'ja', IL: 'he',
};

export function urlLang(url) {
  const m = String(url || '').match(/:\/\/[^/]+\/([a-z]{2})\//i);
  return m ? m[1].toLowerCase() : '';
}

export function geoToLang(geo) {
  return GEO_LANG[String(geo || '').toUpperCase()] || '';
}

// Adapt a competitor comp row into the { creative_language, language, country, vertical,
// title } shape scoreLink / rankLinks / planBulkAssignment already understand, so the RSOC
// side reuses the exact same matching as the Meta side.
export function compToSubject(row) {
  const lang = urlLang(row?.url) || geoToLang(row?.geo);
  return {
    creative_language: lang,
    language: lang,
    country: row?.geo || '',
    vertical: row?.vertical || '',
    title: row?.adtitle || '',
  };
}

// The Client Kits export catalog for the RSOC source: the competitor's own URL is omitted
// by construction (client-safe), the competitor's data columns come first, our link after.
// Reads a comp row joined with our_domain / our_url / our_headline (like KIT_COLUMNS).
export const COMP_KIT_COLUMNS = [
  { key: 'comp_image',   header: 'Competitor Image',   kind: 'image', get: (r) => r.thumb,                                   width: 130, align: 'CENTER', wrap: false },
  { key: 'network',      header: 'Competitor Network', kind: 'text', get: (r) => r.network,                                  width: 140, align: 'LEFT',   wrap: false },
  { key: 'vertical',     header: 'Vertical',           kind: 'text', get: (r) => r.vertical,                                 width: 140, align: 'LEFT',   wrap: false },
  { key: 'geo',          header: 'Geo',                kind: 'text', get: (r) => r.geo,                                      width: 60,  align: 'CENTER', wrap: false },
  { key: 'adtitle',      header: 'Competitor Headline', kind: 'text', get: (r) => r.adtitle,                                 width: 320, align: 'LEFT',   wrap: true  },
  { key: 'comp_desc',    header: 'Competitor Description', kind: 'text', get: (r) => r.meta_body,                            width: 320, align: 'LEFT',   wrap: true  },
  { key: 'revenue',      header: 'Revenue',            kind: 'text', get: (r) => fmtDec(r.revenue),                          width: 100, align: 'RIGHT',  wrap: false },
  { key: 'clicks',       header: 'Clicks',             kind: 'text', get: (r) => (r.clicks != null ? r.clicks : ''),         width: 80,  align: 'RIGHT',  wrap: false },
  { key: 'rpc',          header: 'RPC',                kind: 'text', get: (r) => fmtDec(r.rpc),                              width: 70,  align: 'RIGHT',  wrap: false },
  { key: 'keywords',     header: 'Top Keywords',       kind: 'text', get: (r) => r.top_keywords,                             width: 300, align: 'LEFT',   wrap: true  },
  { key: 'comp_id',      header: 'Comp ID',            kind: 'text', get: (r) => r.id,                                       width: 80,  align: 'LEFT',   wrap: false },
  { key: 'our_domain',   header: 'Our Domain',         kind: 'text', get: (r) => r.our_domain,                               width: 150, align: 'LEFT',   wrap: false },
  { key: 'our_link',     header: 'Our Link',           kind: 'link', get: (r) => r.our_url,                                  width: 300, align: 'LEFT',   wrap: false },
  { key: 'our_headline', header: 'Our Headline',       kind: 'text', get: (r) => r.our_headline,                             width: 260, align: 'LEFT',   wrap: true  },
];
export const COMP_KIT_COLUMN_META = COMP_KIT_COLUMNS.map(({ key, header }) => ({ key, header }));
export const DEFAULT_COMP_KIT_COLUMN_KEYS = COMP_KIT_COLUMNS.map((c) => c.key);

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
// `catalog` selects which column set to build from — the Fresh Finds export (default)
// or the Client Kits export (KIT_COLUMNS) — so both exports share one builder.
export function buildSheetData(ads, now, selectedKeys, catalog = SHEET_COLUMNS) {
  const want = new Set(selectedKeys && selectedKeys.length ? selectedKeys : catalog.map((c) => c.key));
  const cols = catalog.filter((c) => want.has(c.key));
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

// Table column picker persistence. We store the HIDDEN keys (tagged `{ h: [...] }`), not the
// visible ones, so a column ADDED to the catalog after a selection was saved shows by default
// instead of being silently hidden by a stale list (the bug that kept the Policy column
// invisible for anyone who had ever customized their columns). columnVisibility turns a stored
// value into the keys to show; columnPrefValue turns a chosen visible set into the value to save.
//
// A legacy value (a bare array of VISIBLE keys, the old format) is treated as "show everything":
// we cannot tell a deliberately-hidden column from one that did not exist yet, so we reset that
// table's picker once rather than leave a newly added column hidden. From then on the value is
// the new tagged format and curation sticks.
export function columnVisibility(stored, defs) {
  const all = defs.map((d) => d.key);
  if (stored && !Array.isArray(stored) && Array.isArray(stored.h)) {
    const hidden = new Set(stored.h);
    return all.filter((k) => !hidden.has(k));
  }
  return all; // first visit, legacy bare-array format, or garbage -> everything visible
}

export function columnPrefValue(visible, defs) {
  const shown = new Set(visible);
  return { h: defs.map((d) => d.key).filter((k) => !shown.has(k)) };
}

// Accept either a bare spreadsheet id or a full Google Sheets URL and return the id.
export function parseSheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}

export const STATUSES = ['new', 'idea', 'drafting', 'published'];
