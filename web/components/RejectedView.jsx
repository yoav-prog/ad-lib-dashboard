'use client';

import { useEffect, useMemo, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, firstUrl, hostOf, pad, relTime, filterReviewAds, reviewDestOf, reviewPageOf } from '@/lib/ui';
import Thumb from '@/components/Thumb';
import CopyCell from '@/components/CopyCell';
import ColumnPicker, { useColumnPrefs } from '@/components/ColumnPicker';
import Pager, { PageSizePicker, usePageSize } from '@/components/Pager';
import { pageSlice, pageRange, pageCount, clampPage } from '@/lib/paging';

// The Rejected list: ads a human rejected in the Review queue. The row is KEPT (so the
// scraper's dedup never re-imports the ad), which is exactly what lets us bring one
// back: "RESTORE TO FEED" flips it to approved and it reappears in Fresh Finds. This is
// the safety net for an over-eager reject - nothing is lost, just set aside.
//
// Same shape and facets as the Review queue (domain / destination / page), built for
// bulk triage: narrow the list, select the slice, restore them together.

// Every Rejected column the COLUMNS picker can hide, with the width (own padding
// included) it adds to the table min-width. Thumbnail, Headline, and the select /
// restore controls are structural and always render.
const REJECTED_COLS = [
  { key: 'page',   label: 'Page',              w: 150 },
  { key: 'domain', label: 'Searched Domain',   w: 140 },
  { key: 'dest',   label: 'Actually Leads To', w: 170 },
  { key: 'ad_id',  label: 'Ad Archive ID',     w: 146 },
  { key: 'added',  label: 'Added',             w: 80 },
];
const REJECTED_COLS_LS = 'adintel.cols.rejected';

export default function RejectedView({ ads, NOW, canEdit, query, onRestore }) {
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState({ domain: [], dest: [], page: [] });
  const [gsearch, setGsearch] = useState({});
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(0);
  const { pageSize, setPageSize } = usePageSize('adintel.pagesize.rejected');

  // Same user-controlled thumbnail sizing as the other tables; these creatives are
  // text-heavy and reading them is what decides whether to bring one back.
  const IMG_SIZES = [
    { key: 's', label: 'S', px: 44, fit: 'cover', hint: 'small' },
    { key: 'm', label: 'M', px: 120, fit: 'contain', hint: 'medium' },
    { key: 'l', label: 'L', px: 220, fit: 'contain', hint: 'large' },
  ];
  const [imgKey, setImgKey] = useState('s');
  const img = IMG_SIZES.find((z) => z.key === imgKey) || IMG_SIZES[0];
  const thumbColW = img.px + 12;

  // 470 covers the structural parts (row padding, select box, Headline's share, the
  // restore button); the rest is the sum of whichever columns are visible.
  const { visible: cols, toggle: toggleCol, reset: resetCols } = useColumnPrefs(REJECTED_COLS_LS, REJECTED_COLS);
  const tableMinW = 470 + thumbColW + REJECTED_COLS.reduce((n, c) => n + (cols.has(c.key) ? c.w : 0), 0);

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
    return list;   // 'newest' - the server orders by latest sighting
  }, [ads, query, filters, sort]);

  const paged = useMemo(() => pageSlice(filtered, page, pageSize), [filtered, page, pageSize]);
  useEffect(() => { setPage(0); }, [query, filters, sort, pageSize]);
  useEffect(() => { setPage((p) => clampPage(p, filtered.length, pageSize)); }, [filtered.length, pageSize]);
  const pages = pageCount(filtered.length, pageSize);
  const range = pageRange(filtered.length, page, pageSize);
  const goPage = (p) => {
    setPage(p);
    window.scrollTo(0, 0);
    console.info('[feed paging] page', { table: 'rejected', page: p + 1, pages, pageSize, total: filtered.length });
  };

  const activeFilterCount = filters.domain.length + filters.dest.length + filters.page.length;
  const clearFilters = () => setFilters({ domain: [], dest: [], page: [] });
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

  const restore = async (restoreIds) => {
    if (!canEdit || busy || !restoreIds.length) return;
    setBusy(true);
    console.info('[rejected restore]', { count: restoreIds.length });
    try { await onRestore(restoreIds); } finally { setBusy(false); }
    setSelected((prev) => {
      const n = new Set(prev);
      restoreIds.forEach((id) => n.delete(id));
      return n;
    });
  };

  const selIds = ids.filter((id) => selected.has(id));
  const actBtn = () =>
    s(`background:#101216;border:1px solid rgba(123,201,126,.35);color:#7BC97E;font-family:${MONO};font-size:10px;letter-spacing:.4px;padding:4px 10px;cursor:${busy ? 'wait' : 'pointer'}`);

  const sortDefs = [
    { id: 'newest', label: 'newest' },
    { id: 'page', label: 'page' },
    { id: 'domain', label: 'domain' },
    { id: 'dest', label: 'leads to' },
  ];

  return (
    <div style={s('display:flex;align-items:stretch;min-height:calc(100vh - 44px)')}>
      {/* facet rail - narrow the rejected list, then restore the whole slice at once */}
      <div style={s('width:236px;flex-shrink:0;background:#0D0E11;border-right:1px solid rgba(255,255,255,.09)')}>
        <div style={s('display:flex;align-items:center;justify-content:space-between;height:34px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.06)')}>
          <span style={s(`font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:#6C7076`)}>FILTERS</span>
          <button onClick={clearFilters}
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

      {/* list */}
      <div style={s('flex:1;min-width:0;background:#0B0C0E;overflow-x:auto')}>
        {/* header strip: counts, sort, bulk action */}
        <div style={s(`display:flex;align-items:center;gap:12px;height:40px;padding:0 16px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.09);min-width:${tableMinW}px`)}>
          <span style={s(`font-family:${MONO};font-size:11.5px;color:#E7E8EA;font-variant-numeric:tabular-nums`)}>
            {pad(filtered.length)} <span style={s('color:#5A5E64')}>rejected{filtered.length !== ads.length ? ` of ${ads.length}` : ''}</span>
            {pages > 1 && <span style={s('color:#5A5E64')}> &middot; showing {range.from}-{range.to}</span>}
          </span>
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
          <span style={s('color:#2E3136')}>|</span>
          <PageSizePicker value={pageSize} onChange={setPageSize} />
          <span style={s('color:#2E3136')}>|</span>
          <ColumnPicker defs={REJECTED_COLS} visible={cols} toggle={toggleCol} reset={resetCols} />
          <span style={s('flex:1')} />
          {canEdit && selIds.length > 0 ? (
            <>
              <span style={s(`font-family:${MONO};font-size:11px;color:${A};font-variant-numeric:tabular-nums`)}>{selIds.length} selected</span>
              <button onClick={() => setSelected(new Set())} style={s(`background:none;border:none;color:#8A8E94;font-family:${MONO};font-size:10px;cursor:pointer`)}>CLEAR</button>
              <button onClick={() => restore(selIds)} disabled={busy} title="Bring these ads back into Fresh Finds" style={actBtn()}>↩ RESTORE TO FEED {selIds.length}</button>
            </>
          ) : (
            <span style={s('font-size:10.5px;color:#5A5E64')}>Rejected ads are kept here. &ldquo;Restore to feed&rdquo; brings one back to Fresh Finds.</span>
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
          {cols.has('page') && <div style={s('width:150px;flex-shrink:0')}>Page</div>}
          {cols.has('domain') && <div style={s('width:140px;flex-shrink:0')}>Searched Domain</div>}
          {cols.has('dest') && <div style={s('width:170px;flex-shrink:0')}>Actually Leads To</div>}
          <div style={s('flex:1;min-width:0')}>Headline</div>
          {cols.has('ad_id') && <div style={s('width:130px;flex-shrink:0;padding-left:16px')}>Ad Archive ID</div>}
          {cols.has('added') && <div style={s('width:80px;flex-shrink:0;text-align:right')}>Added</div>}
          {canEdit && <div style={s('width:150px;flex-shrink:0;text-align:right')}>Restore</div>}
        </div>

        {paged.map((a) => {
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
              {cols.has('page') && (
                <div style={s('width:150px;flex-shrink:0;padding-right:12px;min-width:0')}>
                  <span style={s('font-size:12.5px;color:#E7E8EA;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{a.page_name || '(unknown)'}</span>
                </div>
              )}
              {cols.has('domain') && (
                <div style={s('width:140px;flex-shrink:0;padding-right:12px;min-width:0')}>
                  <span style={s(`font-family:${MONO};font-size:11px;color:#8A8E94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{a.domain || '-'}</span>
                </div>
              )}
              {cols.has('dest') && (
                <div style={s('width:170px;flex-shrink:0;padding-right:12px;min-width:0')}>
                  {url
                    ? <a href={url} target="_blank" rel="noreferrer" title={url}
                        style={s(`font-family:${MONO};font-size:11px;color:#D8A05A;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{host || url} ↗</a>
                    : <span style={s(`font-family:${MONO};font-size:11px;color:#45484D`)}>no link</span>}
                </div>
              )}
              <div style={s('flex:1;min-width:0;padding-right:16px')}>
                <div style={s('font-size:12.5px;color:#C6C9CE;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical')}>{a.title || a.caption || a.body_text || ''}</div>
              </div>
              {cols.has('ad_id') && (
                <CopyCell value={a.ad_archive_id} style={s('width:130px;flex-shrink:0;padding-left:16px;padding-right:12px;min-width:0')}>
                  <span style={s(`font-family:${MONO};font-size:10.5px;color:#8A8E94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{a.ad_archive_id}</span>
                </CopyCell>
              )}
              {cols.has('added') && (
                <div style={s(`width:80px;flex-shrink:0;text-align:right;font-family:${MONO};font-size:10.5px;color:#6C7076`)}>{relTime(NOW - new Date(a.first_seen_at).getTime())}</div>
              )}
              {canEdit && (
                <div style={s('width:150px;flex-shrink:0;display:flex;justify-content:flex-end;gap:6px')}>
                  <button onClick={() => restore([a.ad_archive_id])} disabled={busy}
                    title="Bring this ad back into Fresh Finds" style={actBtn()}>↩ RESTORE</button>
                </div>
              )}
            </div>
          );
        })}

        <Pager page={page} total={filtered.length} pageSize={pageSize} onPage={goPage} />

        {filtered.length === 0 && (
          <div style={s('padding:60px 0;text-align:center')}>
            <div style={s('font-size:13px;color:#8A8E94')}>{ads.length ? 'No rejected ads match your filters.' : 'Nothing rejected.'}</div>
            {ads.length > 0 && activeFilterCount > 0 && (
              <button onClick={clearFilters}
                style={s(`margin-top:10px;background:#101216;border:1px solid rgba(255,255,255,.12);color:#C6C9CE;font-family:${MONO};font-size:10px;padding:4px 10px;cursor:pointer`)}>CLEAR FILTERS</button>
            )}
            {!ads.length && <div style={s('font-size:11px;color:#5A5E64;margin-top:6px')}>Ads you reject in the Review tab are kept here, so you can restore one to Fresh Finds any time.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
