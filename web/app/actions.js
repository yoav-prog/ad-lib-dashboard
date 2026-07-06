'use server';

import { getSql } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { requireAuth } from '@/lib/auth';

const AD_FIELDS = ['status', 'owner', 'notes', 'is_saved', 'linked_article_url'];
const DOMAIN_FIELDS = ['query', 'country', 'active_status', 'max_ads', 'cadence', 'enabled', 'feed'];

function pick(patch, allowed) {
  const set = {};
  for (const k of allowed) if (k in patch) set[k] = patch[k];
  return set;
}

export async function updateAdWorkflow(adId, patch) {
  await requireAuth();
  const set = pick(patch, AD_FIELDS);
  if (!Object.keys(set).length) return;
  const sql = getSql();
  await sql`update ads set ${sql(set)} where ad_archive_id = ${adId}`;
  revalidatePath('/');
}

export async function addDomain(data) {
  await requireAuth();
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
  await requireAuth();
  const set = pick(patch, DOMAIN_FIELDS);
  if (!Object.keys(set).length) return;
  const sql = getSql();
  await sql`update domains set ${sql(set)} where id = ${id}`;
  revalidatePath('/');
}
