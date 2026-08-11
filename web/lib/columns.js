// The shared column model for the dashboard's four data tables. This is the single
// source of truth for WHICH columns each table has and in what default order; the
// RENDERING (header + cell JSX) still lives in each view, keyed by these column keys.
// Both the browser (the columns manager, the reorder wrapper) and the server (preset
// validation) import from here, so a preset can never carry a key a table doesn't
// have.
//
// A column is one of three kinds:
//   normal  - user can hide it and reorder it (the old COLUMNS-picker columns)
//   pinned  - always visible, but still reorderable (the flexible Headline column)
//   auto    - shown only when the feed makes it relevant (Slug/Query), reorderable,
//             never user-hidden
// Order includes every kind, so a saved order can move Headline or Query anywhere.

export const TABLE_KEYS = ['freshfinds', 'review', 'filtered', 'rejected'];

export const COLUMN_CATALOGS = {
  freshfinds: [
    { key: 'page', label: 'Page' },
    { key: 'domain', label: 'Domain' },
    { key: 'brand', label: 'Brand' },
    { key: 'creative_language', label: 'Creative Lang' },
    { key: 'rsoc', label: 'Policy' },
    { key: 'headline', label: 'Headline', pinned: true },
    { key: 'url', label: 'URL' },
    { key: 'slug', label: 'Slug', auto: true },
    { key: 'query', label: 'Query', auto: true },
    { key: 'revenue', label: 'Rev. Predict' },
    { key: 'clicks', label: 'Clicks' },
    { key: 'rpc', label: 'RPC' },
    { key: 'geos', label: 'GEOS' },
    { key: 'keywords', label: 'Top Keywords' },
    { key: 'format', label: 'Format' },
    { key: 'rank', label: 'Rank' },
    { key: 'added', label: 'Added' },
    { key: 'updated', label: 'Updated' },
    { key: 'days', label: 'Days Run' },
    { key: 'vertical', label: 'Vertical' },
    { key: 'country', label: 'Country' },
    { key: 'language', label: 'Language' },
    { key: 'feed', label: 'Feed' },
    { key: 'ad_id', label: 'Ad Archive ID' },
  ],
  review: [
    { key: 'page', label: 'Page' },
    { key: 'domain', label: 'Searched Domain' },
    { key: 'dest', label: 'Actually Leads To' },
    { key: 'headline', label: 'Headline', pinned: true },
    { key: 'revenue', label: 'Rev. Predict' },
    { key: 'clicks', label: 'Clicks' },
    { key: 'rpc', label: 'RPC' },
    { key: 'geos', label: 'GEOS' },
    { key: 'keywords', label: 'Top Keywords' },
    { key: 'ad_id', label: 'Ad Archive ID' },
    { key: 'added', label: 'Added' },
  ],
  filtered: [
    { key: 'page', label: 'Page' },
    { key: 'domain', label: 'Searched Domain' },
    { key: 'dest', label: 'Leads To' },
    { key: 'headline', label: 'Headline', pinned: true },
    { key: 'ad_id', label: 'Ad Archive ID' },
    { key: 'added', label: 'Added' },
  ],
  rejected: [
    { key: 'page', label: 'Page' },
    { key: 'domain', label: 'Searched Domain' },
    { key: 'dest', label: 'Actually Leads To' },
    { key: 'headline', label: 'Headline', pinned: true },
    { key: 'ad_id', label: 'Ad Archive ID' },
    { key: 'added', label: 'Added' },
  ],
};

// Guardrails on what a client may save, so a preset can never bloat the row or the
// jsonb column. Names are short labels; twenty presets per table is far past any
// real need while still bounding abuse.
export const PRESET_NAME_MAX = 60;
export const PRESETS_PER_TABLE_MAX = 20;

// Build an orderOf(key) for a resolved column order, used by ColumnRow to place each
// cell via CSS `order`. Structural sentinels get fixed slots at the far edges so they
// never interleave with data columns: the accent bar, checkbox, thumbnail and
// category pin to the left; the decision / restore controls pin to the right. Data
// columns take their index in `order`. A null key (an unkeyed child) keeps its source
// position; an unknown data key sits just before the decision column.
export const COLUMN_SENTINELS = { __accent: -400, __checkbox: -300, __thumb: -200, __category: -100, __decision: 100000 };

export function makeOrderOf(order) {
  const index = new Map(order.map((k, i) => [k, i]));
  return (key) => {
    if (key == null) return undefined;
    if (key in COLUMN_SENTINELS) return COLUMN_SENTINELS[key];
    const i = index.get(key);
    return i == null ? 90000 : i;
  };
}

export const catalogFor = (tableKey) => COLUMN_CATALOGS[tableKey] || null;
export const catalogKeys = (catalog) => catalog.map((c) => c.key);
// The columns a user may hide: everything except the pinned Headline and the
// feed-driven auto columns (Slug/Query), matching what the old picker offered.
export const hideableKeys = (catalog) => catalog.filter((c) => !c.pinned && !c.auto).map((c) => c.key);

// Reconcile a stored layout against the live catalog. A stored `order` may be
// partial (a column added to the catalog after it was saved), stale (a column since
// removed), or duplicated; we keep the valid keys in their saved order, then append
// any catalog keys the order is missing in catalog order, so a new column always
// appears rather than vanishing. `hidden` is clamped to the hideable set, so a
// pinned or auto column can never be hidden by a hand-crafted value.
export function resolveLayout(catalog, layout) {
  const keys = catalogKeys(catalog);
  const known = new Set(keys);
  const seen = new Set();
  const order = [];
  const storedOrder = Array.isArray(layout?.order) ? layout.order : [];
  for (const k of storedOrder) {
    if (known.has(k) && !seen.has(k)) { order.push(k); seen.add(k); }
  }
  for (const k of keys) if (!seen.has(k)) order.push(k);

  const canHide = new Set(hideableKeys(catalog));
  const storedHidden = Array.isArray(layout?.hidden) ? layout.hidden : [];
  const hidden = new Set(storedHidden.filter((k) => canHide.has(k)));
  return { order, hidden };
}

// The set of currently-visible keys (pinned + auto + any non-hidden hideable). Note
// auto columns (Slug/Query) are additionally gated by the feed in the view; this
// only reflects the user's hide choices.
export function visibleSet(catalog, layout) {
  const { order, hidden } = resolveLayout(catalog, layout);
  return new Set(order.filter((k) => !hidden.has(k)));
}

// The layout to persist for a chosen order + hidden set. Hidden is clamped to the
// hideable set so we never store a meaningless entry.
export function serializeLayout(catalog, order, hiddenSet) {
  const canHide = new Set(hideableKeys(catalog));
  return {
    order: resolveLayout(catalog, { order }).order,
    hidden: [...hiddenSet].filter((k) => canHide.has(k)),
  };
}

export const defaultLayout = (catalog) => ({ order: catalogKeys(catalog), hidden: [] });

// Convert the old per-table localStorage value (`{ h: [hidden keys] }`, or a legacy
// bare array of visible keys) into a layout, so a user who curated their columns
// before presets existed keeps that choice on first load. A bare array is treated as
// "show everything" for the same reason columnVisibility does: we can't tell a
// deliberately-hidden column from one that didn't exist yet.
export function migrateLegacyHidden(catalog, stored) {
  const canHide = new Set(hideableKeys(catalog));
  const hidden = stored && !Array.isArray(stored) && Array.isArray(stored.h)
    ? stored.h.filter((k) => canHide.has(k))
    : [];
  return { order: catalogKeys(catalog), hidden };
}

// Server-side gate: validate a table key and normalize a client-supplied layout to
// exactly the keys this table owns. Returns null for an unknown table so the caller
// can fail closed.
export function validateLayout(tableKey, layout) {
  const catalog = catalogFor(tableKey);
  if (!catalog) return null;
  return resolveLayoutToPlain(catalog, layout);
}

function resolveLayoutToPlain(catalog, layout) {
  const { order, hidden } = resolveLayout(catalog, layout);
  return { order, hidden: [...hidden] };
}
