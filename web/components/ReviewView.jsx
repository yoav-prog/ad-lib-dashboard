'use client';

import { useMemo, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, firstUrl, hostOf, pad, relTime } from '@/lib/ui';
import Thumb from '@/components/Thumb';

// The review queue: ads the scraper fetched for a tracked domain whose
// destination does NOT point at that domain (the Ad Library keyword search
// drags them in). A human decides: APPROVE moves the ad into the feed,
// REJECT hides it for good (the row is kept so dedup never re-imports it).
export default function ReviewView({ ads, NOW, canEdit, query, onDecide }) {
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return ads;
    return ads.filter((a) => {
      const hay = [a.page_name, a.domain, a.title, a.caption, a.body_text, a.link_url]
        .filter(Boolean).join(' ').toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [ads, query]);

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

  return (
    <div>
      {/* header strip: what this queue is + bulk actions */}
      <div style={s('display:flex;align-items:center;gap:14px;height:46px;padding:0 16px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.09)')}>
        <span style={s(`font-family:${MONO};font-size:12px;color:#E7E8EA;font-variant-numeric:tabular-nums`)}>{pad(filtered.length)} <span style={s('color:#5A5E64')}>waiting for review</span></span>
        <span style={s('font-size:11px;color:#6C7076')}>These ads matched a domain&apos;s keyword search but do not lead to that domain. Approve to add them to the feed, reject to drop them permanently.</span>
        <span style={s('flex:1')} />
        {canEdit && selIds.length > 0 && (
          <>
            <span style={s(`font-family:${MONO};font-size:11px;color:${A}`)}>{selIds.length} selected</span>
            <button onClick={() => decide(selIds, 'approved')} disabled={busy} style={actBtn('#7BC97E', 'rgba(123,201,126,.35)')}>✓ APPROVE</button>
            <button onClick={() => decide(selIds, 'rejected')} disabled={busy} style={actBtn('#ff8a80', 'rgba(255,120,120,.35)')}>✕ REJECT</button>
          </>
        )}
      </div>

      {/* column header */}
      <div style={s('display:flex;align-items:center;height:26px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase;min-width:1100px')}>
        {canEdit && (
          <div style={s('width:28px;flex-shrink:0;display:flex;align-items:center')}>
            <span onClick={() => setSelected(allSelected ? new Set() : new Set(ids))} title="Select all"
              style={s(`width:13px;height:13px;border:1px solid ${allSelected ? A : 'rgba(255,255,255,.25)'};background:${allSelected ? A : 'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:9px;color:#0B0C0E;line-height:1`)}>{allSelected ? '✓' : ''}</span>
          </div>
        )}
        <div style={s('width:56px;flex-shrink:0')} />
        <div style={s('width:150px;flex-shrink:0')}>Page</div>
        <div style={s('width:140px;flex-shrink:0')}>Searched Domain</div>
        <div style={s('width:170px;flex-shrink:0')}>Actually Leads To</div>
        <div style={s('flex:1;min-width:0')}>Headline</div>
        <div style={s('width:80px;flex-shrink:0;text-align:right')}>Added</div>
        {canEdit && <div style={s('width:170px;flex-shrink:0;text-align:right')}>Decision</div>}
      </div>

      {filtered.map((a) => {
        const isSel = selected.has(a.ad_archive_id);
        const url = firstUrl(a.link_url);
        const host = hostOf(url);
        return (
          <div key={a.ad_archive_id}
            style={s(`display:flex;align-items:center;min-height:56px;min-width:1100px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.045);background:${isSel ? 'rgba(232,163,61,.09)' : 'transparent'}`)}>
            {canEdit && (
              <div onClick={() => toggle(a.ad_archive_id)} style={s('width:28px;flex-shrink:0;display:flex;align-items:center;cursor:pointer')}>
                <span style={s(`width:13px;height:13px;border:1px solid ${isSel ? A : 'rgba(255,255,255,.22)'};background:${isSel ? A : 'transparent'};display:flex;align-items:center;justify-content:center;font-size:9px;color:#0B0C0E;line-height:1`)}>{isSel ? '✓' : ''}</span>
              </div>
            )}
            <div style={s('width:56px;flex-shrink:0;padding-right:12px')}><Thumb ad={a} size={44} /></div>
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
          <div style={s('font-size:13px;color:#8A8E94')}>{ads.length ? 'No queued ads match your search.' : 'Nothing waiting for review.'}</div>
          {!ads.length && <div style={s('font-size:11px;color:#5A5E64;margin-top:6px')}>Ads whose destination does not match their searched domain will show up here after each scrape.</div>}
        </div>
      )}
    </div>
  );
}
