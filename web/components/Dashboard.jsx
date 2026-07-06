'use client';

import { useEffect, useMemo, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, hoursSince, daysRunning, isVideo, thumbOf, titleCase, tint, paras, relTime, pad } from '@/lib/ui';
import Thumb from '@/components/Thumb';
import CompetitorView from '@/components/CompetitorView';
import PipelineView from '@/components/PipelineView';
import ControlRoom from '@/components/ControlRoom';
import { updateAdWorkflow } from '@/app/actions';

export default function Dashboard({ ads: adsProp, domains = [], runs = [], lastRunIso, nowIso }) {
  const NOW = useMemo(() => new Date(nowIso).getTime(), [nowIso]);
  const [ads, setAds] = useState(adsProp);
  const [view, setView] = useState('fresh');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('fresh');
  const [sortDir, setSortDir] = useState('desc');
  const [filters, setFilters] = useState({ domain: [], vertical: [], country: [], format: [], status: [] });
  const [dateRange, setDateRange] = useState('all');
  const [selIndex, setSelIndex] = useState(0);
  const [detailId, setDetailId] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');

  const updateLocal = (id, patch) =>
    setAds((prev) => prev.map((a) => (a.ad_archive_id === id ? { ...a, ...patch } : a)));
  const commit = (id, patch) => updateAdWorkflow(id, patch).catch((e) => console.error('save failed', e));
  const update = (id, patch) => { updateLocal(id, patch); commit(id, patch); };

  // Precomputed lowercase haystack per ad -> fast multi-field smart search.
  const searchIndex = useMemo(() => {
    const m = new Map();
    for (const a of ads) {
      m.set(a.ad_archive_id, [
        a.title, a.page_name, a.domain, a.vertical, a.country, a.language,
        a.body_text, a.caption, a.cta_text, a.cta_type, a.link_url,
        a.link_description, a.article_title, a.article_content, a.notes,
        ...(a.tags || []),
      ].filter(Boolean).join(' ').toLowerCase());
    }
    return m;
  }, [ads]);

  // ── filtering + sorting ────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = ads.filter((a) => {
      const f = filters;
      if (f.domain.length && !f.domain.includes(a.domain)) return false;
      if (f.vertical.length && !f.vertical.includes(a.vertical)) return false;
      if (f.country.length && !f.country.includes(a.country)) return false;
      if (f.format.length && !f.format.includes(a.display_format)) return false;
      if (f.status.length && !f.status.includes(a.status)) return false;
      const h = hoursSince(a.first_seen_at, NOW);
      if (dateRange === '24h' && h > 24) return false;
      if (dateRange === '7d' && h > 168) return false;
      if (dateRange === '30d' && h > 720) return false;
      if (tokens.length) {
        const hay = searchIndex.get(a.ad_archive_id) || '';
        if (!tokens.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
    const dir = sortDir === 'desc' ? 1 : -1;
    list = [...list].sort((a, b) => {
      if (sort === 'days') return (daysRunning(b, NOW) - daysRunning(a, NOW)) * dir;
      if (sort === 'page') return (a.page_name || '').localeCompare(b.page_name || '') * -dir;
      return (new Date(b.first_seen_at) - new Date(a.first_seen_at)) * dir;
    });
    return list;
  }, [ads, query, filters, dateRange, sort, sortDir, NOW, searchIndex]);

  const openDetail = (id) => { setDetailId(id); setView('detail'); };
  const stepDetail = (delta) => {
    const idx = filtered.findIndex((a) => a.ad_archive_id === detailId);
    const next = filtered[Math.min(filtered.length - 1, Math.max(0, idx + delta))];
    if (next) setDetailId(next.ad_archive_id);
  };
  const toggleFilter = (group, val) =>
    setFilters((s2) => {
      const arr = s2[group];
      return { ...s2, [group]: arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val] };
    });

  // ── keyboard ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true); setPaletteQuery('');
        setTimeout(() => document.getElementById('ai-palette')?.focus(), 30);
        return;
      }
      if (e.key === 'Escape') {
        if (paletteOpen) return setPaletteOpen(false);
        if (view === 'detail') return setView('fresh');
      }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); document.getElementById('ai-search')?.focus(); return; }
      if (view === 'fresh') {
        if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setSelIndex((i) => Math.min(filtered.length - 1, i + 1)); }
        else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setSelIndex((i) => Math.max(0, i - 1)); }
        else if (e.key === 'Enter') { const a = filtered[selIndex]; if (a) openDetail(a.ad_archive_id); }
      } else if (view === 'detail') {
        if (e.key === 'j') stepDetail(1);
        else if (e.key === 'k') stepDetail(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const lastScrape = lastRunIso ? relTime(NOW - new Date(lastRunIso).getTime()) : 'never';

  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div style={s('min-height:100vh')}>
      <TopChrome
        view={view} setView={setView} query={query} setQuery={setQuery}
        lastScrape={lastScrape}
        openPalette={() => { setPaletteOpen(true); setPaletteQuery(''); setTimeout(() => document.getElementById('ai-palette')?.focus(), 30); }}
      />

      {view === 'fresh' && (
        <FreshFinds
          ads={ads} filtered={filtered} NOW={NOW}
          filters={filters} toggleFilter={toggleFilter}
          clearFilters={() => { setFilters({ domain: [], vertical: [], country: [], format: [], status: [] }); setDateRange('all'); setSelIndex(0); }}
          dateRange={dateRange} setDateRange={(d) => { setDateRange(d); setSelIndex(0); }}
          sort={sort} sortDir={sortDir}
          setSort={(id) => setSortDir((prev) => (sort === id && prev === 'desc' ? 'asc' : 'desc')) || setSort(id)}
          selIndex={selIndex} setSelIndex={setSelIndex} openDetail={openDetail}
        />
      )}

      {view === 'detail' && (
        <Detail
          ad={ads.find((a) => a.ad_archive_id === detailId) || filtered[0]}
          NOW={NOW}
          back={() => setView('fresh')}
          prev={() => stepDetail(-1)} next={() => stepDetail(1)}
          update={update} updateLocal={updateLocal} commit={commit}
        />
      )}

      {view === 'competitor' && <CompetitorView ads={ads} NOW={NOW} openDetail={openDetail} />}
      {view === 'pipeline' && <PipelineView ads={ads} update={update} openDetail={openDetail} />}
      {view === 'settings' && <ControlRoom ads={ads} domains={domains} runs={runs} NOW={NOW} />}

      {paletteOpen && (
        <Palette
          ads={ads} paletteQuery={paletteQuery} setPaletteQuery={setPaletteQuery}
          close={() => setPaletteOpen(false)}
          go={(v) => { setView(v); setPaletteOpen(false); }}
          openDetail={(id) => { openDetail(id); setPaletteOpen(false); }}
        />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// TOP CHROME
// ═════════════════════════════════════════════════════════════════════════════
function TopChrome({ view, setView, query, setQuery, lastScrape, openPalette }) {
  const tabs = [
    { id: 'fresh', label: 'Fresh Finds' },
    { id: 'competitor', label: 'Competitor' },
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'settings', label: 'Control Room' },
  ];
  return (
    <div style={s('position:sticky;top:0;z-index:40;display:flex;align-items:center;height:44px;padding:0 14px;gap:16px;background:#0B0C0E;border-bottom:1px solid rgba(255,255,255,.09)')}>
      <div style={s('display:flex;align-items:center;gap:9px;padding-right:16px;border-right:1px solid rgba(255,255,255,.08);height:100%')}>
        <div style={s('width:15px;height:15px;border:1.5px solid #E8A33D;transform:rotate(45deg)')} />
        <span style={s(`font-family:${MONO};font-size:12px;font-weight:600;letter-spacing:1.5px;color:#E7E8EA`)}>ADINTEL</span>
        <span style={s(`font-family:${MONO};font-size:10px;color:#4A4E54;letter-spacing:.5px`)}>v1</span>
      </div>
      <div style={s('display:flex;align-items:stretch;height:100%;gap:2px')}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setView(t.id)}
            style={s(`background:transparent;border:none;border-bottom:2px solid ${view === t.id ? A : 'transparent'};color:${view === t.id ? '#E7E8EA' : '#8A8E94'};font-size:11.5px;letter-spacing:.4px;padding:0 13px;height:100%;cursor:pointer;text-transform:uppercase`)}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={s('flex:1')} />
      <div style={s('display:flex;align-items:center;gap:8px;height:26px;padding:0 10px;min-width:280px;background:#101216;border:1px solid rgba(255,255,255,.08)')}>
        <span style={s('color:#5A5E64;font-size:12px')}>&#8250;</span>
        <input id="ai-search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search anything: page, domain, copy, country, vertical..."
          style={s('flex:1;background:transparent;border:none;outline:none;color:#E7E8EA;font-size:12px')} />
        <kbd style={s(`font-family:${MONO};font-size:10px;color:#5A5E64;border:1px solid rgba(255,255,255,.1);padding:1px 4px`)}>/</kbd>
      </div>
      <button onClick={openPalette}
        style={s(`display:flex;align-items:center;gap:6px;height:26px;padding:0 9px;background:#101216;border:1px solid rgba(255,255,255,.08);color:#8A8E94;font-family:${MONO};font-size:10.5px;cursor:pointer`)}>
        &#8984;K
      </button>
      <div style={s('display:flex;align-items:center;gap:7px;padding-left:14px;border-left:1px solid rgba(255,255,255,.08);height:100%')}>
        <span style={s('width:6px;height:6px;border-radius:50%;background:#E8A33D;box-shadow:0 0 6px rgba(232,163,61,.6)')} />
        <span style={s(`font-family:${MONO};font-size:10.5px;color:#8A8E94`)}>LIVE</span>
        <span style={s(`font-family:${MONO};font-size:10.5px;color:#5A5E64`)}>{lastScrape}</span>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// FRESH FINDS
// ═════════════════════════════════════════════════════════════════════════════
function FreshFinds({ ads, filtered, NOW, filters, toggleFilter, clearFilters, dateRange, setDateRange, sort, sortDir, setSort, selIndex, setSelIndex, openDetail }) {
  const uniq = (key) => [...new Set(ads.map((a) => a[key]).filter(Boolean))];
  const countBy = (key, val) => ads.filter((a) => a[key] === val).length;

  const fresh24 = ads.filter((a) => hoursSince(a.first_seen_at, NOW) <= 24).length;
  const new7 = ads.filter((a) => hoursSince(a.first_seen_at, NOW) <= 168).length;
  const metrics = [
    { label: 'Fresh 24h', value: pad(fresh24), color: A },
    { label: 'New 7d', value: pad(new7), color: '#E7E8EA' },
    { label: 'Total Tracked', value: pad(ads.length, 3), color: '#E7E8EA' },
    { label: 'Competitors', value: pad(uniq('domain').length), color: '#E7E8EA' },
    { label: 'Verticals', value: pad(uniq('vertical').length), color: '#E7E8EA' },
  ];
  const vcount = {};
  ads.forEach((a) => { if (a.vertical) vcount[a.vertical] = (vcount[a.vertical] || 0) + 1; });
  const vertMix = Object.entries(vcount).sort((x, y) => y[1] - x[1]).slice(0, 4)
    .map(([label, n]) => ({ label, pct: `${Math.round((n / (ads.length || 1)) * 100)}%` }));

  const groups = [
    { title: 'Domain', group: 'domain', key: 'domain', vals: uniq('domain') },
    { title: 'Vertical', group: 'vertical', key: 'vertical', vals: uniq('vertical') },
    { title: 'Country', group: 'country', key: 'country', vals: uniq('country') },
    { title: 'Format', group: 'format', key: 'display_format', vals: uniq('display_format') },
    { title: 'Status', group: 'status', key: 'status', vals: uniq('status') },
  ];
  const activeFilterCount = Object.values(filters).reduce((n, a) => n + a.length, 0) + (dateRange !== 'all' ? 1 : 0);
  const maxDays = Math.max(1, ...ads.map((a) => daysRunning(a, NOW)));

  const sortDefs = [{ id: 'fresh', label: 'freshness' }, { id: 'days', label: 'days running' }, { id: 'page', label: 'page' }];

  return (
    <div>
      {/* ticker strip */}
      <div style={s('display:flex;align-items:stretch;height:74px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.09)')}>
        {metrics.map((m) => (
          <div key={m.label} style={s('display:flex;flex-direction:column;justify-content:center;padding:0 26px;border-right:1px solid rgba(255,255,255,.06);min-width:150px')}>
            <span style={s(`font-family:${MONO};font-size:27px;font-weight:500;letter-spacing:-.5px;color:${m.color};font-variant-numeric:tabular-nums`)}>{m.value}</span>
            <span style={s('font-size:10px;letter-spacing:1px;color:#6C7076;text-transform:uppercase;margin-top:2px')}>{m.label}</span>
          </div>
        ))}
        <div style={s('flex:1;display:flex;align-items:center;justify-content:flex-end;padding:0 24px;gap:20px')}>
          {vertMix.map((v) => (
            <div key={v.label} style={s('display:flex;flex-direction:column;gap:5px;min-width:96px')}>
              <div style={s('display:flex;justify-content:space-between;align-items:baseline')}>
                <span style={s('font-size:10px;color:#8A8E94;letter-spacing:.3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80px')}>{v.label}</span>
                <span style={s(`font-family:${MONO};font-size:10px;color:#6C7076`)}>{v.pct}</span>
              </div>
              <div style={s('height:3px;background:rgba(255,255,255,.06)')}><div style={s(`height:100%;width:${v.pct};background:#5A5E64`)} /></div>
            </div>
          ))}
        </div>
      </div>

      <div style={s('display:flex;align-items:stretch;min-height:calc(100vh - 118px)')}>
        {/* filter rail */}
        <div style={s('width:236px;flex-shrink:0;background:#0D0E11;border-right:1px solid rgba(255,255,255,.09)')}>
          <div style={s('display:flex;align-items:center;justify-content:space-between;height:34px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.06)')}>
            <span style={s(`font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:#6C7076`)}>FILTERS</span>
            <button onClick={clearFilters} style={s(`background:none;border:none;color:${activeFilterCount ? A : '#5A5E64'};font-family:${MONO};font-size:9.5px;letter-spacing:.5px;cursor:pointer`)}>CLEAR ({activeFilterCount})</button>
          </div>
          {groups.map((g) => (
            <div key={g.title} style={s('border-bottom:1px solid rgba(255,255,255,.06);padding:11px 0 12px')}>
              <div style={s('padding:0 14px 8px;font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>{g.title}</div>
              {g.vals.map((v) => {
                const sel = filters[g.group].includes(v);
                return (
                  <button key={v} onClick={() => toggleFilter(g.group, v)}
                    style={s(`display:flex;align-items:center;gap:9px;width:100%;padding:4px 14px;background:${sel ? 'rgba(232,163,61,.06)' : 'transparent'};border:none;cursor:pointer;text-align:left`)}>
                    <span style={s(`width:11px;height:11px;flex-shrink:0;border:1px solid ${sel ? A : 'rgba(255,255,255,.2)'};background:${sel ? A : 'transparent'};display:flex;align-items:center;justify-content:center;font-size:8px;color:#0B0C0E;line-height:1`)}>{sel ? '✓' : ''}</span>
                    <span style={s(`flex:1;font-size:11.5px;color:${sel ? '#E7E8EA' : '#9CA0A6'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{titleCase(v)}</span>
                    <span style={s(`font-family:${MONO};font-size:10px;color:#5A5E64;font-variant-numeric:tabular-nums`)}>{pad(countBy(g.key, v))}</span>
                  </button>
                );
              })}
            </div>
          ))}
          <div style={s('padding:11px 14px')}>
            <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>DATE RANGE</div>
            <div style={s('display:flex;gap:1px;background:rgba(255,255,255,.06)')}>
              {['24h', '7d', '30d', 'all'].map((d) => (
                <button key={d} onClick={() => setDateRange(d)}
                  style={s(`flex:1;padding:5px 0;background:${dateRange === d ? '#1A1C20' : '#0D0E11'};border:none;color:${dateRange === d ? A : '#8A8E94'};font-family:${MONO};font-size:10px;cursor:pointer`)}>{d.toUpperCase()}</button>
              ))}
            </div>
          </div>
        </div>

        {/* feed */}
        <div style={s('flex:1;min-width:0;background:#0B0C0E;overflow-x:auto')}>
          <div style={s('display:flex;align-items:center;justify-content:space-between;height:34px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.06)')}>
            <div style={s('display:flex;align-items:center;gap:12px')}>
              <span style={s(`font-family:${MONO};font-size:11px;color:#8A8E94;font-variant-numeric:tabular-nums`)}>{pad(filtered.length)} <span style={s('color:#5A5E64')}>ads</span></span>
              <span style={s('color:#2E3136')}>|</span>
              <span style={s('font-size:10.5px;color:#5A5E64')}>sorted by</span>
              {sortDefs.map((sd) => (
                <button key={sd.id} onClick={() => setSort(sd.id)}
                  style={s(`background:none;border:none;color:${sort === sd.id ? '#E7E8EA' : '#6C7076'};font-size:10.5px;letter-spacing:.3px;cursor:pointer`)}>
                  {sd.label}{sort === sd.id ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
                </button>
              ))}
            </div>
            <div style={s(`display:flex;align-items:center;gap:5px;font-family:${MONO};font-size:10px;color:#5A5E64`)}>
              <kbd style={s('border:1px solid rgba(255,255,255,.1);padding:1px 4px')}>J</kbd>
              <kbd style={s('border:1px solid rgba(255,255,255,.1);padding:1px 4px')}>K</kbd>
              <span style={s('color:#45484D')}>move</span>
              <kbd style={s('border:1px solid rgba(255,255,255,.1);padding:1px 4px;margin-left:6px')}>&#8629;</kbd>
              <span style={s('color:#45484D')}>open</span>
            </div>
          </div>

          <div style={s('display:flex;align-items:center;height:26px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase;min-width:1040px')}>
            <div style={s('width:56px;flex-shrink:0')} />
            <div style={s('width:148px;flex-shrink:0')}>Page</div>
            <div style={s('width:132px;flex-shrink:0')}>Domain</div>
            <div style={s('flex:1;min-width:0')}>Headline</div>
            <div style={s('width:62px;flex-shrink:0;text-align:center')}>Format</div>
            <div style={s('width:46px;flex-shrink:0;text-align:right')}>Rank</div>
            <div style={s('width:70px;flex-shrink:0;text-align:right')}>Days Run</div>
            <div style={s('width:92px;flex-shrink:0;padding-left:16px')}>Vertical</div>
            <div style={s('width:58px;flex-shrink:0;text-align:center')}>Country</div>
            <div style={s('width:58px;flex-shrink:0;text-align:center')}>Platform</div>
          </div>

          {filtered.map((a, i) => {
            const days = daysRunning(a, NOW);
            const fresh = hoursSince(a.first_seen_at, NOW) <= 24;
            const sel = i === selIndex;
            const vid = isVideo(a);
            return (
              <div key={a.ad_archive_id} onClick={() => openDetail(a.ad_archive_id)} onMouseEnter={() => setSelIndex(i)}
                style={s(`position:relative;display:flex;align-items:center;min-height:56px;min-width:1040px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.045);background:${sel ? 'rgba(232,163,61,.05)' : 'transparent'};cursor:pointer`)}>
                <div style={s(`position:absolute;left:0;top:0;bottom:0;width:2px;background:${sel ? A : (fresh ? 'rgba(232,163,61,.5)' : 'transparent')}`)} />
                <div style={s('width:56px;flex-shrink:0;padding-right:12px')}><Thumb ad={a} size={44} /></div>
                <div style={s('width:148px;flex-shrink:0;padding-right:12px;min-width:0;display:flex;align-items:center;gap:6px')}>
                  {fresh && <span style={s('width:6px;height:6px;border-radius:50%;background:#E8A33D;flex-shrink:0;animation:freshpulse 2.4s ease-in-out infinite')} />}
                  <span style={s('font-size:12.5px;color:#E7E8EA;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{a.page_name || '(unknown)'}</span>
                </div>
                <div style={s('width:132px;flex-shrink:0;padding-right:12px;min-width:0')}>
                  <span style={s(`font-family:${MONO};font-size:11px;color:#8A8E94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{a.domain || '-'}</span>
                </div>
                <div style={s('flex:1;min-width:0;padding-right:16px')}>
                  <div style={s('font-size:12.5px;color:#C6C9CE;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical')}>{a.title || a.caption || a.body_text || ''}</div>
                </div>
                <div style={s('width:62px;flex-shrink:0;display:flex;justify-content:center')}>
                  <span style={s(`font-family:${MONO};font-size:9.5px;letter-spacing:.5px;color:${vid ? '#C6C9CE' : '#8A8E94'};border:1px solid rgba(255,255,255,.14);padding:2px 6px`)}>{a.display_format || '-'}</span>
                </div>
                <div style={s('width:46px;flex-shrink:0;text-align:right')}>
                  <span style={s(`font-family:${MONO};font-size:12.5px;color:${a.rank != null && a.rank <= 3 ? A : '#B6B9BE'};font-variant-numeric:tabular-nums`)}>{a.rank != null ? a.rank : '-'}</span>
                </div>
                <div style={s('width:70px;flex-shrink:0;text-align:right')}>
                  <span style={s(`font-family:${MONO};font-size:14px;color:${days > 45 ? '#E7E8EA' : '#B6B9BE'};font-variant-numeric:tabular-nums`)}>{days}</span>
                  <span style={s('font-size:9px;color:#5A5E64;margin-left:2px')}>d</span>
                  <div style={s('height:2px;margin-top:4px;background:rgba(255,255,255,.06)')}><div style={s(`height:100%;width:${Math.round((days / maxDays) * 100)}%;background:${days > 45 ? '#8A8E94' : 'rgba(255,255,255,.22)'}`)} /></div>
                </div>
                <div style={s('width:92px;flex-shrink:0;padding-left:16px')}>
                  <span style={s('font-size:10.5px;color:#9CA0A6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{a.vertical || '-'}</span>
                </div>
                <div style={s('width:58px;flex-shrink:0;text-align:center')}>
                  <div style={s(`font-family:${MONO};font-size:11px;color:#B6B9BE`)}>{a.country || '-'}</div>
                  <div style={s(`font-family:${MONO};font-size:9px;color:#5A5E64`)}>{(a.language || '').slice(0, 2).toUpperCase()}</div>
                </div>
                <div style={s('width:58px;flex-shrink:0;display:flex;justify-content:center;gap:4px')}>
                  {(a.publisher_platform || []).slice(0, 3).map((p, idx) => (
                    <span key={idx} style={s(`width:16px;height:16px;border:1px solid rgba(255,255,255,.14);display:flex;align-items:center;justify-content:center;font-family:${MONO};font-size:9px;color:#8A8E94`)}>{(p || '?')[0].toUpperCase()}</span>
                  ))}
                </div>
              </div>
            );
          })}

          <div style={s('padding:20px 16px;text-align:center')}>
            <span style={s(`font-family:${MONO};font-size:10.5px;color:#45484D;letter-spacing:.5px`)}>END OF FEED &middot; {pad(filtered.length)} RECORDS</span>
          </div>
          {filtered.length === 0 && (
            <div style={s('padding:60px 16px;text-align:center;color:#5A5E64;font-size:13px')}>No ads match. Run a scrape or clear filters.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CREATIVE DETAIL
// ═════════════════════════════════════════════════════════════════════════════
function Detail({ ad, NOW, back, prev, next, update, updateLocal, commit }) {
  if (!ad) return <Placeholder view="detail" />;
  const vid = isVideo(ad);
  const days = daysRunning(ad, NOW);
  const src = thumbOf(ad);
  const fresh = hoursSince(ad.first_seen_at, NOW) <= 24;
  const statuses = ['idea', 'drafting', 'published'];
  const owners = ['Mara K.', 'Devin R.', 'Priya S.', 'Ari L.'];

  const meta = [
    ['ad_archive_id', ad.ad_archive_id, A],
    ['page_id', ad.page_id, '#C6C9CE'],
    ['page_name', ad.page_name, '#C6C9CE'],
    ['start_date', (ad.start_date || '').slice(0, 10), '#C6C9CE'],
    ['days_running', `${days}d`, '#E7E8EA'],
    ['total_active_time', ad.total_active_time, '#C6C9CE'],
    ['publisher_platform', (ad.publisher_platform || []).join(', '), '#C6C9CE'],
    ['language', ad.language, '#C6C9CE'],
    ['country', ad.country, '#C6C9CE'],
    ['vertical', ad.vertical, '#C6C9CE'],
    ['rank', ad.rank != null ? `#${ad.rank}` : '', '#C6C9CE'],
    ['domain', ad.domain, '#C6C9CE'],
  ];

  return (
    <div style={s('display:flex;min-height:calc(100vh - 44px)')}>
      {/* media column */}
      <div style={s('width:46%;flex-shrink:0;background:#0D0E11;border-right:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column')}>
        <div style={s('display:flex;align-items:center;gap:14px;height:40px;padding:0 18px;border-bottom:1px solid rgba(255,255,255,.06)')}>
          <button onClick={back} style={s(`display:flex;align-items:center;gap:6px;background:none;border:none;color:#8A8E94;font-size:11.5px;cursor:pointer`)}>&#8592; <span style={s(`font-family:${MONO};font-size:10.5px;letter-spacing:.5px`)}>FEED</span></button>
          <div style={s('flex:1')} />
          <button onClick={prev} style={s(`background:#101216;border:1px solid rgba(255,255,255,.08);color:#8A8E94;padding:2px 9px;font-family:${MONO};font-size:11px;cursor:pointer`)}>K &#8593;</button>
          <button onClick={next} style={s(`background:#101216;border:1px solid rgba(255,255,255,.08);color:#8A8E94;padding:2px 9px;font-family:${MONO};font-size:11px;cursor:pointer`)}>J &#8595;</button>
        </div>
        <div style={s('padding:20px;flex:1')}>
          <div style={s(`position:relative;width:100%;aspect-ratio:1/1;background:${tint(ad.ad_archive_id)};border:1px solid rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;overflow:hidden`)}>
            <div style={s('position:absolute;inset:0;background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.035) 0px,rgba(255,255,255,.035) 1px,transparent 1px,transparent 9px)')} />
            {vid && ad.video_hd_url ? (
              <video src={ad.video_hd_url} controls poster={ad.video_preview_url || undefined} style={s('position:relative;width:100%;height:100%;object-fit:contain;background:#000')} />
            ) : src ? (
              <img src={src} alt="" style={s('position:relative;width:100%;height:100%;object-fit:contain')} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
            ) : (
              <span style={s('color:#5A5E64;font-size:12px')}>no media</span>
            )}
            <div style={s(`position:absolute;top:10px;right:12px;font-family:${MONO};font-size:9.5px;color:#8A8E94;border:1px solid rgba(255,255,255,.14);padding:2px 6px;background:rgba(0,0,0,.4)`)}>{ad.display_format || '-'}</div>
          </div>
          {(ad.extra_image_urls?.length > 0 || ad.extra_video_urls?.length > 0) && (
            <div style={s('display:flex;gap:8px;margin-top:12px;flex-wrap:wrap')}>
              {[...(ad.extra_image_urls || []), ...(ad.extra_video_urls || [])].slice(0, 8).map((u, i) => (
                <a key={i} href={u} target="_blank" rel="noreferrer" style={s('width:56px;height:56px;border:1px solid rgba(255,255,255,.08);overflow:hidden;background:#101216;display:block')}>
                  <img src={u} alt="" style={s('width:100%;height:100%;object-fit:cover')} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* copy + workflow */}
      <div style={s('flex:1;min-width:0;display:flex')}>
        <div style={s('flex:1;min-width:0;padding:24px 30px;max-width:720px')}>
          <div style={s('display:flex;align-items:center;gap:10px;margin-bottom:4px')}>
            {fresh && <span style={s(`font-family:${MONO};font-size:9.5px;letter-spacing:1px;color:#0B0C0E;background:#E8A33D;padding:2px 6px`)}>FRESH</span>}
            <span style={s('font-size:11px;color:#8A8E94')}>{ad.page_name}</span>
            <span style={s('color:#2E3136')}>&middot;</span>
            <span style={s(`font-family:${MONO};font-size:11px;color:#6C7076`)}>{ad.domain}</span>
          </div>
          <h1 style={s('font-size:23px;font-weight:600;line-height:1.28;color:#F0F1F3;letter-spacing:-.3px;margin:8px 0 18px')}>{ad.title || ad.caption || '(no headline)'}</h1>

          <Field label="Body Text" big>{ad.body_text}</Field>
          <div style={s('display:flex;gap:24px;margin-top:16px')}>
            <div style={s('flex:1')}><Field label="Caption">{ad.caption}</Field></div>
            <div style={s('flex:1')}><Field label="Link Description">{ad.link_description}</Field></div>
          </div>

          <div style={s('display:flex;align-items:center;gap:16px;padding:12px 14px;margin-top:16px;background:#0D0E11;border:1px solid rgba(255,255,255,.08)')}>
            <span style={s('background:#E7E8EA;color:#0B0C0E;font-size:12px;font-weight:600;padding:8px 16px')}>{ad.cta_text || 'Learn More'}</span>
            <div style={s('display:flex;flex-direction:column;gap:2px;min-width:0')}>
              <span style={s(`font-family:${MONO};font-size:9.5px;color:#6C7076;letter-spacing:.5px`)}>CTA_TYPE &middot; {ad.cta_type || '-'}</span>
              {ad.link_url && <a href={ad.link_url.split(' | ')[0]} target="_blank" rel="noreferrer" style={s(`font-family:${MONO};font-size:11px;color:#E8A33D;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px`)}>{ad.link_url} &#8599;</a>}
            </div>
          </div>

          {(ad.article_title || ad.article_content) && (
            <div style={s('margin-top:28px;padding-top:22px;border-top:1px solid rgba(255,255,255,.09)')}>
              <div style={s('display:flex;align-items:center;gap:8px;margin-bottom:14px')}>
                <span style={s(`font-family:${MONO};font-size:9.5px;letter-spacing:1.2px;color:#5A5E64`)}>SCRAPED LANDING ARTICLE</span>
                <div style={s('flex:1;height:1px;background:rgba(255,255,255,.06)')} />
              </div>
              {ad.article_title && <h2 style={s('font-size:18px;font-weight:600;color:#E7E8EA;line-height:1.35;margin:0 0 14px')}>{ad.article_title}</h2>}
              <div style={s('font-size:13px;line-height:1.72;color:#A8ABB1;max-width:62ch')}>
                {paras(ad.article_content).slice(0, 12).map((p, i) => <p key={i} style={s('margin:0 0 13px')}>{p}</p>)}
              </div>
            </div>
          )}

          <div style={s('margin-top:28px;padding-top:22px;border-top:1px solid rgba(255,255,255,.09)')}>
            <div style={s(`font-family:${MONO};font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;margin-bottom:14px`)}>RECORD METADATA</div>
            <div style={s('display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.06)')}>
              {meta.map(([k, v, c]) => (
                <div key={k} style={s('background:#0B0C0E;padding:9px 12px')}>
                  <div style={s('font-size:9px;letter-spacing:.8px;color:#5A5E64;text-transform:uppercase;margin-bottom:3px')}>{k}</div>
                  <div style={s(`font-family:${MONO};font-size:11.5px;color:${c};font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{v || '-'}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* workflow panel (local state for now; persistence next) */}
        <div style={s('width:300px;flex-shrink:0;background:#0D0E11;border-left:1px solid rgba(255,255,255,.09);position:sticky;top:44px;align-self:flex-start;max-height:calc(100vh - 44px);overflow-y:auto')}>
          <div style={s('display:flex;align-items:center;justify-content:space-between;height:40px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.06)')}>
            <span style={s(`font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:#8A8E94`)}>WORKFLOW</span>
            <button onClick={() => update(ad.ad_archive_id, { is_saved: !ad.is_saved })}
              style={s(`display:flex;align-items:center;gap:5px;background:none;border:1px solid ${ad.is_saved ? A : 'rgba(255,255,255,.14)'};color:${ad.is_saved ? A : '#8A8E94'};padding:3px 8px;font-family:${MONO};font-size:10px;cursor:pointer`)}>{ad.is_saved ? '★ SAVED' : '☆ STAR'}</button>
          </div>
          <div style={s('padding:16px;display:flex;flex-direction:column;gap:18px')}>
            <div>
              <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>Pipeline Status</div>
              <div style={s('display:flex;flex-direction:column;gap:1px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.06)')}>
                {statuses.map((st) => {
                  const active = ad.status === st;
                  return (
                    <button key={st} onClick={() => update(ad.ad_archive_id, { status: st })}
                      style={s(`display:flex;align-items:center;gap:10px;padding:9px 12px;background:${active ? 'rgba(232,163,61,.06)' : '#0B0C0E'};border:none;cursor:pointer;text-align:left`)}>
                      <span style={s(`width:9px;height:9px;border-radius:50%;border:1.5px solid ${active ? A : 'rgba(255,255,255,.25)'};background:${active ? A : 'transparent'};flex-shrink:0`)} />
                      <span style={s(`flex:1;font-size:12px;color:${active ? '#E7E8EA' : '#9CA0A6'}`)}>{titleCase(st)}</span>
                      {active && <span style={s(`font-family:${MONO};font-size:9px;color:#E8A33D`)}>CURRENT</span>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>Owner</div>
              <div style={s('display:flex;gap:6px;flex-wrap:wrap')}>
                {owners.map((o) => {
                  const on = ad.owner === o;
                  const initials = o.split(' ').map((x) => x[0]).join('');
                  return (
                    <button key={o} onClick={() => update(ad.ad_archive_id, { owner: on ? null : o })}
                      style={s(`display:flex;align-items:center;gap:6px;padding:4px;background:${on ? 'rgba(232,163,61,.08)' : '#101216'};border:1px solid ${on ? A : 'rgba(255,255,255,.08)'};cursor:pointer`)}>
                      <span style={s(`width:20px;height:20px;border-radius:50%;background:${on ? A : 'rgba(255,255,255,.1)'};color:${on ? '#0B0C0E' : '#C6C9CE'};display:flex;align-items:center;justify-content:center;font-family:${MONO};font-size:9px;font-weight:600`)}>{initials}</span>
                      <span style={s(`font-size:11px;color:${on ? '#E7E8EA' : '#9CA0A6'};padding-right:6px`)}>{o}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>Linked Article URL</div>
              <input value={ad.linked_article_url || ''}
                onChange={(e) => updateLocal(ad.ad_archive_id, { linked_article_url: e.target.value })}
                onBlur={(e) => commit(ad.ad_archive_id, { linked_article_url: e.target.value })}
                placeholder="https://ourblog.com/..."
                style={s(`width:100%;background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#E8A33D;font-family:${MONO};font-size:11px;padding:7px 9px;outline:none`)} />
            </div>
            <div>
              <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>Notes</div>
              <textarea value={ad.notes || ''}
                onChange={(e) => updateLocal(ad.ad_archive_id, { notes: e.target.value })}
                onBlur={(e) => commit(ad.ad_archive_id, { notes: e.target.value })}
                placeholder="Angle worth copying..."
                style={s('width:100%;height:76px;resize:vertical;background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#C6C9CE;font-size:12px;line-height:1.5;padding:8px 9px;outline:none')} />
            </div>
            <div style={s('font-size:10px;color:#5A5E64;line-height:1.5')}>Changes save automatically to the database.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, big }) {
  return (
    <div>
      <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:6px')}>{label}</div>
      <p style={s(`font-size:${big ? '13.5px' : '12.5px'};line-height:${big ? '1.6' : '1.5'};color:${big ? '#C6C9CE' : '#9CA0A6'};margin:0`)}>{children || '-'}</p>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND PALETTE
// ═════════════════════════════════════════════════════════════════════════════
function Palette({ ads, paletteQuery, setPaletteQuery, close, go, openDetail }) {
  const q = paletteQuery.trim().toLowerCase();
  const actions = [
    { kind: 'VIEW', kc: '#6C7076', label: 'Go to Fresh Finds', run: () => go('fresh') },
    { kind: 'VIEW', kc: '#6C7076', label: 'Go to Competitor Feed', run: () => go('competitor') },
    { kind: 'VIEW', kc: '#6C7076', label: 'Go to Pipeline Board', run: () => go('pipeline') },
    { kind: 'VIEW', kc: '#6C7076', label: 'Go to Control Room', run: () => go('settings') },
  ];
  const adItems = ads.map((a) => ({ kind: 'AD', kc: '#5A5E64', label: a.title || a.page_name || a.ad_archive_id, hint: a.domain, run: () => openDetail(a.ad_archive_id) }));
  const all = [...actions, ...adItems];
  const items = (q ? all.filter((x) => (x.label || '').toLowerCase().includes(q) || (x.hint || '').toLowerCase().includes(q)) : all).slice(0, 8);
  return (
    <div onClick={close} style={s('position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.6);display:flex;align-items:flex-start;justify-content:center;padding-top:120px;animation:fadein .12s ease-out')}>
      <div onClick={(e) => e.stopPropagation()} style={s('width:560px;background:#101216;border:1px solid rgba(255,255,255,.14);box-shadow:0 24px 60px rgba(0,0,0,.6)')}>
        <div style={s('display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08)')}>
          <span style={s('color:#5A5E64')}>&#8250;</span>
          <input id="ai-palette" value={paletteQuery} onChange={(e) => setPaletteQuery(e.target.value)}
            placeholder="Jump to action, view, or ad..."
            style={s('flex:1;background:transparent;border:none;outline:none;color:#E7E8EA;font-size:14px')} />
          <kbd style={s(`font-family:${MONO};font-size:10px;color:#5A5E64;border:1px solid rgba(255,255,255,.1);padding:1px 5px`)}>ESC</kbd>
        </div>
        <div style={s('max-height:340px;overflow-y:auto;padding:6px')}>
          {items.map((pi, i) => (
            <button key={i} onClick={pi.run} style={s('display:flex;align-items:center;gap:12px;width:100%;padding:9px 11px;background:transparent;border:none;cursor:pointer;text-align:left')}>
              <span style={s(`font-family:${MONO};font-size:10px;color:${pi.kc};width:52px;flex-shrink:0`)}>{pi.kind}</span>
              <span style={s('flex:1;font-size:13px;color:#E7E8EA;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{pi.label}</span>
              {pi.hint && <span style={s(`font-family:${MONO};font-size:10px;color:#5A5E64`)}>{pi.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PLACEHOLDER (Competitor / Pipeline / Control Room - built next)
// ═════════════════════════════════════════════════════════════════════════════
function Placeholder({ view }) {
  const label = { competitor: 'Competitor Feed', pipeline: 'Pipeline Board', settings: 'Control Room', detail: 'Creative Detail' }[view] || view;
  return (
    <div style={s('display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 44px);flex-direction:column;gap:10px')}>
      <span style={s(`font-family:${MONO};font-size:13px;letter-spacing:2px;color:#6C7076`)}>{label.toUpperCase()}</span>
      <span style={s('font-size:12px;color:#45484D')}>Built in the next step.</span>
    </div>
  );
}
