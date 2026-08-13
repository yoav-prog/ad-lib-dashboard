'use client';

// Client Kits, RSOC source: the ref_comp_rows competitor intelligence (network / vertical /
// geo / adtitle / revenue / RPC / keywords), our own domains excluded, each row paired with
// one of OUR links. Assignments key on the comp row id (source='rsoc'); global link
// availability is shared with the Meta source. Reuses the shared assign panel and export.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, fmtDec, compToSubject, COMP_KIT_COLUMN_META } from '@/lib/ui';
import TableScroll from '@/components/TableScroll';
import { AssignPanel, ExportModal, Empty, miniBtn, shortUrl, ls, setLs, LS_DOMAIN, LS_NETWORK, REASON } from '@/components/kit-shared';
import { loadCompFacets, loadCompRows, loadCompAssignments, assignOurLinkToComp, unassignFromComp, bulkAssignToComp, exportCompKitToSheet } from '@/app/actions';

export default function ClientKitsRsoc({ canBuild = false, ourDomains = null, ourNetworks = [] }) {
  const [facets, setFacets] = useState(null);      // { networks, verticals, geos } | null
  const [fNetwork, setFNetwork] = useState('');
  const [fVertical, setFVertical] = useState('');
  const [fGeo, setFGeo] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState(null);          // null=loading, []=none
  const [rowsErr, setRowsErr] = useState('');
  const [assignments, setAssignments] = useState({});   // comp_row_id -> assignment
  const [assignFor, setAssignFor] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);

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

  // Rows whenever a filter changes.
  useEffect(() => {
    let alive = true;
    setRows(null); setRowsErr('');
    loadCompRows({ network: fNetwork || null, vertical: fVertical || null, geo: fGeo || null, search: search || null })
      .then((r) => { if (!alive) return; if (r?.ok) setRows(r.rows); else { setRows([]); setRowsErr(REASON[r?.reason] || 'Could not load competitor rows.'); } })
      .catch((e) => { console.error('[kit comp rows] failed', e); if (alive) { setRows([]); setRowsErr('Could not load competitor rows.'); } });
    return () => { alive = false; };
  }, [fNetwork, fVertical, fGeo, search]);

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

  useEffect(() => { setSelected(new Set()); lastIdxRef.current = -1; setBulkMsg(''); }, [fNetwork, fVertical, fGeo, search]);
  useEffect(() => {
    if (!ourDomains || !ourDomains.length || bulkDomain) return;
    const last = ls(LS_DOMAIN, '');
    setBulkDomain(last && ourDomains.some((d) => d.domain === last) ? last : ourDomains[0].domain);
  }, [ourDomains, bulkDomain]);

  const rowList = rows || [];
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

  const runBulk = async () => {
    if (bulkBusy || !bulkDomain || !selected.size) return;
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

  const sel = s(`background:#101216;border:1px solid rgba(255,255,255,.14);color:#E7E8EA;font-family:${MONO};font-size:11px;padding:5px 8px;outline:none`);

  return (
    <div>
      {/* Filter bar */}
      <div style={s('display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:56px;padding:10px 24px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.09)')}>
        <select value={fNetwork} onChange={(e) => setFNetwork(e.target.value)} style={sel}>
          <option value="">All competitor networks</option>
          {(facets?.networks || []).map((n) => <option key={n.value} value={n.value}>{n.value} ({n.total})</option>)}
        </select>
        <select value={fVertical} onChange={(e) => setFVertical(e.target.value)} style={sel}>
          <option value="">All verticals</option>
          {(facets?.verticals || []).map((v) => <option key={v.value} value={v.value}>{v.value} ({v.total})</option>)}
        </select>
        <select value={fGeo} onChange={(e) => setFGeo(e.target.value)} style={sel}>
          <option value="">All geos</option>
          {(facets?.geos || []).map((g) => <option key={g.value} value={g.value}>{g.value} ({g.total})</option>)}
        </select>
        <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search headline / keyword"
          style={s(`flex:1;min-width:180px;background:#0B0C0E;border:1px solid rgba(255,255,255,.1);color:#E7E8EA;font-family:${MONO};font-size:12px;padding:6px 9px;outline:none`)} />
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
              <button onClick={runBulk} disabled={bulkBusy || !bulkDomain}
                style={s(`font-family:${MONO};font-size:10px;letter-spacing:.4px;color:#0B0C0E;background:${A};border:none;padding:7px 14px;cursor:${bulkBusy || !bulkDomain ? 'default' : 'pointer'};opacity:${bulkBusy || !bulkDomain ? '.6' : '1'}`)}>
                {bulkBusy ? 'ASSIGNING...' : 'ASSIGN TO DOMAIN'}
              </button>
              <button onClick={() => setSelected(new Set())} style={miniBtn('#8A8E94')}>CLEAR</button>
            </>
          ) : (
            <button onClick={() => setBulkMsg('')} style={miniBtn('#8A8E94')}>DISMISS</button>
          )}
          {bulkMsg && <span style={s('font-size:11px;color:#86C99A')}>{bulkMsg}</span>}
        </div>
      )}

      {/* Rows */}
      <TableScroll label="clientkits-rsoc">
        <div style={s('display:flex;align-items:center;height:26px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase;min-width:1080px')}>
          {canBuild && (
            <div style={s('width:30px;display:flex;align-items:center')}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all" style={s('cursor:pointer')} />
            </div>
          )}
          <div style={s('flex:1')}>Competitor (RSOC)</div>
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
            key={r.id} row={r} canBuild={canBuild}
            assignment={assignments[r.id]}
            selected={selected.has(r.id)}
            onToggle={(shift) => toggleSel(r.id, shift)}
            onAssignClick={() => setAssignFor(r)}
            onUnassign={onUnassigned}
          />
        ))}
      </TableScroll>

      {assignFor && (
        <AssignPanel
          subject={{ ...compToSubject(assignFor), title: assignFor.adtitle }}
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
          defaultTab={`RSOC Kit${fVertical ? ` - ${fVertical}` : ''}`}
          onExport={({ spreadsheetId, tabName, columnKeys, mode }) => exportCompKitToSheet({ spreadsheetId, tabName, compRowIds: assignedIds, columnKeys, mode })}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

// ── one RSOC competitor row, with its our-link cell ───────────────────────────
function CompRow({ row, canBuild, assignment, selected = false, onToggle, onAssignClick, onUnassign }) {
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try { const r = await unassignFromComp({ compRowId: row.id }); if (r?.ok) onUnassign(row.id); }
    catch (e) { console.error('[kit comp unassign] failed', e); }
    setBusy(false);
  };

  return (
    <div style={s(`display:flex;align-items:center;min-height:64px;padding:8px 24px;border-bottom:1px solid rgba(255,255,255,.045);min-width:1080px;background:${selected ? 'rgba(232,163,61,.06)' : 'transparent'}`)}>
      {canBuild && (
        <div style={s('width:30px;display:flex;align-items:center')}>
          <input type="checkbox" checked={selected} onChange={() => {}} onClick={(e) => onToggle?.(e.shiftKey)} style={s('cursor:pointer')} />
        </div>
      )}
      <div style={s('flex:1;padding-right:16px;min-width:0')}>
        <span style={s('font-size:12.5px;color:#C6C9CE;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{row.adtitle || '(no title)'}</span>
        <span style={s(`font-family:${MONO};font-size:10px;color:#6C7076;margin-top:3px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>
          {row.network || '?'} &middot; {row.vertical || 'no vertical'} &middot; {row.geo || '?'}{row.top_keywords ? ` · ${row.top_keywords}` : ''}
        </span>
      </div>
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
