'use client';

import { useEffect, useRef, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, sanitizeColumnKeys } from '@/lib/ui';

// Per-table column visibility, remembered per browser. `defs` is the table's
// catalog of hideable columns [{ key, label, w }]; structural columns
// (thumbnail, headline, checkboxes, decisions) never enter it. Returns the
// visible keys as a Set plus the handlers the picker needs.
export function useColumnPrefs(storageKey, defs) {
  const allKeys = () => new Set(defs.map((d) => d.key));
  const [visible, setVisible] = useState(allKeys);

  // The table is server-rendered with every column; the saved choice applies
  // after mount. Reading localStorage during render would desync hydration.
  useEffect(() => {
    try {
      const kept = sanitizeColumnKeys(JSON.parse(window.localStorage.getItem(storageKey)), defs);
      if (kept) setVisible(new Set(kept));
    } catch { /* first visit or unusable value: keep everything visible */ }
  }, [storageKey, defs]);

  const save = (next) => {
    setVisible(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...next]));
      console.info('[columns] saved', { key: storageKey, visible: [...next] });
    } catch { /* private mode: the choice lives for this session only */ }
  };
  const toggle = (key) => {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key); else next.add(key);
    save(next);
  };
  const reset = () => save(allKeys());
  return { visible, toggle, reset };
}

// The COLUMNS toolbar button + checkbox popover. Click-outside or Escape
// closes it; the button shows how many columns are hidden so a slimmed table
// is never a mystery.
export default function ColumnPicker({ defs, visible, toggle, reset }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const shown = defs.filter((d) => visible.has(d.key)).length;
  const trimmed = shown < defs.length;
  return (
    <div ref={ref} style={s('position:relative')}>
      <button onClick={() => setOpen((o) => !o)}
        title="Choose which columns this table shows"
        style={s(`background:${open ? '#1A1C20' : '#101216'};border:1px solid rgba(255,255,255,.12);color:${trimmed ? A : '#C6C9CE'};font-family:${MONO};font-size:10px;letter-spacing:.3px;padding:4px 9px;cursor:pointer`)}>
        &#8862; COLUMNS{trimmed ? ` ${shown}/${defs.length}` : ''}
      </button>
      {open && (
        <div style={s('position:absolute;right:0;top:calc(100% + 6px);z-index:60;width:214px;background:#101216;border:1px solid rgba(255,255,255,.14);box-shadow:0 14px 40px rgba(0,0,0,.55);padding:6px 0 8px')}>
          <div style={s('display:flex;align-items:center;justify-content:space-between;padding:4px 12px 8px')}>
            <span style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>Columns</span>
            <button onClick={reset} style={s(`background:none;border:none;color:${trimmed ? A : '#5A5E64'};font-family:${MONO};font-size:9px;letter-spacing:.5px;cursor:pointer`)}>SHOW ALL</button>
          </div>
          {defs.map((d) => {
            const on = visible.has(d.key);
            return (
              <button key={d.key} onClick={() => toggle(d.key)}
                style={s(`display:flex;align-items:center;gap:9px;width:100%;padding:4px 12px;background:transparent;border:none;cursor:pointer;text-align:left`)}>
                <span style={s(`width:11px;height:11px;flex-shrink:0;border:1px solid ${on ? A : 'rgba(255,255,255,.2)'};background:${on ? A : 'transparent'};display:flex;align-items:center;justify-content:center;font-size:8px;color:#0B0C0E;line-height:1`)}>{on ? '✓' : ''}</span>
                <span style={s(`font-size:11.5px;color:${on ? '#E7E8EA' : '#9CA0A6'}`)}>{d.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
