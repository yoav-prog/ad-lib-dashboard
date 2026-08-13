'use client';

// Client Kits, "My Assignments": one place to see everything you've paired, across both
// sources (Meta ads and RSOC comp rows), newest first, regardless of which competitor or
// filter you were on when you assigned it. Remove an assignment (freeing its link) or
// download the whole list as CSV. Read comes from loadAllAssignments (enriched server-side).
import { useEffect, useMemo, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO } from '@/lib/ui';
import TableScroll from '@/components/TableScroll';
import { Empty, miniBtn, shortUrl } from '@/components/kit-shared';
import { loadAllAssignments, unassignOurLink, unassignFromComp } from '@/app/actions';

const CSV_COLS = [
  ['Our Link', (i) => i.our_url],
  ['Our Domain', (i) => i.our_domain],
  ['Our Headline', (i) => i.our_headline],
  ['Source', (i) => i.source],
  ['Competitor', (i) => i.subject],
  ['Competitor Detail', (i) => i.subjectMeta],
  ['Assigned By', (i) => i.assigned_by],
  ['Assigned At', (i) => i.assigned_at],
];

function downloadCsv(items) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [CSV_COLS.map(([h]) => esc(h)).join(',')];
  for (const i of items) lines.push(CSV_COLS.map(([, get]) => esc(get(i))).join(','));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'client-kits-assignments.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export default function ClientKitsSaved({ canBuild = false }) {
  const [items, setItems] = useState(null);   // null=loading
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [busyKey, setBusyKey] = useState('');

  const load = () => {
    setItems(null); setErr('');
    loadAllAssignments()
      .then((r) => { if (r?.ok) setItems(r.items); else { setItems([]); setErr('Could not load your assignments.'); } })
      .catch((e) => { console.error('[kit saved] load failed', e); setItems([]); setErr('Could not load your assignments.'); });
  };
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items || [];
    return (items || []).filter((i) => [i.our_url, i.our_domain, i.our_headline, i.subject, i.subjectMeta, i.source].some((v) => String(v || '').toLowerCase().includes(needle)));
  }, [items, q]);

  const remove = async (i) => {
    if (busyKey) return;
    const key = `${i.source}:${i.ref}`;
    setBusyKey(key);
    try {
      const r = i.source === 'rsoc' ? await unassignFromComp({ compRowId: i.ref }) : await unassignOurLink({ adId: i.ref });
      if (r?.ok) setItems((p) => (p || []).filter((x) => !(x.source === i.source && String(x.ref) === String(i.ref))));
    } catch (e) { console.error('[kit saved] remove failed', e); }
    setBusyKey('');
  };

  return (
    <div>
      <div style={s('display:flex;align-items:center;gap:12px;min-height:56px;padding:10px 24px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.09)')}>
        <h1 style={s('font-size:16px;font-weight:600;color:#F0F1F3;margin:0')}>My Assignments</h1>
        <span style={s(`font-family:${MONO};font-size:12px;color:#6C7076`)}>{items == null ? 'loading...' : `${shown.length}${q ? ` / ${items.length}` : ''} link${(items?.length === 1) ? '' : 's'} paired`}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by link, competitor, domain..."
          style={s(`flex:1;min-width:180px;max-width:360px;background:#0B0C0E;border:1px solid rgba(255,255,255,.1);color:#E7E8EA;font-family:${MONO};font-size:12px;padding:6px 9px;outline:none`)} />
        <div style={s('flex:1')} />
        <button onClick={load} style={s(`font-family:${MONO};font-size:10px;color:#8A8E94;background:none;border:1px solid rgba(255,255,255,.14);padding:7px 12px;cursor:pointer`)}>REFRESH</button>
        <button onClick={() => downloadCsv(shown)} disabled={!shown.length}
          style={s(`font-family:${MONO};font-size:10px;letter-spacing:.4px;color:${shown.length ? '#0B0C0E' : '#6C7076'};background:${shown.length ? A : '#1A1C20'};border:none;padding:8px 14px;cursor:${shown.length ? 'pointer' : 'default'}`)}>
          &#8595; DOWNLOAD CSV ({shown.length})
        </button>
      </div>

      {items == null && <div style={s('padding:40px 24px;text-align:center;color:#8A8E94;font-size:12px')}>Loading your assignments...</div>}
      {err && <div style={s('padding:40px 24px;text-align:center;color:#ff8a80;font-size:12px')}>{err}</div>}
      {items != null && items.length === 0 && !err && (
        <Empty>Nothing paired yet. Assign an our-link to a competitor in the Meta Ads or RSOC source, and it will show up here.</Empty>
      )}

      {items != null && items.length > 0 && (
        <TableScroll label="clientkits-saved">
          <div style={s('display:flex;align-items:center;height:26px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase;min-width:1120px')}>
            <div style={s('width:52px')}>Ad</div>
            <div style={s('flex:1')}>Competitor</div>
            <div style={s('width:70px')}>Source</div>
            <div style={s('width:430px;padding-left:20px')}>Our Link</div>
            <div style={s('width:150px')}>Assigned</div>
            {canBuild && <div style={s('width:70px')} />}
          </div>

          {shown.map((i) => (
            <div key={`${i.source}:${i.ref}`} style={s('display:flex;align-items:center;min-height:60px;padding:8px 24px;border-bottom:1px solid rgba(255,255,255,.045);min-width:1120px')}>
              <div style={s('width:52px')}>
                {i.thumb
                  ? <img src={i.thumb} alt="" style={s('width:40px;height:40px;object-fit:cover;background:#141619;border:1px solid rgba(255,255,255,.08)')} />
                  : <div style={s('width:40px;height:40px;background:#0F1113;border:1px dashed rgba(255,255,255,.1)')} />}
              </div>
              <div style={s('flex:1;padding-right:16px;min-width:0')}>
                <span style={s('font-size:12.5px;color:#C6C9CE;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{i.subject}</span>
                <span style={s(`font-family:${MONO};font-size:10px;color:#6C7076;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{i.subjectMeta || '-'}</span>
              </div>
              <div style={s('width:70px')}>
                <span style={s(`font-family:${MONO};font-size:9px;letter-spacing:.4px;padding:2px 6px;border:1px solid rgba(255,255,255,.14);color:${i.source === 'rsoc' ? A : '#8A8E94'}`)}>{i.source === 'rsoc' ? 'RSOC' : 'META'}</span>
              </div>
              <div style={s('width:430px;padding-left:20px;min-width:0')}>
                <a href={i.our_url} target="_blank" rel="noreferrer"
                  style={s(`font-family:${MONO};font-size:11px;color:${A};text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{shortUrl(i.our_url)}</a>
                <span style={s('font-size:10px;color:#6C7076;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{i.our_headline || i.our_domain}</span>
              </div>
              <div style={s(`width:150px;font-family:${MONO};font-size:10px;color:#8A8E94`)}>
                {i.assigned_at ? i.assigned_at.slice(0, 10) : '-'}{i.assigned_by ? <span style={s('color:#5A5E64;display:block')}>{i.assigned_by}</span> : null}
              </div>
              {canBuild && (
                <div style={s('width:70px')}>
                  <button onClick={() => remove(i)} disabled={busyKey === `${i.source}:${i.ref}`} style={miniBtn('#ff8a80')}>
                    {busyKey === `${i.source}:${i.ref}` ? '...' : 'REMOVE'}
                  </button>
                </div>
              )}
            </div>
          ))}
          {shown.length === 0 && q && (
            <div style={s('padding:40px 24px;text-align:center;color:#5A5E64;font-size:12px')}>No assignments match &quot;{q}&quot;.</div>
          )}
        </TableScroll>
      )}
    </div>
  );
}
