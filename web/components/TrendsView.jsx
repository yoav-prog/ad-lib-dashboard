'use client';

import { useMemo } from 'react';
import { s } from '@/lib/style';
import { A, MONO, hoursSince, pad } from '@/lib/ui';

// Aggregates the current ads into "what competitors are pushing": verticals
// ranked by recent activity, with how many competitors are in each and who.
export default function TrendsView({ ads, NOW, matchesQuery = () => true, openDetail }) {
  const rows = useMemo(() => {
    const map = {};
    for (const a of ads) {
      if (!matchesQuery(a)) continue;
      const v = a.vertical || 'Uncategorized';
      const m = map[v] || (map[v] = { vertical: v, total: 0, fresh7: 0, competitors: new Set(), countries: new Set(), video: 0, sample: a });
      m.total += 1;
      if (hoursSince(a.first_seen_at, NOW) <= 168) m.fresh7 += 1;
      if (a.domain) m.competitors.add(a.domain);
      if (a.country) m.countries.add(a.country);
      if (a.display_format === 'VIDEO') m.video += 1;
    }
    return Object.values(map)
      .map((m) => ({ ...m, competitorList: [...m.competitors], competitors: m.competitors.size, countries: m.countries.size }))
      .sort((x, y) => (y.fresh7 - x.fresh7) || (y.total - x.total));
  }, [ads, NOW, matchesQuery]);

  const maxTotal = Math.max(1, ...rows.map((r) => r.total));

  return (
    <div>
      <div style={s('display:flex;align-items:center;gap:12px;height:44px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.06)')}>
        <span style={s(`font-family:${MONO};font-size:12px;letter-spacing:1px;color:#E7E8EA`)}>TRENDS</span>
        <span style={s(`font-family:${MONO};font-size:10.5px;color:#5A5E64`)}>what competitors are pushing &middot; sorted by fresh activity</span>
      </div>

      <div style={s('display:flex;align-items:center;height:26px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase;min-width:900px')}>
        <div style={s('width:230px;flex-shrink:0')}>Vertical</div>
        <div style={s('flex:1;min-width:0')}>Activity</div>
        <div style={s('width:70px;text-align:right')}>Total</div>
        <div style={s('width:70px;text-align:right')}>New 7d</div>
        <div style={s('width:80px;text-align:right;padding-right:16px')}>Rivals</div>
        <div style={s('width:300px;flex-shrink:0')}>Competitors</div>
      </div>

      {rows.map((r) => (
        <div key={r.vertical} style={s('display:flex;align-items:center;min-height:50px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.045);min-width:900px')}>
          <div style={s('width:230px;flex-shrink:0;padding-right:14px')}>
            <span style={s('font-size:12.5px;color:#E7E8EA;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{r.vertical}</span>
          </div>
          <div style={s('flex:1;min-width:0;padding-right:20px')}>
            <div style={s('height:6px;background:rgba(255,255,255,.05)')}>
              <div style={s(`height:100%;width:${Math.round((r.total / maxTotal) * 100)}%;background:${r.fresh7 > 0 ? A : 'rgba(255,255,255,.22)'}`)} />
            </div>
          </div>
          <div style={s(`width:70px;text-align:right;font-family:${MONO};font-size:14px;color:#E7E8EA;font-variant-numeric:tabular-nums`)}>{pad(r.total)}</div>
          <div style={s(`width:70px;text-align:right;font-family:${MONO};font-size:14px;color:${r.fresh7 > 0 ? A : '#5A5E64'};font-variant-numeric:tabular-nums`)}>{pad(r.fresh7)}</div>
          <div style={s(`width:80px;text-align:right;padding-right:16px;font-family:${MONO};font-size:13px;color:#B6B9BE;font-variant-numeric:tabular-nums`)}>{pad(r.competitors)}</div>
          <div style={s('width:300px;flex-shrink:0;display:flex;gap:5px;flex-wrap:wrap;overflow:hidden;max-height:40px')}>
            {r.competitorList.slice(0, 5).map((c) => (
              <span key={c} style={s(`font-family:${MONO};font-size:9.5px;color:#9CA0A6;background:#101216;border:1px solid rgba(255,255,255,.08);padding:2px 7px;white-space:nowrap`)}>{c}</span>
            ))}
            {r.competitorList.length > 5 && <span style={s(`font-family:${MONO};font-size:9.5px;color:#5A5E64;padding:2px 4px`)}>+{r.competitorList.length - 5}</span>}
          </div>
        </div>
      ))}

      {rows.length === 0 && (
        <div style={s('padding:60px 24px;text-align:center;color:#5A5E64;font-size:13px')}>No data yet. Run a scrape to see trends.</div>
      )}
    </div>
  );
}
