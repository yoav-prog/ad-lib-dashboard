'use client';

import { useEffect, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, fmtInt } from '@/lib/ui';
import CopyCell from '@/components/CopyCell';

// The GEOS table cell Fresh Finds and Review share: the compact "ES-90,MX-10"
// split, copyable on hover and clickable to open the full revenue-by-country
// breakdown. `style` carries the host table's width/padding so the cell slots
// into either layout unchanged.
export default function GeoSplitCell({ ad, style }) {
  const [open, setOpen] = useState(false);
  const geos = ad.sheet_geos;
  const split = ad.sheet_geo_split;
  const openBreakdown = (e) => {
    e.stopPropagation();
    if (!split?.length) return;
    console.info('[geos] open breakdown', { ad: ad.ad_archive_id, countries: split.length });
    setOpen(true);
  };
  return (
    <CopyCell value={geos || ''} style={style}>
      {geos
        ? <button onClick={openBreakdown} title="See the revenue for each country"
            style={s(`display:block;max-width:100%;background:none;border:none;padding:0;text-align:left;font-family:${MONO};font-size:10.5px;color:#B6B9BE;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;text-decoration:underline dotted rgba(232,163,61,.5);text-underline-offset:3px`)}>{geos}</button>
        : <span style={s(`font-family:${MONO};font-size:10.5px;color:#45484D`)}>-</span>}
      {open && <GeoSplitModal ad={ad} split={split} onClose={() => setOpen(false)} />}
    </CopyCell>
  );
}

// One row per country, biggest earner first: code badge, a bar scaled to the
// top earner, the exact revenue, and its share of the total. Click-away and
// Escape both close; every click is swallowed so the ad row underneath never
// opens its detail view by accident.
function GeoSplitModal({ ad, split, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const total = split.reduce((n, g) => n + g.revenue, 0);
  const max = split[0]?.revenue || 1;
  const pct = (share) => (share * 100 >= 1 ? `${Math.round(share * 100)}%` : '<1%');
  const name = ad.title || ad.caption || ad.body_text || ad.page_name || '';

  return (
    <div onClick={(e) => { e.stopPropagation(); onClose(); }}
      style={s('position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;padding:40px;animation:fadein .12s ease-out;cursor:default')}>
      <div onClick={(e) => e.stopPropagation()}
        style={s('width:400px;max-width:100%;max-height:80vh;display:flex;flex-direction:column;background:#101216;border:1px solid rgba(255,255,255,.14);box-shadow:0 24px 60px rgba(0,0,0,.6)')}>
        <div style={s('display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.08)')}>
          <span style={s(`font-family:${MONO};font-size:11px;letter-spacing:1px;color:#E7E8EA`)}>REVENUE BY COUNTRY</span>
          <button onClick={onClose} style={s(`font-family:${MONO};font-size:10px;color:#8A8E94;background:none;border:1px solid rgba(255,255,255,.14);padding:4px 9px;cursor:pointer`)}>CLOSE</button>
        </div>
        {name && (
          <div style={s('padding:12px 18px 0')}>
            <div style={s('font-size:12px;color:#9CA0A6;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical')}>{name}</div>
          </div>
        )}
        <div style={s('padding:14px 18px 4px;overflow-y:auto')}>
          {split.map((g, i) => (
            <div key={g.country} style={s('display:flex;align-items:center;gap:12px;padding:7px 0')}>
              <span style={s(`width:36px;flex-shrink:0;font-family:${MONO};font-size:11px;letter-spacing:.5px;text-align:center;padding:2px 0;color:${i === 0 ? '#0B0C0E' : '#C6C9CE'};background:${i === 0 ? A : 'rgba(255,255,255,.07)'};border:1px solid ${i === 0 ? A : 'rgba(255,255,255,.12)'}`)}>{g.country}</span>
              <div style={s('flex:1;height:6px;background:rgba(255,255,255,.06)')}>
                <div style={s(`height:100%;width:${Math.max(1.5, (g.revenue / max) * 100)}%;background:${i === 0 ? A : '#6C7076'}`)} />
              </div>
              <span title={String(g.revenue)} style={s(`width:74px;flex-shrink:0;text-align:right;font-family:${MONO};font-size:12.5px;color:#E7E8EA;font-variant-numeric:tabular-nums`)}>{fmtInt(g.revenue)}</span>
              <span style={s(`width:38px;flex-shrink:0;text-align:right;font-family:${MONO};font-size:10.5px;color:#8A8E94;font-variant-numeric:tabular-nums`)}>{pct(g.share)}</span>
            </div>
          ))}
        </div>
        <div style={s('display:flex;align-items:center;justify-content:space-between;margin:8px 18px 0;padding:12px 0 14px;border-top:1px solid rgba(255,255,255,.08)')}>
          <span style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>Total revenue prediction</span>
          <span title={String(total)} style={s(`font-family:${MONO};font-size:14px;color:${A};font-variant-numeric:tabular-nums`)}>{fmtInt(total)}</span>
        </div>
      </div>
    </div>
  );
}
