'use server';

import { getSql } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth';

const AD_FIELDS = ['status', 'owner', 'notes', 'is_saved', 'linked_article_url'];
const DOMAIN_FIELDS = ['query', 'country', 'active_status', 'max_ads', 'cadence', 'enabled', 'feed'];

function pick(patch, allowed) {
  const set = {};
  for (const k of allowed) if (k in patch) set[k] = patch[k];
  return set;
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
      insert into domains (query, country, active_status, max_ads, cadence, next_run_at)
      values (${d}, 'ALL', 'active', 100, 'daily', now())
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
    insert into domains (query, country, active_status, max_ads, cadence, feed)
    values (${data.query}, ${data.country || 'ALL'}, ${data.active_status || 'active'},
            ${data.max_ads || 100}, ${data.cadence || 'daily'}, ${data.feed || null})
    on conflict (query, country) do nothing
  `;
  revalidatePath('/');
}

export async function updateDomain(id, patch) {
  await requireAdmin();
  const set = pick(patch, DOMAIN_FIELDS);
  if (!Object.keys(set).length) return;
  const sql = getSql();
  await sql`update domains set ${sql(set)} where id = ${id}`;
  revalidatePath('/');
}

export async function deleteDomain(id) {
  await requireAdmin();
  const sql = getSql();
  await sql`delete from domains where id = ${id}`;
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
  await sql`update domains set next_run_at = now() where enabled and cadence <> 'paused'`;
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

// Stop the current scrape: mark any running run as stopped (frees the run-lock
// and clears the dashboard) and cancel in-progress / queued GitHub workflow runs
// so the runner actually halts. A local CLI run is not killed by this; use Ctrl-C.
export async function stopRun() {
  await requireAdmin();
  const sql = getSql();
  await sql`
    update runs set status = 'failed', finished_at = now(),
           error_detail = coalesce(error_detail, 'Stopped from dashboard')
     where status = 'running'
  `;
  revalidatePath('/');

  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO;
  let cancelled = 0;
  if (token && repo) {
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
  return { ok: true, cancelled };
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
