'use client';

import { useEffect, useRef, useState } from 'react';
import { needsScroll, pageStep, clampScrollLeft, edgeTarget } from '@/lib/tablescroll';

// A horizontal-scroll shell for the dashboard's wide tables. The tables are taller
// than the screen and scroll the WINDOW vertically, so a table's own horizontal
// scrollbar sits at the very bottom of the content, out of reach until you page all
// the way down. This wraps the table body in a viewport whose native bar is hidden
// and mirrors it with two synced scrollbar strips - one pinned just under the top
// nav, one pinned to the bottom of the viewport - so a horizontal bar is always
// where the cursor already is. Hover reveals left/right nudge chevrons on the bars
// and a back-to-top / jump-to-bottom stack in the corner.
//
// Drop-in: replace a table's `overflow-x:auto` wrapper with <TableScroll> and pass
// the same layout style. `topOffset` is where the top bar sticks (default 44, the
// nav height); it only matters cosmetically when the run banner is also showing.
export default function TableScroll({ children, style, className = '', topOffset = 44, label = 'table' }) {
  const viewRef = useRef(null);
  const topRef = useRef(null);
  const botRef = useRef(null);
  const syncing = useRef(false);
  const [width, setWidth] = useState(0);        // content scrollWidth, drives the strips
  const [overflow, setOverflow] = useState(false); // wider than the viewport?

  // Measure the content width and whether it overflows. Column show/hide and reorder
  // change the table's min-width, and paging swaps the rows, so we re-measure on
  // viewport/child resize, on childList mutations, and on window resize - all
  // rAF-coalesced so a burst of changes costs a single measurement.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return undefined;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const w = view.scrollWidth;
      setWidth(w);
      setOverflow(needsScroll(w, view.clientWidth));
      console.debug('[table scroll] measure', { label, scrollWidth: w, clientWidth: view.clientWidth });
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(view);
    for (const child of view.children) ro.observe(child);
    const mo = new MutationObserver(schedule);
    mo.observe(view, { childList: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', schedule);
    };
    // label is stable per table; measuring is keyed off live DOM, not props.
  }, [label]);

  // Whichever surface the user drags (content, top strip, bottom strip), the other
  // two follow. The guard flag swallows the scroll events our own writes trigger.
  const syncFrom = (src) => {
    if (syncing.current || !src) return;
    syncing.current = true;
    const left = src.scrollLeft;
    for (const ref of [viewRef, topRef, botRef]) {
      const el = ref.current;
      if (el && el !== src && el.scrollLeft !== left) el.scrollLeft = left;
    }
    requestAnimationFrame(() => { syncing.current = false; });
  };

  // A chevron press moves most of a screen; the strips follow via the view's own
  // scroll event, so we only drive the content here.
  const nudge = (dir) => {
    const view = viewRef.current;
    if (!view) return;
    const target = clampScrollLeft(view.scrollLeft + dir * pageStep(view.clientWidth), view.scrollWidth, view.clientWidth);
    view.scrollTo({ left: target, behavior: 'smooth' });
  };

  // Jump the whole way to the first (dir<0) or last (dir>0) column.
  const toEdge = (dir) => {
    const view = viewRef.current;
    if (!view) return;
    view.scrollTo({ left: edgeTarget(dir, view.scrollWidth, view.clientWidth), behavior: 'smooth' });
  };

  const toTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  const toBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });

  const bar = (ref, place) => (
    <div className={`tscroll-barwrap tscroll-barwrap-${place}`}
      style={place === 'top' ? { top: `${topOffset}px`, display: overflow ? 'block' : 'none' } : { display: overflow ? 'block' : 'none' }}>
      <div ref={ref} className="tscroll-bar" onScroll={(e) => syncFrom(e.currentTarget)} aria-hidden="true">
        <div className="tscroll-bar-spacer" style={{ width: `${width}px` }} />
      </div>
      <div className="tscroll-edge tscroll-edge-left">
        <button type="button" className="tscroll-edgebtn" tabIndex={-1} title="Jump to first column" onClick={() => toEdge(-1)}>&#171;</button>
        <button type="button" className="tscroll-edgebtn" tabIndex={-1} title="Scroll left" onClick={() => nudge(-1)}>&#8249;</button>
      </div>
      <div className="tscroll-edge tscroll-edge-right">
        <button type="button" className="tscroll-edgebtn" tabIndex={-1} title="Scroll right" onClick={() => nudge(1)}>&#8250;</button>
        <button type="button" className="tscroll-edgebtn" tabIndex={-1} title="Jump to last column" onClick={() => toEdge(1)}>&#187;</button>
      </div>
    </div>
  );

  return (
    <div className={`tscroll-root ${className}`.trim()} style={style}>
      {bar(topRef, 'top')}
      <div ref={viewRef} className="tscroll-viewport" onScroll={(e) => syncFrom(e.currentTarget)}>
        {children}
      </div>
      {bar(botRef, 'bottom')}
      <div className="tscroll-jump">
        <button type="button" title="Back to top" onClick={toTop}>&#8593;</button>
        <button type="button" title="Jump to bottom" onClick={toBottom}>&#8595;</button>
      </div>
    </div>
  );
}
