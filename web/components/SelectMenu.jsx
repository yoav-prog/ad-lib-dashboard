'use client';

// The caret beside a header checkbox: select this page, the first N rows of the current
// view, everything matching, or clear - one gesture instead of ticking rows one by one.
// Same popover manners as ColumnPicker (click-outside / Escape closes). Shared by Fresh
// Finds and the Client Kits tables so the selection control is defined once.
import { useEffect, useRef, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, fmtInt } from '@/lib/ui';

export default function SelectMenu({ pageRows, total, busy, hasSelection, onPage, onFirst, onAll, onClear }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const item = 'display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:5px 12px;background:transparent;border:none;cursor:pointer;text-align:left;font-size:11.5px;color:#C6C9CE';
  const num = s(`font-family:${MONO};font-size:10px;color:#5A5E64;font-variant-numeric:tabular-nums`);
  const firstN = () => {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v) || v < 1) return;
    onFirst(Math.min(v, total));
    setOpen(false);
  };
  const pick = (fn) => () => { fn(); setOpen(false); };
  return (
    <div ref={ref} style={s('position:relative;display:flex;align-items:center')}>
      <button onClick={() => setOpen((o) => !o)} title="Select rows in bulk: this page, the first N, or everything matching"
        style={s(`background:none;border:none;color:${open || busy ? A : '#8A8E94'};font-size:8px;cursor:pointer;padding:2px 1px;line-height:1`)}>&#9662;</button>
      {open && (
        <div style={s('position:absolute;left:-8px;top:calc(100% + 8px);z-index:60;width:216px;background:#101216;border:1px solid rgba(255,255,255,.14);box-shadow:0 14px 40px rgba(0,0,0,.55);padding:6px 0 8px;text-transform:none;letter-spacing:0')}>
          <div style={s('padding:4px 12px 7px;font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>{busy ? 'Selecting...' : 'Select'}</div>
          <button onClick={pick(onPage)} style={s(item)}>This page <span style={num}>{fmtInt(pageRows)}</span></button>
          <div style={s('display:flex;align-items:center;gap:8px;padding:5px 12px')}>
            <span style={s('font-size:11.5px;color:#C6C9CE')}>First</span>
            <input value={n} onChange={(e) => setN(e.target.value.replace(/[^\d]/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') firstN(); }}
              placeholder="50" inputMode="numeric" aria-label="How many rows to select from the top"
              style={s(`flex:1;min-width:0;background:#0B0C0E;border:1px solid rgba(255,255,255,.12);color:#E7E8EA;font-family:${MONO};font-size:11px;padding:3px 7px;outline:none;text-align:right`)} />
            <button onClick={firstN} disabled={!n}
              style={s(`background:#101216;border:1px solid ${n ? A : 'rgba(255,255,255,.12)'};color:${n ? A : '#45484D'};font-family:${MONO};font-size:9.5px;letter-spacing:.4px;padding:3px 8px;cursor:${n ? 'pointer' : 'default'}`)}>GO</button>
          </div>
          <button onClick={pick(onAll)} style={s(item)}>All matching <span style={num}>{fmtInt(total)}</span></button>
          {hasSelection && <button onClick={pick(onClear)} style={s(item + ';color:#8A8E94')}>Clear selection</button>}
        </div>
      )}
    </div>
  );
}
