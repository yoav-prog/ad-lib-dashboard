'use client';

// A faceted filter rail modeled on the Fresh Finds rail: multi-select chip groups (with
// per-value counts and an inline search when a group is long), plus optional numeric range
// filters. Shared by the Client Kits views so their filtering matches Fresh Finds' feel.
// `groups` is a descriptor list: { group, title, vals, count(v), label(v) }. `filters` holds
// the selected arrays keyed by group; onToggle(group, value) flips one. `ranges` is optional:
// { key, title, min, max, onMin, onMax }.
import { useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, titleCase, pad } from '@/lib/ui';

export default function FilterRail({ groups = [], filters = {}, onToggle, ranges = [], onClear, loading = false, width = 232 }) {
  const [gsearch, setGsearch] = useState({});
  const totalChosen = Object.values(filters).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
    + ranges.reduce((n, r) => n + ((r.min !== '' && r.min != null ? 1 : 0) + (r.max !== '' && r.max != null ? 1 : 0)), 0);

  return (
    <div style={s(`width:${width}px;flex-shrink:0;background:#0D0E11;border-right:1px solid rgba(255,255,255,.07);overflow-y:auto;align-self:stretch`)}>
      <div style={s('display:flex;align-items:center;justify-content:space-between;height:34px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.06)')}>
        <span style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>Filters{totalChosen > 0 ? ` · ${totalChosen}` : ''}</span>
        {totalChosen > 0 && onClear && (
          <button onClick={onClear} style={s(`background:none;border:none;color:#8A8E94;font-family:${MONO};font-size:10px;cursor:pointer`)}>CLEAR</button>
        )}
      </div>

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
          {groups.length === 0 && ranges.length === 0 && (
            <div style={s('padding:16px 14px;font-size:11px;color:#5A5E64')}>No filters available.</div>
          )}
        </>
      )}
    </div>
  );
}

function RangeFilter({ title, min, max, onMin, onMax }) {
  const inp = `flex:1;min-width:0;box-sizing:border-box;background:#0B0C0E;border:1px solid rgba(255,255,255,.1);color:#E7E8EA;font-family:${MONO};font-size:11px;padding:6px 8px;outline:none;text-align:center`;
  return (
    <div style={s('padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.06)')}>
      <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>{title}</div>
      <div style={s('display:flex;align-items:center;gap:6px')}>
        <input value={min} onChange={(e) => onMin(e.target.value.replace(/[^\d]/g, ''))} placeholder="min" inputMode="numeric" style={s(inp)} />
        <span style={s('color:#5A5E64;font-size:11px')}>&ndash;</span>
        <input value={max} onChange={(e) => onMax(e.target.value.replace(/[^\d]/g, ''))} placeholder="max" inputMode="numeric" style={s(inp)} />
      </div>
    </div>
  );
}
