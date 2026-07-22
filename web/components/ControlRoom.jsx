'use client';

import { useEffect, useRef, useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, relTime, pad } from '@/lib/ui';
import { addDomain, updateDomain, deleteDomain, bulkUpdateDomains, deleteDomains, addFeed } from '@/app/actions';

// Two independent permissions land here, and they are genuinely separate jobs:
// starting and stopping scrapes (canRun) versus editing what gets tracked
// (canManageDomains). Someone can have either without the other, so the row
// checkboxes and the bulk bar appear for both while the controls inside each
// answer to their own capability.
export default function ControlRoom({
  ads, domains, runs, NOW, query = '', feeds = [],
  canRun = false, canManageDomains = false,
  runStatus = { active: null, lastRun: null }, runLogs = [], pending = false,
  onRunNow, onRunDomains, onMarkFailed, onSeeNewAds, onStop,
}) {
  const canSelect = canRun || canManageDomains;
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('ALL');
  const [maxAds, setMaxAds] = useState(100);
  const [feed, setFeed] = useState('');
  const [newFeed, setNewFeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [stopping, setStopping] = useState(false);
  const [sel, setSel] = useState(() => new Set());   // selected domain ids for a targeted run
  const [selMsg, setSelMsg] = useState('');
  const [search, setSearch] = useState('');          // quick search over the table
  const [sortKey, setSortKey] = useState('created'); // 'created' keeps incoming (created_at) order
  const [sortDir, setSortDir] = useState('asc');
  const [bulkMaxAds, setBulkMaxAds] = useState('');  // pending bulk Max Ads / cadence inputs
  const [bulkDays, setBulkDays] = useState('');
  const [allDays, setAllDays] = useState(() =>     // global "set every row to N days" input
    (domains.length && domains.every((d) => d.interval_days === domains[0].interval_days))
      ? String(domains[0].interval_days) : '3');
  const [applyingAll, setApplyingAll] = useState(false);
  const [allMsg, setAllMsg] = useState('');

  const active = runStatus?.active || null;
  const lastRun = runStatus?.lastRun || null;
  const isBusy = pending || !!active;

  // What a click will actually scrape, so it is never a mystery: every enabled
  // domain, each up to its own Max Ads.
  const activeDomains = domains.filter((d) => d.enabled);
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

  // Quick search across every visible field, so one box finds a row by domain,
  // feed, country, status, its Max Ads, or its cadence. The global top-bar search
  // and the local box both narrow the list (AND), so neither is dead weight.
  const matchDomain = (d, tokens) => {
    if (!tokens.length) return true;
    const hay = [
      d.query, d.feed, d.country, d.enabled ? 'active' : 'paused',
      `${d.max_ads}`, `${d.interval_days}`,
    ].filter(Boolean).join(' ').toLowerCase();
    return tokens.every((t) => hay.includes(t));
  };
  const gTokens = (query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sTokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matched = domains.filter((d) => matchDomain(d, gTokens) && matchDomain(d, sTokens));

  // Sort by any column; 'created' leaves the incoming created_at order untouched.
  const heldOf = (d) => adsByDomain[d.query] || 0;
  const CMP = {
    query: (a, b) => (a.query || '').localeCompare(b.query || ''),
    feed: (a, b) => (a.feed || '').localeCompare(b.feed || ''),
    country: (a, b) => (a.country || '').localeCompare(b.country || ''),
    max_ads: (a, b) => (a.max_ads || 0) - (b.max_ads || 0),
    held: (a, b) => heldOf(a) - heldOf(b),
    interval_days: (a, b) => (a.interval_days || 0) - (b.interval_days || 0),
    status: (a, b) => (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1),
  };
  const shownDomains = sortKey === 'created' || !CMP[sortKey]
    ? matched
    : [...matched].sort((a, b) => CMP[sortKey](a, b) * (sortDir === 'asc' ? 1 : -1));
  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  // Targeted-run selection. Select-all covers only the currently shown (searched)
  // rows; the scope estimate covers whatever is selected across all rows.
  const toggleSel = (id) => setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const clearSel = () => setSel(new Set());
  const shownIds = shownDomains.map((d) => d.id);
  const allShownSelected = shownIds.length > 0 && shownIds.every((id) => sel.has(id));
  const selScopeMax = domains.filter((d) => sel.has(d.id)).reduce((n, d) => n + (d.max_ads || 0), 0);

  const lastCompleted = runs.find((r) => r.status === 'completed' && r.finished_at);
  const dueTimes = domains.filter((d) => d.enabled && d.next_run_at).map((d) => d.next_run_at).sort();
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

  // Always-available stop: works even for a background job the dashboard never
  // saw claim a run (still spinning up on GitHub, or a page you just reloaded).
  // It reports exactly what it halted, so a click is never a mystery.
  const stopRunner = async () => {
    if (stopping || !onStop) return;
    setStopping(true);
    setRunMsg('');
    try {
      const r = await onStop();
      const cancelled = r?.cancelled || 0;
      const cleared = r?.cleared || 0;
      if (cleared || cancelled) {
        const parts = [];
        if (cleared) parts.push(cleared === 1 ? 'cleared the running scrape' : `cleared ${cleared} running scrapes`);
        if (cancelled) parts.push(`cancelled ${cancelled} background ${cancelled === 1 ? 'job' : 'jobs'} on GitHub`);
        setRunMsg('Stopped: ' + parts.join(' and ') + '.');
      } else if (r && r.ghConfigured === false) {
        setRunMsg('Nothing running in the database. GitHub cancel is not wired up here, so a spinning-up job cannot be reached (set GH_DISPATCH_TOKEN + GH_REPO).');
      } else {
        setRunMsg('Nothing was running to stop.');
      }
    } catch (e) {
      setRunMsg('Stop failed: ' + String(e));
    } finally {
      setStopping(false);
    }
  };

  // Run exactly the selected rows (one or many), isolated from the rest. Disabled
  // while a run is active - a second run can't claim the lock anyway. Selection is
  // kept so the outcome message stays visible right where the click happened.
  const runSelected = async () => {
    if (isBusy || !onRunDomains || !sel.size) return;
    const n = sel.size;
    const rows = n === 1 ? 'row' : 'rows';
    setSelMsg('');
    try {
      const r = await onRunDomains([...sel]);
      if (r?.dispatched) setSelMsg(`Dispatched a run for ${n} selected ${rows}. Live status appears at the top in a moment.`);
      else if (r?.reason === 'no-dispatch-token') setSelMsg(`${n} ${rows} marked due. Set GH_DISPATCH_TOKEN + GH_REPO to fire instantly; otherwise the scheduled runner picks them up on its next tick.`);
      else if (r?.reason === 'dispatch-failed') setSelMsg(`Could not dispatch (status ${r?.status ?? '?'}); the workflow input may not be on main yet. Marked the ${rows} due instead.`);
      else if (r?.reason === 'no-ids') setSelMsg('No valid rows to run.');
      else setSelMsg('Run request sent.');
    } catch (e) {
      setSelMsg('Run failed: ' + String(e));
    }
  };

  // Bulk edits over the selected rows: one server round-trip per intent. The table
  // re-renders from fresh server props once the action revalidates. Delete clears
  // the selection (those rows are gone); edits keep it so you can chain changes.
  const bulkStatus = (enabled) => bulkUpdateDomains([...sel], { enabled });
  const applyBulkMaxAds = () => {
    const n = Math.round(Number(bulkMaxAds));
    if (!Number.isFinite(n) || n < 1) return;
    bulkUpdateDomains([...sel], { max_ads: n });
    setBulkMaxAds('');
  };
  const applyBulkDays = () => {
    const n = Math.round(Number(bulkDays));
    if (!Number.isFinite(n) || n < 1) return;
    bulkUpdateDomains([...sel], { interval_days: n });
    setBulkDays('');
  };
  const applyBulkFeed = (name) => bulkUpdateDomains([...sel], { feed: name === '__none__' ? null : name });
  const bulkDelete = () => {
    const n = sel.size;
    if (!n) return;
    if (confirm(`Delete ${n} tracked ${n === 1 ? 'row' : 'rows'}? This stops tracking them (existing ads stay).`)) {
      deleteDomains([...sel]);
      clearSel();
    }
  };

  // Global "set every domain to the same cadence". Unlike the bulk bar (which acts on
  // the selection), this hits every tracked row regardless of any search filter, so
  // "all" always means all. Reuses bulkUpdateDomains, which re-spaces next_run_at.
  const applyAllDays = async () => {
    const raw = Math.round(Number(allDays));
    if (!Number.isFinite(raw) || raw < 1) { setAllMsg('Enter a number of days (1-365).'); return; }
    const n = Math.min(365, raw);
    const total = domains.length;
    if (!total) return;
    if (!confirm(`Set all ${total} tracked ${total === 1 ? 'domain' : 'domains'} to scrape every ${n} ${n === 1 ? 'day' : 'days'}? This overrides each domain's current frequency, ignoring any search filter.`)) return;
    setApplyingAll(true);
    setAllMsg('');
    try {
      await bulkUpdateDomains(domains.map((d) => d.id), { interval_days: n });
      setAllDays(String(n));
      setAllMsg(`All ${total} set to every ${n} ${n === 1 ? 'day' : 'days'}.`);
    } catch (e) {
      setAllMsg('Failed: ' + String(e));
    } finally {
      setApplyingAll(false);
    }
  };

  const inputStyle ='background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#E7E8EA;font-size:12px;padding:8px 10px;outline:none';
  const miniInput = `background:#0B0C0E;border:1px solid rgba(255,255,255,.12);color:#E7E8EA;font-family:${MONO};font-size:11px;text-align:center;padding:4px 6px;outline:none`;
  const bulkBtn = `background:#101216;border:1px solid rgba(255,255,255,.12);color:#C6C9CE;font-family:${MONO};font-size:10px;letter-spacing:.3px;padding:5px 9px;cursor:pointer;white-space:nowrap`;
  const bulkSep = 'color:#2E3136';

  return (
    <div style={s('max-width:1160px')}>
      <div style={s('display:flex;align-items:center;gap:12px;height:44px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.06)')}>
        <span style={s(`font-family:${MONO};font-size:12px;letter-spacing:1px;color:#E7E8EA`)}>CONTROL ROOM</span>
        {!canSelect && <span style={s(`font-family:${MONO};font-size:9.5px;color:#6C7076;border:1px solid rgba(255,255,255,.12);padding:2px 7px`)}>VIEWER · READ-ONLY</span>}
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
          {canRun && (
            <div style={s('display:flex;flex-direction:column;align-items:flex-end;gap:7px')}>
              <div style={s('display:flex;align-items:center;gap:8px')}>
                <button onClick={stopRunner} disabled={stopping}
                  title="Cancel any scrape running in the background (on GitHub) and clear the run lock"
                  style={s(`font-family:${MONO};font-size:10.5px;letter-spacing:.5px;color:#E06C5A;background:none;border:1px solid rgba(224,108,90,.45);padding:9px 13px;cursor:${stopping ? 'default' : 'pointer'};white-space:nowrap`)}>
                  {stopping ? 'STOPPING...' : '■ STOP'}
                </button>
                <button onClick={runNow} disabled={isBusy}
                  style={s(`font-family:${MONO};font-size:11px;letter-spacing:.5px;color:#0B0C0E;background:${isBusy ? '#5A5E64' : A};border:none;padding:9px 16px;cursor:${isBusy ? 'default' : 'pointer'}`)}>
                  {pending ? 'STARTING...' : active ? (active.stale ? 'STALLED' : 'RUNNING...') : '► RUN NOW'}
                </button>
              </div>
              <span style={s('font-size:10px;color:#5A5E64;max-width:280px;text-align:right;line-height:1.4')}>{scopeText}</span>
            </div>
          )}
        </div>
        {runMsg && <div style={s('font-size:11px;color:#9CA0A6;margin-top:12px;line-height:1.5;max-width:640px')}>{runMsg}</div>}
      </div>

      {/* live run panel: exactly what the run is doing, its status, and full logs */}
      {showLivePanel && (
        <LiveRunPanel active={active} pending={pending} lastRun={lastRun} logs={runLogs}
          canEdit={canRun} onMarkFailed={onMarkFailed} onSeeNewAds={onSeeNewAds} onStop={onStop} />
      )}

      {/* feeds */}
      {canManageDomains && (
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
        <div style={s('display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px')}>
          <span style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>Tracked Domains / Queries</span>
          {canManageDomains && domains.length > 0 && (
            <div style={s('display:flex;align-items:center;gap:7px')}>
              {allMsg && <span style={s('font-size:10px;color:#9CA0A6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px')}>{allMsg}</span>}
              <span style={s('font-size:10px;color:#6C7076;white-space:nowrap')}>Set all to every</span>
              <input type="number" min="1" max="365" value={allDays}
                onChange={(e) => setAllDays(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyAllDays()}
                style={s(`width:42px;${miniInput}`)} />
              <span style={s('font-size:10px;color:#6C7076')}>days</span>
              <button onClick={applyAllDays} disabled={applyingAll}
                title="Set every tracked domain to this cadence, ignoring any search filter"
                style={s(bulkBtn)}>{applyingAll ? 'APPLYING...' : 'APPLY TO ALL'}</button>
            </div>
          )}
        </div>

        {/* quick search: matches domain, feed, country, status, max ads, cadence */}
        <div style={s('display:flex;align-items:center;gap:10px;margin-bottom:14px')}>
          <div style={s('display:flex;align-items:center;gap:8px;flex:1;max-width:440px;height:32px;padding:0 10px;background:#101216;border:1px solid rgba(255,255,255,.08)')}>
            <span style={s('color:#5A5E64;font-size:12px')}>&#8250;</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Quick search: domain, feed, country, status, ads..."
              style={s('flex:1;background:transparent;border:none;outline:none;color:#E7E8EA;font-size:12px')} />
            {search && (
              <button onClick={() => setSearch('')} title="Clear search"
                style={s('background:none;border:none;color:#5A5E64;cursor:pointer;font-size:14px;line-height:1;padding:0')}>&#215;</button>
            )}
          </div>
          <span style={s(`font-family:${MONO};font-size:10.5px;color:#5A5E64;white-space:nowrap;font-variant-numeric:tabular-nums`)}>
            {shownDomains.length} of {domains.length}
          </span>
        </div>

        {canManageDomains && (
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

        {canSelect && sel.size > 0 && (
          <div style={s('display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px;margin-bottom:12px;background:#0D0E11;border:1px solid rgba(232,163,61,.28)')}>
            <span style={s(`font-family:${MONO};font-size:11px;color:${A};font-variant-numeric:tabular-nums`)}>{sel.size} selected</span>
            <button onClick={clearSel} style={s(`background:none;border:none;color:#8A8E94;font-family:${MONO};font-size:10px;cursor:pointer`)}>CLEAR</button>
            <span style={s(bulkSep)}>|</span>

            {canRun && (
              <>
                <button onClick={runSelected} disabled={isBusy}
                  title="Scrape only the selected rows, each with its own settings"
                  style={s(`font-family:${MONO};font-size:10.5px;letter-spacing:.5px;color:#0B0C0E;background:${isBusy ? '#5A5E64' : A};border:none;padding:6px 12px;cursor:${isBusy ? 'default' : 'pointer'};white-space:nowrap`)}>
                  {isBusy ? 'RUN IN PROGRESS...' : `► RUN ${sel.size}`}
                </button>
                <span style={s('font-size:10px;color:#5A5E64;white-space:nowrap')}>up to {selScopeMax} ads</span>
                <span style={s(bulkSep)}>|</span>
              </>
            )}

            {canManageDomains && (
              <>
                <button onClick={() => bulkStatus(true)} title="Set selected rows to Active" style={s(bulkBtn)}>&#9679; ACTIVATE</button>
                <button onClick={() => bulkStatus(false)} title="Pause selected rows" style={s(bulkBtn)}>&#10073;&#10073; PAUSE</button>
                <span style={s(bulkSep)}>|</span>

                <div style={s('display:flex;align-items:center;gap:5px')}>
                  <span style={s('font-size:10px;color:#6C7076')}>Max ads</span>
                  <input type="number" min="1" value={bulkMaxAds} placeholder="100"
                    onChange={(e) => setBulkMaxAds(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && applyBulkMaxAds()}
                    style={s(`width:54px;${miniInput}`)} />
                  <button onClick={applyBulkMaxAds} style={s(bulkBtn)}>SET</button>
                </div>

                <div style={s('display:flex;align-items:center;gap:5px')}>
                  <span style={s('font-size:10px;color:#6C7076')}>Every</span>
                  <input type="number" min="1" max="365" value={bulkDays} placeholder="d"
                    onChange={(e) => setBulkDays(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && applyBulkDays()}
                    style={s(`width:44px;${miniInput}`)} />
                  <span style={s('font-size:10px;color:#6C7076')}>days</span>
                  <button onClick={applyBulkDays} style={s(bulkBtn)}>SET</button>
                </div>

                <div style={s('display:flex;align-items:center;gap:5px')}>
                  <span style={s('font-size:10px;color:#6C7076')}>Feed</span>
                  <select value="" onChange={(e) => { if (e.target.value) applyBulkFeed(e.target.value); e.target.value = ''; }}
                    style={s(`${miniInput};font-family:${MONO};min-width:92px;text-align:left`)}>
                    <option value="">set...</option>
                    {feeds.map((f) => <option key={f.id} value={f.name}>{f.name}</option>)}
                    <option value="__none__">(no feed)</option>
                  </select>
                </div>
                <span style={s(bulkSep)}>|</span>

                <button onClick={bulkDelete}
                  style={s(`background:none;border:1px solid rgba(255,120,120,.35);color:#ff8a80;font-family:${MONO};font-size:10px;padding:5px 10px;cursor:pointer;white-space:nowrap`)}>DELETE {sel.size}</button>
              </>
            )}

            {selMsg && <div style={s('flex:1;min-width:120px')}><span style={s('font-size:10px;color:#9CA0A6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block')}>{selMsg}</span></div>}
          </div>
        )}

        <div style={s('border:1px solid rgba(255,255,255,.08)')}>
          <div style={s('display:flex;align-items:center;height:28px;padding:0 14px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase')}>
            {canSelect && (
              <div style={s('width:30px;flex-shrink:0;display:flex;align-items:center')}>
                <span onClick={() => (allShownSelected ? clearSel() : setSel(new Set(shownIds)))} title="Select all shown"
                  style={s(`width:13px;height:13px;border:1px solid ${allShownSelected ? A : 'rgba(255,255,255,.25)'};background:${allShownSelected ? A : 'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:9px;color:#0B0C0E;line-height:1`)}>{allShownSelected ? '✓' : ''}</span>
              </div>
            )}
            <SortTh label="Domain / Query" col="query" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} style="flex:1" />
            <SortTh label="Feed" col="feed" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} style="width:110px" />
            <SortTh label="Country" col="country" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} style="width:66px;text-align:center" />
            <SortTh label="Max Ads" col="max_ads" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} style="width:80px;text-align:right" />
            <SortTh label="Held" col="held" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} style="width:70px;text-align:center" />
            <SortTh label="Frequency" col="interval_days" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} style="width:118px;text-align:center" />
            <SortTh label="Status" col="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} style="width:86px;text-align:center" />
            <div style={s('width:32px')} />
          </div>

          {domains.length === 0 && (
            <div style={s('padding:22px 14px;text-align:center;color:#5A5E64;font-size:12px')}>No domains yet. Add one above to start tracking a competitor.</div>
          )}
          {domains.length > 0 && shownDomains.length === 0 && (
            <div style={s('padding:22px 14px;text-align:center;color:#5A5E64;font-size:12px')}>No domains match your search.</div>
          )}

          {shownDomains.map((d) => (
            <div key={d.id} style={s(`display:flex;align-items:center;height:44px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.045);background:${sel.has(d.id) ? 'rgba(232,163,61,.06)' : 'transparent'}`)}>
              {canSelect && (
                <div style={s('width:30px;flex-shrink:0;display:flex;align-items:center')}>
                  <span onClick={() => toggleSel(d.id)} title="Select for a targeted run"
                    style={s(`width:13px;height:13px;border:1px solid ${sel.has(d.id) ? A : 'rgba(255,255,255,.25)'};background:${sel.has(d.id) ? A : 'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:9px;color:#0B0C0E;line-height:1`)}>{sel.has(d.id) ? '✓' : ''}</span>
                </div>
              )}
              <div style={s('flex:1;min-width:0')}>
                <div style={s('font-size:12px;color:#E7E8EA;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{d.query}</div>
              </div>
              <div style={s(`width:110px;font-family:${MONO};font-size:10.5px;color:#9CA0A6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{d.feed || '-'}</div>
              <div style={s(`width:66px;text-align:center;font-family:${MONO};font-size:11px;color:#B6B9BE`)}>{d.country}</div>
              <div style={s(`width:80px;text-align:right;font-family:${MONO};font-size:13px;color:#C6C9CE;font-variant-numeric:tabular-nums`)}>{d.max_ads}</div>
              <div style={s(`width:70px;text-align:center;font-family:${MONO};font-size:13px;color:#E7E8EA;font-variant-numeric:tabular-nums`)}>{adsByDomain[d.query] || 0}</div>
              <div style={s('width:118px;display:flex;align-items:center;justify-content:center;gap:6px')}>
                <span style={s('font-size:10px;color:#6C7076')}>every</span>
                {canManageDomains ? (
                  <input key={d.interval_days} type="number" min="1" max="365" defaultValue={d.interval_days}
                    title="Days between scrapes"
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    onBlur={(e) => {
                      const n = Math.min(365, Math.max(1, Math.round(Number(e.target.value)) || d.interval_days));
                      e.target.value = n;
                      if (n !== d.interval_days) updateDomain(d.id, { interval_days: n });
                    }}
                    style={s(`width:36px;background:#0B0C0E;border:1px solid rgba(255,255,255,.12);color:${A};font-family:${MONO};font-size:11px;text-align:center;padding:3px 2px;outline:none`)} />
                ) : (
                  <span style={s(`font-family:${MONO};font-size:11px;color:${A}`)}>{d.interval_days}</span>
                )}
                <span style={s('font-size:10px;color:#6C7076')}>{d.interval_days === 1 ? 'day' : 'days'}</span>
              </div>
              <div style={s('width:86px;text-align:center')}>
                {canManageDomains ? (
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
                {canManageDomains && (
                  <button onClick={() => { if (confirm(`Delete "${d.query}"? This stops tracking it (existing ads stay).`)) deleteDomain(d.id); }}
                    title="Delete"
                    style={s('background:none;border:none;color:#8A8E94;font-size:15px;cursor:pointer;padding:2px 6px')}>×</button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div style={s('font-size:10px;color:#5A5E64;line-height:1.6;margin-top:12px')}>
          Changes write to the database immediately. The scheduled runner reads these to decide what to scrape and when. &ldquo;Run now&rdquo; runs every active domain; to run just one or a few, tick their checkboxes and use &ldquo;Run selected&rdquo;.
        </div>
      </div>

      <RunHistory runs={runs} canEdit={canRun} NOW={NOW} />
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

// Clickable column header. First click sorts ascending, clicking the active column
// again flips direction; the active column shows its arrow and the accent colour.
function SortTh({ label, col, sortKey, sortDir, onSort, style }) {
  const active = sortKey === col;
  return (
    <div onClick={() => onSort(col)} title={`Sort by ${label.toLowerCase()}`}
      style={s(`${style};cursor:pointer;user-select:none;color:${active ? A : '#5A5E64'}`)}>
      {label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
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

  // A completed run reports both halves of what it saw: brand-new imports and
  // already-known ads it re-surfaced back into the fresh window.
  const newCount = lastRun?.ads_new ?? 0;
  const seenCount = lastRun?.ads_found ?? newCount;
  const reSeen = Math.max(0, seenCount - newCount);
  const runSummary = reSeen > 0
    ? `${newCount > 0 ? `+${newCount} new` : 'no new ads'} · ${reSeen} re-surfaced`
    : (newCount > 0 ? `+${newCount} new ${newCount === 1 ? 'ad' : 'ads'}` : 'no new ads this run');
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
        {completed && <span style={s('font-size:11px;color:#8A8E94')}>{runSummary} · {relTime(Date.now() - new Date(lastRun.finished_at).getTime())}</span>}
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
          <LiveStat label="Ads Found" value={String(found)} color={A} />
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

      {completed && seenCount > 0 && (
        <div style={s('margin-bottom:14px')}>
          <button onClick={() => onSeeNewAds && onSeeNewAds()}
            style={s(`font-family:${MONO};font-size:11px;letter-spacing:.5px;color:#0B0C0E;background:${A};border:none;padding:8px 14px;cursor:pointer`)}>
            SEE {seenCount} {seenCount === 1 ? 'AD' : 'ADS'} FROM THIS RUN →
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
