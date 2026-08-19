'use client';

// A faceted filter rail, shared by Fresh Finds and the Client Kits views so the filtering
// UX is defined once. Multi-select chip groups (per-value counts, inline search when a group
// is long), optional numeric range filters, an optional date-range toggle, and a Clear.
// `groups` is a descriptor list: { group, title, vals, count(v), label(v) }. `filters` holds
// the selected arrays keyed by group; onToggle(group, value) flips one. `ranges` is optional:
// { key, title, min, max, onMin, onMax }. `dateRange`/`onDateRange` render the date buttons.
// `sticky` keeps the rail in view while the table scrolls (opt-in, used by Client Kits).
// `top` is a slot rendered above the groups, for a filter that is a single choice rather than
// a chip set (Fresh Finds puts the "our domain" picker there); it renders while the facets are
// still loading, since it does not depend on them.
import { useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, titleCase, pad } from '@/lib/ui';

export default function FilterRail({
  groups = [], filters = {}, onToggle, ranges = [], onClear, loading = false, width = 236,
  dateRange = null, onDateRange = null, dateOptions = ['24h', '7d', '30d', 'all'],
  chosenCount = null, sticky = false, stickyTop = 44, top = null,
}) {
  const [gsearch, setGsearch] = useState({});
  const auto = Object.values(filters).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
    + ranges.reduce((n, r) => n + ((r.min !== '' && r.min != null ? 1 : 0) + (r.max !== '' && r.max != null ? 1 : 0)), 0)
    + (dateRange && dateRange !== 'all' ? 1 : 0);
  const count = chosenCount == null ? auto : chosenCount;

  const box = sticky
    ? `width:${width}px;flex-shrink:0;align-self:flex-start;position:sticky;top:${stickyTop}px;max-height:calc(100vh - ${stickyTop}px);overflow-y:auto;background:#0D0E11;border-right:1px solid rgba(255,255,255,.09)`
    : `width:${width}px;flex-shrink:0;align-self:stretch;overflow-y:auto;background:#0D0E11;border-right:1px solid rgba(255,255,255,.09)`;

  return (
    <div style={s(box)}>
      <div style={s('display:flex;align-items:center;justify-content:space-between;height:34px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.06)')}>
        <span style={s(`font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:#6C7076`)}>FILTERS</span>
        {onClear && <button onClick={onClear} style={s(`background:none;border:none;color:${count ? A : '#5A5E64'};font-family:${MONO};font-size:9.5px;letter-spacing:.5px;cursor:pointer`)}>CLEAR ({count})</button>}
      </div>

      {top}

      {loading ? (
        <div style={s('display:flex;align-items:center;gap:8px;padding:16px 14px')}>
          <span style={s(`width:7px;height:7px;border-radius:50%;background:${A};animation:freshpulse 1.4s ease-in-out infinite`)} />
          <span style={s(`font-family:${MONO};font-size:10px;letter-spacing:.5px;color:#8A8E94`)}>LOADING FILTERS...</span>
        </div>
      ) : (
        <>
          {groups.map((g) => {
            const chosen = (filters[g.group] || []);
            const term = (gsearch[g.group] || '').toLowerCase();
            const searchable = g.vals.length > 6;
            const opts = term ? g.vals.filter((v) => String(v).toLowerCase().includes(term)) : g.vals;
            return (
              <div key={g.group} style={s('border-bottom:1px solid rgba(255,255,255,.06);padding:11px 0 12px')}>
                <div style={s('display:flex;align-items:center;justify-content:space-between;padding:0 14px 8px')}>
                  <span style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>{g.title}</span>
                  {chosen.length > 0 && <span style={s(`font-family:${MONO};font-size:9px;color:${A}`)}>{chosen.length}</span>}
                </div>
                {searchable && (
                  <div style={s('padding:0 14px 8px')}>
                    <input value={gsearch[g.group] || ''} onChange={(e) => setGsearch((p) => ({ ...p, [g.group]: e.target.value }))}
                      placeholder={`Filter ${g.title.toLowerCase()}...`}
                      style={s('width:100%;box-sizing:border-box;background:#0B0C0E;border:1px solid rgba(255,255,255,.08);color:#C6C9CE;font-size:11px;padding:5px 8px;outline:none')} />
                  </div>
                )}
                <div style={s(searchable ? 'max-height:184px;overflow-y:auto' : '')}>
                  {opts.map((v) => {
                    const sel = chosen.includes(v);
                    return (
                      <button key={v} onClick={() => onToggle(g.group, v)}
                        style={s(`display:flex;align-items:center;gap:9px;width:100%;padding:4px 14px;background:${sel ? 'rgba(232,163,61,.06)' : 'transparent'};border:none;cursor:pointer;text-align:left`)}>
                        <span style={s(`width:11px;height:11px;flex-shrink:0;border:1px solid ${sel ? A : 'rgba(255,255,255,.2)'};background:${sel ? A : 'transparent'};display:flex;align-items:center;justify-content:center;font-size:8px;color:#0B0C0E;line-height:1`)}>{sel ? '✓' : ''}</span>
                        <span style={s(`flex:1;font-size:11.5px;color:${sel ? '#E7E8EA' : '#9CA0A6'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{g.label ? g.label(v) : titleCase(String(v))}</span>
                        <span style={s(`font-family:${MONO};font-size:10px;color:#5A5E64;font-variant-numeric:tabular-nums`)}>{pad(g.count(v))}</span>
                      </button>
                    );
                  })}
                  {opts.length === 0 && <div style={s('padding:4px 14px;font-size:11px;color:#45484D')}>no match</div>}
                </div>
              </div>
            );
          })}
          {ranges.map((r) => (
            <RangeFilter key={r.key} title={r.title} min={r.min} max={r.max} onMin={r.onMin} onMax={r.onMax} />
          ))}
          {onDateRange && (
            <div style={s('padding:11px 14px')}>
              <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>DATE RANGE</div>
              <div style={s('display:flex;gap:1px;background:rgba(255,255,255,.06)')}>
                {dateOptions.map((d) => (
                  <button key={d} onClick={() => onDateRange(d)}
                    style={s(`flex:1;padding:5px 0;background:${dateRange === d ? '#1A1C20' : '#0D0E11'};border:none;color:${dateRange === d ? A : '#8A8E94'};font-family:${MONO};font-size:10px;cursor:pointer`)}>{d.toUpperCase()}</button>
                ))}
              </div>
            </div>
          )}
          {groups.length === 0 && ranges.length === 0 && !onDateRange && (
            <div style={s('padding:16px 14px;font-size:11px;color:#5A5E64')}>No filters available.</div>
          )}
        </>
      )}
    </div>
  );
}

function RangeFilter({ title, min, max, onMin, onMax }) {
  const inp = `flex:1;min-width:0;box-sizing:border-box;background:#0B0C0E;border:1px solid rgba(255,255,255,.1);color:#E7E8EA;font-family:${MONO};font-size:11px;padding:6px 8px;outline:none;text-align:center`;
  const active = min !== '' || max !== '';
  return (
    <div style={s('border-bottom:1px solid rgba(255,255,255,.06);padding:11px 14px 12px')}>
      <div style={s('display:flex;align-items:center;justify-content:space-between;margin-bottom:8px')}>
        <span style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>{title}</span>
        {active && <button onClick={() => { onMin(''); onMax(''); }} style={s(`background:none;border:none;color:${A};font-family:${MONO};font-size:9px;cursor:pointer`)}>reset</button>}
      </div>
      <div style={s('display:flex;align-items:center;gap:8px')}>
        <input type="number" value={min} onChange={(e) => onMin(e.target.value)} placeholder="min" style={s(inp)} />
        <span style={s('color:#45484D;font-size:11px')}>&ndash;</span>
        <input type="number" value={max} onChange={(e) => onMax(e.target.value)} placeholder="max" style={s(inp)} />
      </div>
    </div>
  );
}
