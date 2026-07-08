'use client';

import { useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, relTime, pad } from '@/lib/ui';
import { addDomain, updateDomain, deleteDomain, addFeed, triggerScrape } from '@/app/actions';

const CADENCES = ['hourly', 'daily', 'weekly', 'paused'];

export default function ControlRoom({ ads, domains, runs, NOW, query = '', feeds = [], canEdit = true }) {
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('ALL');
  const [maxAds, setMaxAds] = useState(100);
  const [feed, setFeed] = useState('');
  const [newFeed, setNewFeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');

  const adsByDomain = {};
  ads.forEach((a) => { if (a.domain) adsByDomain[a.domain] = (adsByDomain[a.domain] || 0) + 1; });

  const term = (query || '').trim().toLowerCase();
  const shownDomains = term ? domains.filter((d) => (d.query || '').toLowerCase().includes(term)) : domains;

  const lastCompleted = runs.find((r) => r.status === 'completed' && r.finished_at);
  const dueTimes = domains.filter((d) => d.enabled && d.cadence !== 'paused' && d.next_run_at).map((d) => d.next_run_at).sort();
  const nextDue = dueTimes[0];

  const addDomainSubmit = async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    try {
      await addDomain({ query: q.trim(), country: country.trim() || 'ALL', max_ads: Number(maxAds) || 100, feed: feed || null });
      setQ('');
    } finally {
      setBusy(false);
    }
  };

  const addFeedSubmit = async () => {
    const n = newFeed.trim();
    if (!n) return;
    await addFeed(n);
    setFeed(n);
    setNewFeed('');
  };

  const runNow = async () => {
    if (running) return;
    setRunning(true);
    setRunMsg('');
    try {
      const r = await triggerScrape();
      if (r?.dispatched) setRunMsg('Scrape dispatched to GitHub Actions. New ads will appear here shortly.');
      else if (r?.reason === 'no-dispatch-token') setRunMsg('All active domains marked due. Set GH_DISPATCH_TOKEN + GH_REPO to fire instantly, otherwise the scheduled runner picks them up on its next tick.');
      else setRunMsg(`Could not dispatch (status ${r?.status ?? '?'}). Domains were still marked due.`);
    } catch (e) {
      setRunMsg('Run failed: ' + String(e));
    } finally {
      setRunning(false);
    }
  };

  const inputStyle = 'background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#E7E8EA;font-size:12px;padding:8px 10px;outline:none';

  return (
    <div style={s('max-width:1160px')}>
      <div style={s('display:flex;align-items:center;gap:12px;height:44px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.06)')}>
        <span style={s(`font-family:${MONO};font-size:12px;letter-spacing:1px;color:#E7E8EA`)}>CONTROL ROOM</span>
        {!canEdit && <span style={s(`font-family:${MONO};font-size:9.5px;color:#6C7076;border:1px solid rgba(255,255,255,.12);padding:2px 7px`)}>VIEWER · READ-ONLY</span>}
      </div>

      {/* run summary + run now */}
      <div style={s('padding:22px 24px;border-bottom:1px solid rgba(255,255,255,.06)')}>
        <div style={s('display:flex;align-items:flex-end;justify-content:space-between')}>
          <div style={s('flex:1')}>
            <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:12px')}>Scrape Status</div>
            <div style={s('display:flex;gap:34px')}>
              <Stat label="Next Due" value={nextDue ? relFuture(nextDue, NOW) : '-'} color={A} />
              <Stat label="Last Run" value={lastCompleted ? relTime(NOW - new Date(lastCompleted.finished_at).getTime()) : 'never'} color="#C6C9CE" />
              <Stat label="Last New / Errors" value={lastCompleted ? `+${lastCompleted.ads_new} / ${lastCompleted.errors}` : '-'} color="#C6C9CE" />
              <Stat label="Total Runs" value={pad(runs.length)} color="#C6C9CE" />
            </div>
          </div>
          {canEdit && (
            <button onClick={runNow} disabled={running}
              style={s(`font-family:${MONO};font-size:11px;letter-spacing:.5px;color:#0B0C0E;background:${running ? '#5A5E64' : A};border:none;padding:9px 16px;cursor:${running ? 'default' : 'pointer'}`)}>
              {running ? 'STARTING...' : '► RUN NOW'}
            </button>
          )}
        </div>
        {runMsg && <div style={s('font-size:11px;color:#9CA0A6;margin-top:12px;line-height:1.5;max-width:640px')}>{runMsg}</div>}
      </div>

      {/* feeds */}
      {canEdit && (
        <div style={s('padding:18px 24px;border-bottom:1px solid rgba(255,255,255,.06)')}>
          <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:10px')}>Feeds</div>
          <div style={s('display:flex;align-items:center;gap:8px;flex-wrap:wrap')}>
            {feeds.map((f) => (
              <span key={f.id} style={s(`font-family:${MONO};font-size:11px;color:#C6C9CE;background:#101216;border:1px solid rgba(255,255,255,.1);padding:4px 9px`)}>{f.name}</span>
            ))}
            {feeds.length === 0 && <span style={s('font-size:11px;color:#5A5E64')}>none yet</span>}
            <input value={newFeed} onChange={(e) => setNewFeed(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addFeedSubmit()}
              placeholder="new feed name" style={s(`${inputStyle};width:150px;padding:5px 9px`)} />
            <button onClick={addFeedSubmit} style={s(`font-family:${MONO};font-size:10px;color:#C6C9CE;background:none;border:1px dashed rgba(255,255,255,.16);padding:5px 10px;cursor:pointer`)}>+ FEED</button>
          </div>
        </div>
      )}

      {/* domains */}
      <div style={s('padding:22px 24px')}>
        <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:12px')}>Tracked Domains / Queries</div>

        {canEdit && (
          <div style={s('display:flex;gap:8px;margin-bottom:14px')}>
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addDomainSubmit()}
              placeholder="competitor.com or keyword" style={s(`flex:1;${inputStyle}`)} />
            <select value={feed} onChange={(e) => setFeed(e.target.value)}
              style={s(`${inputStyle};font-family:${MONO};min-width:120px`)}>
              <option value="">(no feed)</option>
              {feeds.map((f) => <option key={f.id} value={f.name}>{f.name}</option>)}
            </select>
            <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="ALL"
              style={s(`width:70px;${inputStyle};font-family:${MONO};text-align:center`)} />
            <input type="number" value={maxAds} onChange={(e) => setMaxAds(e.target.value)}
              style={s(`width:80px;${inputStyle};font-family:${MONO};text-align:center`)} />
            <button onClick={addDomainSubmit} disabled={busy}
              style={s(`font-family:${MONO};font-size:10.5px;color:#0B0C0E;background:${busy ? '#5A5E64' : A};border:none;padding:0 16px;cursor:${busy ? 'default' : 'pointer'}`)}>
              {busy ? 'ADDING...' : '+ ADD'}
            </button>
          </div>
        )}

        <div style={s('border:1px solid rgba(255,255,255,.08)')}>
          <div style={s('display:flex;align-items:center;height:28px;padding:0 14px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase')}>
            <div style={s('flex:1')}>Domain / Query</div>
            <div style={s('width:110px')}>Feed</div>
            <div style={s('width:66px;text-align:center')}>Country</div>
            <div style={s('width:80px;text-align:right')}>Max Ads</div>
            <div style={s('width:70px;text-align:center')}>Held</div>
            <div style={s('width:100px;text-align:center')}>Cadence</div>
            <div style={s('width:86px;text-align:center')}>Status</div>
            <div style={s('width:32px')} />
          </div>

          {domains.length === 0 && (
            <div style={s('padding:22px 14px;text-align:center;color:#5A5E64;font-size:12px')}>No domains yet. Add one above to start tracking a competitor.</div>
          )}
          {domains.length > 0 && shownDomains.length === 0 && (
            <div style={s('padding:22px 14px;text-align:center;color:#5A5E64;font-size:12px')}>No domains match your search.</div>
          )}

          {shownDomains.map((d) => (
            <div key={d.id} style={s('display:flex;align-items:center;height:44px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.045)')}>
              <div style={s('flex:1;min-width:0')}>
                <div style={s('font-size:12px;color:#E7E8EA;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{d.query}</div>
              </div>
              <div style={s(`width:110px;font-family:${MONO};font-size:10.5px;color:#9CA0A6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{d.feed || '-'}</div>
              <div style={s(`width:66px;text-align:center;font-family:${MONO};font-size:11px;color:#B6B9BE`)}>{d.country}</div>
              <div style={s(`width:80px;text-align:right;font-family:${MONO};font-size:13px;color:#C6C9CE;font-variant-numeric:tabular-nums`)}>{d.max_ads}</div>
              <div style={s(`width:70px;text-align:center;font-family:${MONO};font-size:13px;color:#E7E8EA;font-variant-numeric:tabular-nums`)}>{adsByDomain[d.query] || 0}</div>
              <div style={s('width:100px;display:flex;justify-content:center')}>
                {canEdit ? (
                  <button onClick={() => updateDomain(d.id, { cadence: CADENCES[(CADENCES.indexOf(d.cadence) + 1) % CADENCES.length] })}
                    style={s(`font-family:${MONO};font-size:10px;color:${d.cadence === 'paused' ? '#6C7076' : A};background:none;border:1px solid rgba(255,255,255,.12);padding:3px 10px;cursor:pointer;letter-spacing:.5px`)}>
                    {d.cadence.toUpperCase()}
                  </button>
                ) : (
                  <span style={s(`font-family:${MONO};font-size:10px;color:${d.cadence === 'paused' ? '#6C7076' : A}`)}>{d.cadence.toUpperCase()}</span>
                )}
              </div>
              <div style={s('width:86px;text-align:center')}>
                {canEdit ? (
                  <button onClick={() => updateDomain(d.id, { enabled: !d.enabled })}
                    style={s(`display:inline-flex;align-items:center;gap:5px;background:none;border:1px solid ${d.enabled ? 'rgba(232,163,61,.4)' : 'rgba(255,255,255,.12)'};padding:3px 8px;cursor:pointer`)}>
                    <span style={s(`width:6px;height:6px;border-radius:50%;background:${d.enabled ? A : '#5A5E64'}`)} />
                    <span style={s(`font-family:${MONO};font-size:9.5px;color:${d.enabled ? A : '#6C7076'}`)}>{d.enabled ? 'ACTIVE' : 'PAUSED'}</span>
                  </button>
                ) : (
                  <span style={s(`font-family:${MONO};font-size:9.5px;color:${d.enabled ? A : '#6C7076'}`)}>{d.enabled ? 'ACTIVE' : 'PAUSED'}</span>
                )}
              </div>
              <div style={s('width:32px;display:flex;justify-content:flex-end')}>
                {canEdit && (
                  <button onClick={() => { if (confirm(`Delete "${d.query}"? This stops tracking it (existing ads stay).`)) deleteDomain(d.id); }}
                    title="Delete"
                    style={s('background:none;border:none;color:#8A8E94;font-size:15px;cursor:pointer;padding:2px 6px')}>×</button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div style={s('font-size:10px;color:#5A5E64;line-height:1.6;margin-top:12px')}>
          Changes write to the database immediately. The scheduled runner reads these to decide what to scrape and when; &ldquo;Run now&rdquo; makes every active domain due at once.
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <div style={s('font-size:9px;letter-spacing:.8px;color:#5A5E64;text-transform:uppercase')}>{label}</div>
      <div style={s(`font-family:${MONO};font-size:14px;color:${color};margin-top:3px`)}>{value}</div>
    </div>
  );
}

function relFuture(iso, now) {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'due now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}
