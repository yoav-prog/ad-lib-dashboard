// Client-side paging math for the big tables (Fresh Finds, Review). The server
// ships every eligible row; these helpers decide which slice actually renders,
// so a 5,000-row dataset never turns into 5,000 DOM rows. Pure functions only -
// the localStorage hook and the controls live in components/Pager.jsx.

// Rows-per-page choices offered to the user. 'all' renders everything on one
// page for people who prefer one long scroll and accept the rendering cost.
export const PAGE_SIZES = [50, 100, 250, 500, 'all'];
export const DEFAULT_PAGE_SIZE = 100;

// A stored or incoming page-size value, normalized to a known option.
// Returns null for anything unrecognized (first visit, tampered storage).
export function parsePageSize(raw) {
  if (raw === 'all') return 'all';
  const n = Number(raw);
  return PAGE_SIZES.includes(n) ? n : null;
}

export function pageCount(total, size) {
  if (size === 'all') return 1;
  return Math.max(1, Math.ceil((total || 0) / size));
}

// Keep the current page valid after the list shrinks (filters, deletes) or the
// page size changes: never below 0, never past the last page.
export function clampPage(page, total, size) {
  return Math.min(Math.max(0, page), pageCount(total, size) - 1);
}

export function pageSlice(list, page, size) {
  if (size === 'all') return list;
  const p = clampPage(page, list.length, size);
  return list.slice(p * size, (p + 1) * size);
}

// "101-200 of 1,843" for the toolbar counter; callers format the numbers.
export function pageRange(total, page, size) {
  if (!total) return { from: 0, to: 0 };
  if (size === 'all') return { from: 1, to: total };
  const p = clampPage(page, total, size);
  return { from: p * size + 1, to: Math.min(total, (p + 1) * size) };
}
