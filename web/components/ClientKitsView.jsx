'use client';

// Client Kits: take a competitor's winning ads and pair each creative with one of OUR
// OWN article links, so a client gets the creative beside our link instead of the
// competitor's. Our links come from the read-only articles DB (via server actions);
// which link is taken is remembered in the adintel DB. The export writes the creative +
// our link with the competitor's own URL columns dropped by construction (KIT_COLUMNS).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, thumbOf, isVideo, daysRunning, fmtDec, langCode, rankLinks, parseSheetId, KIT_COLUMN_META } from '@/lib/ui';
import TableScroll from '@/components/TableScroll';
import { loadOurDomains, searchOurLinks, loadKitAssignments, assignOurLink, unassignOurLink, bulkAssignOurLinks, exportKitToSheet } from '@/app/actions';

const LS_DOMAIN = 'adintel.kit.ourdomain';
const LS_SHEET_ID = 'adintel.kit.sheetid';
const LS_SHEET_TAB = 'adintel.kit.sheettab';

const shortUrl = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const ls = (k, d) => { try { return (typeof window !== 'undefined' && window.localStorage.getItem(k)) || d; } catch { return d; } };
const setLs = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* ignore */ } };

export default function ClientKitsView({ ads, NOW, canBuild = false, matchesQuery = () => true, notConfigured = false }) {
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
  const [assignFor, setAssignFor] = useState(null);     // the ad being assigned, or null
  const [exportOpen, setExportOpen] = useState(false);

  // Our publishing domains, once.
  useEffect(() => {
    let alive = true;
    loadOurDomains()
      .then((r) => { if (alive) setOurDomains(r?.ok ? r.domains : []); })
      .catch((e) => { console.error('[kit domains] load failed', e); if (alive) setOurDomains([]); });
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
  const [bulkMatch, setBulkMatch] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState('');

  // Switching competitor starts a fresh selection (ids from one list never carry over).
  useEffect(() => { setSelected(new Set()); lastIdxRef.current = -1; setBulkMsg(''); }, [active]);

  // Default the bulk domain once our domains load (remembering the last one used).
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
        const add = !prev.has(id);   // extend using the state the clicked row is moving to
        for (let i = lo; i <= hi; i++) { const rid = list[i].ad_archive_id; if (add) next.add(rid); else next.delete(rid); }
      } else if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    lastIdxRef.current = idx;
  }, [list]);

  const allSelected = list.length > 0 && list.every((a) => selected.has(a.ad_archive_id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(list.map((a) => a.ad_archive_id)));

  const runBulk = async () => {
    if (bulkBusy || !bulkDomain || !selected.size) return;
    setBulkBusy(true); setBulkMsg('');
    // Send ids in the on-screen (revenue) order so top earners get first pick of links.
    const orderedIds = list.map((a) => a.ad_archive_id).filter((id) => selected.has(id));
    try {
      const r = await bulkAssignOurLinks({ adIds: orderedIds, domain: bulkDomain, matchByAd: bulkMatch });
      if (r?.ok) {
        setAssignments((p) => ({ ...p, ...r.assigned }));
        setLs(LS_DOMAIN, bulkDomain);
        const parts = [`Assigned ${r.matched}`];
        if (r.alreadyHad) parts.push(`${r.alreadyHad} already had a link`);
        if (r.noLink?.length) parts.push(`${r.noLink.length} had no ${bulkMatch ? 'matching ' : ''}link on ${bulkDomain}`);
        setBulkMsg(parts.join(' · ') + '.');
        setSelected(new Set());
      } else setBulkMsg(REASON[r?.reason] || 'Bulk assign failed.');
    } catch (e) { console.error('[kit bulk] failed', e); setBulkMsg('Bulk assign failed.'); }
    setBulkBusy(false);
  };

  if (notConfigured) {
    return (
      <Empty>
        Client Kits needs the articles database configured. Set <Mono>ARTICLES_DATABASE_URL</Mono> in the
        environment (see <Mono>.env.example</Mono>) and reload.
      </Empty>
    );
  }
  if (!domains.length) {
    return <Empty>No competitors yet. Run a scrape to populate the feed, then build a kit here.</Empty>;
  }

  const ref = list[0] || ads.find((a) => a.domain === active) || {};

  return (
    <div>
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

      {/* Bulk-assign bar: appears when rows are selected (or a result is waiting to be read) */}
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

      {/* Column head */}
      <TableScroll label="clientkits">
        <div style={s('display:flex;align-items:center;height:26px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase;min-width:1010px')}>
          {canBuild && (
            <div style={s('width:30px;display:flex;align-items:center')}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all in this list" style={s('cursor:pointer')} />
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
          ad={assignFor} ourDomains={ourDomains || []}
          onClose={() => setAssignFor(null)}
          onAssigned={(assignment) => { onAssigned(assignFor.ad_archive_id, assignment); setAssignFor(null); }}
        />
      )}

      {exportOpen && (
        <KitExportModal
          adIds={assignedIds} competitor={active}
          onClose={() => setExportOpen(false)}
        />
      )}
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
    <div style={s(`display:flex;align-items:center;min-height:70px;padding:8px 24px;border-bottom:1px solid rgba(255,255,255,.045);min-width:1010px;background:${selected ? 'rgba(232,163,61,.06)' : 'transparent'}`)}>
      {canBuild && (
        <div style={s('width:30px;display:flex;align-items:center')}>
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

// ── assign panel: pick an available link for one ad ───────────────────────────
function AssignPanel({ ad, ourDomains, onClose, onAssigned }) {
  const [domain, setDomain] = useState(() => {
    const last = ls(LS_DOMAIN, '');
    if (last && ourDomains.some((d) => d.domain === last)) return last;
    return ourDomains[0]?.domain || '';
  });
  const [matchAd, setMatchAd] = useState(true);   // narrow by the ad's language + country
  const [search, setSearch] = useState('');
  const [links, setLinks] = useState(null);        // null=loading
  const [err, setErr] = useState('');
  const [busyUrl, setBusyUrl] = useState('');

  const adLang = langCode(ad.creative_language || ad.language);
  const adCountry = ad.country || '';

  // Fetch available links whenever the domain / match toggle / (debounced) search changes.
  useEffect(() => {
    if (!domain) { setLinks([]); return; }
    let alive = true;
    setLinks(null); setErr('');
    const t = setTimeout(() => {
      searchOurLinks({
        domain,
        language: matchAd ? adLang : null,
        country: matchAd ? adCountry : null,
        search: search.trim() || null,
      })
        .then((r) => {
          if (!alive) return;
          if (r?.ok) setLinks(rankLinks(ad, r.links));
          else { setLinks([]); setErr(REASON[r?.reason] || 'Could not load links.'); }
        })
        .catch((e) => { console.error('[kit search] failed', e); if (alive) { setLinks([]); setErr('Could not load links.'); } });
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [domain, matchAd, search]);

  const choose = async (link) => {
    if (busyUrl) return;
    setBusyUrl(link.url); setErr('');
    try {
      const r = await assignOurLink({ adId: ad.ad_archive_id, url: link.url, domain: link.domain || domain, headline: link.headline, articleId: link.id });
      if (r?.ok) {
        setLs(LS_DOMAIN, domain);
        onAssigned({ our_url: link.url, our_domain: link.domain || domain, our_headline: link.headline || null, our_article_id: link.id ?? null });
        return;
      }
      if (r?.reason === 'taken') { setErr('That link was just taken. Refreshing the list.'); setLinks((p) => (p || []).filter((l) => l.url !== link.url)); }
      else setErr(REASON[r?.reason] || 'Could not assign that link.');
    } catch (e) { console.error('[kit assign] failed', e); setErr('Could not assign that link.'); }
    setBusyUrl('');
  };

  const label = s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:6px');
  const input = s(`width:100%;background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#E7E8EA;font-family:${MONO};font-size:12px;padding:8px 9px;outline:none;box-sizing:border-box`);

  return (
    <Overlay onClose={onClose} width={640}>
      <ModalHead title="ASSIGN OUR LINK" onClose={onClose} />
      <div style={s('padding:18px;display:flex;flex-direction:column;gap:14px;overflow-y:auto')}>
        <div style={s('font-size:11.5px;color:#9CA0A6;line-height:1.5')}>
          For <span style={s('color:#C6C9CE')}>{ad.title || ad.caption || ad.body_text || 'this ad'}</span>
          {' '}(<Mono>{adLang || '?'}</Mono> &middot; <Mono>{adCountry || '?'}</Mono>). Pick a domain and choose one of our available links. Taken links are hidden.
        </div>
        <div style={s('display:flex;gap:10px')}>
          <div style={s('flex:1;min-width:0')}>
            <div style={label}>Our domain</div>
            <select value={domain} onChange={(e) => setDomain(e.target.value)} style={{ ...input }}>
              {ourDomains.length === 0 && <option value="">No domains available</option>}
              {ourDomains.map((d) => <option key={d.domain} value={d.domain}>{d.domain} ({d.total})</option>)}
            </select>
          </div>
          <div style={s('flex:1;min-width:0')}>
            <div style={label}>Search headline / keyword</div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="optional" style={input} />
          </div>
        </div>
        <label style={s('display:flex;align-items:center;gap:8px;font-size:11px;color:#9CA0A6;cursor:pointer')}>
          <input type="checkbox" checked={matchAd} onChange={(e) => setMatchAd(e.target.checked)} />
          Match this ad&apos;s language and country ({adLang || '?'} / {adCountry || '?'})
        </label>

        {err && <div style={s('font-size:11.5px;color:#ff8a80')}>{err}</div>}

        <div style={s('border:1px solid rgba(255,255,255,.08);max-height:44vh;overflow-y:auto')}>
          {links == null && <div style={s('padding:24px;text-align:center;color:#8A8E94;font-size:11px')}>Loading available links...</div>}
          {links != null && links.length === 0 && (
            <div style={s('padding:24px;text-align:center;color:#5A5E64;font-size:11.5px;line-height:1.5')}>
              No available links{matchAd ? ' match this ad on that domain. Turn off the match toggle or pick another domain.' : ' on that domain.'}
            </div>
          )}
          {(links || []).map((l) => (
            <div key={l.url} onClick={() => choose(l)}
              style={s(`display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.045);cursor:${busyUrl ? 'default' : 'pointer'};opacity:${busyUrl && busyUrl !== l.url ? '.5' : '1'}`)}>
              <div style={s('flex:1;min-width:0')}>
                <span style={s('font-size:12px;color:#D6D9DE;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{l.headline || shortUrl(l.url)}</span>
                <span style={s(`font-family:${MONO};font-size:10px;color:#6C7076;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{shortUrl(l.url)}</span>
              </div>
              <span style={s(`font-family:${MONO};font-size:9.5px;color:#8A8E94`)}>{[l.language, l.country].filter(Boolean).join('/')}</span>
              {l.score > 0 && <span style={s(`font-family:${MONO};font-size:9px;color:${A};border:1px solid rgba(232,163,61,.4);padding:1px 5px`)}>match {l.score}</span>}
              <span style={s(`font-family:${MONO};font-size:9.5px;color:${busyUrl === l.url ? A : '#5A5E64'}`)}>{busyUrl === l.url ? 'SAVING...' : 'PICK'}</span>
            </div>
          ))}
        </div>
      </div>
    </Overlay>
  );
}

// ── export the assigned kit to a sheet (mirrors the Fresh Finds sheet export) ──
function KitExportModal({ adIds, competitor, onClose }) {
  const [sheetId, setSheetId] = useState(() => ls(LS_SHEET_ID, ''));
  const [tab, setTab] = useState(() => ls(LS_SHEET_TAB, competitor ? `Kit - ${competitor}` : 'Client Kit'));
  const [cols, setCols] = useState(() => KIT_COLUMN_META.map((m) => m.key));
  const [mode, setMode] = useState('replace');
  const [state, setState] = useState('idle');   // idle | working | done | error
  const [msg, setMsg] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');

  const toggleCol = (key) => setCols((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  const run = async () => {
    if (state === 'working') return;
    const id = parseSheetId(sheetId);
    if (!id) { setState('error'); setMsg('That does not look like a Sheet ID or URL.'); return; }
    if (!tab.trim()) { setState('error'); setMsg('Give the tab a name.'); return; }
    if (!cols.length) { setState('error'); setMsg('Pick at least one column.'); return; }
    if (!adIds.length) { setState('error'); setMsg('Assign a link to at least one ad first.'); return; }
    setState('working'); setMsg('');
    let r;
    try {
      r = await exportKitToSheet({ spreadsheetId: id, tabName: tab.trim(), adIds, columnKeys: cols, mode });
    } catch (e) { setState('error'); setMsg(String(e?.message || e)); return; }
    if (r?.ok) {
      setLs(LS_SHEET_ID, id); setLs(LS_SHEET_TAB, tab.trim());
      setSheetUrl(r.sheetUrl || '');
      setState('done');
      setMsg(`${r.mode === 'replace' ? 'Wrote' : 'Added'} ${r.appended} row${r.appended === 1 ? '' : 's'}${r.created ? ` · created tab "${tab.trim()}"` : ''}${r.skipped ? ` · skipped ${r.skipped} already there` : ''}.`);
    } else {
      setState('error');
      setMsg(REASON[r?.reason] || r?.message || 'Export failed. Please try again.');
      if (r?.saEmail && r?.reason === 'permission') setMsg((m) => `${m} Share the sheet with ${r.saEmail} as Editor.`);
    }
  };

  const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } };
  const label = s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:6px');
  const input = s(`width:100%;background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#E7E8EA;font-family:${MONO};font-size:12px;padding:8px 9px;outline:none;box-sizing:border-box`);
  const canRun = state !== 'working' && cols.length > 0 && adIds.length > 0;

  return (
    <Overlay onClose={onClose} width={540}>
      <ModalHead title="EXPORT KIT TO GOOGLE SHEET" onClose={onClose} />
      <div style={s('padding:18px;display:flex;flex-direction:column;gap:14px;overflow-y:auto')}>
        <div style={s('font-size:11.5px;color:#9CA0A6;line-height:1.5')}>
          Writes <span style={s(`color:${A};font-variant-numeric:tabular-nums`)}>{adIds.length}</span> paired ad{adIds.length === 1 ? '' : 's'} &mdash; the competitor creative beside our link. The competitor&apos;s own URL is never included.
        </div>
        <div>
          <div style={label}>Sheet ID or URL</div>
          <input autoFocus value={sheetId} onChange={(e) => setSheetId(e.target.value)} onKeyDown={onKey}
            placeholder="1KA-szj...  or  https://docs.google.com/spreadsheets/d/.../edit" style={input} />
        </div>
        <div>
          <div style={label}>Tab name</div>
          <input value={tab} onChange={(e) => setTab(e.target.value)} onKeyDown={onKey} style={input} />
        </div>
        <div>
          <div style={label}>When the tab already has data</div>
          <div style={s('display:flex;gap:1px;background:rgba(255,255,255,.06)')}>
            {[['append', 'Add new (skip duplicates)'], ['replace', 'Replace tab']].map(([m, lbl]) => (
              <button key={m} onClick={() => setMode(m)}
                style={s(`flex:1;padding:7px 0;background:${mode === m ? '#1A1C20' : '#0D0E11'};border:none;color:${mode === m ? (m === 'replace' ? '#ff8a80' : A) : '#8A8E94'};font-family:${MONO};font-size:10px;letter-spacing:.3px;cursor:pointer`)}>{lbl}</button>
            ))}
          </div>
        </div>
        <div>
          <div style={s('display:flex;align-items:center;justify-content:space-between;margin-bottom:8px')}>
            <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>Columns ({cols.length}/{KIT_COLUMN_META.length})</div>
            <div style={s('display:flex;gap:12px')}>
              <button onClick={() => setCols(KIT_COLUMN_META.map((m) => m.key))} style={miniBtn('#8A8E94')}>ALL</button>
              <button onClick={() => setCols([])} style={miniBtn('#8A8E94')}>NONE</button>
            </div>
          </div>
          <div style={s('display:flex;flex-wrap:wrap;gap:6px')}>
            {KIT_COLUMN_META.map((m) => {
              const on = cols.includes(m.key);
              return (
                <button key={m.key} onClick={() => toggleCol(m.key)}
                  style={s(`font-family:${MONO};font-size:10px;padding:4px 8px;cursor:pointer;border:1px solid ${on ? A : 'rgba(255,255,255,.12)'};background:${on ? 'rgba(232,163,61,.12)' : '#0B0C0E'};color:${on ? A : '#8A8E94'}`)}>
                  {on ? '✓ ' : ''}{m.header}
                </button>
              );
            })}
          </div>
        </div>
        {msg && (
          <div style={s(`font-size:11.5px;line-height:1.5;color:${state === 'error' ? '#ff8a80' : state === 'done' ? '#86C99A' : '#9CA0A6'}`)}>
            {msg}{' '}
            {state === 'done' && sheetUrl && <a href={sheetUrl} target="_blank" rel="noreferrer" style={s(`color:${A};text-decoration:none`)}>Open sheet &#8599;</a>}
          </div>
        )}
      </div>
      <div style={s('display:flex;justify-content:flex-end;gap:8px;padding:14px 18px;border-top:1px solid rgba(255,255,255,.08)')}>
        <button onClick={onClose} style={s(`font-family:${MONO};font-size:10px;color:#8A8E94;background:none;border:1px solid rgba(255,255,255,.14);padding:6px 12px;cursor:pointer`)}>CLOSE</button>
        <button onClick={run} disabled={!canRun}
          style={s(`font-family:${MONO};font-size:10px;color:#0B0C0E;background:${A};border:none;padding:6px 14px;cursor:${canRun ? 'pointer' : 'default'};opacity:${canRun ? '1' : '.6'}`)}>
          {state === 'working' ? 'EXPORTING...' : 'EXPORT'}
        </button>
      </div>
    </Overlay>
  );
}

// ── small shared bits ─────────────────────────────────────────────────────────
const REASON = {
  'not-configured': 'The articles database or Google Sheets is not configured on the server.',
  'no-domain': 'Pick a domain first.',
  'bad-url': 'That link is not a valid URL.',
  'bad-id': 'That does not look like a Sheet ID or URL.',
  'no-tab': 'Give the tab a name.',
  'no-columns': 'Pick at least one column.',
  'no-rows': 'Nothing to export.',
  'no-assignments': 'Assign a link to at least one ad first.',
  'permission': 'The service account cannot reach that sheet.',
  'taken': 'That link was just taken.',
  'error': 'Something went wrong. Please try again.',
};

const miniBtn = (color) => s(`font-family:${MONO};font-size:9px;letter-spacing:.5px;color:${color};background:none;border:none;cursor:pointer`);

function Overlay({ onClose, width, children }) {
  return (
    <div onClick={onClose} style={s('position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;padding:40px;animation:fadein .12s ease-out')}>
      <div onClick={(e) => e.stopPropagation()} style={s(`width:${width}px;max-width:100%;max-height:88vh;display:flex;flex-direction:column;background:#101216;border:1px solid rgba(255,255,255,.14);box-shadow:0 24px 60px rgba(0,0,0,.6)`)}>
        {children}
      </div>
    </div>
  );
}

function ModalHead({ title, onClose }) {
  return (
    <div style={s('display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.08)')}>
      <span style={s(`font-family:${MONO};font-size:11px;letter-spacing:1px;color:#E7E8EA`)}>&#8599; {title}</span>
      <button onClick={onClose} style={s(`font-family:${MONO};font-size:10px;color:#8A8E94;background:none;border:1px solid rgba(255,255,255,.14);padding:4px 9px;cursor:pointer`)}>CLOSE</button>
    </div>
  );
}

function Empty({ children }) {
  return (
    <div style={s('display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 44px);padding:40px;text-align:center;color:#8A8E94;font-size:13px;line-height:1.6;max-width:560px;margin:0 auto')}>
      <div>{children}</div>
    </div>
  );
}

const Mono = ({ children }) => <span style={s(`font-family:${MONO};color:#C6C9CE`)}>{children}</span>;
