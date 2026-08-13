'use client';

// Client Kits. Two competitor sources, chosen by the toggle at the top:
//   - "Meta Ads" (this file): the adintel Meta Ad Library creatives, grouped by competitor
//     domain, each paired with one of OUR OWN article links.
//   - "RSOC" (ClientKitsRsoc): the ref_comp_rows RSOC competitor intelligence Maya's
//     workflow actually uses.
// Both share the assign panel and sheet export (components/kit-shared). Our links come from
// the read-only articles DB; which link is taken is remembered in the adintel DB.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, thumbOf, isVideo, daysRunning, fmtDec, langCode, KIT_COLUMN_META } from '@/lib/ui';
import TableScroll from '@/components/TableScroll';
import ClientKitsRsoc from '@/components/ClientKitsRsoc';
import ClientKitsSaved from '@/components/ClientKitsSaved';
import SelectMenu from '@/components/SelectMenu';
import { AssignPanel, ExportModal, Empty, Mono, miniBtn, shortUrl, ls, setLs, LS_DOMAIN, LS_NETWORK, REASON } from '@/components/kit-shared';
import { loadOurDomains, loadOurNetworks, loadKitAssignments, assignOurLink, unassignOurLink, bulkAssignOurLinks, bulkAssignSisters, exportKitToSheet } from '@/app/actions';

export default function ClientKitsView({ ads, NOW, canBuild = false, matchesQuery = () => true, notConfigured = false }) {
  const [source, setSource] = useState('meta');   // 'meta' | 'rsoc'

  const domains = useMemo(() => {
    const counts = {};
    ads.forEach((a) => { if (a.domain) counts[a.domain] = (counts[a.domain] || 0) + 1; });
    return Object.entries(counts).sort((x, y) => y[1] - x[1]).map(([d]) => d);
  }, [ads]);

  const [dom, setDom] = useState(domains[0] || '');
  const active = dom || domains[0] || '';

  // The competitor's ads, winners first (revenue, then longevity), search-filtered.
  const list = useMemo(() => {
    const rev = (a) => (a.sheet_revenue == null || a.sheet_revenue === '' ? -1 : Number(a.sheet_revenue));
    return ads
      .filter((a) => a.domain === active && matchesQuery(a))
      .sort((x, y) => rev(y) - rev(x) || daysRunning(y, NOW) - daysRunning(x, NOW));
  }, [ads, active, matchesQuery, NOW]);

  // assignments: ad_archive_id -> { our_url, our_domain, our_headline, ... }
  const [assignments, setAssignments] = useState({});
  const [ourDomains, setOurDomains] = useState(null);   // null=loading, []=none/err
  const [ourNetworks, setOurNetworks] = useState([]);   // [{network,total}]
  const [assignFor, setAssignFor] = useState(null);     // the ad being assigned, or null
  const [exportOpen, setExportOpen] = useState(false);

  // Our publishing domains and networks, once. Shared with the RSOC view below.
  useEffect(() => {
    let alive = true;
    loadOurDomains()
      .then((r) => { if (alive) setOurDomains(r?.ok ? r.domains : []); })
      .catch((e) => { console.error('[kit domains] load failed', e); if (alive) setOurDomains([]); });
    loadOurNetworks()
      .then((r) => { if (alive && r?.ok) setOurNetworks(r.networks || []); })
      .catch((e) => console.error('[kit networks] load failed', e));
    return () => { alive = false; };
  }, []);

  // Assignments for the current competitor's ads, refreshed when the competitor changes.
  const idsKey = list.map((a) => a.ad_archive_id).join(',');
  useEffect(() => {
    const ids = idsKey ? idsKey.split(',') : [];
    if (!ids.length) { setAssignments({}); return; }
    let alive = true;
    loadKitAssignments(ids)
      .then((r) => { if (alive && r?.ok) setAssignments(r.assignments || {}); })
      .catch((e) => console.error('[kit assignments] load failed', e));
    return () => { alive = false; };
  }, [idsKey]);

  const onAssigned = useCallback((adId, assignment) => {
    setAssignments((p) => ({ ...p, [adId]: assignment }));
  }, []);
  const onUnassigned = useCallback((adId) => {
    setAssignments((p) => { const n = { ...p }; delete n[adId]; return n; });
  }, []);

  const assignedIds = useMemo(() => list.map((a) => a.ad_archive_id).filter((id) => assignments[id]), [list, assignments]);

  // ── multi-select + bulk assign ──────────────────────────────────────────────
  const [selected, setSelected] = useState(() => new Set());
  const lastIdxRef = useRef(-1);
  const [bulkDomain, setBulkDomain] = useState('');
  const [bulkNetwork, setBulkNetwork] = useState(() => ls(LS_NETWORK, ''));   // '' = any network
  const [bulkMatch, setBulkMatch] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState('');

  useEffect(() => { setSelected(new Set()); lastIdxRef.current = -1; setBulkMsg(''); }, [active]);

  useEffect(() => {
    if (!ourDomains || !ourDomains.length || bulkDomain) return;
    const last = ls(LS_DOMAIN, '');
    setBulkDomain(last && ourDomains.some((d) => d.domain === last) ? last : ourDomains[0].domain);
  }, [ourDomains, bulkDomain]);

  const toggleSel = useCallback((id, shift) => {
    const idx = list.findIndex((a) => a.ad_archive_id === id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && lastIdxRef.current >= 0 && idx >= 0) {
        const [lo, hi] = [lastIdxRef.current, idx].sort((x, y) => x - y);
        const add = !prev.has(id);
        for (let i = lo; i <= hi; i++) { const rid = list[i].ad_archive_id; if (add) next.add(rid); else next.delete(rid); }
      } else if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    lastIdxRef.current = idx;
  }, [list]);

  const allSelected = list.length > 0 && list.every((a) => selected.has(a.ad_archive_id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(list.map((a) => a.ad_archive_id)));
  // Select the first n rows (or all when n is omitted) - powers the shared SelectMenu.
  const selectMany = (n) => setSelected(new Set((n ? list.slice(0, n) : list).map((a) => a.ad_archive_id)));

  const [sistersBusy, setSistersBusy] = useState(false);

  const runBulk = async () => {
    if (bulkBusy || sistersBusy || !bulkDomain || !selected.size) return;
    setBulkBusy(true); setBulkMsg('');
    const orderedIds = list.map((a) => a.ad_archive_id).filter((id) => selected.has(id));
    try {
      const r = await bulkAssignOurLinks({ adIds: orderedIds, domain: bulkDomain, network: bulkNetwork || null, matchByAd: bulkMatch });
      if (r?.ok) {
        setAssignments((p) => ({ ...p, ...r.assigned }));
        setLs(LS_DOMAIN, bulkDomain); setLs(LS_NETWORK, bulkNetwork);
        const parts = [`Assigned ${r.matched}`];
        if (r.alreadyHad) parts.push(`${r.alreadyHad} already had a link`);
        if (r.noLink?.length) parts.push(`${r.noLink.length} had no ${bulkMatch ? 'matching ' : ''}link on ${bulkDomain}${bulkNetwork ? ` (${bulkNetwork})` : ''}`);
        setBulkMsg(parts.join(' · ') + '.');
        setSelected(new Set());
      } else setBulkMsg(REASON[r?.reason] || 'Bulk assign failed.');
    } catch (e) { console.error('[kit bulk] failed', e); setBulkMsg('Bulk assign failed.'); }
    setBulkBusy(false);
  };

  // Assign the exact sister article to each selected ad that has one (ignores the domain
  // picker - a sister lives on whatever domain we published it on).
  const runBulkSisters = async () => {
    if (bulkBusy || sistersBusy || !selected.size) return;
    setSistersBusy(true); setBulkMsg('');
    const orderedIds = list.map((a) => a.ad_archive_id).filter((id) => selected.has(id));
    try {
      const r = await bulkAssignSisters({ source: 'meta', ids: orderedIds, network: bulkNetwork || null });
      if (r?.ok) {
        setAssignments((p) => ({ ...p, ...r.assigned }));
        const parts = [`Assigned ${r.matched} sister${r.matched === 1 ? '' : 's'}`];
        if (r.alreadyHad) parts.push(`${r.alreadyHad} already had a link`);
        if (r.noSister?.length) parts.push(`${r.noSister.length} had no sister`);
        setBulkMsg(parts.join(' · ') + '.');
        setSelected(new Set());
      } else setBulkMsg(REASON[r?.reason] || 'Assign sisters failed.');
    } catch (e) { console.error('[kit sisters bulk] failed', e); setBulkMsg('Assign sisters failed.'); }
    setSistersBusy(false);
  };

  const toggle = <SourceToggle source={source} setSource={setSource} />;

  if (notConfigured) {
    return (
      <div>{toggle}
        <Empty>
          Client Kits needs the articles database configured. Set <Mono>ARTICLES_DATABASE_URL</Mono> in the
          environment (see <Mono>.env.example</Mono>) and reload.
        </Empty>
      </div>
    );
  }
  if (source === 'saved') {
    return <div>{toggle}<ClientKitsSaved canBuild={canBuild} /></div>;
  }
  if (source === 'rsoc') {
    return <div>{toggle}<ClientKitsRsoc canBuild={canBuild} ourDomains={ourDomains} ourNetworks={ourNetworks} /></div>;
  }
  if (!domains.length) {
    return <div>{toggle}<Empty>No Meta competitors yet. Run a scrape to populate the feed, or switch to the RSOC source above.</Empty></div>;
  }

  const ref = list[0] || ads.find((a) => a.domain === active) || {};

  return (
    <div>
      {toggle}
      {/* Header: competitor picker + kit progress + export */}
      <div style={s('display:flex;align-items:center;gap:16px;min-height:96px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.09);padding:0 24px')}>
        <div style={s(`width:48px;height:48px;background:#141619;border:1px solid rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;font-family:${MONO};font-size:16px;color:#E7E8EA`)}>
          {(ref.page_name || active).slice(0, 2).toUpperCase()}
        </div>
        <div>
          <div style={s('display:flex;align-items:center;gap:10px')}>
            <h1 style={s('font-size:18px;font-weight:600;color:#F0F1F3;margin:0')}>{ref.page_name || active}</h1>
            <select value={active} onChange={(e) => setDom(e.target.value)}
              style={s(`background:#101216;border:1px solid rgba(255,255,255,.1);color:#8A8E94;font-family:${MONO};font-size:11px;padding:3px 6px;outline:none`)}>
              {domains.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div style={s(`font-family:${MONO};font-size:12px;color:#6C7076;margin-top:4px`)}>
            {assignedIds.length}/{list.length} ads paired with our links
          </div>
        </div>
        <div style={s('flex:1')} />
        {canBuild && (
          <button onClick={() => setExportOpen(true)} disabled={!assignedIds.length}
            style={s(`font-family:${MONO};font-size:10px;letter-spacing:.4px;color:${assignedIds.length ? '#0B0C0E' : '#6C7076'};background:${assignedIds.length ? A : '#1A1C20'};border:none;padding:8px 14px;cursor:${assignedIds.length ? 'pointer' : 'default'}`)}>
            &#8599; EXPORT KIT ({assignedIds.length})
          </button>
        )}
      </div>

      {/* Bulk-assign bar */}
      {canBuild && (selected.size > 0 || bulkMsg) && (
        <div style={s('display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 24px;background:#12100B;border-bottom:1px solid rgba(232,163,61,.25)')}>
          {selected.size > 0 ? (
            <>
              <span style={s(`font-family:${MONO};font-size:11px;color:${A};font-variant-numeric:tabular-nums`)}>{selected.size} selected</span>
              <span style={s('font-size:11px;color:#8A8E94')}>assign each to</span>
              <select value={bulkDomain} onChange={(e) => setBulkDomain(e.target.value)}
                style={s(`background:#101216;border:1px solid rgba(255,255,255,.14);color:#E7E8EA;font-family:${MONO};font-size:11px;padding:5px 8px;outline:none`)}>
                {ourDomains == null && <option value="">loading domains...</option>}
                {(ourDomains || []).map((d) => <option key={d.domain} value={d.domain}>{d.domain} ({d.total})</option>)}
              </select>
              <select value={bulkNetwork} onChange={(e) => setBulkNetwork(e.target.value)} title="Only offer links from this network"
                style={s(`background:#101216;border:1px solid rgba(255,255,255,.14);color:#E7E8EA;font-family:${MONO};font-size:11px;padding:5px 8px;outline:none`)}>
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
                title="Assign the exact sister article to each selected ad that has one"
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

      {/* Column head + rows */}
      <TableScroll label="clientkits">
        <div style={s('display:flex;align-items:center;height:26px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase;min-width:1032px')}>
          {canBuild && (
            <div style={s('width:52px;display:flex;align-items:center;gap:3px')}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all in this list" style={s('cursor:pointer')} />
              <SelectMenu pageRows={list.length} total={list.length} busy={false} hasSelection={selected.size > 0}
                onPage={() => selectMany()} onFirst={(n) => selectMany(n)} onAll={() => selectMany()} onClear={() => setSelected(new Set())} />
            </div>
          )}
          <div style={s('width:64px')} />
          <div style={s('flex:1')}>Competitor Creative</div>
          <div style={s('width:70px;text-align:right')}>Days</div>
          <div style={s('width:90px;text-align:right')}>Revenue</div>
          <div style={s('width:420px;padding-left:20px')}>Our Link</div>
        </div>

        {list.map((a) => (
          <KitRow
            key={a.ad_archive_id} ad={a} NOW={NOW} canBuild={canBuild}
            assignment={assignments[a.ad_archive_id]}
            selected={selected.has(a.ad_archive_id)}
            onToggle={(shift) => toggleSel(a.ad_archive_id, shift)}
            onAssignClick={() => setAssignFor(a)}
            onUnassign={onUnassigned}
          />
        ))}
        {list.length === 0 && (
          <div style={s('padding:40px 24px;text-align:center;color:#5A5E64;font-size:12px')}>No ads match your search for this competitor.</div>
        )}
      </TableScroll>

      {assignFor && (
        <AssignPanel
          subject={{ title: assignFor.title || assignFor.caption || assignFor.body_text, language: assignFor.creative_language || assignFor.language, country: assignFor.country, vertical: assignFor.vertical }}
          competitorUrl={assignFor.resolved_url || assignFor.link_url || ''}
          ourDomains={ourDomains || []} ourNetworks={ourNetworks}
          onClose={() => setAssignFor(null)}
          onChoose={async (link) => {
            const r = await assignOurLink({ adId: assignFor.ad_archive_id, url: link.url, domain: link.domain, headline: link.headline, articleId: link.id });
            if (r?.ok) onAssigned(assignFor.ad_archive_id, { our_url: link.url, our_domain: link.domain, our_headline: link.headline || null, our_article_id: link.id ?? null });
            return r;
          }}
        />
      )}

      {exportOpen && (
        <ExportModal
          title="EXPORT KIT TO GOOGLE SHEET"
          count={assignedIds.length}
          columnMeta={KIT_COLUMN_META}
          defaultTab={`Kit - ${active}`}
          onExport={({ spreadsheetId, tabName, columnKeys, mode }) => exportKitToSheet({ spreadsheetId, tabName, adIds: assignedIds, columnKeys, mode })}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

// ── the source toggle: Meta Ads vs RSOC competitors ───────────────────────────
function SourceToggle({ source, setSource }) {
  const opt = (id, label) => (
    <button key={id} onClick={() => setSource(id)}
      style={s(`font-family:${MONO};font-size:10.5px;letter-spacing:.4px;padding:6px 14px;cursor:pointer;border:none;background:${source === id ? A : 'transparent'};color:${source === id ? '#0B0C0E' : '#9CA0A6'}`)}>
      {label}
    </button>
  );
  return (
    <div style={s('display:flex;align-items:center;gap:10px;height:40px;padding:0 24px;background:#0B0C0E;border-bottom:1px solid rgba(255,255,255,.06)')}>
      <span style={s('font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase')}>Competitor source</span>
      <div style={s('display:flex;gap:1px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.08)')}>
        {opt('meta', 'Meta Ads')}
        {opt('rsoc', 'RSOC')}
        {opt('saved', 'My Assignments')}
      </div>
    </div>
  );
}

// ── one competitor ad, with its our-link cell ─────────────────────────────────
function KitRow({ ad, NOW, canBuild, assignment, selected = false, onToggle, onAssignClick, onUnassign }) {
  const [busy, setBusy] = useState(false);
  const days = daysRunning(ad, NOW);
  const thumb = thumbOf(ad);

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await unassignOurLink({ adId: ad.ad_archive_id });
      if (r?.ok) onUnassign(ad.ad_archive_id);
    } catch (e) { console.error('[kit unassign] failed', e); }
    setBusy(false);
  };

  return (
    <div style={s(`display:flex;align-items:center;min-height:70px;padding:8px 24px;border-bottom:1px solid rgba(255,255,255,.045);min-width:1032px;background:${selected ? 'rgba(232,163,61,.06)' : 'transparent'}`)}>
      {canBuild && (
        <div style={s('width:52px;display:flex;align-items:center')}>
          <input type="checkbox" checked={selected} onChange={() => {}}
            onClick={(e) => onToggle?.(e.shiftKey)} style={s('cursor:pointer')} />
        </div>
      )}
      <div style={s('width:64px')}>
        {thumb
          ? <img src={thumb} alt="" style={s('width:48px;height:48px;object-fit:cover;background:#141619;border:1px solid rgba(255,255,255,.08)')} />
          : <div style={s('width:48px;height:48px;background:#141619;border:1px solid rgba(255,255,255,.08)')} />}
      </div>
      <div style={s('flex:1;padding-right:16px;min-width:0')}>
        <span style={s('font-size:12.5px;color:#C6C9CE;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{ad.title || ad.caption || ad.body_text || '(no headline)'}</span>
        <span style={s(`font-family:${MONO};font-size:10px;color:#6C7076;margin-top:3px;display:block`)}>
          {(ad.display_format || (isVideo(ad) ? 'video' : 'image'))} &middot; {langCode(ad.creative_language || ad.language) || '?'} &middot; {ad.country || '?'} &middot; {ad.vertical || 'no vertical'}
        </span>
      </div>
      <div style={s(`width:70px;text-align:right;font-family:${MONO};font-size:13px;color:#B6B9BE;font-variant-numeric:tabular-nums`)}>{days}<span style={s('font-size:9px;color:#5A5E64')}>d</span></div>
      <div style={s(`width:90px;text-align:right;font-family:${MONO};font-size:12px;color:#9CA0A6;font-variant-numeric:tabular-nums`)}>{ad.sheet_revenue != null && ad.sheet_revenue !== '' ? `$${fmtDec(ad.sheet_revenue)}` : '-'}</div>
      <div style={s('width:420px;padding-left:20px')}>
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
