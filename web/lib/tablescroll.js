// Pure helpers behind components/TableScroll.jsx. The DOM wiring (refs, scroll
// events, ResizeObserver) lives in the component and needs a browser; these are the
// bits of arithmetic that decide when a scrollbar is needed and how far a nudge
// jumps, factored out so they can be unit-tested without one.

// A table overflows horizontally (and therefore wants the synced scrollbars) only
// when its content is wider than the viewport. The 1px tolerance keeps sub-pixel
// rounding from flickering the bars on for a table that visually fits.
export function needsScroll(scrollWidth, clientWidth) {
  return Number(scrollWidth) > Number(clientWidth) + 1;
}

// How far one chevron press (or bar page) moves the table: most of a screen width,
// so a couple of presses cross a wide table while still leaving an overlap column
// for orientation. Never less than a sensible minimum, so a narrow viewport still
// makes real progress.
export function pageStep(clientWidth, factor = 0.85) {
  const w = Number(clientWidth);
  if (!Number.isFinite(w) || w <= 0) return 240;
  return Math.max(120, Math.round(w * factor));
}

// The scroll offset that lands the table on its first (dir < 0) or last (dir > 0)
// column: 0, or the maximum scrollable distance. Never negative when the table fits.
export function edgeTarget(dir, scrollWidth, clientWidth) {
  if (dir < 0) return 0;
  return Math.max(0, Number(scrollWidth) - Number(clientWidth));
}

// Keep a target scroll offset inside the legal range [0, maxScrollLeft]. Guards the
// chevron nudges from driving scrollLeft negative or past the end (browsers clamp
// anyway, but clamping here keeps the synced bars in exact agreement).
export function clampScrollLeft(left, scrollWidth, clientWidth) {
  const max = Math.max(0, Number(scrollWidth) - Number(clientWidth));
  const x = Number(left) || 0;
  return Math.min(max, Math.max(0, x));
}
