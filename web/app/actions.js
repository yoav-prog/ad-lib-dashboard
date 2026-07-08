'use server';

import { getSql } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth';
import { getAdsByIds } from '@/lib/queries';
import { buildSheetData, DEFAULT_SHEET_COLUMN_KEYS } from '@/lib/ui';
import { appendRowsToSheet, sheetsConfigured, serviceAccountEmail } from '@/lib/sheets';

const AD_FIELDS = ['status', 'owner', 'notes', 'is_saved', 'linked_article_url'];
const DOMAIN_FIELDS = ['query', 'country', 'active_status', 'max_ads', 'interval_days', 'enabled', 'feed'];

function pick(patch, allowed) {
  const set = {};
  for (const k of allowed) if (k in patch) set[k] = patch[k];
  return set;
}

// Domain ids key a uuid column and there is no uuid = text operator, so anything
// that is not a uuid is dropped rather than trusted. Deduped and capped so a bulk
// call can never smuggle in a huge or malformed id list.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanDomainIds(ids, cap = 500) {
  return Array.isArray(ids)
    ? [...new Set(ids.map(String).filter((x) => UUID_RE.test(x)))].slice(0, cap)
    : [];
}

export async function updateAdWorkflow(adId, patch) {
  await requireAdmin();
  const set = pick(patch, AD_FIELDS);
  if (!Object.keys(set).length) return;
  const sql = getSql();
  await sql`update ads set ${sql(set)} where ad_archive_id = ${adId}`;
  revalidatePath('/');
}

export async function deleteAds(ids) {
  await requireAdmin();
  if (!Array.isArray(ids) || !ids.length) return;
  const sql = getSql();
  await sql`delete from ads where ad_archive_id = any(${ids})`;
  revalidatePath('/');
}

export async function bulkUpdateAds(ids, patch) {
  await requireAdmin();
  if (!Array.isArray(ids) || !ids.length) return;
  const set = pick(patch, AD_FIELDS);
  if (!Object.keys(set).length) return;
  const sql = getSql();
  await sql`update ads set ${sql(set)} where ad_archive_id = any(${ids})`;
  revalidatePath('/');
}

// Re-scrape the domains behind the given ads so their rank / last_seen refresh.
// The pipeline is per-query, so this marks the matching tracked domains due (and
// dispatches the workflow if configured); the scrape then upserts fresh data.
export async function refreshAds(ids) {
  await requireAdmin();
  if (!Array.isArray(ids) || !ids.length) return { ok: false, matched: 0 };
  const sql = getSql();
  const rows = await sql`select distinct domain from ads where ad_archive_id = any(${ids}) and domain is not null`;
  const doms = rows.map((r) => r.domain);
  if (!doms.length) return { ok: false, matched: 0, reason: 'no-domain' };
  // Mark already-tracked domains due (re-enabling any that were paused).
  const bumped = await sql`
    update domains set next_run_at = now(), enabled = true
    where query = any(${doms}) returning query
  `;
  const tracked = new Set(bumped.map((r) => r.query));

  // Auto-track any domain not yet in Control Room, so refresh always works.
  let added = 0;
  for (const d of doms) {
    if (tracked.has(d)) continue;
    const ins = await sql`
      insert into domains (query, country, active_status, max_ads, interval_days, next_run_at)
      values (${d}, 'ALL', 'active', 100, 3, now())
      on conflict (query, country) do update set next_run_at = now(), enabled = true
      returning id
    `;
    if (ins.length) added += 1;
  }
  revalidatePath('/');

  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO;
  let dispatched = false;
  if (token && repo) {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/scrape.yml/dispatches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ ref: 'main' }),
      });
      dispatched = r.ok;
    } catch {
      // ignore
    }
  }
  return { ok: true, matched: tracked.size + added, added, dispatched, doms };
}

export async function addDomain(data) {
  await requireAdmin();
  const sql = getSql();
  await sql`
    insert into domains (query, country, active_status, max_ads, interval_days, feed)
    values (${data.query}, ${data.country || 'ALL'}, ${data.active_status || 'active'},
            ${data.max_ads || 100}, ${clampDays(data.interval_days, 3)}, ${data.feed || null})
    on conflict (query, country) do nothing
  `;
  revalidatePath('/');
}

// Clamp an incoming interval to the DB's 1..365 CHECK so a bad value fails safe in
// the app rather than at the database. Falls back to `dflt` when absent/unparseable.
function clampDays(v, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(365, Math.max(1, n));
}

// Keep a bulk-set Max Ads sane (1..1000) so one fat-fingered value can't blow up a
// scrape's scope across many rows at once.
function clampMaxAds(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 100;
  return Math.min(1000, Math.max(1, n));
}

export async function updateDomain(id, patch) {
  await requireAdmin();
  const set = pick(patch, DOMAIN_FIELDS);
  if (!Object.keys(set).length) return;
  const sql = getSql();
  // Changing the frequency also re-spaces the next run from the last one, so
  // "Next Due" reflects the new interval immediately instead of on the next scrape.
  // Any other fields in the same patch are written first with the normal helper.
  if ('interval_days' in set) {
    const days = clampDays(set.interval_days, 3);
    delete set.interval_days;
    if (Object.keys(set).length) await sql`update domains set ${sql(set)} where id = ${id}`;
    await sql`update domains
                 set interval_days = ${days},
                     next_run_at = coalesce(last_run_at, now()) + make_interval(days => ${days})
               where id = ${id}`;
    revalidatePath('/');
    return;
  }
  await sql`update domains set ${sql(set)} where id = ${id}`;
  revalidatePath('/');
}

export async function deleteDomain(id) {
  await requireAdmin();
  const sql = getSql();
  await sql`delete from domains where id = ${id}`;
  revalidatePath('/');
}

// Apply one change (status, feed, max ads, or cadence) to many tracked rows at
// once. Mirrors updateDomain's rules: fields are restricted to DOMAIN_FIELDS,
// max_ads/interval_days are clamped, and an interval change re-spaces next_run_at
// so "Next Due" reflects the new cadence immediately.
export async function bulkUpdateDomains(ids, patch) {
  await requireAdmin();
  const clean = cleanDomainIds(ids);
  if (!clean.length) return;
  const set = pick(patch, DOMAIN_FIELDS);
  if ('max_ads' in set) set.max_ads = clampMaxAds(set.max_ads);
  if (!Object.keys(set).length) return;
  const sql = getSql();
  if ('interval_days' in set) {
    const days = clampDays(set.interval_days, 3);
    delete set.interval_days;
    if (Object.keys(set).length) await sql`update domains set ${sql(set)} where id = any(${clean}::uuid[])`;
    await sql`update domains
                 set interval_days = ${days},
                     next_run_at = coalesce(last_run_at, now()) + make_interval(days => ${days})
               where id = any(${clean}::uuid[])`;
    revalidatePath('/');
    return;
  }
  await sql`update domains set ${sql(set)} where id = any(${clean}::uuid[])`;
  revalidatePath('/');
}

export async function deleteDomains(ids) {
  await requireAdmin();
  const clean = cleanDomainIds(ids);
  if (!clean.length) return;
  const sql = getSql();
  await sql`delete from domains where id = any(${clean}::uuid[])`;
  revalidatePath('/');
}

export async function addFeed(name) {
  await requireAdmin();
  const n = String(name || '').trim();
  if (!n) return;
  const sql = getSql();
  await sql`insert into feeds (name) values (${n}) on conflict (name) do nothing`;
  revalidatePath('/');
}

export async function deleteFeed(id) {
  await requireAdmin();
  const sql = getSql();
  await sql`delete from feeds where id = ${id}`;
  revalidatePath('/');
}

// Manual "Run now": make every enabled domain due immediately, then (if a
// GitHub dispatch token is configured) kick the scrape workflow so it runs at
// once. Without the token it still marks them due for the next scheduled tick.
export async function triggerScrape() {
  await requireAdmin();
  const sql = getSql();
  await sql`update domains set next_run_at = now() where enabled`;
  revalidatePath('/');

  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO; // e.g. "yoav-prog/ad-lib-dashboard"
  if (!token || !repo) {
    return { ok: true, dispatched: false, reason: 'no-dispatch-token' };
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/scrape.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    return { ok: r.ok, dispatched: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, dispatched: false, reason: String(e) };
  }
}

// Targeted "Run selected": scrape exactly the given tracked rows (one or many),
// each with its own settings, in isolation from the rest. Dispatches the scrape
// workflow with the selected domain ids so the runner scrapes only those and
// advances only their schedules. Without a dispatch token (or if the workflow on
// main does not yet declare the domain_ids input, e.g. before this branch merges)
// we fall back to marking just those rows due; the scheduled runner then picks
// them up on its next tick, alongside anything else already due. Returns what it
// did so the UI can report honestly. Capped at 50 rows per targeted run.
export async function runDomains(ids) {
  await requireAdmin();
  const clean = cleanDomainIds(ids, 50);
  if (!clean.length) return { ok: false, reason: 'no-ids' };

  const sql = getSql();
  const markDue = async () => {
    // Cast to uuid[]: id is a uuid column and there is no uuid = text operator.
    await sql`update domains set next_run_at = now(), enabled = true where id = any(${clean}::uuid[])`;
    revalidatePath('/');
  };

  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO;
  if (!token || !repo) {
    await markDue();
    return { ok: true, dispatched: false, count: clean.length, reason: 'no-dispatch-token' };
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/scrape.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ ref: 'main', inputs: { domain_ids: clean.join(',') } }),
    });
    if (r.ok) return { ok: true, dispatched: true, count: clean.length, status: r.status };
    // Non-ok (e.g. 422 when main has not merged the domain_ids input yet): degrade
    // to marking due so the click is never a no-op.
    await markDue();
    return { ok: true, dispatched: false, count: clean.length, reason: 'dispatch-failed', status: r.status };
  } catch (e) {
    await markDue();
    return { ok: true, dispatched: false, count: clean.length, reason: String(e) };
  }
}

// Stop the current scrape: mark any running run as stopped (frees the run-lock
// and clears the dashboard) and cancel in-progress / queued GitHub workflow runs
// so the runner actually halts, even a background job the dashboard never saw
// claim a run (e.g. one still spinning up). A local CLI run is not killed by
// this; use Ctrl-C. Returns exactly what it stopped so the UI can report it:
//   cleared      - running DB runs marked failed (the visible run, if any)
//   cancelled    - GitHub workflow runs cancelled (the background job)
//   ghConfigured - whether we could reach GitHub to cancel at all
export async function stopRun() {
  await requireAdmin();
  const sql = getSql();
  const clearedRows = await sql`
    update runs set status = 'failed', finished_at = now(),
           error_detail = coalesce(error_detail, 'Stopped from dashboard')
     where status = 'running'
     returning id
  `;
  const cleared = clearedRows.length;
  revalidatePath('/');

  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO;
  const ghConfigured = Boolean(token && repo);
  let cancelled = 0;
  if (ghConfigured) {
    const gh = (path, method = 'GET') => fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    try {
      const res = await gh('/actions/workflows/scrape.yml/runs?per_page=15');
      if (res.ok) {
        const data = await res.json();
        for (const run of data.workflow_runs || []) {
          if (run.status === 'in_progress' || run.status === 'queued' || run.status === 'waiting') {
            const c = await gh(`/actions/runs/${run.id}/cancel`, 'POST');
            if (c.ok) cancelled += 1;
          }
        }
      }
    } catch {
      // ignore; the DB status flip already stopped the dashboard/lock
    }
  }
  return { ok: true, cancelled, cleared, ghConfigured };
}

// Mark a stalled run as failed from the dashboard, used when the heartbeat has
// gone silent. Scoped to status='running' so it can never clobber a run that
// completed on its own in the meantime.
export async function markRunFailed(runId) {
  await requireAdmin();
  const sql = getSql();
  await sql`
    update runs
       set status = 'failed', finished_at = now(),
           error_detail = coalesce(error_detail, 'Marked failed from dashboard (stalled: no heartbeat for 90s+)')
     where id = ${runId} and status = 'running'
  `;
  revalidatePath('/');
}

// Push the current Fresh Finds view to a Google Sheet the caller names by id + tab,
// exporting only the columns they picked. The client sends only the on-screen ad ids
// and the chosen column keys; the rows are re-read from the DB here so the payload is
// small and the exported data is server-authoritative. New rows are appended and ones
// already in the tab (matched by Ad ID, when that column is included) are skipped.
// Auth is the project's existing service account (see lib/sheets). Returns a summary,
// or an { ok:false } with a reason the modal turns into a clear message. Capped at
// 1000 ids so one call can never smuggle in an unbounded list.
const SHEET_ID_RE = /^[a-zA-Z0-9-_]{20,}$/;

export async function exportToSheet({ spreadsheetId, tabName, adIds, columnKeys } = {}) {
  await requireAdmin();
  const id = String(spreadsheetId || '').trim();
  const tab = String(tabName || '').trim();
  const saEmail = serviceAccountEmail();
  if (!SHEET_ID_RE.test(id)) return { ok: false, reason: 'bad-id', saEmail };
  if (!tab) return { ok: false, reason: 'no-tab', saEmail };
  if (!Array.isArray(adIds) || !adIds.length) return { ok: false, reason: 'no-rows', saEmail };
  if (!sheetsConfigured()) return { ok: false, reason: 'not-configured', saEmail };

  // Trust only known column keys; fall back to the full set. Preserves canonical order.
  const allowed = new Set(DEFAULT_SHEET_COLUMN_KEYS);
  const keys = Array.isArray(columnKeys) ? columnKeys.filter((k) => allowed.has(k)) : [];
  if (Array.isArray(columnKeys) && !keys.length) return { ok: false, reason: 'no-columns', saEmail };

  const ids = [...new Set(adIds.map(String))].slice(0, 1000);
  const ads = await getAdsByIds(ids);
  if (!ads.length) return { ok: false, reason: 'no-rows', saEmail };

  const { columns, rows } = buildSheetData(ads, Date.now(), keys.length ? keys : DEFAULT_SHEET_COLUMN_KEYS);
  try {
    const result = await appendRowsToSheet({ spreadsheetId: id, tabName: tab, columns, rows }, Date.now());
    return { ok: true, saEmail, sheetUrl: `https://docs.google.com/spreadsheets/d/${id}`, ...result };
  } catch (e) {
    return { ok: false, reason: e.code === 'PERMISSION' ? 'permission' : 'error', message: String(e.message || e), saEmail };
  }
}
