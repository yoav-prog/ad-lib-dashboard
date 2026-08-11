'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { s } from '@/lib/style';
import { A, MONO } from '@/lib/ui';
import {
  catalogFor, resolveLayout, hideableKeys, serializeLayout, defaultLayout, migrateLegacyHidden, makeOrderOf,
} from '@/lib/columns';
import { listColumnPresets, saveColumnPreset, deleteColumnPreset, setDefaultColumnPreset } from '@/app/preset-actions';

// Per-table column state: order, visibility, and named presets that live on the
// user's account. The table server-renders in catalog order with everything visible,
// so the hook starts there (no hydration mismatch) and applies the saved layout after
// mount - the account default preset if there is one, else the local cache, else a
// one-time migration of the old COLUMNS-picker localStorage value.
//
// Returns what a view needs to render (`visible` set, `orderOf` for ColumnRow) plus
// everything <ColumnsManager> needs to edit and persist.
export function useColumnLayout(tableKey) {
  const catalog = useMemo(() => catalogFor(tableKey), [tableKey]);
  const cacheKey = `adintel.layout.${tableKey}`;
  const legacyKey = `adintel.cols.${tableKey}`;

  const [layout, setLayout] = useState(() => defaultLayout(catalog));
  const [presets, setPresets] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const writeCache = useCallback((next) => {
    try { window.localStorage.setItem(cacheKey, JSON.stringify(next)); } catch { /* private mode */ }
  }, [cacheKey]);

  // Apply the saved layout once, after mount. Order of precedence: account default
  // preset > local cache > migrated legacy value > catalog default.
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      let next = null;
      try {
        const cached = JSON.parse(window.localStorage.getItem(cacheKey));
        if (cached && Array.isArray(cached.order)) next = cached;
      } catch { /* ignore */ }
      if (!next) {
        try {
          const legacy = JSON.parse(window.localStorage.getItem(legacyKey));
          if (legacy) next = migrateLegacyHidden(catalog, legacy);
        } catch { /* ignore */ }
      }

      let list = [];
      try {
        const res = await listColumnPresets();
        if (res?.ok) list = res.presets.filter((p) => p.table_key === tableKey);
      } catch (e) { console.warn('[columns layout] preset load failed', { tableKey, error: String(e) }); }
      if (cancelled) return;

      const def = list.find((p) => p.is_default);
      if (def) { next = def.layout; setActiveId(def.id); }
      setPresets(list);
      if (next) { setLayout(next); }
      setLoaded(true);
      console.info('[columns layout] booted', { tableKey, presets: list.length, applied: def ? `default:${def.name}` : (next ? 'cache' : 'catalog') });
    };
    boot();
    return () => { cancelled = true; };
  }, [tableKey, catalog, cacheKey, legacyKey]);

  const resolved = useMemo(() => resolveLayout(catalog, layout), [catalog, layout]);
  const visible = useMemo(() => new Set(resolved.order.filter((k) => !resolved.hidden.has(k))), [resolved]);
  const orderOf = useMemo(() => makeOrderOf(resolved.order), [resolved]);

  // Every layout edit writes the working layout to the cache. The active preset stays
  // selected; the `dirty` flag below then drives the "Save" affordance so a tweak to a
  // loaded preset can be written back in one click (rather than silently detaching).
  const commit = useCallback((updater) => {
    setLayout((prev) => {
      const next = typeof updater === 'function' ? updater(resolveLayout(catalog, prev)) : updater;
      const serialized = serializeLayout(catalog, next.order, new Set(next.hidden));
      writeCache(serialized);
      return serialized;
    });
  }, [catalog, writeCache]);

  const toggle = useCallback((key) => {
    const canHide = new Set(hideableKeys(catalog));
    if (!canHide.has(key)) return;
    commit((cur) => {
      const hidden = new Set(cur.hidden);
      if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
      return { order: cur.order, hidden: [...hidden] };
    });
    console.info('[columns layout] toggle', { tableKey, key });
  }, [catalog, commit, tableKey]);

  const setOrder = useCallback((order) => {
    commit((cur) => ({ order, hidden: [...cur.hidden] }));
  }, [commit]);

  const showAll = useCallback(() => commit((cur) => ({ order: cur.order, hidden: [] })), [commit]);
  // Reset goes back to the catalog default and steps off any active preset - it is an
  // explicit "start over", not an edit of the loaded preset.
  const reset = useCallback(() => { commit(defaultLayout(catalog)); setActiveId(null); console.info('[columns layout] reset', { tableKey }); }, [catalog, commit, tableKey]);

  const refresh = useCallback(async () => {
    try {
      const res = await listColumnPresets();
      if (res?.ok) setPresets(res.presets.filter((p) => p.table_key === tableKey));
    } catch (e) { console.warn('[columns layout] refresh failed', { tableKey, error: String(e) }); }
  }, [tableKey]);

  const applyPreset = useCallback((id) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    const serialized = serializeLayout(catalog, p.layout.order || [], new Set(p.layout.hidden || []));
    setLayout(serialized);
    writeCache(serialized);
    setActiveId(id);
    console.info('[columns layout] apply preset', { tableKey, name: p.name });
  }, [presets, catalog, writeCache, tableKey]);

  const saveAs = useCallback(async (name, makeDefault = false) => {
    const res = await saveColumnPreset({ tableKey, name, layout, makeDefault });
    if (res?.ok) { await refresh(); setActiveId(res.preset.id); }
    return res;
  }, [tableKey, layout, refresh]);

  const setDefault = useCallback(async (id) => {
    await setDefaultColumnPreset({ tableKey, id });
    await refresh();
  }, [tableKey, refresh]);

  const remove = useCallback(async (id) => {
    await deleteColumnPreset(id);
    if (activeId === id) setActiveId(null);
    await refresh();
  }, [activeId, refresh]);

  // Whether the working layout differs from the active preset (drives the Save button).
  const dirty = useMemo(() => {
    if (!activeId) return false;
    const p = presets.find((x) => x.id === activeId);
    if (!p) return true;
    const a = serializeLayout(catalog, p.layout.order || [], new Set(p.layout.hidden || []));
    return JSON.stringify(a) !== JSON.stringify(layout);
  }, [activeId, presets, catalog, layout]);

  return {
    catalog, order: resolved.order, hidden: resolved.hidden, visible, orderOf,
    presets, activeId, loaded, dirty,
    toggle, setOrder, showAll, reset, applyPreset, saveAs, setDefault, remove,
  };
}

// ── The manager popover ────────────────────────────────────────────────────────
// The COLUMNS button plus a popover that hides/shows columns, drag-reorders them, and
// saves the arrangement as an account preset. Click-outside or Escape closes it.
export default function ColumnsManager({ layout }) {
  const { catalog, order, hidden, presets, activeId, dirty, toggle, setOrder, showAll, reset, applyPreset, saveAs, setDefault, remove } = layout;
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setNaming(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const labelOf = useMemo(() => Object.fromEntries(catalog.map((c) => [c.key, c])), [catalog]);
  const hiddenCount = hidden.size;
  const trimmed = hiddenCount > 0;
  const activePreset = presets.find((p) => p.id === activeId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const from = order.indexOf(active.id);
    const to = order.indexOf(over.id);
    if (from < 0 || to < 0) return;
    setOrder(arrayMove(order, from, to));
  };

  const submitName = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true); setErr('');
    const res = await saveAs(n, presets.length === 0); // first preset a user makes becomes their default
    setBusy(false);
    if (res?.ok) { setNaming(false); setName(''); }
    else setErr(res?.reason === 'limit' ? `Limit is ${res.max} presets` : 'Could not save');
  };
  const saveActive = async () => {
    if (!activePreset || busy) return;
    setBusy(true); await saveAs(activePreset.name, activePreset.is_default); setBusy(false);
  };

  return (
    <div ref={ref} style={s('position:relative')}>
      <button onClick={() => setOpen((o) => !o)}
        title="Show, hide, reorder and save this table's columns"
        style={s(`background:${open ? '#1A1C20' : '#101216'};border:1px solid rgba(255,255,255,.12);color:${trimmed ? A : '#C6C9CE'};font-family:${MONO};font-size:10px;letter-spacing:.3px;padding:4px 9px;cursor:pointer`)}>
        &#9636; COLUMNS{trimmed ? ` ${order.length - hiddenCount}/${order.length}` : ''}{activePreset ? ` · ${activePreset.name}${dirty ? '*' : ''}` : ''}
      </button>
      {open && (
        <div style={s('position:absolute;right:0;top:calc(100% + 6px);z-index:60;width:264px;background:#101216;border:1px solid rgba(255,255,255,.14);box-shadow:0 14px 40px rgba(0,0,0,.55);text-transform:none;letter-spacing:0')}>

          {/* presets */}
          <div style={s('padding:9px 12px 8px;border-bottom:1px solid rgba(255,255,255,.08)')}>
            <div style={s('display:flex;align-items:center;justify-content:space-between;margin-bottom:7px')}>
              <span style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>Presets</span>
              {!naming && <button onClick={() => { setNaming(true); setName(activePreset?.name || ''); setErr(''); }}
                style={s(`background:none;border:none;color:${A};font-family:${MONO};font-size:9px;letter-spacing:.5px;cursor:pointer`)}>+ SAVE AS</button>}
            </div>
            {presets.length === 0 && !naming && (
              <div style={s('font-size:10.5px;color:#5A5E64;line-height:1.4')}>No saved presets yet. Arrange the columns, then Save as.</div>
            )}
            {presets.map((p) => {
              const on = p.id === activeId;
              return (
                <div key={p.id} style={s(`display:flex;align-items:center;gap:6px;padding:3px 0`)}>
                  <button onClick={() => setDefault(p.is_default ? null : p.id)}
                    title={p.is_default ? 'Default preset - loads automatically' : 'Set as default'}
                    style={s(`background:none;border:none;cursor:pointer;font-size:12px;line-height:1;color:${p.is_default ? A : '#45484D'};padding:0`)}>{p.is_default ? '★' : '☆'}</button>
                  <button onClick={() => applyPreset(p.id)}
                    style={s(`flex:1;text-align:left;background:none;border:none;cursor:pointer;font-size:11.5px;color:${on ? '#E7E8EA' : '#9CA0A6'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>
                    {p.name}{on && dirty ? ' *' : ''}
                  </button>
                  {on && dirty && <button onClick={saveActive} disabled={busy} title="Save changes to this preset"
                    style={s(`background:none;border:none;color:${A};font-family:${MONO};font-size:9px;cursor:pointer`)}>SAVE</button>}
                  <button onClick={() => remove(p.id)} title="Delete preset"
                    style={s('background:none;border:none;color:#5A5E64;cursor:pointer;font-size:12px;line-height:1;padding:0 2px')}>&times;</button>
                </div>
              );
            })}
            {naming && (
              <div style={s('margin-top:6px')}>
                <div style={s('display:flex;gap:6px')}>
                  <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitName(); }} placeholder="Preset name"
                    maxLength={60}
                    style={s('flex:1;min-width:0;background:#0B0C0E;border:1px solid rgba(255,255,255,.12);color:#E7E8EA;font-size:11px;padding:5px 7px;outline:none')} />
                  <button onClick={submitName} disabled={busy || !name.trim()}
                    style={s(`background:${name.trim() ? A : '#2A2D31'};border:none;color:#0B0C0E;font-family:${MONO};font-size:10px;padding:0 10px;cursor:${name.trim() ? 'pointer' : 'default'}`)}>SAVE</button>
                </div>
                {err && <div style={s('font-size:10px;color:#E5575B;margin-top:4px')}>{err}</div>}
              </div>
            )}
          </div>

          {/* columns: drag to reorder, checkbox to show/hide */}
          <div style={s('display:flex;align-items:center;justify-content:space-between;padding:8px 12px 4px')}>
            <span style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>Columns · drag to reorder</span>
          </div>
          <div style={s('max-height:280px;overflow-y:auto;padding:0 6px 4px')}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
              <SortableContext items={order} strategy={verticalListSortingStrategy}>
                {order.map((key) => (
                  <SortableColumn key={key} id={key} col={labelOf[key]} hidden={hidden.has(key)} onToggle={() => toggle(key)} />
                ))}
              </SortableContext>
            </DndContext>
          </div>
          <div style={s('display:flex;gap:14px;padding:8px 12px 10px;border-top:1px solid rgba(255,255,255,.08)')}>
            <button onClick={showAll} style={s(`background:none;border:none;color:${trimmed ? A : '#5A5E64'};font-family:${MONO};font-size:9px;letter-spacing:.5px;cursor:pointer`)}>SHOW ALL</button>
            <button onClick={reset} style={s(`background:none;border:none;color:#8A8E94;font-family:${MONO};font-size:9px;letter-spacing:.5px;cursor:pointer`)}>RESET ORDER</button>
          </div>
        </div>
      )}
    </div>
  );
}

// One draggable row in the manager: a drag handle, a show/hide checkbox (a lock for
// pinned Headline and the feed-driven Slug/Query, which are always shown), and the
// column's label.
function SortableColumn({ id, col, hidden, onToggle }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const locked = !!(col?.pinned || col?.auto);
  const on = !hidden;
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...s(`display:flex;align-items:center;gap:8px;padding:4px 6px;background:${isDragging ? '#1A1C20' : 'transparent'};position:relative;z-index:${isDragging ? 2 : 1}`),
  };
  return (
    <div ref={setNodeRef} style={style}>
      <button type="button" {...attributes} {...listeners}
        title="Drag to reorder" aria-label={`Reorder ${col?.label || id}`}
        style={s('background:none;border:none;color:#5A5E64;cursor:grab;padding:0 2px;font-size:12px;line-height:1;touch-action:none')}>&#8942;&#8942;</button>
      <button onClick={locked ? undefined : onToggle} disabled={locked}
        title={locked ? 'Always shown' : (on ? 'Hide column' : 'Show column')}
        style={s(`width:12px;height:12px;flex-shrink:0;border:1px solid ${on ? A : 'rgba(255,255,255,.22)'};background:${on ? A : 'transparent'};display:flex;align-items:center;justify-content:center;font-size:8px;color:#0B0C0E;line-height:1;cursor:${locked ? 'default' : 'pointer'};opacity:${locked ? 0.5 : 1};padding:0`)}>{on ? (locked ? '·' : '✓') : ''}</button>
      <span style={s(`flex:1;font-size:11.5px;color:${on ? '#E7E8EA' : '#8A8E94'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{col?.label || id}</span>
      {locked && <span title="Always shown for its feed" style={s('font-size:9px;color:#45484D')}>&#128274;</span>}
    </div>
  );
}
