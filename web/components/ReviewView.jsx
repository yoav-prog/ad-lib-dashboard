'use client';

import { useMemo, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, firstUrl, hostOf, pad, relTime, filterReviewAds, reviewDestOf, reviewPageOf } from '@/lib/ui';
import Thumb from '@/components/Thumb';
import CopyCell from '@/components/CopyCell';

// The review queue: ads the scraper fetched for a tracked domain whose
// destination does NOT point at that domain (the Ad Library keyword search
// drags them in). A human decides: APPROVE moves the ad into the feed,
// REJECT hides it for good (the row is kept so dedup never re-imports it).
//
// Built for bulk triage: the facet rail narrows the queue (e.g. every ad that
// leads to alibaba.com), select-all grabs exactly the filtered rows, and one
// bulk button decides them together.
export default function ReviewView({ ads, NOW, canEdit, query, onDecide }) {
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState({ domain: [], dest: [], page: [] });
  const [gsearch, setGsearch] = useState({});
  const [sort, setSort] = useState('newest');

  // Same user-controlled thumbnail sizing as Fresh Finds: these creatives are
  // text-heavy, and reading them is often what decides approve vs reject. S is
  // the tidy default; M and L show the whole creative uncropped.
  const IMG_SIZES = [
    { key: 's', label: 'S', px: 44, fit: 'cover', hint: 'small' },
    { key: 'm', label: 'M', px: 120, fit: 'contain', hint: 'medium' },
    { key: 'l', label: 'L', px: 220, fit: 'contain', hint: 'large' },
  ];
  const [imgKey, setImgKey] = useState('s');
  const img = IMG_SIZES.find((z) => z.key === imgKey) || IMG_SIZES[0];
  const thumbColW = img.px + 12; // image box + the cell's right padding
  const tableMinW = 1230 + (img.px - 44);

  const facetGroups = useMemo(() => {
    const count = (of) => {
      const m = new Map();
      for (const a of ads) {
        const v = of(a);
        m.set(v, (m.get(v) || 0) + 1);
      }
      return [...m.entries()].sort((x, y) => y[1] - x[1]);
    };
    return [
      { title: 'Searched Domain', group: 'domain', vals: count((a) => a.domain || '-') },
      { title: 'Leads To', group: 'dest', vals: count(reviewDestOf) },
      { title: 'Page', group: 'page', vals: count(reviewPageOf) },
    ];
  }, [ads]);

  const filtered = useMemo(() => {
    const list = filterReviewAds(ads, query, filters);
    if (sort === 'page') return [...list].sort((a, b) => reviewPageOf(a).localeCompare(reviewPageOf(b)));
    if (sort === 'domain') return [...list].sort((a, b) => (a.domain || '').localeCompare(b.domain || ''));
    if (sort === 'dest') return [...list].sort((a, b) => reviewDestOf(a).localeCompare(reviewDestOf(b)));
    return list;   // 'newest' - the server orders by latest sighting, so just-reopened ads sit on top
  }, [ads, query, filters, sort]);

  const activeFilterCount = filters.domain.length + filters.dest.length + filters.page.length;
  const toggleFilter = (group, val) =>
    setFilters((prev) => {
      const arr = prev[group];
      return { ...prev, [group]: arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val] };
    });

  const ids = filtered.map((a) => a.ad_archive_id);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const toggle = (id) => setSelected((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const decide = async (decideIds, decision) => {
    if (!canEdit || busy || !decideIds.length) return;
    setBusy(true);
    console.info('[review decide]', { decision, count: decideIds.length });
    try { await onDecide(decideIds, decision); } finally { setBusy(false); }
    setSelected((prev) => {
      const n = new Set(prev);
      decideIds.forEach((id) => n.delete(id));
      return n;
    });
  };

  const selIds = ids.filter((id) => selected.has(id));
  const actBtn = (color, border) =>
    s(`background:#101216;border:1px solid ${border};color:${color};font-family:${MONO};font-size:10px;letter-spacing:.4px;padding:4px 10px;cursor:${busy ? 'wait' : 'pointer'}`);

  const sortDefs = [
    { id: 'newest', label: 'newest' },
    { id: 'page', label: 'page' },
    { id: 'domain', label: 'domain' },
    { id: 'dest', label: 'leads to' },
  ];

  return (
    <div style={s('display:flex;align-items:stretch;min-height:calc(100vh - 44px)')}>
      {/* facet rail - narrow the queue, then decide the whole slice at once */}
      <div style={s('width:236px;flex-shrink:0;background:#0D0E11;border-right:1px solid rgba(255,255,255,.09)')}>
        <div style={s('display:flex;align-items:center;justify-content:space-between;height:34px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.06)')}>
          <span style={s(`font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:#6C7076`)}>FILTERS</span>
          <button onClick={() => setFilters({ domain: [], dest: [], page: [] })}
            style={s(`background:none;border:none;color:${activeFilterCount ? A : '#5A5E64'};font-family:${MONO};font-size:9.5px;letter-spacing:.5px;cursor:pointer`)}>CLEAR ({activeFilterCount})</button>
        </div>
        {facetGroups.map((g) => {
          const term = (gsearch[g.group] || '').toLowerCase();
          const opts = term ? g.vals.filter(([v]) => String(v).toLowerCase().includes(term)) : g.vals;
          const searchable = g.vals.length > 6;
          const chosen = filters[g.group].length;
          return (
            <div key={g.group} style={s('border-bottom:1px solid rgba(255,255,255,.06);padding:11px 0 12px')}>
              <div style={s('display:flex;align-items:center;justify-content:space-between;padding:0 14px 8px')}>
                <span style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>{g.title}</span>
                {chosen > 0 && <span style={s(`font-family:${MONO};font-size:9px;color:${A}`)}>{chosen}</span>}
              </div>
              {searchable && (
                <div style={s('padding:0 14px 8px')}>
                  <input value={gsearch[g.group] || ''} onChange={(e) => setGsearch((p) => ({ ...p, [g.group]: e.target.value }))}
                    placeholder={`Filter ${g.title.toLowerCase()}...`}
                    style={s('width:100%;background:#0B0C0E;border:1px solid rgba(255,255,255,.08);color:#C6C9CE;font-size:11px;padding:5px 8px;outline:none')} />
                </div>
              )}
              <div style={s(searchable ? 'max-height:184px;overflow-y:auto' : '')}>
                {opts.map(([v, n]) => {
                  const sel = filters[g.group].includes(v);
                  return (
                    <button key={v} onClick={() => toggleFilter(g.group, v)}
                      style={s(`display:flex;align-items:center;gap:9px;width:100%;padding:4px 14px;background:${sel ? 'rgba(232,163,61,.06)' : 'transparent'};border:none;cursor:pointer;text-align:left`)}>
                      <span style={s(`width:11px;height:11px;flex-shrink:0;border:1px solid ${sel ? A : 'rgba(255,255,255,.2)'};background:${sel ? A : 'transparent'};display:flex;align-items:center;justify-content:center;font-size:8px;color:#0B0C0E;line-height:1`)}>{sel ? '✓' : ''}</span>
                      <span style={s(`flex:1;font-size:11.5px;color:${sel ? '#E7E8EA' : '#9CA0A6'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{v}</span>
                      <span style={s(`font-family:${MONO};font-size:10px;color:#5A5E64;font-variant-numeric:tabular-nums`)}>{pad(n)}</span>
                    </button>
                  );
                })}
                {opts.length === 0 && <div style={s('padding:4px 14px;font-size:11px;color:#45484D')}>no match</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* queue */}
      <div style={s('flex:1;min-width:0;background:#0B0C0E;overflow-x:auto')}>
        {/* header strip: counts, sort, bulk actions */}
        <div style={s(`display:flex;align-items:center;gap:12px;height:40px;padding:0 16px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.09);min-width:${tableMinW}px`)}>
          <span style={s(`font-family:${MONO};font-size:11.5px;color:#E7E8EA;font-variant-numeric:tabular-nums`)}>{pad(filtered.length)} <span style={s('color:#5A5E64')}>waiting for review{filtered.length !== ads.length ? ` of ${ads.length}` : ''}</span></span>
          <span style={s('color:#2E3136')}>|</span>
          <span style={s('font-size:10.5px;color:#5A5E64')}>sorted by</span>
          {sortDefs.map((sd) => (
            <button key={sd.id} onClick={() => setSort(sd.id)}
              style={s(`background:none;border:none;color:${sort === sd.id ? '#E7E8EA' : '#6C7076'};font-size:10.5px;letter-spacing:.3px;cursor:pointer`)}>{sd.label}</button>
          ))}
          <span style={s('color:#2E3136')}>|</span>
          <span style={s(`font-family:${MONO};font-size:10px;color:#5A5E64;letter-spacing:.3px`)}>images</span>
          <div style={s('display:flex;gap:1px;background:rgba(255,255,255,.08)')}>
            {IMG_SIZES.map((z) => (
              <button key={z.key} onClick={() => setImgKey(z.key)}
                title={`Preview images ${z.hint}`}
                style={s(`padding:3px 7px;background:${imgKey === z.key ? '#1A1C20' : '#0D0E11'};border:none;color:${imgKey === z.key ? A : '#8A8E94'};font-family:${MONO};font-size:10px;cursor:pointer`)}>{z.label}</button>
            ))}
          </div>
          <span style={s('flex:1')} />
          {canEdit && selIds.length > 0 ? (
            <>
              <span style={s(`font-family:${MONO};font-size:11px;color:${A};font-variant-numeric:tabular-nums`)}>{selIds.length} selected</span>
              <button onClick={() => setSelected(new Set())} style={s(`background:none;border:none;color:#8A8E94;font-family:${MONO};font-size:10px;cursor:pointer`)}>CLEAR</button>
              <button onClick={() => decide(selIds, 'approved')} disabled={busy} style={actBtn('#7BC97E', 'rgba(123,201,126,.35)')}>✓ APPROVE {selIds.length}</button>
              <button onClick={() => decide(selIds, 'rejected')} disabled={busy} style={actBtn('#ff8a80', 'rgba(255,120,120,.35)')}>✕ REJECT {selIds.length}</button>
            </>
          ) : (
            <span style={s('font-size:10.5px;color:#5A5E64')}>Approve adds an ad to the feed; reject drops it permanently.</span>
          )}
        </div>

        {/* column header */}
        <div style={s(`display:flex;align-items:center;height:26px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase;min-width:${tableMinW}px`)}>
          {canEdit && (
            <div style={s('width:28px;flex-shrink:0;display:flex;align-items:center')}>
              <span onClick={() => setSelected(allSelected ? new Set() : new Set(ids))} title="Select all filtered rows"
                style={s(`width:13px;height:13px;border:1px solid ${allSelected ? A : 'rgba(255,255,255,.25)'};background:${allSelected ? A : 'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:9px;color:#0B0C0E;line-height:1`)}>{allSelected ? '✓' : ''}</span>
            </div>
          )}
          <div style={s(`width:${thumbColW}px;flex-shrink:0`)} />
          <div style={s('width:150px;flex-shrink:0')}>Page</div>
          <div style={s('width:140px;flex-shrink:0')}>Searched Domain</div>
          <div style={s('width:170px;flex-shrink:0')}>Actually Leads To</div>
          <div style={s('flex:1;min-width:0')}>Headline</div>
          <div style={s('width:130px;flex-shrink:0')}>Ad Archive ID</div>
          <div style={s('width:80px;flex-shrink:0;text-align:right')}>Added</div>
          {canEdit && <div style={s('width:170px;flex-shrink:0;text-align:right')}>Decision</div>}
        </div>

        {filtered.map((a) => {
          const isSel = selected.has(a.ad_archive_id);
          const url = firstUrl(a.link_url);
          const host = hostOf(url);
          return (
            <div key={a.ad_archive_id}
              style={s(`display:flex;align-items:center;min-height:56px;min-width:${tableMinW}px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.045);background:${isSel ? 'rgba(232,163,61,.09)' : 'transparent'}`)}>
              {canEdit && (
                <div onClick={() => toggle(a.ad_archive_id)} style={s('width:28px;flex-shrink:0;display:flex;align-items:center;cursor:pointer')}>
                  <span style={s(`width:13px;height:13px;border:1px solid ${isSel ? A : 'rgba(255,255,255,.22)'};background:${isSel ? A : 'transparent'};display:flex;align-items:center;justify-content:center;font-size:9px;color:#0B0C0E;line-height:1`)}>{isSel ? '✓' : ''}</span>
                </div>
              )}
              <div style={s(`width:${thumbColW}px;flex-shrink:0;padding-right:12px`)}><Thumb ad={a} size={img.px} fit={img.fit} /></div>
              <div style={s('width:150px;flex-shrink:0;padding-right:12px;min-width:0')}>
                <span style={s('font-size:12.5px;color:#E7E8EA;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{a.page_name || '(unknown)'}</span>
              </div>
              <div style={s('width:140px;flex-shrink:0;padding-right:12px;min-width:0')}>
                <span style={s(`font-family:${MONO};font-size:11px;color:#8A8E94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{a.domain || '-'}</span>
              </div>
              <div style={s('width:170px;flex-shrink:0;padding-right:12px;min-width:0')}>
                {url
                  ? <a href={url} target="_blank" rel="noreferrer" title={url}
                      style={s(`font-family:${MONO};font-size:11px;color:#D8A05A;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{host || url} ↗</a>
                  : <span style={s(`font-family:${MONO};font-size:11px;color:#45484D`)}>no link</span>}
              </div>
              <div style={s('flex:1;min-width:0;padding-right:16px')}>
                <div style={s('font-size:12.5px;color:#C6C9CE;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical')}>{a.title || a.caption || a.body_text || ''}</div>
              </div>
              <CopyCell value={a.ad_archive_id} style={s('width:130px;flex-shrink:0;padding-right:12px;min-width:0')}>
                <span style={s(`font-family:${MONO};font-size:10.5px;color:#8A8E94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{a.ad_archive_id}</span>
              </CopyCell>
              <div style={s(`width:80px;flex-shrink:0;text-align:right;font-family:${MONO};font-size:10.5px;color:#6C7076`)}>{relTime(NOW - new Date(a.first_seen_at).getTime())}</div>
              {canEdit && (
                <div style={s('width:170px;flex-shrink:0;display:flex;justify-content:flex-end;gap:6px')}>
                  <button onClick={() => decide([a.ad_archive_id], 'approved')} disabled={busy}
                    title="Add this ad to the feed" style={actBtn('#7BC97E', 'rgba(123,201,126,.35)')}>✓</button>
                  <button onClick={() => decide([a.ad_archive_id], 'rejected')} disabled={busy}
                    title="Drop this ad permanently" style={actBtn('#ff8a80', 'rgba(255,120,120,.35)')}>✕</button>
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div style={s('padding:60px 0;text-align:center')}>
            <div style={s('font-size:13px;color:#8A8E94')}>{ads.length ? 'No queued ads match your filters.' : 'Nothing waiting for review.'}</div>
            {ads.length > 0 && activeFilterCount > 0 && (
              <button onClick={() => setFilters({ domain: [], dest: [], page: [] })}
                style={s(`margin-top:10px;background:#101216;border:1px solid rgba(255,255,255,.12);color:#C6C9CE;font-family:${MONO};font-size:10px;padding:4px 10px;cursor:pointer`)}>CLEAR FILTERS</button>
            )}
            {!ads.length && <div style={s('font-size:11px;color:#5A5E64;margin-top:6px')}>Ads whose destination does not match their searched domain will show up here after each scrape.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
