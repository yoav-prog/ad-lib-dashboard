'use client';

import { useMemo, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, daysRunning, hoursSince, isVideo, pad } from '@/lib/ui';

export default function CompetitorView({ ads, NOW, openDetail, matchesQuery = () => true }) {
  const domains = useMemo(() => {
    const counts = {};
    ads.forEach((a) => { if (a.domain) counts[a.domain] = (counts[a.domain] || 0) + 1; });
    return Object.entries(counts).sort((x, y) => y[1] - x[1]).map(([d]) => d);
  }, [ads]);

  const [dom, setDom] = useState(domains[0] || '');
  const active = dom || domains[0] || '';
  const full = ads.filter((a) => a.domain === active);   // competitor totals (stats)
  const list = full.filter(matchesQuery);                // search-filtered (table)
  const ref = full[0] || {};
  const vids = full.filter(isVideo).length;
  const avgDays = full.length ? Math.round(full.reduce((n, a) => n + daysRunning(a, NOW), 0) / full.length) : 0;
  const fresh7 = full.filter((a) => hoursSince(a.first_seen_at, NOW) <= 168).length;
  const countries = new Set(full.map((a) => a.country).filter(Boolean)).size;

  if (!domains.length) {
    return (
      <div style={s('display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 44px);color:#5A5E64;font-size:13px')}>
        No competitors yet. Run a scrape to populate the feed.
      </div>
    );
  }

  const stats = [
    { label: 'Ads Tracked', value: pad(full.length), color: '#E7E8EA' },
    { label: 'Video / Image', value: `${vids}/${full.length - vids}`, color: '#E7E8EA' },
    { label: 'Avg Days Run', value: `${avgDays}d`, color: A },
    { label: 'Fresh 7d', value: pad(fresh7), color: A },
    { label: 'Countries', value: pad(countries), color: '#E7E8EA' },
  ];

  return (
    <div>
      <div style={s('display:flex;align-items:stretch;min-height:118px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.09);padding:0 24px')}>
        <div style={s('display:flex;align-items:center;gap:16px;flex:1')}>
          <div style={s(`width:52px;height:52px;background:#141619;border:1px solid rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;font-family:${MONO};font-size:18px;color:#E7E8EA`)}>
            {(ref.page_name || active).slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div style={s('display:flex;align-items:center;gap:10px')}>
              <h1 style={s('font-size:20px;font-weight:600;color:#F0F1F3;margin:0')}>{ref.page_name || active}</h1>
              <select value={active} onChange={(e) => setDom(e.target.value)}
                style={s(`background:#101216;border:1px solid rgba(255,255,255,.1);color:#8A8E94;font-family:${MONO};font-size:11px;padding:3px 6px;outline:none`)}>
                {domains.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div style={s(`font-family:${MONO};font-size:12px;color:#6C7076;margin-top:4px`)}>{active} &middot; {ref.vertical || '-'}</div>
          </div>
        </div>
        {stats.map((cs) => (
          <div key={cs.label} style={s('display:flex;flex-direction:column;justify-content:center;padding:0 22px;border-left:1px solid rgba(255,255,255,.06);min-width:120px')}>
            <span style={s(`font-family:${MONO};font-size:22px;color:${cs.color};font-variant-numeric:tabular-nums`)}>{cs.value}</span>
            <span style={s('font-size:9.5px;letter-spacing:.8px;color:#6C7076;text-transform:uppercase;margin-top:2px')}>{cs.label}</span>
          </div>
        ))}
      </div>

      <div style={s('display:flex;align-items:center;height:26px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase;min-width:760px')}>
        <div style={s('width:52px')} />
        <div style={s('flex:1')}>Headline</div>
        <div style={s('width:80px;text-align:center')}>Format</div>
        <div style={s('width:90px;text-align:right')}>Days Run</div>
        <div style={s('width:120px;padding-left:20px')}>Vertical</div>
        <div style={s('width:60px;text-align:center')}>Geo</div>
      </div>

      {list.map((a) => {
        const days = daysRunning(a, NOW);
        const vid = isVideo(a);
        return (
          <div key={a.ad_archive_id} onClick={() => openDetail(a.ad_archive_id)}
            style={s('display:flex;align-items:center;min-height:52px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.045);cursor:pointer;min-width:760px')}>
            <div style={s('flex:1;padding-right:16px')}>
              <span style={s('font-size:12.5px;color:#C6C9CE;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{a.title || a.caption || a.body_text || ''}</span>
            </div>
            <div style={s('width:80px;text-align:center')}>
              <span style={s(`font-family:${MONO};font-size:9.5px;color:${vid ? '#C6C9CE' : '#8A8E94'};border:1px solid rgba(255,255,255,.14);padding:2px 6px`)}>{a.display_format || '-'}</span>
            </div>
            <div style={s(`width:90px;text-align:right;font-family:${MONO};font-size:14px;color:${days > 45 ? '#E7E8EA' : '#B6B9BE'};font-variant-numeric:tabular-nums`)}>{days}<span style={s('font-size:9px;color:#5A5E64')}>d</span></div>
            <div style={s('width:120px;padding-left:20px;font-size:11px;color:#9CA0A6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{a.vertical || '-'}</div>
            <div style={s(`width:60px;text-align:center;font-family:${MONO};font-size:11px;color:#B6B9BE`)}>{a.country || '-'}</div>
          </div>
        );
      })}
      {list.length === 0 && (
        <div style={s('padding:40px 24px;text-align:center;color:#5A5E64;font-size:12px')}>No ads match your search for this competitor.</div>
      )}
    </div>
  );
}
