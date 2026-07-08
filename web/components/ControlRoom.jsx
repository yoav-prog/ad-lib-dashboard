'use client';

import { useEffect, useRef, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, relTime, pad } from '@/lib/ui';
import { addDomain, updateDomain, deleteDomain, addFeed } from '@/app/actions';

const CADENCES = ['hourly', 'daily', 'weekly', 'paused'];

export default function ControlRoom({
  ads, domains, runs, NOW, query = '', feeds = [], canEdit = true,
  runStatus = { active: null, lastRun: null }, runLogs = [], pending = false,
  onRunNow, onMarkFailed, onSeeNewAds, onStop,
}) {
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('ALL');
  const [maxAds, setMaxAds] = useState(100);
  const [feed, setFeed] = useState('');
  const [newFeed, setNewFeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [runMsg, setRunMsg] = useState('');

  const active = runStatus?.active || null;
  const lastRun = runStatus?.lastRun || null;
  const isBusy = pending || !!active;

  // What a click will actually scrape, so it is never a mystery: every active
  // (enabled, non-paused) domain, each up to its own Max Ads.
  const activeDomains = domains.filter((d) => d.enabled && d.cadence !== 'paused');
  const scopeAdsMax = activeDomains.reduce((n, d) => n + (d.max_ads || 0), 0);
  const scopeNames = activeDomains.slice(0, 3).map((d) => d.query).join(', ')
    + (activeDomains.length > 3 ? `, +${activeDomains.length - 3} more` : '');
  const scopeText = activeDomains.length
    ? `Runs ${activeDomains.length} active ${activeDomains.length === 1 ? 'domain' : 'domains'} (${scopeNames}), up to ${scopeAdsMax} ads total.`
    : 'No active domains. Add one below, or un-pause a domain, before running.';

  const recentlyFinished = lastRun?.finished_at
    && Date.now() - new Date(lastRun.finished_at).getTime() < 10 * 60 * 1000;
  const showLivePanel = pending || !!active || recentlyFinished;

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
    if (isBusy || !onRunNow) return;
    setRunMsg('');
    try {
      const r = await onRunNow();
      if (r?.dispatched) setRunMsg('Scrape dispatched. The runner is spinning up now; live status appears below in a moment.');
      else if (r?.reason === 'no-dispatch-token') setRunMsg('All active domains marked due. Set GH_DISPATCH_TOKEN + GH_REPO to fire instantly, otherwise the scheduled runner picks them up on its next tick.');
      else setRunMsg(`Could not dispatch (status ${r?.status ?? '?'}). Domains were still marked due.`);
    } catch (e) {
      setRunMsg('Run failed: ' + String(e));
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
            <div style={s('display:flex;flex-direction:column;align-items:flex-end;gap:7px')}>
              <button onClick={runNow} disabled={isBusy}
                style={s(`font-family:${MONO};font-size:11px;letter-spacing:.5px;color:#0B0C0E;background:${isBusy ? '#5A5E64' : A};border:none;padding:9px 16px;cursor:${isBusy ? 'default' : 'pointer'}`)}>
                {pending ? 'STARTING...' : active ? (active.stale ? 'STALLED' : 'RUNNING...') : '► RUN NOW'}
              </button>
              <span style={s('font-size:10px;color:#5A5E64;max-width:280px;text-align:right;line-height:1.4')}>{scopeText}</span>
            </div>
          )}
        </div>
        {runMsg && <div style={s('font-size:11px;color:#9CA0A6;margin-top:12px;line-height:1.5;max-width:640px')}>{runMsg}</div>}
      </div>

      {/* live run panel: exactly what the run is doing, its status, and full logs */}
      {showLivePanel && (
        <LiveRunPanel active={active} pending={pending} lastRun={lastRun} logs={runLogs}
          canEdit={canEdit} onMarkFailed={onMarkFailed} onSeeNewAds={onSeeNewAds} onStop={onStop} />
      )}

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

      <RunHistory runs={runs} canEdit={canEdit} NOW={NOW} />
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

// ═════════════════════════════════════════════════════════════════════════════
// LIVE RUN PANEL - what the run is doing, its exact status, and the full log
// ═════════════════════════════════════════════════════════════════════════════
const LEVEL_COLOR = { info: '#9CA0A6', warn: '#E8A33D', error: '#E06C5A', success: '#6FCF97' };

function fmtDuration(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s2 = sec % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s2)}`;
  return `${m}:${pad(s2)}`;
}

function LiveRunPanel({ active, pending, lastRun, logs, canEdit, onMarkFailed, onSeeNewAds, onStop }) {
  const stalled = active && active.stale;
  const running = active && !active.stale;
  const finished = !active && lastRun;
  const failed = finished && lastRun.status === 'failed';
  const completed = finished && lastRun.status === 'completed';

  let tone = '#9CA0A6', label = '', dotColor = '#5A5E64', dotPulse = false;
  if (pending && !active) { tone = A; label = 'STARTING'; dotColor = A; dotPulse = true; }
  else if (running) { tone = A; label = 'RUNNING'; dotColor = A; dotPulse = true; }
  else if (stalled) { tone = '#E8A33D'; label = 'STALLED'; dotColor = '#E8A33D'; }
  else if (failed) { tone = '#E06C5A'; label = 'FAILED'; dotColor = '#E06C5A'; }
  else if (completed) { tone = '#6FCF97'; label = 'COMPLETED'; dotColor = '#6FCF97'; }

  const done = active?.domains_done ?? 0;
  const total = active?.domains_total ?? 0;
  const found = active?.ads_found_so_far ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : (running ? 5 : 0);
  const elapsed = active ? fmtDuration(active.elapsed_seconds) : '';

  let eta = '';
  if (running && total > 0 && done > 0 && done < total && active.elapsed_seconds > 5) {
    const remaining = Math.round((active.elapsed_seconds / done) * (total - done));
    if (remaining > 30) eta = `~${fmtDuration(remaining)} left`;
  }

  return (
    <div style={s('padding:18px 24px;border-bottom:1px solid rgba(255,255,255,.06)')}>
      <div style={s('display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap')}>
        <span style={s(`width:8px;height:8px;border-radius:50%;background:${dotColor}${dotPulse ? ';animation:freshpulse 1.6s ease-in-out infinite' : ''}`)} />
        <span style={s(`font-family:${MONO};font-size:11px;letter-spacing:1.5px;color:${tone}`)}>{label}</span>
        {running && <span style={s('font-size:11px;color:#8A8E94')}>scraping <span style={s('color:#E7E8EA')}>{active.current_domain || '...'}</span></span>}
        {pending && !active && <span style={s('font-size:11px;color:#8A8E94')}>waiting for the runner to spin up (up to a minute on first boot)</span>}
        {completed && <span style={s('font-size:11px;color:#8A8E94')}>{lastRun.ads_new > 0 ? `+${lastRun.ads_new} new ${lastRun.ads_new === 1 ? 'ad' : 'ads'}` : 'no new ads this run'} · {relTime(Date.now() - new Date(lastRun.finished_at).getTime())}</span>}
        {failed && <span style={s('font-size:11px;color:#B08A84')}>{(lastRun.error_detail || 'run failed').slice(0, 140)}</span>}
        {(pending || running || stalled) && canEdit && (
          <>
            <span style={s('flex:1')} />
            <button onClick={() => onStop && onStop()}
              style={s(`font-family:${MONO};font-size:10px;letter-spacing:.5px;color:#E06C5A;background:none;border:1px solid rgba(224,108,90,.4);padding:5px 12px;cursor:pointer;white-space:nowrap`)}>&#9632; STOP</button>
          </>
        )}
      </div>

      {(running || stalled) && total > 0 && (
        <div style={s('display:flex;align-items:center;gap:26px;margin-bottom:14px;flex-wrap:wrap')}>
          <LiveStat label="Competitor" value={`${done} / ${total}`} />
          <LiveStat label="New Found" value={String(found)} color={A} />
          <LiveStat label="Elapsed" value={elapsed} />
          {eta && <LiveStat label="Remaining" value={eta} />}
          <div style={s('flex:1;min-width:120px')}>
            <div style={s('height:3px;background:rgba(255,255,255,.08)')}>
              <div style={s(`height:100%;width:${Math.min(100, Math.max(3, pct))}%;background:${stalled ? '#E8A33D' : A};transition:width .4s`)} />
            </div>
          </div>
        </div>
      )}

      {stalled && canEdit && (
        <div style={s('display:flex;align-items:center;gap:12px;margin-bottom:14px;padding:10px 12px;background:rgba(232,163,61,.07);border:1px solid rgba(232,163,61,.28)')}>
          <span style={s('font-size:11.5px;color:#D8C08A;flex:1;line-height:1.5')}>No heartbeat for 90 seconds or more. The run may have died on the runner. Mark it failed to clear the lock, then you can run again.</span>
          <button onClick={() => onMarkFailed && onMarkFailed(active.id)}
            style={s(`font-family:${MONO};font-size:10px;letter-spacing:.5px;color:#0B0C0E;background:#E8A33D;border:none;padding:6px 12px;cursor:pointer;white-space:nowrap`)}>MARK FAILED</button>
        </div>
      )}

      {completed && lastRun.ads_new > 0 && (
        <div style={s('margin-bottom:14px')}>
          <button onClick={() => onSeeNewAds && onSeeNewAds()}
            style={s(`font-family:${MONO};font-size:11px;letter-spacing:.5px;color:#0B0C0E;background:${A};border:none;padding:8px 14px;cursor:pointer`)}>
            SEE {lastRun.ads_new} NEW {lastRun.ads_new === 1 ? 'AD' : 'ADS'} →
          </button>
        </div>
      )}

      <LogConsole logs={logs} />
    </div>
  );
}

function LiveStat({ label, value, color = '#E7E8EA' }) {
  return (
    <div>
      <div style={s('font-size:9px;letter-spacing:.8px;color:#5A5E64;text-transform:uppercase')}>{label}</div>
      <div style={s(`font-family:${MONO};font-size:14px;color:${color};margin-top:3px;font-variant-numeric:tabular-nums`)}>{value}</div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// RUN HISTORY - past runs, each expandable to its full stored logs (failed too)
// ═════════════════════════════════════════════════════════════════════════════
function RunHistory({ runs, canEdit, NOW }) {
  const [openId, setOpenId] = useState(null);
  const [logsById, setLogsById] = useState({});
  const [loadingId, setLoadingId] = useState(null);

  if (!runs || runs.length === 0) return null;

  const toggle = async (id) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    if (canEdit && !logsById[id]) {
      setLoadingId(id);
      try {
        const res = await fetch(`/api/run-logs?runId=${encodeURIComponent(id)}`, { cache: 'no-store' });
        const data = res.ok ? await res.json() : { logs: [] };
        setLogsById((m) => ({ ...m, [id]: data.logs || [] }));
      } catch {
        setLogsById((m) => ({ ...m, [id]: [] }));
      } finally {
        setLoadingId(null);
      }
    }
  };

  return (
    <div style={s('padding:22px 24px;border-top:1px solid rgba(255,255,255,.06)')}>
      <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:12px')}>Run History</div>
      <div style={s('border:1px solid rgba(255,255,255,.08)')}>
        {runs.map((r) => {
          const open = openId === r.id;
          const dur = r.finished_at && r.started_at
            ? fmtDuration((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)
            : (r.status === 'running' ? 'live' : '-');
          const statusColor = r.status === 'completed' ? '#6FCF97' : r.status === 'failed' ? '#E06C5A' : A;
          return (
            <div key={r.id} style={s('border-bottom:1px solid rgba(255,255,255,.045)')}>
              <div onClick={() => toggle(r.id)}
                style={s(`display:flex;align-items:center;gap:12px;min-height:40px;padding:8px 14px;cursor:pointer;background:${open ? 'rgba(255,255,255,.02)' : 'transparent'}`)}>
                <span style={s(`font-family:${MONO};font-size:9px;letter-spacing:.5px;color:${statusColor};border:1px solid ${statusColor}44;padding:2px 6px;width:76px;text-align:center;flex-shrink:0`)}>{r.status.toUpperCase()}</span>
                <span style={s('font-size:11.5px;color:#C6C9CE;flex:1;min-width:0')}>{r.started_at ? relTime(NOW - new Date(r.started_at).getTime()) : '-'}</span>
                <span style={s(`font-family:${MONO};font-size:10.5px;color:#8A8E94;width:74px;text-align:right;flex-shrink:0`)}>{dur}</span>
                <span style={s(`font-family:${MONO};font-size:10.5px;color:#8A8E94;width:130px;text-align:right;flex-shrink:0`)}>+{r.ads_new ?? 0} new / {r.errors ?? 0} err</span>
                <span style={s(`font-family:${MONO};font-size:12px;color:#5A5E64;width:14px;text-align:center;flex-shrink:0`)}>{open ? '−' : '+'}</span>
              </div>
              {open && (
                <div style={s('padding:0 14px 14px')}>
                  {!canEdit
                    ? <div style={s('font-size:11px;color:#5A5E64')}>Logs are visible to admins only.</div>
                    : loadingId === r.id
                      ? <div style={s('font-size:11px;color:#5A5E64')}>loading logs...</div>
                      : (logsById[r.id]?.length ?? 0) === 0
                        ? <div style={s('font-size:11px;color:#5A5E64;line-height:1.6')}>No logs stored for this run. It ran before live logging was added, so only the summary above was recorded. Runs from now on capture their full log here.</div>
                        : <LogConsole logs={logsById[r.id]} title="Run Log" />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Full raw console. Auto-scrolls to the newest line, but stops sticking the
// moment you scroll up to read, so you can inspect history mid-run.
function LogConsole({ logs, title = 'Live Log' }) {
  const ref = useRef(null);
  const stick = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div>
      <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>{title}</div>
      <div ref={ref} onScroll={onScroll}
        style={s('height:260px;overflow-y:auto;background:#08090B;border:1px solid rgba(255,255,255,.08);padding:10px 12px')}>
        {logs.length === 0 && <div style={s('font-size:11px;color:#45484D')}>waiting for output...</div>}
        {logs.map((l) => (
          <div key={l.id} style={s(`font-family:${MONO};font-size:11px;line-height:1.55;color:${LEVEL_COLOR[l.level] || '#9CA0A6'};white-space:pre-wrap;word-break:break-word`)}>{l.message}</div>
        ))}
      </div>
    </div>
  );
}
