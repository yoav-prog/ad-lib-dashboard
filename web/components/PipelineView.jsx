'use client';

import { useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, isVideo, tint, titleCase, pad } from '@/lib/ui';

const COLS = [
  { id: 'new', dotBorder: 'rgba(255,255,255,.3)', dotBg: 'transparent', accent: 'rgba(255,255,255,.18)' },
  { id: 'idea', dotBorder: A, dotBg: 'rgba(232,163,61,.4)', accent: 'rgba(232,163,61,.45)' },
  { id: 'drafting', dotBorder: A, dotBg: 'rgba(232,163,61,.7)', accent: 'rgba(232,163,61,.7)' },
  { id: 'published', dotBorder: A, dotBg: A, accent: A },
];

export default function PipelineView({ ads, update, openDetail }) {
  const [dragId, setDragId] = useState(null);

  return (
    <div>
      <div style={s('display:flex;align-items:center;justify-content:space-between;height:44px;padding:0 20px;border-bottom:1px solid rgba(255,255,255,.06)')}>
        <span style={s(`font-family:${MONO};font-size:12px;letter-spacing:1px;color:#E7E8EA`)}>CONTENT PIPELINE</span>
        <span style={s(`font-family:${MONO};font-size:10.5px;color:#5A5E64`)}>drag cards between columns &middot; status saves to the record</span>
      </div>
      <div style={s('display:flex;gap:1px;background:rgba(255,255,255,.06);min-height:calc(100vh - 89px)')}>
        {COLS.map((col) => {
          const cards = ads.filter((a) => (a.status || 'new') === col.id);
          return (
            <div key={col.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (dragId) update(dragId, { status: col.id }); setDragId(null); }}
              style={s('flex:1;background:#0B0C0E;display:flex;flex-direction:column;min-width:200px')}>
              <div style={s('display:flex;align-items:center;justify-content:space-between;height:38px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.06);background:#0D0E11')}>
                <div style={s('display:flex;align-items:center;gap:9px')}>
                  <span style={s(`width:9px;height:9px;border-radius:50%;border:1.5px solid ${col.dotBorder};background:${col.dotBg}`)} />
                  <span style={s('font-size:11.5px;letter-spacing:.5px;color:#C6C9CE;text-transform:uppercase')}>{titleCase(col.id)}</span>
                </div>
                <span style={s(`font-family:${MONO};font-size:12px;color:#6C7076;font-variant-numeric:tabular-nums`)}>{pad(cards.length)}</span>
              </div>
              <div style={s('padding:12px;display:flex;flex-direction:column;gap:10px;flex:1')}>
                {cards.map((a) => {
                  const initials = a.owner ? a.owner.split(' ').map((x) => x[0]).join('') : '–';
                  return (
                    <div key={a.ad_archive_id} draggable
                      onDragStart={() => setDragId(a.ad_archive_id)}
                      onClick={() => openDetail(a.ad_archive_id)}
                      style={s(`background:#101216;border:1px solid rgba(255,255,255,.09);border-left:2px solid ${col.accent};padding:11px 12px;cursor:grab`)}>
                      <div style={s('display:flex;gap:10px')}>
                        <div style={s(`position:relative;width:38px;height:38px;flex-shrink:0;background:${tint(a.ad_archive_id)};border:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;overflow:hidden`)}>
                          {isVideo(a) && <div style={s('width:0;height:0;border-style:solid;border-width:5px 0 5px 8px;border-color:transparent transparent transparent rgba(255,255,255,.8)')} />}
                        </div>
                        <div style={s('min-width:0;flex:1')}>
                          <div style={s('font-size:11.5px;color:#C6C9CE;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical')}>{a.title || a.caption || a.page_name}</div>
                        </div>
                      </div>
                      <div style={s('display:flex;align-items:center;justify-content:space-between;margin-top:10px')}>
                        <span style={s(`font-family:${MONO};font-size:9.5px;color:#8A8E94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px`)}>{a.vertical || '-'}</span>
                        <div style={s('display:flex;align-items:center;gap:6px')}>
                          <span style={s(`font-family:${MONO};font-size:9px;color:#5A5E64;max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{a.domain}</span>
                          <span style={s(`width:18px;height:18px;border-radius:50%;background:${a.owner ? A : 'rgba(255,255,255,.1)'};color:${a.owner ? '#0B0C0E' : '#C6C9CE'};display:flex;align-items:center;justify-content:center;font-family:${MONO};font-size:8px;font-weight:600`)}>{initials}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {cards.length === 0 && <div style={s('padding:16px 4px;color:#3A3D42;font-size:11px;text-align:center')}>drop here</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
