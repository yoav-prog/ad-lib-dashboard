'use client';

// Shared Client Kits UI, used by both competitor sources (Meta ads and RSOC comp rows):
// the modal chrome, the "assign one of our links" panel, and the sheet-export modal. The
// panel and the export are source-agnostic - they take a plain `subject` for matching and
// an `onChoose` / `onExport` the caller wires to the right server action - so the two views
// share one implementation instead of drifting.
import { useEffect, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, langCode, rankLinks, parseSheetId } from '@/lib/ui';
import { searchOurLinks } from '@/app/actions';

export const LS_DOMAIN = 'adintel.kit.ourdomain';
export const LS_NETWORK = 'adintel.kit.ournetwork';
export const LS_SHEET_ID = 'adintel.kit.sheetid';
export const LS_SHEET_TAB = 'adintel.kit.sheettab';

export const shortUrl = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
export const ls = (k, d) => { try { return (typeof window !== 'undefined' && window.localStorage.getItem(k)) || d; } catch { return d; } };
export const setLs = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* ignore */ } };
export const miniBtn = (color) => s(`font-family:${MONO};font-size:9px;letter-spacing:.5px;color:${color};background:none;border:none;cursor:pointer`);

export const REASON = {
  'not-configured': 'The articles database or Google Sheets is not configured on the server.',
  'no-domain': 'Pick a domain first.',
  'bad-url': 'That link is not a valid URL.',
  'bad-id': 'That does not look like a Sheet ID or URL.',
  'no-tab': 'Give the tab a name.',
  'no-columns': 'Pick at least one column.',
  'no-rows': 'Nothing to export.',
  'no-assignments': 'Assign a link to at least one row first.',
  'permission': 'The service account cannot reach that sheet.',
  'taken': 'That link was just taken.',
  'error': 'Something went wrong. Please try again.',
};

export const Mono = ({ children }) => <span style={s(`font-family:${MONO};color:#C6C9CE`)}>{children}</span>;

export function Overlay({ onClose, width, children }) {
  return (
    <div onClick={onClose} style={s('position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;padding:40px;animation:fadein .12s ease-out')}>
      <div onClick={(e) => e.stopPropagation()} style={s(`width:${width}px;max-width:100%;max-height:88vh;display:flex;flex-direction:column;background:#101216;border:1px solid rgba(255,255,255,.14);box-shadow:0 24px 60px rgba(0,0,0,.6)`)}>
        {children}
      </div>
    </div>
  );
}

export function ModalHead({ title, onClose }) {
  return (
    <div style={s('display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.08)')}>
      <span style={s(`font-family:${MONO};font-size:11px;letter-spacing:1px;color:#E7E8EA`)}>&#8599; {title}</span>
      <button onClick={onClose} style={s(`font-family:${MONO};font-size:10px;color:#8A8E94;background:none;border:1px solid rgba(255,255,255,.14);padding:4px 9px;cursor:pointer`)}>CLOSE</button>
    </div>
  );
}

export function Empty({ children }) {
  return (
    <div style={s('display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 88px);padding:40px;text-align:center;color:#8A8E94;font-size:13px;line-height:1.6;max-width:560px;margin:0 auto')}>
      <div>{children}</div>
    </div>
  );
}

// Assign one of our links to a subject (a Meta ad or an RSOC comp row). `subject` carries
// { title, language, country, vertical } for matching/display; `onChoose(link)` persists the
// pick (the caller wires the right action) and returns { ok, reason }.
export function AssignPanel({ subject, ourDomains = [], ourNetworks = [], onClose, onChoose }) {
  const [domain, setDomain] = useState(() => {
    const last = ls(LS_DOMAIN, '');
    if (last && ourDomains.some((d) => d.domain === last)) return last;
    return ourDomains[0]?.domain || '';
  });
  const [network, setNetwork] = useState(() => ls(LS_NETWORK, ''));
  const [matchAd, setMatchAd] = useState(true);
  const [search, setSearch] = useState('');
  const [links, setLinks] = useState(null);
  const [err, setErr] = useState('');
  const [busyUrl, setBusyUrl] = useState('');

  const adLang = langCode(subject.language || subject.creative_language);
  const adCountry = subject.country || '';

  useEffect(() => {
    if (!domain) { setLinks([]); return; }
    let alive = true;
    setLinks(null); setErr('');
    const t = setTimeout(() => {
      searchOurLinks({
        domain,
        network: network || null,
        language: matchAd ? adLang : null,
        country: matchAd ? adCountry : null,
        search: search.trim() || null,
      })
        .then((r) => {
          if (!alive) return;
          if (r?.ok) setLinks(rankLinks(subject, r.links));
          else { setLinks([]); setErr(REASON[r?.reason] || 'Could not load links.'); }
        })
        .catch((e) => { console.error('[kit search] failed', e); if (alive) { setLinks([]); setErr('Could not load links.'); } });
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [domain, network, matchAd, search]);

  const choose = async (link) => {
    if (busyUrl) return;
    setBusyUrl(link.url); setErr('');
    try {
      const r = await onChoose(link);
      if (r?.ok) { setLs(LS_DOMAIN, domain); setLs(LS_NETWORK, network); onClose(); return; }
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
          For <span style={s('color:#C6C9CE')}>{subject.title || 'this row'}</span>
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
            <div style={label}>Network</div>
            <select value={network} onChange={(e) => setNetwork(e.target.value)} style={{ ...input }}>
              <option value="">Any network</option>
              {ourNetworks.map((n) => <option key={n.network} value={n.network}>{n.network} ({n.total})</option>)}
            </select>
          </div>
          <div style={s('flex:1;min-width:0')}>
            <div style={label}>Search headline / keyword</div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="optional" style={input} />
          </div>
        </div>
        <label style={s('display:flex;align-items:center;gap:8px;font-size:11px;color:#9CA0A6;cursor:pointer')}>
          <input type="checkbox" checked={matchAd} onChange={(e) => setMatchAd(e.target.checked)} />
          Match language and country ({adLang || '?'} / {adCountry || '?'})
        </label>

        {err && <div style={s('font-size:11.5px;color:#ff8a80')}>{err}</div>}

        <div style={s('border:1px solid rgba(255,255,255,.08);max-height:44vh;overflow-y:auto')}>
          {links == null && <div style={s('padding:24px;text-align:center;color:#8A8E94;font-size:11px')}>Loading available links...</div>}
          {links != null && links.length === 0 && (
            <div style={s('padding:24px;text-align:center;color:#5A5E64;font-size:11.5px;line-height:1.5')}>
              No available links{matchAd ? ' match on that domain. Turn off the match toggle or pick another domain/network.' : ' on that domain.'}
            </div>
          )}
          {(links || []).map((l) => (
            <div key={l.url} onClick={() => choose(l)}
              style={s(`display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.045);cursor:${busyUrl ? 'default' : 'pointer'};opacity:${busyUrl && busyUrl !== l.url ? '.5' : '1'}`)}>
              <div style={s('flex:1;min-width:0')}>
                <span style={s('font-size:12px;color:#D6D9DE;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{l.headline || shortUrl(l.url)}</span>
                <span style={s(`font-family:${MONO};font-size:10px;color:#6C7076;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{shortUrl(l.url)}</span>
              </div>
              <span style={s(`font-family:${MONO};font-size:9.5px;color:#8A8E94`)}>{[l.network, l.language, l.country].filter(Boolean).join('/')}</span>
              {l.score > 0 && <span style={s(`font-family:${MONO};font-size:9px;color:${A};border:1px solid rgba(232,163,61,.4);padding:1px 5px`)}>match {l.score}</span>}
              <span style={s(`font-family:${MONO};font-size:9.5px;color:${busyUrl === l.url ? A : '#5A5E64'}`)}>{busyUrl === l.url ? 'SAVING...' : 'PICK'}</span>
            </div>
          ))}
        </div>
      </div>
    </Overlay>
  );
}

// Sheet export, source-agnostic: `columnMeta` is the column catalog to offer, `onExport`
// runs the right server action with the chosen sheet/tab/columns/mode.
export function ExportModal({ title = 'EXPORT TO GOOGLE SHEET', count, columnMeta, defaultTab, onExport, onClose }) {
  const [sheetId, setSheetId] = useState(() => ls(LS_SHEET_ID, ''));
  const [tab, setTab] = useState(() => ls(LS_SHEET_TAB, defaultTab || 'Client Kit'));
  const [cols, setCols] = useState(() => columnMeta.map((m) => m.key));
  const [mode, setMode] = useState('replace');
  const [state, setState] = useState('idle');
  const [msg, setMsg] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');

  const toggleCol = (key) => setCols((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  const run = async () => {
    if (state === 'working') return;
    const id = parseSheetId(sheetId);
    if (!id) { setState('error'); setMsg('That does not look like a Sheet ID or URL.'); return; }
    if (!tab.trim()) { setState('error'); setMsg('Give the tab a name.'); return; }
    if (!cols.length) { setState('error'); setMsg('Pick at least one column.'); return; }
    if (!count) { setState('error'); setMsg('Assign a link to at least one row first.'); return; }
    setState('working'); setMsg('');
    let r;
    try {
      r = await onExport({ spreadsheetId: id, tabName: tab.trim(), columnKeys: cols, mode });
    } catch (e) { setState('error'); setMsg(String(e?.message || e)); return; }
    if (r?.ok) {
      setLs(LS_SHEET_ID, id); setLs(LS_SHEET_TAB, tab.trim());
      setSheetUrl(r.sheetUrl || '');
      setState('done');
      setMsg(`${r.mode === 'replace' ? 'Wrote' : 'Added'} ${r.appended} row${r.appended === 1 ? '' : 's'}${r.created ? ` · created tab "${tab.trim()}"` : ''}${r.skipped ? ` · skipped ${r.skipped} already there` : ''}.`);
    } else {
      setState('error');
      let m = REASON[r?.reason] || r?.message || 'Export failed. Please try again.';
      if (r?.saEmail && r?.reason === 'permission') m += ` Share the sheet with ${r.saEmail} as Editor.`;
      setMsg(m);
    }
  };

  const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } };
  const label = s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:6px');
  const input = s(`width:100%;background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#E7E8EA;font-family:${MONO};font-size:12px;padding:8px 9px;outline:none;box-sizing:border-box`);
  const canRun = state !== 'working' && cols.length > 0 && count > 0;

  return (
    <Overlay onClose={onClose} width={540}>
      <ModalHead title={title} onClose={onClose} />
      <div style={s('padding:18px;display:flex;flex-direction:column;gap:14px;overflow-y:auto')}>
        <div style={s('font-size:11.5px;color:#9CA0A6;line-height:1.5')}>
          Writes <span style={s(`color:${A};font-variant-numeric:tabular-nums`)}>{count}</span> paired row{count === 1 ? '' : 's'} &mdash; the competitor beside our link. The competitor&apos;s own URL is never included.
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
            <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>Columns ({cols.length}/{columnMeta.length})</div>
            <div style={s('display:flex;gap:12px')}>
              <button onClick={() => setCols(columnMeta.map((m) => m.key))} style={miniBtn('#8A8E94')}>ALL</button>
              <button onClick={() => setCols([])} style={miniBtn('#8A8E94')}>NONE</button>
            </div>
          </div>
          <div style={s('display:flex;flex-wrap:wrap;gap:6px')}>
            {columnMeta.map((m) => {
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
