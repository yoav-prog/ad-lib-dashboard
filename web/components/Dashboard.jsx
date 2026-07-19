'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { s } from '@/lib/style';
import { A, MONO, hoursSince, daysRunning, isVideo, thumbOf, firstUrl, isTarzo, tarzoSlug, isPredicto, predictoQuery, titleCase, tint, paras, relTime, pad, fmtDate, fmtInt, fmtDec, geoCountries, buildCsv, parseSheetId, langCode, brandLabel, brandColor, BRAND_OPTIONS, SHEET_COLUMN_META, DEFAULT_SHEET_COLUMN_KEYS } from '@/lib/ui';
import Thumb from '@/components/Thumb';
import CopyCell from '@/components/CopyCell';
import ColumnPicker, { useColumnPrefs } from '@/components/ColumnPicker';
import Pager, { PageSizePicker, usePageSize } from '@/components/Pager';
import { pageSlice, pageRange, pageCount, clampPage } from '@/lib/paging';
import GeoSplitCell from '@/components/GeoSplitCell';
import CompetitorView from '@/components/CompetitorView';
import TrendsView from '@/components/TrendsView';
import PipelineView from '@/components/PipelineView';
import ControlRoom from '@/components/ControlRoom';
import ReviewView from '@/components/ReviewView';
import { updateAdWorkflow, getAdArticle, triggerScrape, runDomains, markRunFailed, deleteAds, bulkUpdateAds, refreshAds, stopRun, exportToSheet, refreshMetrics, reviewAds as decideReviewAds } from '@/app/actions';

export default function Dashboard({ ads: adsProp, reviewAds: reviewAdsProp = [], domains = [], runs = [], feeds = [], lastRunIso, lastRunStartIso, nowIso, canEdit = true, exportSaEmail = null }) {
  const NOW = useMemo(() => new Date(nowIso).getTime(), [nowIso]);
  const lastRunStart = lastRunStartIso ? new Date(lastRunStartIso).getTime() : null;
  const [ads, setAds] = useState(adsProp);
  const [reviewAds, setReviewAds] = useState(reviewAdsProp);
  const [view, setView] = useState('fresh');
  // The search box updates `searchInput` instantly; `query` (what actually drives the
  // whole-feed filter) trails it by a short debounce. At this row count, re-scanning
  // every ad on each keystroke is the main reason typing felt stuck.
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(searchInput), 220);
    return () => clearTimeout(t);
  }, [searchInput]);
  const [sort, setSort] = useState('fresh');
  const [sortDir, setSortDir] = useState('desc');
  const [filters, setFilters] = useState({
    domain: [], feed: [], vertical: [], country: [], geos: [], language: [], creative_language: [], brand: [], format: [], status: [],
    daysMin: '', daysMax: '', rankMin: '', rankMax: '',
  });
  const [dateRange, setDateRange] = useState('all');
  const [page, setPage] = useState(0);
  const { pageSize, setPageSize } = usePageSize('adintel.pagesize.freshfinds');
  const [selIndex, setSelIndex] = useState(0);
  const [detailId, setDetailId] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');

  const updateLocal = (id, patch) =>
    setAds((prev) => prev.map((a) => (a.ad_archive_id === id ? { ...a, ...patch } : a)));
  const commit = (id, patch) => { if (!canEdit) return; updateAdWorkflow(id, patch).catch((e) => console.error('save failed', e)); };
  const update = (id, patch) => { if (!canEdit) return; updateLocal(id, patch); commit(id, patch); };

  // ── bulk selection ──────────────────────────────────────────────────────────
  const [selected, setSelected] = useState(() => new Set());
  const toggleSel = (id) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setSelection = (ids) => setSelected(new Set(ids));
  const clearSel = () => setSelected(new Set());
  const bulkDelete = async () => {
    if (!canEdit || !selected.size) return;
    const ids = [...selected];
    setAds((prev) => prev.filter((a) => !selected.has(a.ad_archive_id)));
    clearSel();
    try { await deleteAds(ids); } catch (e) { console.error(e); }
  };
  const bulkSet = async (patch) => {
    if (!canEdit || !selected.size) return;
    const ids = [...selected];
    setAds((prev) => prev.map((a) => (selected.has(a.ad_archive_id) ? { ...a, ...patch } : a)));
    try { await bulkUpdateAds(ids, patch); } catch (e) { console.error(e); }
  };
  const bulkRefresh = async () => {
    if (!canEdit || !selected.size) return { ok: false };
    try { return await refreshAds([...selected]); } catch (e) { return { ok: false, reason: String(e) }; }
  };

  // ── live run status ─────────────────────────────────────────────────────────
  // One poller for the whole dashboard, so the banner and the Control Room panel
  // share it and it survives switching tabs. State lives in the DB, so leaving and
  // returning (even a full reload) just resumes wherever the run is.
  const router = useRouter();
  const [runStatus, setRunStatus] = useState({ active: null, lastRun: null, runId: null });
  const [runLogs, setRunLogs] = useState([]);
  const [pending, setPending] = useState(false);
  const cursorRef = useRef(0);         // highest run_log id seen (poll cursor)
  const watchedRef = useRef(null);     // run whose logs are currently in runLogs
  const prevActiveIdRef = useRef(null);// last active run id seen, to detect completion
  const dispatchedAtRef = useRef(0);   // when Run Now fired, for the "starting" window
  const timerRef = useRef(null);
  const pollRef = useRef(null);

  // Keep the local feed in sync when the server sends fresh props (after router.refresh).
  useEffect(() => { setAds(adsProp); }, [adsProp]);
  useEffect(() => { setReviewAds(reviewAdsProp); }, [reviewAdsProp]);

  // Decide review-queue ads. Optimistic: the rows leave the queue immediately;
  // router.refresh() then pulls fresh server props so approvals land in the feed.
  const onReviewDecide = useCallback(async (ids, decision) => {
    const idSet = new Set(ids);
    setReviewAds((prev) => prev.filter((a) => !idSet.has(a.ad_archive_id)));
    try { await decideReviewAds(ids, decision); } catch (e) { console.error('[review decide] failed', e); }
    router.refresh();
  }, [router]);

  const poll = useCallback(async () => {
    let active = null;
    try {
      const rid = watchedRef.current || '';
      const res = await fetch(`/api/run-status?since=${cursorRef.current}&runId=${encodeURIComponent(rid)}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        active = data.active || null;
        if (active) dispatchedAtRef.current = 0;   // a real run supersedes the "starting" window
        const stillStarting = !active && dispatchedAtRef.current > 0 && Date.now() - dispatchedAtRef.current < 3 * 60 * 1000;
        setPending(stillStarting);
        setRunStatus({ active, lastRun: data.lastRun || null, runId: data.runId || null });
        // A run just cleared: pull fresh server props so new finds land in the feed
        // automatically, no "SEE N NEW ADS" click needed.
        if (prevActiveIdRef.current && !active) router.refresh();
        prevActiveIdRef.current = active ? active.id : null;
        if (data.runId && data.runId !== watchedRef.current) {
          watchedRef.current = data.runId;                 // switched runs: reset the console
          const ls = data.logs || [];
          setRunLogs(ls.slice(-2000));
          cursorRef.current = ls.length ? ls[ls.length - 1].id : 0;
        } else if (data.logs && data.logs.length) {
          setRunLogs((prev) => [...prev, ...data.logs].slice(-2000));
          cursorRef.current = data.logs[data.logs.length - 1].id;
        }
      }
    } catch { /* transient network/db blip: just try again next tick */ }
    const recentlyDispatched = dispatchedAtRef.current > 0 && Date.now() - dispatchedAtRef.current < 3 * 60 * 1000;
    const delay = (active || recentlyDispatched) ? 2500 : 12000;  // fast while live, idle otherwise
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => pollRef.current && pollRef.current(), delay);
  }, []);
  pollRef.current = poll;

  useEffect(() => {
    poll();
    return () => clearTimeout(timerRef.current);
  }, [poll]);

  const onRunNow = useCallback(async () => {
    const r = await triggerScrape();
    if (r?.dispatched) { dispatchedAtRef.current = Date.now(); setPending(true); }
    poll();   // refresh + reschedule immediately
    return r;
  }, [poll]);

  // Targeted run of a chosen subset of tracked rows (one or many). Same live-status
  // handling as onRunNow, just scoped to the selected domain ids.
  const onRunDomains = useCallback(async (ids) => {
    const r = await runDomains(ids);
    if (r?.dispatched) { dispatchedAtRef.current = Date.now(); setPending(true); }
    poll();
    return r;
  }, [poll]);

  const onMarkFailed = useCallback(async (runId) => {
    try { await markRunFailed(runId); } catch (e) { console.error('mark failed', e); }
    poll();
  }, [poll]);

  const onStop = useCallback(async () => {
    dispatchedAtRef.current = 0;
    setPending(false);
    let r;
    try { r = await stopRun(); } catch (e) { console.error('stop failed', e); }
    poll();
    return r;
  }, [poll]);

  const onSeeNewAds = useCallback(() => {
    setView('fresh');
    router.refresh();   // re-fetch server props; the ads-sync effect updates the feed
  }, [router]);

  // Force a re-read of the campaign metrics sheet, then pull fresh server props
  // so the new numbers land in every table (Fresh Finds and Review alike).
  const onRefreshMetrics = useCallback(async () => {
    let r;
    try { r = await refreshMetrics(); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
    router.refresh();
    return r;
  }, [router]);

  // Precomputed lowercase haystack per ad -> fast multi-field smart search. The
  // landing-article title and link description are deliberately left out: they are
  // among the heaviest fields and almost never what someone types, so indexing them
  // just bloated every haystack and slowed the scan. Article bodies are never shipped.
  const searchIndex = useMemo(() => {
    const m = new Map();
    for (const a of ads) {
      m.set(a.ad_archive_id, [
        a.title, a.page_name, a.domain, a.vertical, a.country, a.language,
        a.creative_language,
        brandLabel(a.brand),
        a.body_text, a.caption, a.cta_text, a.cta_type, a.link_url,
        a.notes, a.sheet_keywords,
        ...(a.tags || []),
      ].filter(Boolean).join(' ').toLowerCase());
    }
    return m;
  }, [ads]);

  // ── filtering + sorting ────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = ads.filter((a) => {
      const f = filters;
      if (f.domain.length && !f.domain.includes(a.domain)) return false;
      if (f.vertical.length && !f.vertical.includes(a.vertical)) return false;
      if (f.country.length && !f.country.includes(a.country)) return false;
      if (f.geos.length && !geoCountries(a.sheet_geos).some((c) => f.geos.includes(c))) return false;
      if (f.language.length && !f.language.includes(a.language)) return false;
      if (f.creative_language.length && !f.creative_language.includes(a.creative_language)) return false;
      if (f.brand.length && !f.brand.includes(a.brand)) return false;
      if (f.format.length && !f.format.includes(a.display_format)) return false;
      if (f.feed.length && !f.feed.includes(a.feed)) return false;
      if (f.status.length && !f.status.includes(a.status)) return false;
      const days = daysRunning(a, NOW);
      if (f.daysMin !== '' && days < Number(f.daysMin)) return false;
      if (f.daysMax !== '' && days > Number(f.daysMax)) return false;
      if (f.rankMin !== '' || f.rankMax !== '') {
        if (a.rank == null) return false;
        if (f.rankMin !== '' && a.rank < Number(f.rankMin)) return false;
        if (f.rankMax !== '' && a.rank > Number(f.rankMax)) return false;
      }
      const h = hoursSince(a.first_seen_at, NOW);
      if (dateRange === '24h' && h > 24) return false;
      if (dateRange === '7d' && h > 168) return false;
      if (dateRange === '30d' && h > 720) return false;
      if (tokens.length) {
        const hay = searchIndex.get(a.ad_archive_id) || '';
        if (!tokens.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
    const dir = sortDir === 'desc' ? 1 : -1;
    list = [...list].sort((a, b) => {
      if (sort === 'days') return (daysRunning(b, NOW) - daysRunning(a, NOW)) * dir;
      if (sort === 'rank') {
        // Rank 1 is best; ads with no rank always sink to the bottom either way.
        if (a.rank == null && b.rank == null) return 0;
        if (a.rank == null) return 1;
        if (b.rank == null) return -1;
        return (a.rank - b.rank) * dir;
      }
      if (sort === 'revenue' || sort === 'rpc') {
        // Sheet metrics; ads with no matching campaign always sink to the bottom.
        const key = sort === 'revenue' ? 'sheet_revenue' : 'sheet_rpc';
        if (a[key] == null && b[key] == null) return 0;
        if (a[key] == null) return 1;
        if (b[key] == null) return -1;
        return (b[key] - a[key]) * dir;
      }
      if (sort === 'page') return (a.page_name || '').localeCompare(b.page_name || '') * -dir;
      if (sort === 'domain') return (a.domain || '').localeCompare(b.domain || '') * -dir;
      if (sort === 'vertical') return (a.vertical || '').localeCompare(b.vertical || '') * -dir;
      // Freshness = latest sighting, not first discovery, so everything the
      // last run saw (including re-surfaced ads) clusters at the top.
      return (new Date(b.last_seen_at || b.first_seen_at) - new Date(a.last_seen_at || a.first_seen_at)) * dir;
    });
    return list;
  }, [ads, query, filters, dateRange, sort, sortDir, NOW, searchIndex]);

  // Only the current page of rows reaches the DOM; filters, search, sort, facet
  // counts and exports all keep seeing the full filtered list. This is what lets
  // the feed hold every ad ever found without the browser rendering them all.
  const paged = useMemo(() => pageSlice(filtered, page, pageSize), [filtered, page, pageSize]);

  // Back to page one whenever the visible set changes shape - staying on page 7
  // of a brand-new list is disorienting. The list can also shrink under us
  // (bulk delete, refreshed server props), so clamp separately.
  useEffect(() => { setPage(0); setSelIndex(0); }, [query, filters, dateRange, sort, sortDir, pageSize]);
  useEffect(() => { setPage((p) => clampPage(p, filtered.length, pageSize)); }, [filtered.length, pageSize]);

  const goPage = useCallback((p, total, size) => {
    setPage(p);
    setSelIndex(0);
    window.scrollTo(0, 0);
    console.info('[feed paging] page', { table: 'fresh', page: p + 1, pages: pageCount(total, size), pageSize: size, total });
  }, []);

  // Same smart-match, reused by the Competitor and Pipeline views so search is per-page.
  const matchesQuery = (a) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const hay = searchIndex.get(a.ad_archive_id) || '';
    return q.split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
  };
  const searchPlaceholder = {
    fresh: 'Search fresh finds...',
    competitor: 'Search this competitor...',
    trends: 'Search trends...',
    pipeline: 'Search pipeline...',
    review: 'Search review queue...',
    settings: 'Search domains...',
  }[view] || 'Search...';

  const openDetail = (id) => { setDetailId(id); setView('detail'); };
  const stepDetail = (delta) => {
    const idx = filtered.findIndex((a) => a.ad_archive_id === detailId);
    const next = filtered[Math.min(filtered.length - 1, Math.max(0, idx + delta))];
    if (next) setDetailId(next.ad_archive_id);
  };
  const toggleFilter = (group, val) =>
    setFilters((s2) => {
      const arr = s2[group];
      return { ...s2, [group]: arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val] };
    });

  // ── keyboard ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true); setPaletteQuery('');
        setTimeout(() => document.getElementById('ai-palette')?.focus(), 30);
        return;
      }
      if (e.key === 'Escape') {
        if (paletteOpen) return setPaletteOpen(false);
        if (view === 'detail') return setView('fresh');
      }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); document.getElementById('ai-search')?.focus(); return; }
      if (view === 'fresh') {
        // j/k walk the visible page and roll over to the neighbor page at the
        // edges, so the keyboard can traverse the whole feed without the mouse.
        const pages = pageCount(filtered.length, pageSize);
        if (e.key === 'j' || e.key === 'ArrowDown') {
          e.preventDefault();
          if (selIndex >= paged.length - 1 && page < pages - 1) goPage(page + 1, filtered.length, pageSize);
          else setSelIndex((i) => Math.min(paged.length - 1, i + 1));
        } else if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (selIndex === 0 && page > 0) { goPage(page - 1, filtered.length, pageSize); setSelIndex(pageSize - 1); }
          else setSelIndex((i) => Math.max(0, i - 1));
        } else if (e.key === 'Enter') { const a = paged[selIndex]; if (a) openDetail(a.ad_archive_id); }
      } else if (view === 'detail') {
        if (e.key === 'j') stepDetail(1);
        else if (e.key === 'k') stepDetail(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const lastScrape = lastRunIso ? relTime(NOW - new Date(lastRunIso).getTime()) : 'never';

  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div style={s('min-height:100vh')}>
      <TopChrome
        view={view} setView={setView} query={searchInput} setQuery={setSearchInput}
        placeholder={searchPlaceholder} showSearch={view !== 'detail'}
        lastScrape={lastScrape} reviewCount={reviewAds.length}
        openPalette={() => { setPaletteOpen(true); setPaletteQuery(''); setTimeout(() => document.getElementById('ai-palette')?.focus(), 30); }}
      />

      <RunBanner status={runStatus} pending={pending} onClick={() => setView('settings')} />

      {view === 'fresh' && (
        <FreshFinds
          ads={ads} filtered={filtered} paged={paged} NOW={NOW}
          page={page} pageSize={pageSize} setPageSize={setPageSize} goPage={goPage}
          filters={filters} toggleFilter={toggleFilter}
          setRange={(key, val) => { setFilters((s2) => ({ ...s2, [key]: val })); setSelIndex(0); }}
          clearFilters={() => { setFilters({ domain: [], feed: [], vertical: [], country: [], geos: [], language: [], creative_language: [], brand: [], format: [], status: [], daysMin: '', daysMax: '', rankMin: '', rankMax: '' }); setDateRange('all'); setSelIndex(0); }}
          dateRange={dateRange} setDateRange={(d) => { setDateRange(d); setSelIndex(0); }}
          sort={sort} sortDir={sortDir}
          setSort={(id) => setSortDir((prev) => (sort === id && prev === 'desc' ? 'asc' : 'desc')) || setSort(id)}
          selIndex={selIndex} setSelIndex={setSelIndex} openDetail={openDetail} lastRunStart={lastRunStart}
          canEdit={canEdit} selected={selected} toggleSel={toggleSel} setSelection={setSelection} clearSel={clearSel} bulkDelete={bulkDelete} bulkSet={bulkSet} bulkRefresh={bulkRefresh}
          exportSaEmail={exportSaEmail} onRefreshMetrics={onRefreshMetrics}
        />
      )}

      {view === 'detail' && (
        <Detail
          ad={ads.find((a) => a.ad_archive_id === detailId) || filtered[0]}
          NOW={NOW}
          back={() => setView('fresh')}
          prev={() => stepDetail(-1)} next={() => stepDetail(1)}
          update={update} updateLocal={updateLocal} commit={commit} canEdit={canEdit} lastRunStart={lastRunStart}
        />
      )}

      {view === 'competitor' && <CompetitorView ads={ads} NOW={NOW} openDetail={openDetail} matchesQuery={matchesQuery} />}
      {view === 'trends' && <TrendsView ads={ads} NOW={NOW} matchesQuery={matchesQuery} openDetail={openDetail} />}
      {view === 'pipeline' && <PipelineView ads={ads} update={update} openDetail={openDetail} matchesQuery={matchesQuery} />}
      {view === 'review' && <ReviewView ads={reviewAds} NOW={NOW} canEdit={canEdit} query={query} onDecide={onReviewDecide} />}
      {view === 'settings' && (
        <ControlRoom
          ads={ads} domains={domains} runs={runs} NOW={NOW} query={query} feeds={feeds} canEdit={canEdit}
          runStatus={runStatus} runLogs={runLogs} pending={pending}
          onRunNow={onRunNow} onRunDomains={onRunDomains} onMarkFailed={onMarkFailed} onSeeNewAds={onSeeNewAds} onStop={onStop}
        />
      )}

      {paletteOpen && (
        <Palette
          ads={ads} paletteQuery={paletteQuery} setPaletteQuery={setPaletteQuery}
          close={() => setPaletteOpen(false)}
          go={(v) => { setView(v); setPaletteOpen(false); }}
          openDetail={(id) => { openDetail(id); setPaletteOpen(false); }}
        />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// RUN BANNER - always-visible "something is running" strip across every tab
// ═════════════════════════════════════════════════════════════════════════════
function RunBanner({ status, pending, onClick }) {
  const active = status?.active;
  if (!active && !pending) return null;
  const stalled = active && active.stale;
  const dot = stalled ? '#E8A33D' : A;
  let text;
  if (active && !stalled) {
    const prog = active.domains_total > 0 ? `, ${active.domains_done}/${active.domains_total}` : '';
    text = `Scrape running — ${active.current_domain || 'starting'}${prog}, ${active.ads_found_so_far} found`;
  } else if (stalled) {
    text = 'Scrape stalled — no heartbeat. Open Control Room to resolve.';
  } else {
    text = 'Scrape starting — waiting for the runner to spin up...';
  }
  return (
    <div onClick={onClick}
      style={s(`position:sticky;top:44px;z-index:39;display:flex;align-items:center;gap:10px;height:30px;padding:0 16px;background:#141210;border-bottom:1px solid ${stalled ? 'rgba(232,163,61,.3)' : 'rgba(232,163,61,.22)'};cursor:pointer`)}>
      <span style={s(`width:7px;height:7px;border-radius:50%;background:${dot};animation:freshpulse 1.6s ease-in-out infinite`)} />
      <span style={s(`font-family:${MONO};font-size:10.5px;letter-spacing:.4px;color:#D8C08A`)}>{text}</span>
      <span style={s('flex:1')} />
      <span style={s(`font-family:${MONO};font-size:9.5px;color:#8A7A5A;letter-spacing:.5px`)}>CONTROL ROOM →</span>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// TOP CHROME
// ═════════════════════════════════════════════════════════════════════════════
function TopChrome({ view, setView, query, setQuery, placeholder, showSearch, lastScrape, reviewCount = 0, openPalette }) {
  const tabs = [
    { id: 'fresh', label: 'Fresh Finds' },
    { id: 'competitor', label: 'Competitors' },
    { id: 'trends', label: 'Trends' },
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'review', label: 'Review', badge: reviewCount },
    { id: 'settings', label: 'Control Room' },
  ];
  const logout = () => fetch('/api/logout', { method: 'POST' }).then(() => { window.location.href = '/login'; });
  return (
    <div style={s('position:sticky;top:0;z-index:40;display:flex;align-items:center;height:44px;padding:0 14px;gap:14px;background:#0B0C0E;border-bottom:1px solid rgba(255,255,255,.09)')}>
      <div style={s('display:flex;align-items:center;gap:9px;padding-right:16px;border-right:1px solid rgba(255,255,255,.08);height:100%')}>
        <div style={s('width:15px;height:15px;border:1.5px solid #E8A33D;transform:rotate(45deg)')} />
        <span style={s(`font-family:${MONO};font-size:12px;font-weight:600;letter-spacing:1.5px;color:#E7E8EA`)}>ADINTEL</span>
        <span style={s(`font-family:${MONO};font-size:10px;color:#4A4E54;letter-spacing:.5px`)}>v1</span>
      </div>
      <div style={s('display:flex;align-items:stretch;height:100%;gap:2px')}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setView(t.id)}
            style={s(`display:flex;align-items:center;gap:6px;background:transparent;border:none;border-bottom:2px solid ${view === t.id ? A : 'transparent'};color:${view === t.id ? '#E7E8EA' : '#8A8E94'};font-size:11.5px;letter-spacing:.4px;padding:0 13px;height:100%;cursor:pointer;text-transform:uppercase`)}>
            {t.label}
            {t.badge > 0 && (
              <span style={s(`font-family:${MONO};font-size:9px;color:#0B0C0E;background:${A};padding:1px 5px;border-radius:8px;font-variant-numeric:tabular-nums`)}>{t.badge}</span>
            )}
          </button>
        ))}
      </div>
      <div style={s('flex:1')} />
      {showSearch && (
        <div style={s('display:flex;align-items:center;gap:8px;height:26px;padding:0 10px;min-width:300px;background:#101216;border:1px solid rgba(255,255,255,.08)')}>
          <span style={s('color:#5A5E64;font-size:12px')}>&#8250;</span>
          <input id="ai-search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            style={s('flex:1;background:transparent;border:none;outline:none;color:#E7E8EA;font-size:12px')} />
          {query
            ? <button onClick={() => setQuery('')} style={s('background:none;border:none;color:#5A5E64;cursor:pointer;font-size:14px;line-height:1;padding:0')}>&#215;</button>
            : <kbd style={s(`font-family:${MONO};font-size:10px;color:#5A5E64;border:1px solid rgba(255,255,255,.1);padding:1px 4px`)}>/</kbd>}
        </div>
      )}
      <button onClick={openPalette}
        style={s(`display:flex;align-items:center;gap:6px;height:26px;padding:0 9px;background:#101216;border:1px solid rgba(255,255,255,.08);color:#8A8E94;font-family:${MONO};font-size:10.5px;cursor:pointer`)}>
        &#8984;K
      </button>
      <div style={s('display:flex;align-items:center;gap:7px;padding-left:14px;border-left:1px solid rgba(255,255,255,.08);height:100%')}>
        <span style={s('width:6px;height:6px;border-radius:50%;background:#E8A33D;box-shadow:0 0 6px rgba(232,163,61,.6)')} />
        <span style={s(`font-family:${MONO};font-size:10.5px;color:#8A8E94`)}>LIVE</span>
        <span style={s(`font-family:${MONO};font-size:10.5px;color:#5A5E64`)}>{lastScrape}</span>
      </div>
      <button onClick={logout} title="Log out"
        style={s(`background:none;border:1px solid rgba(255,255,255,.1);color:#6C7076;font-family:${MONO};font-size:10px;padding:4px 8px;cursor:pointer`)}>EXIT</button>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// FRESH FINDS
// ═════════════════════════════════════════════════════════════════════════════

// Every Fresh Finds column the COLUMNS picker can hide, with the width (its own
// padding included) each one contributes to the table's min-width. Thumbnail and
// Headline are structural and always render; Slug manages itself (it only
// appears while the current view holds a Tarzo row).
const FRESH_COLS = [
  { key: 'page',     label: 'Page',               w: 148 },
  { key: 'domain',   label: 'Domain',             w: 132 },
  { key: 'brand',    label: 'Brand',              w: 96 },
  { key: 'creative_language', label: 'Creative Lang', w: 100 },
  { key: 'url',      label: 'URL',                w: 168 },
  { key: 'revenue',  label: 'Revenue Prediction', w: 96 },
  { key: 'clicks',   label: 'Clicks',             w: 76 },
  { key: 'rpc',      label: 'RPC',                w: 60 },
  { key: 'geos',     label: 'GEOS',               w: 126 },
  { key: 'keywords', label: 'Top Keywords',       w: 186 },
  { key: 'format',   label: 'Format',             w: 62 },
  { key: 'rank',     label: 'Rank',               w: 46 },
  { key: 'added',    label: 'Added',              w: 68 },
  { key: 'updated',  label: 'Updated',            w: 66 },
  { key: 'days',     label: 'Days Run',           w: 70 },
  { key: 'vertical', label: 'Vertical',           w: 108 },
  { key: 'country',  label: 'Country',            w: 58 },
  { key: 'language', label: 'Language',           w: 74 },
  { key: 'feed',     label: 'Feed',               w: 108 },
  { key: 'ad_id',    label: 'Ad Archive ID',      w: 146 },
];
const FRESH_COLS_LS = 'adintel.cols.freshfinds';

function FreshFinds({ ads, filtered, paged, NOW, page, pageSize, setPageSize, goPage, filters, toggleFilter, setRange, clearFilters, dateRange, setDateRange, sort, sortDir, setSort, selIndex, setSelIndex, openDetail, lastRunStart, canEdit, selected, toggleSel, setSelection, clearSel, bulkDelete, bulkSet, bulkRefresh, exportSaEmail, onRefreshMetrics }) {
  const selCount = selected ? selected.size : 0;
  const [sheetOpen, setSheetOpen] = useState(false);
  const filteredIds = filtered.map((a) => a.ad_archive_id);
  const allSelected = filteredIds.length > 0 && selected && filteredIds.every((id) => selected.has(id));
  const bulkBtn = s(`background:#101216;border:1px solid rgba(255,255,255,.12);color:#C6C9CE;font-family:${MONO};font-size:10px;padding:4px 9px;cursor:pointer`);
  const [bulkMsg, setBulkMsg] = useState('');
  // Fresh = seen by the latest run (the scraper re-surfaces every ad Meta
  // still returns, not just never-seen ones), falling back to the last 24h.
  const isFresh = (a) => (lastRunStart ? new Date(a.last_seen_at || a.first_seen_at).getTime() >= lastRunStart : hoursSince(a.last_seen_at || a.first_seen_at, NOW) <= 24);

  // Thumbnail size is user-controlled: these creatives are text-heavy, so a bigger
  // preview (shown whole, not cropped) is often needed to actually read them. S is
  // the tidy default; M and L trade rows-per-screen for legibility.
  const IMG_SIZES = [
    { key: 's', label: 'S', px: 44, fit: 'cover', hint: 'small' },
    { key: 'm', label: 'M', px: 120, fit: 'contain', hint: 'medium' },
    { key: 'l', label: 'L', px: 220, fit: 'contain', hint: 'large' },
  ];
  const [imgKey, setImgKey] = useState('s');
  const img = IMG_SIZES.find((z) => z.key === imgKey) || IMG_SIZES[0];
  const thumbColW = img.px + 12; // image box + the cell's right padding

  // Which columns this table shows, chosen from the COLUMNS picker and
  // remembered per browser.
  const { visible: cols, toggle: toggleCol, reset: resetCols } = useColumnPrefs(FRESH_COLS_LS, FRESH_COLS);

  // Paging bookkeeping for the toolbar counter and the bottom pager. The row
  // slice itself (`paged`) is computed by the parent, which also owns the
  // keyboard navigation across pages.
  const pages = pageCount(filtered.length, pageSize);
  const range = pageRange(filtered.length, page, pageSize);

  // Slug (Tarzo) and Search Query (Predicto) are feed-specific: each rides along
  // only while the current view actually contains a row of that feed, and the
  // table widens to make room when it does. Enlarging the thumbnail widens the
  // table by the same delta so nothing crushes. 294 covers the structural parts
  // (row padding, select box, Headline's share); the rest is the sum of whichever
  // columns are actually visible.
  const showSlug = filtered.some(isTarzo);
  const showQuery = filtered.some(isPredicto);
  const tableMinW = 294 + thumbColW + (showSlug ? 150 : 0) + (showQuery ? 240 : 0)
    + FRESH_COLS.reduce((n, c) => n + (cols.has(c.key) ? c.w : 0), 0);
  const [gsearch, setGsearch] = useState({});
  const uniq = (key) => [...new Set(ads.map((a) => a[key]).filter(Boolean))];
  const countBy = (key, val) => ads.filter((a) => a[key] === val).length;

  // Feed-scoped Domain facet: once a feed is chosen, the Domain list shows only
  // that feed's domains (and their counts), so the picker never offers a domain
  // the current feed can't contain. Any already-picked domain stays in the list
  // even if it falls outside the feed, so a stale choice is never stranded
  // unselectable (its count then reads 0, a hint that it matches nothing here).
  const feedScoped = filters.feed.length ? ads.filter((a) => filters.feed.includes(a.feed)) : ads;
  const uniqIn = (rows, key) => [...new Set(rows.map((a) => a[key]).filter(Boolean))];
  const countIn = (rows, key, val) => rows.filter((a) => a[key] === val).length;
  const withSelected = (list, sel) => [...list, ...sel.filter((v) => v && !list.includes(v))];

  const fresh24 = ads.filter(isFresh).length;
  const new7 = ads.filter((a) => hoursSince(a.first_seen_at, NOW) <= 168).length;
  const winners = ads.filter((a) => daysRunning(a, NOW) >= 60).length;
  const metrics = [
    { label: lastRunStart ? 'Seen This Scrape' : 'Fresh 24h', value: pad(fresh24), color: A },
    { label: 'New 7d', value: pad(new7), color: '#E7E8EA' },
    { label: 'Proven Winners', value: pad(winners), color: A },
    { label: 'Total Tracked', value: pad(ads.length, 3), color: '#E7E8EA' },
    { label: 'Competitors', value: pad(uniq('domain').length), color: '#E7E8EA' },
    { label: 'Verticals', value: pad(uniq('vertical').length), color: '#E7E8EA' },
  ];
  const vcount = {};
  ads.forEach((a) => { if (a.vertical) vcount[a.vertical] = (vcount[a.vertical] || 0) + 1; });
  const vertMix = Object.entries(vcount).sort((x, y) => y[1] - x[1]).slice(0, 4)
    .map(([label, n]) => ({ label, pct: `${Math.round((n / (ads.length || 1)) * 100)}%` }));

  // GEOS facet: every country that appears in some ad's sheet revenue split,
  // busiest first. Selecting one keeps ads that earn there at all (any share) -
  // "show me everything making money in ES", per the sheet, not per AdIntel's
  // own Country guess.
  const geoCounts = new Map();
  for (const a of ads) for (const c of geoCountries(a.sheet_geos)) geoCounts.set(c, (geoCounts.get(c) || 0) + 1);

  const groups = [
    { title: 'Domain', group: 'domain', vals: withSelected(uniqIn(feedScoped, 'domain'), filters.domain), count: (v) => countIn(feedScoped, 'domain', v) },
    { title: 'Feed', group: 'feed', vals: uniq('feed'), count: (v) => countBy('feed', v) },
    { title: 'Vertical', group: 'vertical', vals: uniq('vertical'), count: (v) => countBy('vertical', v) },
    { title: 'Country', group: 'country', vals: uniq('country'), count: (v) => countBy('country', v) },
    // Hidden entirely while no ad carries sheet data (fresh install, sheet unreachable).
    ...(geoCounts.size ? [{ title: 'GEOS (Earns In)', group: 'geos', vals: [...geoCounts.keys()].sort((x, y) => geoCounts.get(y) - geoCounts.get(x)), count: (v) => geoCounts.get(v) || 0 }] : []),
    { title: 'Language', group: 'language', vals: uniq('language'), count: (v) => countBy('language', v) },
    // Language of the text ON the creative; hidden until some ad is classified.
    ...(ads.some((a) => a.creative_language) ? [{ title: 'Creative Language', group: 'creative_language', vals: uniq('creative_language'), count: (v) => countBy('creative_language', v) }] : []),
    // Brand keys ('none'/'brand'/'car_brand') get a readable label; ordered by
    // BRAND_OPTIONS. Hidden entirely until some ad is classified (before the backfill).
    ...(ads.some((a) => a.brand) ? [{ title: 'Brand', group: 'brand', vals: BRAND_OPTIONS.map((o) => o.key).filter((k) => countBy('brand', k)), count: (v) => countBy('brand', v), label: (v) => brandLabel(v) }] : []),
    { title: 'Format', group: 'format', vals: uniq('display_format'), count: (v) => countBy('display_format', v) },
    { title: 'Status', group: 'status', vals: uniq('status'), count: (v) => countBy('status', v) },
  ];
  const checkboxGroups = ['domain', 'feed', 'vertical', 'country', 'geos', 'language', 'creative_language', 'brand', 'format', 'status'];
  const activeFilterCount =
    checkboxGroups.reduce((n, k) => n + (filters[k]?.length || 0), 0)
    + (dateRange !== 'all' ? 1 : 0)
    + (filters.daysMin !== '' || filters.daysMax !== '' ? 1 : 0)
    + (filters.rankMin !== '' || filters.rankMax !== '' ? 1 : 0);
  const maxDays = Math.max(1, ...ads.map((a) => daysRunning(a, NOW)));

  const sortDefs = [
    { id: 'fresh', label: 'freshness' },
    { id: 'rank', label: 'rank' },
    { id: 'days', label: 'days running' },
    { id: 'revenue', label: 'revenue' },
    { id: 'rpc', label: 'rpc' },
    { id: 'page', label: 'page' },
    { id: 'domain', label: 'domain' },
    { id: 'vertical', label: 'vertical' },
  ];

  // Download exactly what's on screen (current filters/search/date range) as CSV.
  const exportCsv = () => {
    if (!filtered.length) return;
    // Prepend a UTF-8 BOM (U+FEFF) so Excel opens accented ad copy in the right encoding.
    const bom = String.fromCharCode(0xFEFF);
    const blob = new Blob([bom + buildCsv(filtered, NOW)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fresh-finds-${new Date(NOW).toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      {/* ticker strip */}
      <div style={s('display:flex;align-items:stretch;height:74px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.09)')}>
        {metrics.map((m) => (
          <div key={m.label} style={s('display:flex;flex-direction:column;justify-content:center;padding:0 26px;border-right:1px solid rgba(255,255,255,.06);min-width:150px')}>
            <span style={s(`font-family:${MONO};font-size:27px;font-weight:500;letter-spacing:-.5px;color:${m.color};font-variant-numeric:tabular-nums`)}>{m.value}</span>
            <span style={s('font-size:10px;letter-spacing:1px;color:#6C7076;text-transform:uppercase;margin-top:2px')}>{m.label}</span>
          </div>
        ))}
        <div style={s('flex:1;display:flex;align-items:center;justify-content:flex-end;padding:0 24px;gap:20px')}>
          {vertMix.map((v) => (
            <div key={v.label} style={s('display:flex;flex-direction:column;gap:5px;min-width:96px')}>
              <div style={s('display:flex;justify-content:space-between;align-items:baseline')}>
                <span style={s('font-size:10px;color:#8A8E94;letter-spacing:.3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80px')}>{v.label}</span>
                <span style={s(`font-family:${MONO};font-size:10px;color:#6C7076`)}>{v.pct}</span>
              </div>
              <div style={s('height:3px;background:rgba(255,255,255,.06)')}><div style={s(`height:100%;width:${v.pct};background:#5A5E64`)} /></div>
            </div>
          ))}
        </div>
      </div>

      <div style={s('display:flex;align-items:stretch;min-height:calc(100vh - 118px)')}>
        {/* filter rail */}
        <div style={s('width:236px;flex-shrink:0;background:#0D0E11;border-right:1px solid rgba(255,255,255,.09)')}>
          <div style={s('display:flex;align-items:center;justify-content:space-between;height:34px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.06)')}>
            <span style={s(`font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:#6C7076`)}>FILTERS</span>
            <button onClick={clearFilters} style={s(`background:none;border:none;color:${activeFilterCount ? A : '#5A5E64'};font-family:${MONO};font-size:9.5px;letter-spacing:.5px;cursor:pointer`)}>CLEAR ({activeFilterCount})</button>
          </div>
          {groups.map((g) => {
            const term = (gsearch[g.group] || '').toLowerCase();
            const opts = term ? g.vals.filter((v) => String(v).toLowerCase().includes(term)) : g.vals;
            const searchable = g.vals.length > 6;
            const chosen = filters[g.group].length;
            return (
              <div key={g.title} style={s('border-bottom:1px solid rgba(255,255,255,.06);padding:11px 0 12px')}>
                <div style={s('display:flex;align-items:center;justify-content:space-between;padding:0 14px 8px')}>
                  <span style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>{g.title}</span>
                  {chosen > 0 && <span style={s(`font-family:${MONO};font-size:9px;color:#E8A33D`)}>{chosen}</span>}
                </div>
                {searchable && (
                  <div style={s('padding:0 14px 8px')}>
                    <input value={gsearch[g.group] || ''} onChange={(e) => setGsearch((p) => ({ ...p, [g.group]: e.target.value }))}
                      placeholder={`Filter ${g.title.toLowerCase()}...`}
                      style={s('width:100%;background:#0B0C0E;border:1px solid rgba(255,255,255,.08);color:#C6C9CE;font-size:11px;padding:5px 8px;outline:none')} />
                  </div>
                )}
                <div style={s(searchable ? 'max-height:184px;overflow-y:auto' : '')}>
                  {opts.map((v) => {
                    const sel = filters[g.group].includes(v);
                    return (
                      <button key={v} onClick={() => toggleFilter(g.group, v)}
                        style={s(`display:flex;align-items:center;gap:9px;width:100%;padding:4px 14px;background:${sel ? 'rgba(232,163,61,.06)' : 'transparent'};border:none;cursor:pointer;text-align:left`)}>
                        <span style={s(`width:11px;height:11px;flex-shrink:0;border:1px solid ${sel ? A : 'rgba(255,255,255,.2)'};background:${sel ? A : 'transparent'};display:flex;align-items:center;justify-content:center;font-size:8px;color:#0B0C0E;line-height:1`)}>{sel ? '✓' : ''}</span>
                        <span style={s(`flex:1;font-size:11.5px;color:${sel ? '#E7E8EA' : '#9CA0A6'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{g.label ? g.label(v) : titleCase(v)}</span>
                        <span style={s(`font-family:${MONO};font-size:10px;color:#5A5E64;font-variant-numeric:tabular-nums`)}>{pad(g.count(v))}</span>
                      </button>
                    );
                  })}
                  {opts.length === 0 && <div style={s('padding:4px 14px;font-size:11px;color:#45484D')}>no match</div>}
                </div>
              </div>
            );
          })}
          <RangeFilter title="Days Running" min={filters.daysMin} max={filters.daysMax}
            onMin={(v) => setRange('daysMin', v)} onMax={(v) => setRange('daysMax', v)} />
          <RangeFilter title="Rank" min={filters.rankMin} max={filters.rankMax}
            onMin={(v) => setRange('rankMin', v)} onMax={(v) => setRange('rankMax', v)} />
          <div style={s('padding:11px 14px')}>
            <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>DATE RANGE</div>
            <div style={s('display:flex;gap:1px;background:rgba(255,255,255,.06)')}>
              {['24h', '7d', '30d', 'all'].map((d) => (
                <button key={d} onClick={() => setDateRange(d)}
                  style={s(`flex:1;padding:5px 0;background:${dateRange === d ? '#1A1C20' : '#0D0E11'};border:none;color:${dateRange === d ? A : '#8A8E94'};font-family:${MONO};font-size:10px;cursor:pointer`)}>{d.toUpperCase()}</button>
              ))}
            </div>
          </div>
        </div>

        {/* feed */}
        <div style={s('flex:1;min-width:0;background:#0B0C0E;overflow-x:auto')}>
          <div style={s('display:flex;align-items:center;justify-content:space-between;height:34px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.06)')}>
            {selCount > 0 && canEdit ? (
              <div style={s('display:flex;align-items:center;gap:10px;width:100%')}>
                <span style={s(`font-family:${MONO};font-size:11px;color:${A};font-variant-numeric:tabular-nums`)}>{selCount} selected</span>
                <button onClick={clearSel} style={s(`background:none;border:none;color:#8A8E94;font-family:${MONO};font-size:10px;cursor:pointer`)}>CLEAR</button>
                <span style={s('color:#2E3136')}>|</span>
                <button onClick={() => bulkSet({ is_saved: true })} style={bulkBtn}>★ STAR</button>
                <button onClick={() => bulkSet({ status: 'idea' })} style={bulkBtn}>IDEA</button>
                <button onClick={() => bulkSet({ status: 'drafting' })} style={bulkBtn}>DRAFTING</button>
                <button onClick={() => bulkSet({ status: 'published' })} style={bulkBtn}>PUBLISHED</button>
                <button onClick={async () => { setBulkMsg('Refreshing...'); const r = await bulkRefresh(); setBulkMsg(r?.dispatched ? ((r.added ? `Tracked ${r.added} new domain(s), then ` : '') + 'dispatched. Ranks update when the scrape finishes.') : r?.reason === 'no-domain' ? 'These ads have no domain to refresh.' : r?.matched ? ((r.added ? `Tracked ${r.added} new domain(s), ` : '') + 'marked due; the runner refreshes on its next tick.') : 'Nothing to refresh.'); }} style={bulkBtn}>&#8635; REFRESH</button>
                <div style={s('flex:1;padding:0 12px;min-width:0')}><span style={s('font-size:10px;color:#9CA0A6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block')}>{bulkMsg}</span></div>
                <button onClick={() => { if (confirm(`Delete ${selCount} ad(s)? This removes them from the database.`)) bulkDelete(); }}
                  style={s(`background:none;border:1px solid rgba(255,120,120,.35);color:#ff8a80;font-family:${MONO};font-size:10px;padding:4px 10px;cursor:pointer`)}>DELETE {selCount}</button>
              </div>
            ) : (
              <>
                <div style={s('display:flex;align-items:center;gap:12px')}>
                  <span style={s(`font-family:${MONO};font-size:11px;color:#8A8E94;font-variant-numeric:tabular-nums`)}>
                    {pad(filtered.length)} <span style={s('color:#5A5E64')}>ads</span>
                    {pages > 1 && <span style={s('color:#5A5E64')}> &middot; showing {fmtInt(range.from)}-{fmtInt(range.to)}</span>}
                  </span>
                  <span style={s('color:#2E3136')}>|</span>
                  <span style={s('font-size:10.5px;color:#5A5E64')}>sorted by</span>
                  {sortDefs.map((sd) => (
                    <button key={sd.id} onClick={() => setSort(sd.id)}
                      style={s(`background:none;border:none;color:${sort === sd.id ? '#E7E8EA' : '#6C7076'};font-size:10.5px;letter-spacing:.3px;cursor:pointer`)}>
                      {sd.label}{sort === sd.id ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
                    </button>
                  ))}
                </div>
                <div style={s(`display:flex;align-items:center;gap:5px;font-family:${MONO};font-size:10px;color:#5A5E64`)}>
                  <span style={s('color:#5A5E64;letter-spacing:.3px')}>images</span>
                  <div style={s('display:flex;gap:1px;background:rgba(255,255,255,.08)')}>
                    {IMG_SIZES.map((z) => (
                      <button key={z.key} onClick={() => setImgKey(z.key)}
                        title={`Preview images ${z.hint}`}
                        style={s(`padding:3px 7px;background:${imgKey === z.key ? '#1A1C20' : '#0D0E11'};border:none;color:${imgKey === z.key ? A : '#8A8E94'};font-family:${MONO};font-size:10px;cursor:pointer`)}>{z.label}</button>
                    ))}
                  </div>
                  <span style={s('color:#2E3136;margin:0 4px')}>|</span>
                  <PageSizePicker value={pageSize} onChange={setPageSize} />
                  <span style={s('color:#2E3136;margin:0 4px')}>|</span>
                  <ColumnPicker defs={FRESH_COLS} visible={cols} toggle={toggleCol} reset={resetCols} />
                  {canEdit && <MetricsRefreshButton onRefresh={onRefreshMetrics} />}
                  <span style={s('color:#2E3136;margin:0 4px')}>|</span>
                  <button onClick={exportCsv} disabled={!filtered.length}
                    title={`Download these ${fmtInt(filtered.length)} ad(s) as a CSV — exactly the rows your filters and search leave showing`}
                    style={s(`background:#101216;border:1px solid rgba(255,255,255,.12);color:${filtered.length ? '#C6C9CE' : '#45484D'};font-family:${MONO};font-size:10px;letter-spacing:.3px;padding:4px 9px;cursor:${filtered.length ? 'pointer' : 'default'}`)}>↓ EXPORT CSV ({fmtInt(filtered.length)})</button>
                  {canEdit && (
                    <button onClick={() => setSheetOpen(true)} disabled={!filtered.length}
                      title={`Send these ${fmtInt(filtered.length)} ad(s) to a Google Sheet — exactly the rows your filters and search leave showing`}
                      style={s(`background:#101216;border:1px solid rgba(255,255,255,.12);color:${filtered.length ? '#C6C9CE' : '#45484D'};font-family:${MONO};font-size:10px;letter-spacing:.3px;padding:4px 9px;cursor:${filtered.length ? 'pointer' : 'default'}`)}>&#8599; EXPORT TO SHEET ({fmtInt(filtered.length)})</button>
                  )}
                  <span style={s('color:#2E3136;margin:0 4px')}>|</span>
                  <kbd style={s('border:1px solid rgba(255,255,255,.1);padding:1px 4px')}>J</kbd>
                  <kbd style={s('border:1px solid rgba(255,255,255,.1);padding:1px 4px')}>K</kbd>
                  <span style={s('color:#45484D')}>move</span>
                  <kbd style={s('border:1px solid rgba(255,255,255,.1);padding:1px 4px;margin-left:6px')}>&#8629;</kbd>
                  <span style={s('color:#45484D')}>open</span>
                </div>
              </>
            )}
          </div>

          <div style={s(`display:flex;align-items:center;height:26px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase;min-width:${tableMinW}px`)}>
            {canEdit && (
              <div style={s('width:28px;flex-shrink:0;display:flex;align-items:center')}>
                <span onClick={() => (allSelected ? clearSel() : setSelection(filteredIds))} title={`Select all ${filtered.length} filtered ads (every page)`}
                  style={s(`width:13px;height:13px;border:1px solid ${allSelected ? A : 'rgba(255,255,255,.25)'};background:${allSelected ? A : 'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:9px;color:#0B0C0E;line-height:1`)}>{allSelected ? '✓' : ''}</span>
              </div>
            )}
            <div style={s(`width:${thumbColW}px;flex-shrink:0`)} />
            {cols.has('page') && <div style={s('width:148px;flex-shrink:0')}>Page</div>}
            {cols.has('domain') && <div style={s('width:132px;flex-shrink:0')}>Domain</div>}
            {cols.has('brand') && <div style={s('width:96px;flex-shrink:0;padding-left:16px')}>Brand</div>}
            {cols.has('creative_language') && <div title="Language of the text ON the creative (image / video), not the ad copy" style={s('width:100px;flex-shrink:0;padding-left:16px')}>Creative Lang</div>}
            <div style={s('flex:1;min-width:0')}>Headline</div>
            {cols.has('url') && <div style={s('width:168px;flex-shrink:0')}>URL</div>}
            {showSlug && <div style={s('width:150px;flex-shrink:0;padding-left:16px')}>Slug</div>}
            {showQuery && <div title="The searched phrase from the Predicto landing link" style={s('width:240px;flex-shrink:0;padding-left:16px')}>Search Query</div>}
            {cols.has('revenue') && <div title="Revenue prediction from the campaign metrics sheet" style={s('width:96px;flex-shrink:0;text-align:right')}>Rev. Predict</div>}
            {cols.has('clicks') && <div style={s('width:76px;flex-shrink:0;text-align:right')}>Clicks</div>}
            {cols.has('rpc') && <div title="Revenue per click" style={s('width:60px;flex-shrink:0;text-align:right')}>RPC</div>}
            {cols.has('geos') && <div title="Revenue share by country from the campaign sheet, e.g. ES-90,MX-10" style={s('width:110px;flex-shrink:0;padding-left:16px')}>GEOS</div>}
            {cols.has('keywords') && <div style={s('width:170px;flex-shrink:0;padding-left:16px')}>Top Keywords</div>}
            {cols.has('format') && <div style={s('width:62px;flex-shrink:0;text-align:center')}>Format</div>}
            {cols.has('rank') && <div style={s('width:46px;flex-shrink:0;text-align:right')}>Rank</div>}
            {cols.has('added') && <div style={s('width:68px;flex-shrink:0;text-align:right')}>Added</div>}
            {cols.has('updated') && <div style={s('width:66px;flex-shrink:0;text-align:right')}>Updated</div>}
            {cols.has('days') && <div style={s('width:70px;flex-shrink:0;text-align:right')}>Days Run</div>}
            {cols.has('vertical') && <div style={s('width:92px;flex-shrink:0;padding-left:16px')}>Vertical</div>}
            {cols.has('country') && <div style={s('width:58px;flex-shrink:0;text-align:center')}>Country</div>}
            {cols.has('language') && <div style={s('width:74px;flex-shrink:0;padding-left:16px')}>Language</div>}
            {cols.has('feed') && <div style={s('width:92px;flex-shrink:0;padding-left:16px')}>Feed</div>}
            {cols.has('ad_id') && <div style={s('width:130px;flex-shrink:0;padding-left:16px')}>Ad Archive ID</div>}
          </div>

          {paged.map((a, i) => {
            const days = daysRunning(a, NOW);
            const fresh = isFresh(a);
            const sel = i === selIndex;
            const isSel = selected ? selected.has(a.ad_archive_id) : false;
            const vid = isVideo(a);
            const url = firstUrl(a.link_url);
            const slug = showSlug ? tarzoSlug(a) : '';
            const query = showQuery ? predictoQuery(a) : '';
            return (
              <div key={a.ad_archive_id} onClick={() => openDetail(a.ad_archive_id)} onMouseEnter={() => setSelIndex(i)}
                style={s(`position:relative;display:flex;align-items:center;min-height:56px;min-width:${tableMinW}px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.045);background:${isSel ? 'rgba(232,163,61,.09)' : (sel ? 'rgba(232,163,61,.05)' : 'transparent')};cursor:pointer`)}>
                <div style={s(`position:absolute;left:0;top:0;bottom:0;width:2px;background:${isSel || sel ? A : (fresh ? 'rgba(232,163,61,.5)' : 'transparent')}`)} />
                {canEdit && (
                  <div onClick={(e) => { e.stopPropagation(); toggleSel(a.ad_archive_id); }} style={s('width:28px;flex-shrink:0;display:flex;align-items:center;cursor:pointer')}>
                    <span style={s(`width:13px;height:13px;border:1px solid ${isSel ? A : 'rgba(255,255,255,.22)'};background:${isSel ? A : 'transparent'};display:flex;align-items:center;justify-content:center;font-size:9px;color:#0B0C0E;line-height:1`)}>{isSel ? '✓' : ''}</span>
                  </div>
                )}
                <div style={s(`width:${thumbColW}px;flex-shrink:0;padding-right:12px`)}><Thumb ad={a} size={img.px} fit={img.fit} /></div>
                {cols.has('page') && (
                  <CopyCell value={a.page_name} style={s('width:148px;flex-shrink:0;padding-right:12px;min-width:0;display:flex;align-items:center;gap:6px')}>
                    {fresh && <span style={s('width:6px;height:6px;border-radius:50%;background:#E8A33D;flex-shrink:0;animation:freshpulse 2.4s ease-in-out infinite')} />}
                    <span style={s('font-size:12.5px;color:#E7E8EA;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{a.page_name || '(unknown)'}</span>
                  </CopyCell>
                )}
                {cols.has('domain') && (
                  <CopyCell value={a.domain} style={s('width:132px;flex-shrink:0;padding-right:12px;min-width:0')}>
                    <span style={s(`font-family:${MONO};font-size:11px;color:#8A8E94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{a.domain || '-'}</span>
                  </CopyCell>
                )}
                {cols.has('brand') && (
                  <div style={s('width:96px;flex-shrink:0;padding-left:16px')}>
                    {a.brand
                      ? <span style={s(`display:inline-block;font-family:${MONO};font-size:9.5px;letter-spacing:.3px;color:${brandColor(a.brand)};border:1px solid ${brandColor(a.brand)}55;padding:2px 6px;white-space:nowrap`)}>{brandLabel(a.brand)}</span>
                      : <span style={s(`font-family:${MONO};font-size:10.5px;color:#45484D`)}>-</span>}
                  </div>
                )}
                {cols.has('creative_language') && (
                  <div style={s('width:100px;flex-shrink:0;padding-left:16px')} title={a.creative_language || (a.creative_language === '' ? 'No text on the creative' : '')}>
                    <span style={s(`font-family:${MONO};font-size:11px;color:${a.creative_language ? '#B6B9BE' : '#45484D'}`)}>{langCode(a.creative_language) || '-'}</span>
                  </div>
                )}
                <CopyCell value={a.title || a.caption || a.body_text || ''} style={s('flex:1;min-width:0;padding-right:16px')}>
                  <div style={s('font-size:12.5px;color:#C6C9CE;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical')}>{a.title || a.caption || a.body_text || ''}</div>
                </CopyCell>
                {cols.has('url') && (
                  <CopyCell value={url} style={s('width:168px;flex-shrink:0;padding-right:12px;min-width:0')}>
                    {url
                      ? <a href={url} target="_blank" rel="noreferrer" title={url} onClick={(e) => e.stopPropagation()}
                          style={s('display:flex;align-items:center;gap:4px;min-width:0;text-decoration:none')}>
                          <span style={s(`font-family:${MONO};font-size:10.5px;color:#8A8E94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{url}</span>
                          <span style={s('color:#5A5E64;font-size:9px;flex-shrink:0')}>&#8599;</span>
                        </a>
                      : <span style={s(`font-family:${MONO};font-size:10.5px;color:#45484D`)}>-</span>}
                  </CopyCell>
                )}
                {showSlug && (
                  <CopyCell value={slug} style={s('width:150px;flex-shrink:0;padding-left:16px;min-width:0')}>
                    {slug
                      ? <span title={slug} style={s('font-size:10.5px;color:#9CA0A6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{slug}</span>
                      : <span style={s('font-size:10.5px;color:#45484D')}>-</span>}
                  </CopyCell>
                )}
                {showQuery && (
                  <CopyCell value={query} style={s('width:240px;flex-shrink:0;padding-left:16px;min-width:0')}>
                    {query
                      ? <span title={query} style={s('font-size:10.5px;color:#9CA0A6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{query}</span>
                      : <span style={s('font-size:10.5px;color:#45484D')}>-</span>}
                  </CopyCell>
                )}
                {cols.has('revenue') && (
                  <div style={s('width:96px;flex-shrink:0;text-align:right')}>
                    <span title={a.sheet_revenue != null ? String(a.sheet_revenue) : 'No matching campaign in the metrics sheet'}
                      style={s(`font-family:${MONO};font-size:12px;color:${a.sheet_revenue != null ? '#E7E8EA' : '#45484D'};font-variant-numeric:tabular-nums`)}>{a.sheet_revenue != null ? fmtInt(a.sheet_revenue) : '-'}</span>
                  </div>
                )}
                {cols.has('clicks') && (
                  <div style={s('width:76px;flex-shrink:0;text-align:right')}>
                    <span style={s(`font-family:${MONO};font-size:11px;color:${a.sheet_clicks != null ? '#B6B9BE' : '#45484D'};font-variant-numeric:tabular-nums`)}>{a.sheet_clicks != null ? fmtInt(a.sheet_clicks) : '-'}</span>
                  </div>
                )}
                {cols.has('rpc') && (
                  <div style={s('width:60px;flex-shrink:0;text-align:right')}>
                    <span title={a.sheet_rpc != null ? String(a.sheet_rpc) : ''}
                      style={s(`font-family:${MONO};font-size:11px;color:${a.sheet_rpc != null ? '#B6B9BE' : '#45484D'};font-variant-numeric:tabular-nums`)}>{a.sheet_rpc != null ? fmtDec(a.sheet_rpc) : '-'}</span>
                  </div>
                )}
                {cols.has('geos') && (
                  <GeoSplitCell ad={a} style={s('width:110px;flex-shrink:0;padding-left:16px;min-width:0')} />
                )}
                {cols.has('keywords') && (
                  <CopyCell value={a.sheet_keywords || ''} style={s('width:170px;flex-shrink:0;padding-left:16px;min-width:0')}>
                    {a.sheet_keywords
                      ? <span title={a.sheet_keywords} style={s('font-size:10.5px;color:#9CA0A6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{a.sheet_keywords}</span>
                      : <span style={s('font-size:10.5px;color:#45484D')}>-</span>}
                  </CopyCell>
                )}
                {cols.has('format') && (
                  <div style={s('width:62px;flex-shrink:0;display:flex;justify-content:center')}>
                    <span style={s(`font-family:${MONO};font-size:9.5px;letter-spacing:.5px;color:${vid ? '#C6C9CE' : '#8A8E94'};border:1px solid rgba(255,255,255,.14);padding:2px 6px`)}>{a.display_format || '-'}</span>
                  </div>
                )}
                {cols.has('rank') && (
                  <div style={s('width:46px;flex-shrink:0;text-align:right')}>
                    <span style={s(`font-family:${MONO};font-size:12.5px;color:${a.rank != null && a.rank <= 3 ? A : '#B6B9BE'};font-variant-numeric:tabular-nums`)}>{a.rank != null ? a.rank : '-'}</span>
                  </div>
                )}
                {cols.has('added') && (
                  <div style={s('width:68px;flex-shrink:0;text-align:right')}>
                    <span title={a.first_seen_at || ''} style={s(`font-family:${MONO};font-size:10.5px;color:#8A8E94;font-variant-numeric:tabular-nums`)}>{fmtDate(a.first_seen_at)}</span>
                  </div>
                )}
                {cols.has('updated') && (
                  <div style={s('width:66px;flex-shrink:0;text-align:right')}>
                    <span title={a.last_seen_at || ''} style={s(`font-family:${MONO};font-size:10.5px;color:#8A8E94;font-variant-numeric:tabular-nums`)}>{a.last_seen_at ? relTime(NOW - new Date(a.last_seen_at).getTime()) : '-'}</span>
                  </div>
                )}
                {cols.has('days') && (
                  <div style={s('width:70px;flex-shrink:0;text-align:right')}>
                    {days >= 60 && <span title="Proven winner" style={s(`color:${A};font-size:10px;margin-right:3px`)}>★</span>}<span style={s(`font-family:${MONO};font-size:14px;color:${days >= 60 ? A : (days > 45 ? '#E7E8EA' : '#B6B9BE')};font-variant-numeric:tabular-nums`)}>{days}</span>
                    <span style={s('font-size:9px;color:#5A5E64;margin-left:2px')}>d</span>
                    <div style={s('height:2px;margin-top:4px;background:rgba(255,255,255,.06)')}><div style={s(`height:100%;width:${Math.round((days / maxDays) * 100)}%;background:${days > 45 ? '#8A8E94' : 'rgba(255,255,255,.22)'}`)} /></div>
                  </div>
                )}
                {cols.has('vertical') && (
                  <CopyCell value={a.vertical} style={s('width:92px;flex-shrink:0;padding-left:16px')}>
                    <span style={s('font-size:10.5px;color:#9CA0A6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{a.vertical || '-'}</span>
                  </CopyCell>
                )}
                {cols.has('country') && (
                  <div style={s('width:58px;flex-shrink:0;text-align:center')}>
                    <div style={s(`font-family:${MONO};font-size:11px;color:#B6B9BE`)}>{a.country || '-'}</div>
                    <div style={s(`font-family:${MONO};font-size:9px;color:#5A5E64`)} title={a.language || ''}>{langCode(a.language)}</div>
                  </div>
                )}
                {cols.has('language') && (
                  <div style={s('width:74px;flex-shrink:0;padding-left:16px')} title={a.language || ''}>
                    <span style={s(`font-family:${MONO};font-size:11px;color:${a.language ? '#B6B9BE' : '#45484D'}`)}>{langCode(a.language) || '-'}</span>
                  </div>
                )}
                {cols.has('feed') && (
                  <div style={s('width:92px;flex-shrink:0;padding-left:16px')}>
                    <span style={s('font-size:10.5px;color:#9CA0A6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block')}>{a.feed || '-'}</span>
                  </div>
                )}
                {cols.has('ad_id') && (
                  <CopyCell value={a.ad_archive_id} style={s('width:130px;flex-shrink:0;padding-left:16px;min-width:0')}>
                    <span style={s(`font-family:${MONO};font-size:10.5px;color:#8A8E94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block`)}>{a.ad_archive_id}</span>
                  </CopyCell>
                )}
              </div>
            );
          })}

          <Pager page={page} total={filtered.length} pageSize={pageSize} onPage={(p) => goPage(p, filtered.length, pageSize)} />
          <div style={s('padding:20px 16px;text-align:center')}>
            <span style={s(`font-family:${MONO};font-size:10.5px;color:#45484D;letter-spacing:.5px`)}>
              {pages > 1 ? <>PAGE {page + 1} OF {fmtInt(pages)}</> : <>END OF FEED</>} &middot; {pad(filtered.length)} RECORDS
            </span>
          </div>
          {filtered.length === 0 && (
            <div style={s('padding:60px 16px;text-align:center;color:#5A5E64;font-size:13px')}>No ads match. Run a scrape or clear filters.</div>
          )}
        </div>
      </div>
      {sheetOpen && (
        <SheetExportModal filtered={filtered} saEmail={exportSaEmail} onClose={() => setSheetOpen(false)} />
      )}
    </div>
  );
}

// Manual re-pull of the campaign metrics sheet (revenue, clicks, RPC, keywords).
// The server re-reads the tab immediately, bypassing its cache, and the fresh
// numbers arrive with the next server props. The button narrates its own state
// so a click is never a silent no-op.
function MetricsRefreshButton({ onRefresh }) {
  const [state, setState] = useState('idle'); // idle | working | done | error
  const [note, setNote] = useState('');
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const run = async (e) => {
    e.stopPropagation();
    if (state === 'working') return;
    setState('working');
    const r = await onRefresh();
    console.info('[metrics] refresh clicked', r);
    if (r?.ok) { setState('done'); setNote(`${r.campaigns} campaigns`); }
    else { setState('error'); setNote(r?.error || 'refresh failed'); }
    timerRef.current = setTimeout(() => { setState('idle'); setNote(''); }, 5000);
  };

  const color = state === 'error' ? '#ff8a80' : state === 'done' ? '#86C99A' : '#C6C9CE';
  const label = state === 'working' ? '⟳ REFRESHING...'
    : state === 'done' ? `✓ METRICS · ${note}`
    : state === 'error' ? '✕ METRICS FAILED'
    : '⟳ METRICS';
  return (
    <button onClick={run}
      title={state === 'error' ? note : 'Re-read the campaign metrics sheet now (revenue, clicks, RPC, keywords)'}
      style={s(`background:#101216;border:1px solid rgba(255,255,255,.12);color:${color};font-family:${MONO};font-size:10px;letter-spacing:.3px;padding:4px 9px;cursor:${state === 'working' ? 'wait' : 'pointer'}`)}>
      {label}
    </button>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPORT TO GOOGLE SHEET
// ═════════════════════════════════════════════════════════════════════════════
const SHEET_LS_ID = 'adintel.export.sheetId';
const SHEET_LS_TAB = 'adintel.export.tab';
const SHEET_LS_COLS = 'adintel.export.cols';
const SHEET_LS_MODE = 'adintel.export.mode';
// Reasons the server action can return, mapped to plain messages. permission/error
// carry their own already-actionable message, so they are not listed here.
const SHEET_REASON_MSG = {
  'bad-id': 'That does not look like a valid Sheet ID or URL.',
  'no-tab': 'Enter a tab name.',
  'no-rows': 'Nothing to export in the current view.',
  'no-columns': 'Pick at least one column to export.',
  'not-configured': 'Sheet export is not set up on the server yet (missing service-account credentials).',
};

// Read the remembered column selection, keeping only keys we still know. Falls back
// to every column the first time or if the stored value is unusable.
function loadCols() {
  try {
    const arr = JSON.parse(window.localStorage.getItem(SHEET_LS_COLS));
    if (Array.isArray(arr)) {
      const known = new Set(DEFAULT_SHEET_COLUMN_KEYS);
      const kept = arr.filter((k) => known.has(k));
      if (kept.length) return kept;
    }
  } catch { /* ignore */ }
  return [...DEFAULT_SHEET_COLUMN_KEYS];
}

// Modal: send the current Fresh Finds view to a Google Sheet the user names by id (or
// pasted URL) + tab, choosing which columns go out. The rows land with an image
// preview and link, styled for reading; rows already in the tab are skipped. The id,
// tab, and column choice are remembered in localStorage so a repeat export is nearly
// field-free. Only the ad ids + column keys are sent; the server re-reads the rows.
// Styled to match the AI-draft modal above.
function SheetExportModal({ filtered, saEmail, onClose }) {
  const ls = (k, d) => { try { return (typeof window !== 'undefined' && window.localStorage.getItem(k)) || d; } catch { return d; } };
  const [sheetId, setSheetId] = useState(() => ls(SHEET_LS_ID, ''));
  const [tab, setTab] = useState(() => ls(SHEET_LS_TAB, 'Fresh Finds'));
  const [cols, setCols] = useState(loadCols);
  const [mode, setMode] = useState(() => (ls(SHEET_LS_MODE, 'append') === 'replace' ? 'replace' : 'append'));
  const [state, setState] = useState('idle'); // idle | working | done | error
  const [msg, setMsg] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const count = filtered.length;
  const adIdOn = cols.includes('ad_id');

  // Remember the column choice and write mode as soon as they change, not only on a
  // successful export.
  useEffect(() => { try { window.localStorage.setItem(SHEET_LS_COLS, JSON.stringify(cols)); } catch { /* ignore */ } }, [cols]);
  useEffect(() => { try { window.localStorage.setItem(SHEET_LS_MODE, mode); } catch { /* ignore */ } }, [mode]);

  const toggleCol = (key) => setCols((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  const run = async () => {
    if (state === 'working') return;
    const id = parseSheetId(sheetId);
    if (!id) { setState('error'); setMsg(SHEET_REASON_MSG['bad-id']); return; }
    if (!tab.trim()) { setState('error'); setMsg(SHEET_REASON_MSG['no-tab']); return; }
    if (!cols.length) { setState('error'); setMsg(SHEET_REASON_MSG['no-columns']); return; }
    setState('working'); setMsg('');
    let r;
    try {
      r = await exportToSheet({ spreadsheetId: id, tabName: tab.trim(), adIds: filtered.map((a) => a.ad_archive_id), columnKeys: cols, mode });
    } catch (e) {
      setState('error'); setMsg(String(e?.message || e)); return;
    }
    if (r?.ok) {
      try { window.localStorage.setItem(SHEET_LS_ID, id); window.localStorage.setItem(SHEET_LS_TAB, tab.trim()); } catch { /* ignore */ }
      let done;
      if (r.mode === 'replace') {
        const bits = [r.created ? `Created tab "${tab.trim()}" with ${r.appended} row${r.appended === 1 ? '' : 's'}` : `Replaced tab with ${r.appended} row${r.appended === 1 ? '' : 's'}`];
        if (r.cleared) bits.push(`cleared ${r.cleared} old`);
        done = bits.join(' · ') + '.';
      } else if (r.appended === 0 && r.skipped > 0) {
        done = `All ${r.skipped} row${r.skipped === 1 ? '' : 's'} are already in that tab, so nothing new was added. Switch to Replace to refresh the whole tab.`;
      } else {
        const bits = [`Added ${r.appended} new row${r.appended === 1 ? '' : 's'}`];
        if (r.skipped) bits.push(`skipped ${r.skipped} already there`);
        if (r.created) bits.push(`created tab "${tab.trim()}"`);
        done = bits.join(' · ') + '.';
      }
      setSheetUrl(r.sheetUrl || '');
      setState('done'); setMsg(done);
    } else {
      setState('error');
      setMsg(SHEET_REASON_MSG[r?.reason] || r?.message || 'Export failed. Please try again.');
    }
  };

  const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } };
  const label = s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:6px');
  const input = s(`width:100%;background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#E7E8EA;font-family:${MONO};font-size:12px;padding:8px 9px;outline:none`);
  const miniBtn = s(`font-family:${MONO};font-size:9px;letter-spacing:.5px;color:#8A8E94;background:none;border:none;cursor:pointer`);
  const canRun = state !== 'working' && cols.length > 0;

  return (
    <div onClick={onClose} style={s('position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;padding:40px;animation:fadein .12s ease-out')}>
      <div onClick={(e) => e.stopPropagation()} style={s('width:520px;max-width:100%;max-height:88vh;display:flex;flex-direction:column;background:#101216;border:1px solid rgba(255,255,255,.14);box-shadow:0 24px 60px rgba(0,0,0,.6)')}>
        <div style={s('display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.08)')}>
          <span style={s(`font-family:${MONO};font-size:11px;letter-spacing:1px;color:#E7E8EA`)}>&#8599; EXPORT TO GOOGLE SHEET</span>
          <button onClick={onClose} style={s(`font-family:${MONO};font-size:10px;color:#8A8E94;background:none;border:1px solid rgba(255,255,255,.14);padding:4px 9px;cursor:pointer`)}>CLOSE</button>
        </div>
        <div style={s('padding:18px;display:flex;flex-direction:column;gap:14px;overflow-y:auto')}>
          <div style={s('font-size:11.5px;color:#9CA0A6;line-height:1.5')}>
            {mode === 'replace' ? 'Clears the tab and writes ' : 'Appends '}
            <span style={s(`color:${A};font-variant-numeric:tabular-nums`)}>{count}</span> row{count === 1 ? '' : 's'} &times; <span style={s(`color:${A};font-variant-numeric:tabular-nums`)}>{cols.length}</span> column{cols.length === 1 ? '' : 's'} from the current view (exactly the rows your filters and search leave showing — narrow them first to export a subset), with an image preview and image URL per row. {mode === 'replace' ? 'Whatever is in the tab now is replaced' : (adIdOn ? 'Rows already in the tab (matched by Ad ID) are skipped' : 'Include the Ad ID column to skip rows already in the tab')}, and the tab is created if it does not exist.
          </div>
          <div>
            <div style={label}>Sheet ID or URL</div>
            <input autoFocus value={sheetId} onChange={(e) => setSheetId(e.target.value)} onKeyDown={onKey}
              placeholder="1KA-szj...  or  https://docs.google.com/spreadsheets/d/.../edit" style={input} />
          </div>
          <div>
            <div style={label}>Tab name</div>
            <input value={tab} onChange={(e) => setTab(e.target.value)} onKeyDown={onKey} placeholder="Fresh Finds" style={input} />
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
              <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>Columns ({cols.length}/{SHEET_COLUMN_META.length})</div>
              <div style={s('display:flex;gap:12px')}>
                <button onClick={() => setCols(SHEET_COLUMN_META.map((m) => m.key))} style={miniBtn}>ALL</button>
                <button onClick={() => setCols([])} style={miniBtn}>NONE</button>
              </div>
            </div>
            <div style={s('display:flex;flex-wrap:wrap;gap:6px')}>
              {SHEET_COLUMN_META.map((m) => {
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
          {saEmail && (
            <div style={s('font-size:10.5px;color:#6C7076;line-height:1.5')}>
              Exports as <span style={s(`font-family:${MONO};color:#9CA0A6`)}>{saEmail}</span>. Share your sheet with this address as <b style={s('color:#9CA0A6')}>Editor</b> first, or the export cannot reach it.
            </div>
          )}
          {msg && (
            <div style={s(`font-size:11.5px;line-height:1.5;color:${state === 'error' ? '#ff8a80' : state === 'done' ? '#86C99A' : '#9CA0A6'}`)}>
              {msg}{' '}
              {state === 'done' && sheetUrl && <a href={sheetUrl} target="_blank" rel="noreferrer" style={s(`color:${A};text-decoration:none`)}>Open sheet &#8599;</a>}
            </div>
          )}
        </div>
        <div style={s('display:flex;justify-content:flex-end;gap:8px;padding:14px 18px;border-top:1px solid rgba(255,255,255,.08)')}>
          <button onClick={onClose} style={s(`font-family:${MONO};font-size:10px;color:#8A8E94;background:none;border:1px solid rgba(255,255,255,.14);padding:6px 12px;cursor:pointer`)}>CANCEL</button>
          <button onClick={run} disabled={!canRun}
            style={s(`font-family:${MONO};font-size:10px;color:#0B0C0E;background:${A};border:none;padding:6px 14px;cursor:${canRun ? 'pointer' : 'default'};opacity:${canRun ? '1' : '.6'}`)}>
            {state === 'working' ? 'EXPORTING...' : 'EXPORT'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CREATIVE DETAIL
// ═════════════════════════════════════════════════════════════════════════════
function RangeFilter({ title, min, max, onMin, onMax }) {
  const inp = 'flex:1;min-width:0;background:#0B0C0E;border:1px solid rgba(255,255,255,.1);color:#E7E8EA;font-family:' + MONO + ';font-size:11px;padding:6px 8px;outline:none;text-align:center';
  const active = min !== '' || max !== '';
  return (
    <div style={s('border-bottom:1px solid rgba(255,255,255,.06);padding:11px 14px 12px')}>
      <div style={s('display:flex;align-items:center;justify-content:space-between;margin-bottom:8px')}>
        <span style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>{title}</span>
        {active && <button onClick={() => { onMin(''); onMax(''); }} style={s(`background:none;border:none;color:#E8A33D;font-family:${MONO};font-size:9px;cursor:pointer`)}>reset</button>}
      </div>
      <div style={s('display:flex;align-items:center;gap:8px')}>
        <input type="number" value={min} onChange={(e) => onMin(e.target.value)} placeholder="min" style={s(inp)} />
        <span style={s('color:#45484D;font-size:11px')}>&ndash;</span>
        <input type="number" value={max} onChange={(e) => onMax(e.target.value)} placeholder="max" style={s(inp)} />
      </div>
    </div>
  );
}

function Detail({ ad, NOW, back, prev, next, update, updateLocal, commit, canEdit = true, lastRunStart }) {
  if (!ad) return <Placeholder view="detail" />;
  const vid = isVideo(ad);
  const days = daysRunning(ad, NOW);
  const src = thumbOf(ad);
  const fresh = lastRunStart ? new Date(ad.last_seen_at || ad.first_seen_at).getTime() >= lastRunStart : hoursSince(ad.last_seen_at || ad.first_seen_at, NOW) <= 24;
  const slug = tarzoSlug(ad);
  const query = predictoQuery(ad);
  const statuses = ['idea', 'drafting', 'published'];
  const owners = ['Mara K.', 'Devin R.', 'Priya S.', 'Ari L.'];

  // The feed ships ads without their article bodies (they dwarf everything else
  // combined), so pull this ad's body on first open and cache it into the shared
  // ads state - stepping back to this ad is then instant. `alive` drops a stale
  // response if the user has already moved to another ad; a failure is remembered
  // per ad so the section says so instead of spinning forever.
  const [articleFailedId, setArticleFailedId] = useState(null);
  useEffect(() => {
    if (!ad.has_article || ad.article_content) return;
    let alive = true;
    console.info('[detail article] loading', { adId: ad.ad_archive_id });
    getAdArticle(ad.ad_archive_id)
      .then((r) => {
        if (!alive) return;
        if (r?.ok) updateLocal(ad.ad_archive_id, { article_title: r.article_title, article_content: r.article_content });
        else setArticleFailedId(ad.ad_archive_id);
      })
      .catch((e) => { console.error('[detail article] load failed', e); if (alive) setArticleFailedId(ad.ad_archive_id); });
    return () => { alive = false; };
  }, [ad.ad_archive_id]);

  const [draft, setDraft] = useState(null);
  const [drafting, setDrafting] = useState(false);
  const genDraft = async () => {
    setDrafting(true);
    setDraft(null);
    try {
      const r = await fetch('/api/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adId: ad.ad_archive_id }),
      });
      const data = await r.json();
      setDraft(data.ok ? data.draft : `Error: ${data.error || 'draft failed'}`);
    } catch (e) {
      setDraft('Error: ' + String(e));
    }
    setDrafting(false);
  };

  const meta = [
    ['ad_archive_id', ad.ad_archive_id, A],
    ['page_id', ad.page_id, '#C6C9CE'],
    ['page_name', ad.page_name, '#C6C9CE'],
    ['start_date', (ad.start_date || '').slice(0, 10), '#C6C9CE'],
    ['days_running', `${days}d`, '#E7E8EA'],
    ['total_active_time', ad.total_active_time, '#C6C9CE'],
    ['publisher_platform', (ad.publisher_platform || []).join(', '), '#C6C9CE'],
    ['language', ad.language, '#C6C9CE'],
    ['creative_language', ad.creative_language, '#C6C9CE'],
    ['country', ad.country, '#C6C9CE'],
    ['vertical', ad.vertical, '#C6C9CE'],
    ['brand', brandLabel(ad.brand), ad.brand ? brandColor(ad.brand) : '#C6C9CE'],
    ['rank', ad.rank != null ? `#${ad.rank}` : '', '#C6C9CE'],
    ['domain', ad.domain, '#C6C9CE'],
  ];

  return (
    <div style={s('display:flex;min-height:calc(100vh - 44px)')}>
      {/* media column */}
      <div style={s('width:46%;flex-shrink:0;background:#0D0E11;border-right:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column')}>
        <div style={s('display:flex;align-items:center;gap:14px;height:40px;padding:0 18px;border-bottom:1px solid rgba(255,255,255,.06)')}>
          <button onClick={back} style={s(`display:flex;align-items:center;gap:6px;background:none;border:none;color:#8A8E94;font-size:11.5px;cursor:pointer`)}>&#8592; <span style={s(`font-family:${MONO};font-size:10.5px;letter-spacing:.5px`)}>FEED</span></button>
          <div style={s('flex:1')} />
          <button onClick={prev} style={s(`background:#101216;border:1px solid rgba(255,255,255,.08);color:#8A8E94;padding:2px 9px;font-family:${MONO};font-size:11px;cursor:pointer`)}>K &#8593;</button>
          <button onClick={next} style={s(`background:#101216;border:1px solid rgba(255,255,255,.08);color:#8A8E94;padding:2px 9px;font-family:${MONO};font-size:11px;cursor:pointer`)}>J &#8595;</button>
        </div>
        <div style={s('padding:20px;flex:1')}>
          <div style={s(`position:relative;width:100%;aspect-ratio:1/1;background:${tint(ad.ad_archive_id)};border:1px solid rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;overflow:hidden`)}>
            <div style={s('position:absolute;inset:0;background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.035) 0px,rgba(255,255,255,.035) 1px,transparent 1px,transparent 9px)')} />
            {vid && ad.video_hd_url ? (
              <video src={ad.video_hd_url} controls poster={ad.video_preview_url || undefined} style={s('position:relative;width:100%;height:100%;object-fit:contain;background:#000')} />
            ) : src ? (
              <img src={src} alt="" style={s('position:relative;width:100%;height:100%;object-fit:contain')} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
            ) : (
              <span style={s('color:#5A5E64;font-size:12px')}>no media</span>
            )}
            <div style={s(`position:absolute;top:10px;right:12px;font-family:${MONO};font-size:9.5px;color:#8A8E94;border:1px solid rgba(255,255,255,.14);padding:2px 6px;background:rgba(0,0,0,.4)`)}>{ad.display_format || '-'}</div>
          </div>
          {(ad.extra_image_urls?.length > 0 || ad.extra_video_urls?.length > 0) && (
            <div style={s('display:flex;gap:8px;margin-top:12px;flex-wrap:wrap')}>
              {[...(ad.extra_image_urls || []), ...(ad.extra_video_urls || [])].slice(0, 8).map((u, i) => (
                <a key={i} href={u} target="_blank" rel="noreferrer" style={s('width:56px;height:56px;border:1px solid rgba(255,255,255,.08);overflow:hidden;background:#101216;display:block')}>
                  <img src={u} alt="" style={s('width:100%;height:100%;object-fit:cover')} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* copy + workflow */}
      <div style={s('flex:1;min-width:0;display:flex')}>
        <div style={s('flex:1;min-width:0;padding:24px 30px;max-width:720px')}>
          <div style={s('display:flex;align-items:center;gap:10px;margin-bottom:4px')}>
            {fresh && <span style={s(`font-family:${MONO};font-size:9.5px;letter-spacing:1px;color:#0B0C0E;background:#E8A33D;padding:2px 6px`)}>FRESH</span>}
            <span style={s('font-size:11px;color:#8A8E94')}>{ad.page_name}</span>
            <span style={s('color:#2E3136')}>&middot;</span>
            <span style={s(`font-family:${MONO};font-size:11px;color:#6C7076`)}>{ad.domain}</span>
          </div>
          <h1 style={s('font-size:23px;font-weight:600;line-height:1.28;color:#F0F1F3;letter-spacing:-.3px;margin:8px 0 18px')}>{ad.title || ad.caption || '(no headline)'}</h1>

          <Field label="Body Text" big>{ad.body_text}</Field>
          <div style={s('display:flex;gap:24px;margin-top:16px')}>
            <div style={s('flex:1')}><Field label="Caption">{ad.caption}</Field></div>
            <div style={s('flex:1')}><Field label="Link Description">{ad.link_description}</Field></div>
          </div>

          <div style={s('display:flex;align-items:center;gap:16px;padding:12px 14px;margin-top:16px;background:#0D0E11;border:1px solid rgba(255,255,255,.08)')}>
            <span style={s('background:#E7E8EA;color:#0B0C0E;font-size:12px;font-weight:600;padding:8px 16px')}>{ad.cta_text || 'Learn More'}</span>
            <div style={s('display:flex;flex-direction:column;gap:2px;min-width:0')}>
              <span style={s(`font-family:${MONO};font-size:9.5px;color:#6C7076;letter-spacing:.5px`)}>CTA_TYPE &middot; {ad.cta_type || '-'}</span>
              {ad.link_url && <a href={ad.link_url.split(' | ')[0]} target="_blank" rel="noreferrer" style={s(`font-family:${MONO};font-size:11px;color:#E8A33D;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px`)}>{ad.link_url} &#8599;</a>}
              {isTarzo(ad) && slug && <span style={s(`font-family:${MONO};font-size:9.5px;color:#6C7076;letter-spacing:.5px`)}>SLUG &middot; <span style={s('color:#C6C9CE')}>{slug}</span></span>}
              {isPredicto(ad) && query && <span style={s(`font-family:${MONO};font-size:9.5px;color:#6C7076;letter-spacing:.5px`)}>SEARCH &middot; <span style={s('color:#C6C9CE')}>{query}</span></span>}
            </div>
          </div>

          {(ad.article_title || ad.article_content || ad.has_article) && (
            <div style={s('margin-top:28px;padding-top:22px;border-top:1px solid rgba(255,255,255,.09)')}>
              <div style={s('display:flex;align-items:center;gap:8px;margin-bottom:14px')}>
                <span style={s(`font-family:${MONO};font-size:9.5px;letter-spacing:1.2px;color:#5A5E64`)}>SCRAPED LANDING ARTICLE</span>
                <div style={s('flex:1;height:1px;background:rgba(255,255,255,.06)')} />
              </div>
              {ad.article_title && <h2 style={s('font-size:18px;font-weight:600;color:#E7E8EA;line-height:1.35;margin:0 0 14px')}>{ad.article_title}</h2>}
              <div style={s('font-size:13px;line-height:1.72;color:#A8ABB1;max-width:62ch')}>
                {ad.article_content
                  ? paras(ad.article_content).slice(0, 12).map((p, i) => <p key={i} style={s('margin:0 0 13px')}>{p}</p>)
                  : !ad.has_article
                    ? null
                    : articleFailedId === ad.ad_archive_id
                      ? <span style={s(`font-family:${MONO};font-size:11px;color:#5A5E64`)}>The article could not be loaded. Reopen this ad to retry.</span>
                      : <span style={s(`font-family:${MONO};font-size:11px;color:#5A5E64`)}>Loading article...</span>}
              </div>
            </div>
          )}

          <div style={s('margin-top:28px;padding-top:22px;border-top:1px solid rgba(255,255,255,.09)')}>
            <div style={s(`font-family:${MONO};font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;margin-bottom:14px`)}>RECORD METADATA</div>
            <div style={s('display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.06)')}>
              {meta.map(([k, v, c]) => (
                <div key={k} style={s('background:#0B0C0E;padding:9px 12px')}>
                  <div style={s('font-size:9px;letter-spacing:.8px;color:#5A5E64;text-transform:uppercase;margin-bottom:3px')}>{k}</div>
                  <div style={s(`font-family:${MONO};font-size:11.5px;color:${c};font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{v || '-'}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* workflow panel (local state for now; persistence next) */}
        <div style={s('width:300px;flex-shrink:0;background:#0D0E11;border-left:1px solid rgba(255,255,255,.09);position:sticky;top:44px;align-self:flex-start;max-height:calc(100vh - 44px);overflow-y:auto')}>
          <div style={s('display:flex;align-items:center;justify-content:space-between;height:40px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.06)')}>
            <span style={s(`font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:#8A8E94`)}>WORKFLOW</span>
            <button onClick={() => update(ad.ad_archive_id, { is_saved: !ad.is_saved })}
              style={s(`display:flex;align-items:center;gap:5px;background:none;border:1px solid ${ad.is_saved ? A : 'rgba(255,255,255,.14)'};color:${ad.is_saved ? A : '#8A8E94'};padding:3px 8px;font-family:${MONO};font-size:10px;cursor:pointer`)}>{ad.is_saved ? '★ SAVED' : '☆ STAR'}</button>
          </div>
          <div style={s('padding:16px;display:flex;flex-direction:column;gap:18px')}>
            {canEdit && (
              <button onClick={genDraft} disabled={drafting}
                style={s(`width:100%;background:${drafting ? '#5A5E64' : A};color:#0B0C0E;border:none;font-size:12px;font-weight:600;letter-spacing:.3px;padding:10px;cursor:${drafting ? 'default' : 'pointer'}`)}>
                {drafting ? 'DRAFTING...' : '✎ DRAFT ARTICLE'}
              </button>
            )}
            <div>
              <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>Pipeline Status</div>
              <div style={s('display:flex;flex-direction:column;gap:1px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.06)')}>
                {statuses.map((st) => {
                  const active = ad.status === st;
                  return (
                    <button key={st} onClick={() => update(ad.ad_archive_id, { status: st })}
                      style={s(`display:flex;align-items:center;gap:10px;padding:9px 12px;background:${active ? 'rgba(232,163,61,.06)' : '#0B0C0E'};border:none;cursor:pointer;text-align:left`)}>
                      <span style={s(`width:9px;height:9px;border-radius:50%;border:1.5px solid ${active ? A : 'rgba(255,255,255,.25)'};background:${active ? A : 'transparent'};flex-shrink:0`)} />
                      <span style={s(`flex:1;font-size:12px;color:${active ? '#E7E8EA' : '#9CA0A6'}`)}>{titleCase(st)}</span>
                      {active && <span style={s(`font-family:${MONO};font-size:9px;color:#E8A33D`)}>CURRENT</span>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>Brand</div>
              <div style={s('display:flex;flex-direction:column;gap:1px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.06)')}>
                {BRAND_OPTIONS.map((o) => {
                  const on = ad.brand === o.key;
                  return (
                    <button key={o.key} onClick={() => update(ad.ad_archive_id, { brand: on ? null : o.key })}
                      style={s(`display:flex;align-items:center;gap:10px;padding:9px 12px;background:${on ? 'rgba(232,163,61,.06)' : '#0B0C0E'};border:none;cursor:pointer;text-align:left`)}>
                      <span style={s(`width:9px;height:9px;border-radius:50%;border:1.5px solid ${on ? o.color : 'rgba(255,255,255,.25)'};background:${on ? o.color : 'transparent'};flex-shrink:0`)} />
                      <span style={s(`flex:1;font-size:12px;color:${on ? '#E7E8EA' : '#9CA0A6'}`)}>{o.label}</span>
                      {on && <span style={s(`font-family:${MONO};font-size:9px;color:${o.color}`)}>SET</span>}
                    </button>
                  );
                })}
              </div>
              <div style={s('font-size:9.5px;color:#5A5E64;margin-top:6px;line-height:1.4')}>Auto-detected from the creative; click to correct, or click again to clear.</div>
            </div>
            <div>
              <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>Owner</div>
              <div style={s('display:flex;gap:6px;flex-wrap:wrap')}>
                {owners.map((o) => {
                  const on = ad.owner === o;
                  const initials = o.split(' ').map((x) => x[0]).join('');
                  return (
                    <button key={o} onClick={() => update(ad.ad_archive_id, { owner: on ? null : o })}
                      style={s(`display:flex;align-items:center;gap:6px;padding:4px;background:${on ? 'rgba(232,163,61,.08)' : '#101216'};border:1px solid ${on ? A : 'rgba(255,255,255,.08)'};cursor:pointer`)}>
                      <span style={s(`width:20px;height:20px;border-radius:50%;background:${on ? A : 'rgba(255,255,255,.1)'};color:${on ? '#0B0C0E' : '#C6C9CE'};display:flex;align-items:center;justify-content:center;font-family:${MONO};font-size:9px;font-weight:600`)}>{initials}</span>
                      <span style={s(`font-size:11px;color:${on ? '#E7E8EA' : '#9CA0A6'};padding-right:6px`)}>{o}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>Linked Article URL</div>
              <input value={ad.linked_article_url || ''}
                onChange={(e) => updateLocal(ad.ad_archive_id, { linked_article_url: e.target.value })}
                onBlur={(e) => commit(ad.ad_archive_id, { linked_article_url: e.target.value })}
                placeholder="https://ourblog.com/..."
                style={s(`width:100%;background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#E8A33D;font-family:${MONO};font-size:11px;padding:7px 9px;outline:none`)} />
            </div>
            <div>
              <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>Notes</div>
              <textarea value={ad.notes || ''}
                onChange={(e) => updateLocal(ad.ad_archive_id, { notes: e.target.value })}
                onBlur={(e) => commit(ad.ad_archive_id, { notes: e.target.value })}
                placeholder="Angle worth copying..."
                style={s('width:100%;height:76px;resize:vertical;background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#C6C9CE;font-size:12px;line-height:1.5;padding:8px 9px;outline:none')} />
            </div>
            <div style={s('font-size:10px;color:#5A5E64;line-height:1.5')}>Changes save automatically to the database.</div>
          </div>
        </div>
      </div>

      {draft !== null && (
        <div onClick={() => setDraft(null)} style={s('position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;padding:40px;animation:fadein .12s ease-out')}>
          <div onClick={(e) => e.stopPropagation()} style={s('width:680px;max-width:100%;max-height:82vh;display:flex;flex-direction:column;background:#101216;border:1px solid rgba(255,255,255,.14);box-shadow:0 24px 60px rgba(0,0,0,.6)')}>
            <div style={s('display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.08)')}>
              <span style={s(`font-family:${MONO};font-size:11px;letter-spacing:1px;color:#E7E8EA`)}>AI DRAFT &middot; {ad.vertical || 'article'}</span>
              <div style={s('display:flex;gap:8px')}>
                <button onClick={() => navigator.clipboard?.writeText(draft)} style={s(`font-family:${MONO};font-size:10px;color:#C6C9CE;background:none;border:1px solid rgba(255,255,255,.14);padding:4px 9px;cursor:pointer`)}>COPY</button>
                {canEdit && <button onClick={() => { const merged = (ad.notes ? ad.notes + '\n\n' : '') + draft; updateLocal(ad.ad_archive_id, { notes: merged }); commit(ad.ad_archive_id, { notes: merged }); setDraft(null); }} style={s(`font-family:${MONO};font-size:10px;color:#0B0C0E;background:${A};border:none;padding:4px 9px;cursor:pointer`)}>SAVE TO NOTES</button>}
                <button onClick={() => setDraft(null)} style={s(`font-family:${MONO};font-size:10px;color:#8A8E94;background:none;border:1px solid rgba(255,255,255,.14);padding:4px 9px;cursor:pointer`)}>CLOSE</button>
              </div>
            </div>
            <div style={s('padding:20px 22px;overflow-y:auto;font-size:13.5px;line-height:1.7;color:#C6C9CE;white-space:pre-wrap')}>{draft}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children, big }) {
  return (
    <div>
      <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:6px')}>{label}</div>
      <p style={s(`font-size:${big ? '13.5px' : '12.5px'};line-height:${big ? '1.6' : '1.5'};color:${big ? '#C6C9CE' : '#9CA0A6'};margin:0`)}>{children || '-'}</p>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND PALETTE
// ═════════════════════════════════════════════════════════════════════════════
function Palette({ ads, paletteQuery, setPaletteQuery, close, go, openDetail }) {
  const q = paletteQuery.trim().toLowerCase();
  const actions = [
    { kind: 'VIEW', kc: '#6C7076', label: 'Go to Fresh Finds', run: () => go('fresh') },
    { kind: 'VIEW', kc: '#6C7076', label: 'Go to Competitor Feed', run: () => go('competitor') },
    { kind: 'VIEW', kc: '#6C7076', label: 'Go to Pipeline Board', run: () => go('pipeline') },
    { kind: 'VIEW', kc: '#6C7076', label: 'Go to Review Queue', run: () => go('review') },
    { kind: 'VIEW', kc: '#6C7076', label: 'Go to Control Room', run: () => go('settings') },
  ];
  const adItems = ads.map((a) => ({ kind: 'AD', kc: '#5A5E64', label: a.title || a.page_name || a.ad_archive_id, hint: a.domain, run: () => openDetail(a.ad_archive_id) }));
  const all = [...actions, ...adItems];
  const items = (q ? all.filter((x) => (x.label || '').toLowerCase().includes(q) || (x.hint || '').toLowerCase().includes(q)) : all).slice(0, 8);
  return (
    <div onClick={close} style={s('position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.6);display:flex;align-items:flex-start;justify-content:center;padding-top:120px;animation:fadein .12s ease-out')}>
      <div onClick={(e) => e.stopPropagation()} style={s('width:560px;background:#101216;border:1px solid rgba(255,255,255,.14);box-shadow:0 24px 60px rgba(0,0,0,.6)')}>
        <div style={s('display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08)')}>
          <span style={s('color:#5A5E64')}>&#8250;</span>
          <input id="ai-palette" value={paletteQuery} onChange={(e) => setPaletteQuery(e.target.value)}
            placeholder="Jump to action, view, or ad..."
            style={s('flex:1;background:transparent;border:none;outline:none;color:#E7E8EA;font-size:14px')} />
          <kbd style={s(`font-family:${MONO};font-size:10px;color:#5A5E64;border:1px solid rgba(255,255,255,.1);padding:1px 5px`)}>ESC</kbd>
        </div>
        <div style={s('max-height:340px;overflow-y:auto;padding:6px')}>
          {items.map((pi, i) => (
            <button key={i} onClick={pi.run} style={s('display:flex;align-items:center;gap:12px;width:100%;padding:9px 11px;background:transparent;border:none;cursor:pointer;text-align:left')}>
              <span style={s(`font-family:${MONO};font-size:10px;color:${pi.kc};width:52px;flex-shrink:0`)}>{pi.kind}</span>
              <span style={s('flex:1;font-size:13px;color:#E7E8EA;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{pi.label}</span>
              {pi.hint && <span style={s(`font-family:${MONO};font-size:10px;color:#5A5E64`)}>{pi.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PLACEHOLDER (Competitor / Pipeline / Control Room - built next)
// ═════════════════════════════════════════════════════════════════════════════
function Placeholder({ view }) {
  const label = { competitor: 'Competitor Feed', pipeline: 'Pipeline Board', settings: 'Control Room', detail: 'Creative Detail' }[view] || view;
  return (
    <div style={s('display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 44px);flex-direction:column;gap:10px')}>
      <span style={s(`font-family:${MONO};font-size:13px;letter-spacing:2px;color:#6C7076`)}>{label.toUpperCase()}</span>
      <span style={s('font-size:12px;color:#45484D')}>Built in the next step.</span>
    </div>
  );
}
