'use server';

import { getSql } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { validateLayout, TABLE_KEYS, PRESET_NAME_MAX, PRESETS_PER_TABLE_MAX } from '@/lib/columns';

// Per-account column presets for the dashboard tables. Presets are personal
// preference, so the gate is "any signed-in user" (like the feed reads), and every
// query is scoped to that user's id - a client can never name another user's id, and
// the layout is re-validated here against the table's catalog so a crafted request
// can't smuggle in an unknown column key or hide a pinned one. All writes fail closed
// on an unknown table_key.

async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new Error('Forbidden: sign in required');
  return user;
}

function cleanName(name) {
  return String(name || '').trim().slice(0, PRESET_NAME_MAX);
}

// Every preset the signed-in user has, across all four tables. The client groups
// them by table_key itself, so one round-trip serves every table on the page.
export async function listColumnPresets() {
  const user = await requireUser();
  const sql = getSql();
  const rows = await sql`
    select id, table_key, name, layout, is_default from column_presets
     where user_id = ${user.id}
     order by table_key, lower(name)
  `;
  return { ok: true, presets: rows };
}

// Create or overwrite a named preset for one table. Re-saving an existing name
// updates its layout in place (so "Save" on a tweaked preset does the obvious thing)
// rather than erroring or spawning a duplicate. Optionally makes it the table's
// default in the same transaction.
export async function saveColumnPreset({ tableKey, name, layout, makeDefault = false } = {}) {
  const user = await requireUser();
  if (!TABLE_KEYS.includes(tableKey)) return { ok: false, reason: 'bad-table' };
  const clean = cleanName(name);
  if (!clean) return { ok: false, reason: 'no-name' };
  const normalized = validateLayout(tableKey, layout);
  if (!normalized) return { ok: false, reason: 'bad-layout' };

  const sql = getSql();
  try {
    const preset = await sql.begin(async (tx) => {
      // Cap only bites new names; overwriting an existing preset is always allowed.
      const exists = await tx`
        select id from column_presets
         where user_id = ${user.id} and table_key = ${tableKey} and lower(name) = lower(${clean})
      `;
      if (!exists.length) {
        const [{ count }] = await tx`
          select count(*)::int as count from column_presets
           where user_id = ${user.id} and table_key = ${tableKey}
        `;
        if (count >= PRESETS_PER_TABLE_MAX) throw new Error('preset-limit');
      }
      if (makeDefault) {
        await tx`
          update column_presets set is_default = false
           where user_id = ${user.id} and table_key = ${tableKey} and is_default
        `;
      }
      const rows = await tx`
        insert into column_presets (user_id, table_key, name, layout, is_default)
        values (${user.id}, ${tableKey}, ${clean}, ${tx.json(normalized)}, ${makeDefault})
        on conflict (user_id, table_key, lower(name))
        do update set layout = excluded.layout,
                      is_default = column_presets.is_default or excluded.is_default,
                      updated_at = now()
        returning id, table_key, name, layout, is_default
      `;
      return rows[0];
    });
    console.info('[preset save]', { tableKey, name: clean, id: preset.id, makeDefault });
    return { ok: true, preset };
  } catch (e) {
    if (String(e.message).includes('preset-limit')) return { ok: false, reason: 'limit', max: PRESETS_PER_TABLE_MAX };
    console.error('[preset save] failed', { tableKey, message: String(e.message || e) });
    return { ok: false, reason: 'error' };
  }
}

export async function deleteColumnPreset(id) {
  const user = await requireUser();
  const sql = getSql();
  const rows = await sql`
    delete from column_presets where id = ${String(id)} and user_id = ${user.id} returning id
  `;
  console.info('[preset delete]', { id: String(id), removed: rows.length });
  return { ok: rows.length > 0, removed: rows.length };
}

// Make one preset the table's default, or clear the default entirely (id = null).
// Done in a transaction so the one-default-per-table index never sees two.
export async function setDefaultColumnPreset({ tableKey, id = null } = {}) {
  const user = await requireUser();
  if (!TABLE_KEYS.includes(tableKey)) return { ok: false, reason: 'bad-table' };
  const sql = getSql();
  await sql.begin(async (tx) => {
    await tx`
      update column_presets set is_default = false
       where user_id = ${user.id} and table_key = ${tableKey} and is_default
    `;
    if (id) {
      await tx`
        update column_presets set is_default = true, updated_at = now()
         where id = ${String(id)} and user_id = ${user.id} and table_key = ${tableKey}
      `;
    }
  });
  console.info('[preset default]', { tableKey, id: id ? String(id) : null });
  return { ok: true };
}
