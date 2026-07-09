'use client';

import { useEffect, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, fmtInt } from '@/lib/ui';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, parsePageSize, pageCount } from '@/lib/paging';

// Rows-per-page preference, remembered per browser per table. The table is
// server-rendered with the default; the saved choice applies after mount.
// Reading localStorage during render would desync hydration (same deal as
// useColumnPrefs).
export function usePageSize(storageKey) {
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  useEffect(() => {
    try {
      const saved = parsePageSize(window.localStorage.getItem(storageKey));
      if (saved) setPageSize(saved);
    } catch { /* first visit or unusable value: keep the default */ }
  }, [storageKey]);

  const save = (next) => {
    setPageSize(next);
    try {
      window.localStorage.setItem(storageKey, String(next));
      console.info('[feed paging] page size saved', { key: storageKey, pageSize: next });
    } catch { /* private mode: the choice lives for this session only */ }
  };
  return { pageSize, setPageSize: save };
}

// Segmented rows-per-page control, styled like the images S/M/L picker so the
// toolbar reads as one family of view controls.
export function PageSizePicker({ value, onChange }) {
  return (
    <>
      <span style={s(`font-family:${MONO};font-size:10px;color:#5A5E64;letter-spacing:.3px`)}>rows</span>
      <div style={s('display:flex;gap:1px;background:rgba(255,255,255,.08)')}>
        {PAGE_SIZES.map((n) => (
          <button key={n} onClick={() => onChange(n)}
            title={n === 'all' ? 'Show every row on one page (can be slow with thousands)' : `Show ${n} rows per page`}
            style={s(`padding:3px 7px;background:${value === n ? '#1A1C20' : '#0D0E11'};border:none;color:${value === n ? A : '#8A8E94'};font-family:${MONO};font-size:10px;cursor:pointer`)}>
            {n === 'all' ? 'ALL' : n}
          </button>
        ))}
      </div>
    </>
  );
}

// First / prev / "PAGE X OF Y" / next / last. Renders nothing while everything
// fits on one page, so small tables stay exactly as they were. `onPage` gets
// the clamped target page; the parent scrolls back to the top of the table.
export default function Pager({ page, total, pageSize, onPage }) {
  const pages = pageCount(total, pageSize);
  if (pages <= 1) return null;
  const go = (p) => onPage(Math.min(Math.max(0, p), pages - 1));
  const btn = (enabled) =>
    s(`background:#101216;border:1px solid rgba(255,255,255,.12);color:${enabled ? '#C6C9CE' : '#45484D'};font-family:${MONO};font-size:10px;letter-spacing:.3px;padding:4px 9px;cursor:${enabled ? 'pointer' : 'default'}`);
  return (
    <div style={s('display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 16px')}>
      <button onClick={() => go(0)} disabled={page === 0} title="First page" style={btn(page > 0)}>&#171;</button>
      <button onClick={() => go(page - 1)} disabled={page === 0} title="Previous page" style={btn(page > 0)}>&#8249; PREV</button>
      <span style={s(`font-family:${MONO};font-size:10.5px;color:#8A8E94;letter-spacing:.5px;font-variant-numeric:tabular-nums;padding:0 6px`)}>
        PAGE {page + 1} OF {fmtInt(pages)}
      </span>
      <button onClick={() => go(page + 1)} disabled={page >= pages - 1} title="Next page" style={btn(page < pages - 1)}>NEXT &#8250;</button>
      <button onClick={() => go(pages - 1)} disabled={page >= pages - 1} title="Last page" style={btn(page < pages - 1)}>&#187;</button>
    </div>
  );
}
