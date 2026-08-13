'use client';

// Client Kits, RSOC source: the ref_comp_rows competitor intelligence (network / vertical /
// geo / adtitle / revenue / RPC / keywords), our own domains excluded, each row paired with
// one of OUR links. Assignments key on the comp row id (source='rsoc'); global link
// availability is shared with the Meta source. Reuses the shared assign panel and export.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, fmtDec, compToSubject, dedupeBy, COMP_KIT_COLUMN_META } from '@/lib/ui';
import TableScroll from '@/components/TableScroll';
import SelectMenu from '@/components/SelectMenu';
import FilterRail from '@/components/FilterRail';
import { AssignPanel, ExportModal, Empty, miniBtn, shortUrl, ls, setLs, LS_DOMAIN, LS_NETWORK, REASON, IMG_SIZES, ImageSizeToggle } from '@/components/kit-shared';
import { loadCompFacets, loadCompRows, loadCompAssignments, assignOurLinkToComp, unassignFromComp, bulkAssignToComp, bulkAssignSisters, exportCompKitToSheet } from '@/app/actions';

export default function ClientKitsRsoc({ canBuild = false, ourDomains = null, ourNetworks = [] }) {
  const [facets, setFacets] = useState(null);      // { networks, verticals, geos } | null
  const [f, setF] = useState({ network: [], vertical: [], geo: [] });   // multi-select facets
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState(null);          // null=loading, []=none
  const [rowsErr, setRowsErr] = useState('');
  const [assignments, setAssignments] = useState({});   // comp_row_id -> assignment
  const [assignFor, setAssignFor] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [uniqueOnly, setUniqueOnly] = useState(true);   // collapse identical creatives (by title)
  const [imgKey, setImgKey] = useState('s');
  const img = IMG_SIZES.find((z) => z.key === imgKey) || IMG_SIZES[0];
  const rowMinW = 1252 + img.px;   // table min-width grows with the thumbnail

  // Facets once.
  useEffect(() => {
    let alive = true;
    loadCompFacets()
      .then((r) => { if (alive) setFacets(r?.ok ? r.facets : { networks: [], verticals: [], geos: [] }); })
      .catch((e) => { console.error('[kit comp facets] failed', e); if (alive) setFacets({ networks: [], verticals: [], geos: [] }); });
    return () => { alive = false; };
  }, []);

  // Debounce the free-text search.
  useEffect(() => { const t = setTimeout(() => setSearch(searchInput), 250); return () => clearTimeout(t); }, [searchInput]);

  // Rows whenever a filter changes (facets are multi-select, filtered server-side).
  useEffect(() => {
    let alive = true;
    setRows(null); setRowsErr('');
    loadCompRows({ network: f.network, vertical: f.vertical, geo: f.geo, search: search || null })
      .then((r) => { if (!alive) return; if (r?.ok) setRows(r.rows); else { setRows([]); setRowsErr(REASON[r?.reason] || 'Could not load competitor rows.'); } })
      .catch((e) => { console.error('[kit comp rows] failed', e); if (alive) { setRows([]); setRowsErr('Could not load competitor rows.'); } });
    return () => { alive = false; };
  }, [f, search]);

  const onToggle = useCallback((group, val) => {
    setF((prev) => {
      const cur = prev[group] || [];
      return { ...prev, [group]: cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val] };
    });
  }, []);
  const clearFilters = useCallback(() => setF({ network: [], vertical: [], geo: [] }), []);

  // Facet groups for the rail, from the (our-domains-excluded) comp facets.
  const groups = useMemo(() => {
    if (!facets) return [];
    const mk = (group, title, list) => ({ group, title, vals: list.map((x) => x.value), count: (v) => (list.find((x) => x.value === v)?.total || 0) });
    return [
      mk('network', 'Competitor network', facets.networks || []),
      mk('vertical', 'Vertical', facets.verticals || []),
      mk('geo', 'Geo', facets.geos || []),
    ];
  }, [facets]);

  // Assignments for the loaded rows.
  const idsKey = (rows || []).map((r) => r.id).join(',');
  useEffect(() => {
    const ids = idsKey ? idsKey.split(',').map(Number) : [];
    if (!ids.length) { setAssignments({}); return; }
    let alive = true;
    loadCompAssignments(ids)
      .then((r) => { if (alive && r?.ok) setAssignments(r.assignments || {}); })
      .catch((e) => console.error('[kit comp assignments] failed', e));
    return () => { alive = false; };
  }, [idsKey]);

  const onAssigned = useCallback((cid, a) => setAssignments((p) => ({ ...p, [cid]: a })), []);
  const onUnassigned = useCallback((cid) => setAssignments((p) => { const n = { ...p }; delete n[cid]; return n; }), []);

  const assignedIds = useMemo(() => (rows || []).map((r) => r.id).filter((id) => assignments[id]), [rows, assignments]);

  // ── selection + bulk ────────────────────────────────────────────────────────
  const [selected, setSelected] = useState(() => new Set());
  const lastIdxRef = useRef(-1);
  const [bulkDomain, setBulkDomain] = useState('');
  const [bulkNetwork, setBulkNetwork] = useState(() => ls(LS_NETWORK, ''));
  const [bulkMatch, setBulkMatch] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState('');

  useEffect(() => { setSelected(new Set()); lastIdxRef.current = -1; setBulkMsg(''); }, [f, search]);
  useEffect(() => {
    if (!ourDomains || !ourDomains.length || bulkDomain) return;
    const last = ls(LS_DOMAIN, '');
    setBulkDomain(last && ourDomains.some((d) => d.domain === last) ? last : ourDomains[0].domain);
  }, [ourDomains, bulkDomain]);

  // RSOC rows have only a title (no image/body), so "unique" collapses identical titles.
  const rowList = useMemo(() => {
    const base = rows || [];
    return uniqueOnly ? dedupeBy(base, (r) => String(r.adtitle || '').trim().toLowerCase()) : base;
  }, [rows, uniqueOnly]);
  const toggleSel = useCallback((id, shift) => {
    const idx = rowList.findIndex((r) => r.id === id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && lastIdxRef.current >= 0 && idx >= 0) {
        const [lo, hi] = [lastIdxRef.current, idx].sort((x, y) => x - y);
        const add = !prev.has(id);
        for (let i = lo; i <= hi; i++) { const rid = rowList[i].id; if (add) next.add(rid); else next.delete(rid); }
      } else if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    lastIdxRef.current = idx;
  }, [rowList]);

  const allSelected = rowList.length > 0 && rowList.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rowList.map((r) => r.id)));
  // Select the first n rows (or all when n is omitted) - powers the shared SelectMenu.
  const selectMany = (n) => setSelected(new Set((n ? rowList.slice(0, n) : rowList).map((r) => r.id)));

  const [sistersBusy, setSistersBusy] = useState(false);

  const runBulk = async () => {
    if (bulkBusy || sistersBusy || !bulkDomain || !selected.size) return;
    setBulkBusy(true); setBulkMsg('');
    const orderedIds = rowList.map((r) => r.id).filter((id) => selected.has(id));   // revenue order
    try {
      const r = await bulkAssignToComp({ compRowIds: orderedIds, domain: bulkDomain, network: bulkNetwork || null, matchByAd: bulkMatch });
      if (r?.ok) {
        setAssignments((p) => ({ ...p, ...r.assigned }));
        setLs(LS_DOMAIN, bulkDomain); setLs(LS_NETWORK, bulkNetwork);
        const parts = [`Assigned ${r.matched}`];
        if (r.alreadyHad) parts.push(`${r.alreadyHad} already had a link`);
        if (r.noLink?.length) parts.push(`${r.noLink.length} had no ${bulkMatch ? 'matching ' : ''}link on ${bulkDomain}${bulkNetwork ? ` (${bulkNetwork})` : ''}`);
        setBulkMsg(parts.join(' · ') + '.');
        setSelected(new Set());
      } else setBulkMsg(REASON[r?.reason] || 'Bulk assign failed.');
    } catch (e) { console.error('[kit comp bulk] failed', e); setBulkMsg('Bulk assign failed.'); }
    setBulkBusy(false);
  };

  // Assign the exact sister article to each selected comp row that has one.
  const runBulkSisters = async () => {
    if (bulkBusy || sistersBusy || !selected.size) return;
    setSistersBusy(true); setBulkMsg('');
    const orderedIds = rowList.map((r) => r.id).filter((id) => selected.has(id));
    try {
      const r = await bulkAssignSisters({ source: 'rsoc', ids: orderedIds, network: bulkNetwork || null });
      if (r?.ok) {
        setAssignments((p) => ({ ...p, ...r.assigned }));
        const parts = [`Assigned ${r.matched} sister${r.matched === 1 ? '' : 's'}`];
        if (r.alreadyHad) parts.push(`${r.alreadyHad} already had a link`);
        if (r.noSister?.length) parts.push(`${r.noSister.length} had no sister`);
        setBulkMsg(parts.join(' · ') + '.');
        setSelected(new Set());
      } else setBulkMsg(REASON[r?.reason] || 'Assign sisters failed.');
    } catch (e) { console.error('[kit comp sisters bulk] failed', e); setBulkMsg('Assign sisters failed.'); }
    setSistersBusy(false);
  };

  const sel = s(`background:#101216;border:1px solid rgba(255,255,255,.14);color:#E7E8EA;font-family:${MONO};font-size:11px;padding:5px 8px;outline:none`);

  return (
    <div>
      {/* Filter bar (facets moved to the left rail below) */}
      <div style={s('display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:56px;padding:10px 24px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.09)')}>
        <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search headline / keyword"
          style={s(`flex:1;min-width:180px;background:#0B0C0E;border:1px solid rgba(255,255,255,.1);color:#E7E8EA;font-family:${MONO};font-size:12px;padding:6px 9px;outline:none`)} />
        <ImageSizeToggle value={imgKey} onChange={setImgKey} />
        <label style={s('display:flex;align-items:center;gap:6px;font-size:11px;color:#9CA0A6;cursor:pointer')} title="Collapse rows with an identical competitor title to one">
          <input type="checkbox" checked={uniqueOnly} onChange={(e) => setUniqueOnly(e.target.checked)} /> Unique
        </label>
        <span style={s(`font-family:${MONO};font-size:11px;color:#6C7076`)}>{assignedIds.length}/{rowList.length} paired</span>
        {canBuild && (
          <button onClick={() => setExportOpen(true)} disabled={!assignedIds.length}
            style={s(`font-family:${MONO};font-size:10px;letter-spacing:.4px;color:${assignedIds.length ? '#0B0C0E' : '#6C7076'};background:${assignedIds.length ? A : '#1A1C20'};border:none;padding:8px 14px;cursor:${assignedIds.length ? 'pointer' : 'default'}`)}>
            &#8599; EXPORT KIT ({assignedIds.length})
          </button>
        )}
      </div>

      {/* Bulk bar */}
      {canBuild && (selected.size > 0 || bulkMsg) && (
        <div style={s('display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 24px;background:#12100B;border-bottom:1px solid rgba(232,163,61,.25)')}>
          {selected.size > 0 ? (
            <>
              <span style={s(`font-family:${MONO};font-size:11px;color:${A};font-variant-numeric:tabular-nums`)}>{selected.size} selected</span>
              <span style={s('font-size:11px;color:#8A8E94')}>assign each to</span>
              <select value={bulkDomain} onChange={(e) => setBulkDomain(e.target.value)} style={sel}>
                {ourDomains == null && <option value="">loading domains...</option>}
                {(ourDomains || []).map((d) => <option key={d.domain} value={d.domain}>{d.domain} ({d.total})</option>)}
              </select>
              <select value={bulkNetwork} onChange={(e) => setBulkNetwork(e.target.value)} title="Only offer links from this network" style={sel}>
                <option value="">any network</option>
                {ourNetworks.map((n) => <option key={n.network} value={n.network}>{n.network} ({n.total})</option>)}
              </select>
              <label style={s('display:flex;align-items:center;gap:6px;font-size:11px;color:#9CA0A6;cursor:pointer')}>
                <input type="checkbox" checked={bulkMatch} onChange={(e) => setBulkMatch(e.target.checked)} /> match language
              </label>
              <button onClick={runBulk} disabled={bulkBusy || sistersBusy || !bulkDomain}
                style={s(`font-family:${MONO};font-size:10px;letter-spacing:.4px;color:#0B0C0E;background:${A};border:none;padding:7px 14px;cursor:${bulkBusy || sistersBusy || !bulkDomain ? 'default' : 'pointer'};opacity:${bulkBusy || sistersBusy || !bulkDomain ? '.6' : '1'}`)}>
                {bulkBusy ? 'ASSIGNING...' : 'ASSIGN TO DOMAIN'}
              </button>
              <button onClick={runBulkSisters} disabled={bulkBusy || sistersBusy}
                title="Assign the exact sister article to each selected row that has one"
                style={s(`font-family:${MONO};font-size:10px;letter-spacing:.4px;color:${A};background:rgba(232,163,61,.1);border:1px solid rgba(232,163,61,.5);padding:6px 12px;cursor:${bulkBusy || sistersBusy ? 'default' : 'pointer'};opacity:${bulkBusy || sistersBusy ? '.6' : '1'}`)}>
                {sistersBusy ? 'ASSIGNING...' : '★ ASSIGN SISTERS'}
              </button>
              <button onClick={() => setSelected(new Set())} style={miniBtn('#8A8E94')}>CLEAR</button>
            </>
          ) : (
            <button onClick={() => setBulkMsg('')} style={miniBtn('#8A8E94')}>DISMISS</button>
          )}
          {bulkMsg && <span style={s('font-size:11px;color:#86C99A')}>{bulkMsg}</span>}
        </div>
      )}

      {/* Rail + rows */}
      <div style={s('display:flex;align-items:stretch')}>
      <FilterRail groups={groups} filters={f} onToggle={onToggle} onClear={clearFilters} loading={!facets} sticky stickyTop={44} />
      <TableScroll label="clientkits-rsoc" style={s('flex:1;min-width:0')}>
        <div style={s(`display:flex;align-items:center;height:26px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase;min-width:${rowMinW}px`)}>
          {canBuild && (
            <div style={s('width:52px;display:flex;align-items:center;gap:3px')}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all" style={s('cursor:pointer')} />
              <SelectMenu pageRows={rowList.length} total={rowList.length} busy={false} hasSelection={selected.size > 0}
                onPage={() => selectMany()} onFirst={(n) => selectMany(n)} onAll={() => selectMany()} onClear={() => setSelected(new Set())} />
            </div>
          )}
          <div style={s(`width:${img.px + 12}px`)}>Ad</div>
          <div style={s('flex:1')}>Competitor (RSOC)</div>
          <div style={s('width:130px')}>Vertical</div>
          <div style={s('width:60px')}>Geo</div>
          <div style={s('width:90px;text-align:right')}>Revenue</div>
          <div style={s('width:60px;text-align:right')}>RPC</div>
          <div style={s('width:430px;padding-left:20px')}>Our Link</div>
        </div>

        {rows == null && <div style={s('padding:40px 24px;text-align:center;color:#8A8E94;font-size:12px')}>Loading competitor rows...</div>}
        {rowsErr && <div style={s('padding:40px 24px;text-align:center;color:#ff8a80;font-size:12px')}>{rowsErr}</div>}
        {rows != null && rows.length === 0 && !rowsErr && (
          <div style={s('padding:40px 24px;text-align:center;color:#5A5E64;font-size:12px')}>No competitor rows match these filters.</div>
        )}
        {rowList.map((r) => (
          <CompRow
            key={r.id} row={r} canBuild={canBuild} img={img} rowMinW={rowMinW}
            assignment={assignments[r.id]}
            selected={selected.has(r.id)}
            onToggle={(shift) => toggleSel(r.id, shift)}
            onAssignClick={() => setAssignFor(r)}
            onUnassign={onUnassigned}
          />
        ))}
      </TableScroll>
      </div>

      {assignFor && (
        <AssignPanel
          subject={{ ...compToSubject(assignFor), title: assignFor.adtitle }}
          competitorUrl={assignFor.url || ''}
          ourDomains={ourDomains || []} ourNetworks={ourNetworks}
          onClose={() => setAssignFor(null)}
          onChoose={async (link) => {
            const r = await assignOurLinkToComp({ compRowId: assignFor.id, url: link.url, domain: link.domain, headline: link.headline, articleId: link.id });
            if (r?.ok) onAssigned(assignFor.id, { our_url: link.url, our_domain: link.domain, our_headline: link.headline || null, our_article_id: link.id ?? null });
            return r;
          }}
        />
      )}

      {exportOpen && (
        <ExportModal
          title="EXPORT RSOC KIT TO GOOGLE SHEET"
          count={assignedIds.length}
          columnMeta={COMP_KIT_COLUMN_META}
          defaultTab={`RSOC Kit${f.vertical.length === 1 ? ` - ${f.vertical[0]}` : ''}`}
          onExport={({ spreadsheetId, tabName, columnKeys, mode }) => exportCompKitToSheet({ spreadsheetId, tabName, compRowIds: assignedIds, columnKeys, mode })}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

// ── one RSOC competitor row, with its our-link cell ───────────────────────────
function CompRow({ row, canBuild, img, rowMinW = 1150, assignment, selected = false, onToggle, onAssignClick, onUnassign }) {
  const [busy, setBusy] = useState(false);
  const px = img?.px || 48;
  const fit = img?.fit || 'cover';
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try { const r = await unassignFromComp({ compRowId: row.id }); if (r?.ok) onUnassign(row.id); }
    catch (e) { console.error('[kit comp unassign] failed', e); }
    setBusy(false);
  };

  return (
    <div style={s(`display:flex;align-items:center;min-height:${Math.max(64, px + 18)}px;padding:8px 24px;border-bottom:1px solid rgba(255,255,255,.045);min-width:${rowMinW}px;background:${selected ? 'rgba(232,163,61,.06)' : 'transparent'}`)}>
      {canBuild && (
        <div style={s('width:52px;display:flex;align-items:center')}>
          <input type="checkbox" checked={selected} onChange={() => {}} onClick={(e) => onToggle?.(e.shiftKey)} style={s('cursor:pointer')} />
        </div>
      )}
      <div style={s(`width:${px + 12}px`)} title={row.thumb ? 'Matching Meta creative (by landing host)' : 'No matching Meta creative'}>
        {row.thumb
          ? <img src={row.thumb} alt="" style={s(`width:${px}px;height:${px}px;object-fit:${fit};background:#141619;border:1px solid rgba(255,255,255,.08)`)} />
          : <div style={s(`width:${px}px;height:${px}px;background:#0F1113;border:1px dashed rgba(255,255,255,.1)`)} />}
      </div>
      <div style={s('flex:1;padding-right:16px;min-width:0')}>
        <span style={s('font-size:12.5px;color:#C6C9CE;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>
          {row.has_sister && <span title="We have a sister article for this competitor" style={s(`font-family:${MONO};font-size:8.5px;letter-spacing:.4px;color:${A};border:1px solid rgba(232,163,61,.5);padding:1px 4px;margin-right:6px`)}>&#9733; SISTER</span>}
          {row.adtitle || '(no title)'}
        </span>
        {row.meta_body && <span style={s('font-size:11px;color:#8A8E94;margin-top:2px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{row.meta_body}</span>}
        <span style={s(`font-family:${MONO};font-size:10px;color:#6C7076;margin-top:3px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>
          {row.network || '?'}{row.top_keywords ? ` · ${row.top_keywords}` : ''}
        </span>
      </div>
      <div style={s('width:130px;font-size:11px;color:#9CA0A6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px')}>{row.vertical || '-'}</div>
      <div style={s(`width:60px;font-family:${MONO};font-size:11px;color:#B6B9BE`)}>{row.geo || '-'}</div>
      <div style={s(`width:90px;text-align:right;font-family:${MONO};font-size:12px;color:#9CA0A6;font-variant-numeric:tabular-nums`)}>{row.revenue != null ? `$${fmtDec(row.revenue)}` : '-'}</div>
      <div style={s(`width:60px;text-align:right;font-family:${MONO};font-size:12px;color:#9CA0A6;font-variant-numeric:tabular-nums`)}>{row.rpc != null ? fmtDec(row.rpc) : '-'}</div>
      <div style={s('width:430px;padding-left:20px')}>
        {assignment ? (
          <div style={s('display:flex;align-items:center;gap:8px')}>
            <div style={s('min-width:0;flex:1')}>
              <a href={assignment.our_url} target="_blank" rel="noreferrer"
                style={s(`font-family:${MONO};font-size:11px;color:${A};text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>
                {shortUrl(assignment.our_url)}
              </a>
              <span style={s('font-size:10px;color:#6C7076;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{assignment.our_headline || assignment.our_domain}</span>
            </div>
            {canBuild && (
              <>
                <button onClick={onAssignClick} style={miniBtn('#8A8E94')}>CHANGE</button>
                <button onClick={remove} disabled={busy} style={miniBtn('#ff8a80')}>{busy ? '...' : 'REMOVE'}</button>
              </>
            )}
          </div>
        ) : canBuild ? (
          <button onClick={onAssignClick}
            style={s(`font-family:${MONO};font-size:10px;letter-spacing:.4px;color:${A};background:rgba(232,163,61,.1);border:1px solid rgba(232,163,61,.4);padding:6px 12px;cursor:pointer`)}>
            + ASSIGN OUR LINK
          </button>
        ) : (
          <span style={s('font-size:11px;color:#5A5E64')}>not assigned</span>
        )}
      </div>
    </div>
  );
}
