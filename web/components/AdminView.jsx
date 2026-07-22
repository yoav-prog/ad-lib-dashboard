'use client';

import { useState } from 'react';
import Link from 'next/link';
import { s } from '@/lib/style';
import { A, MONO, relTime } from '@/lib/ui';
import { CAPABILITIES, ROLE_META, ROLE_DEFAULTS, FIXED_ADMIN_ONLY, resolveCapabilities } from '@/lib/capabilities';
import { inviteUser, resendInvite, updateUser, setUserDisabled, removeUser } from '@/app/admin/actions';

const PANEL = 'background:#0D0E11;border:1px solid rgba(255,255,255,.09)';
const LABEL = 'font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase';

function btn(kind = 'plain') {
  const base = `font-family:${MONO};font-size:10px;padding:4px 9px;cursor:pointer;background:#101216`;
  if (kind === 'primary') return s(`${base};background:${A};color:#0B0C0E;border:none;font-weight:600;padding:9px 14px;font-size:11px`);
  if (kind === 'danger') return s(`${base};border:1px solid rgba(255,120,120,.35);color:#ff8a80`);
  return s(`${base};border:1px solid rgba(255,255,255,.12);color:#C6C9CE`);
}

// The permissions a role grants, as a readable phrase for the table.
function capSummary(user) {
  const caps = resolveCapabilities(user);
  if (user.status !== 'active') return '—';
  const on = CAPABILITIES.filter((c) => caps[c.key]);
  if (!on.length) return 'Read-only';
  if (on.length === CAPABILITIES.length) return 'Full access';
  return on.filter((c) => c.key !== FIXED_ADMIN_ONLY).map((c) => c.label).join(', ');
}

function statusPill(status) {
  const map = {
    active: { text: 'Active', color: '#7BC47F', border: 'rgba(123,196,127,.35)' },
    invited: { text: 'Invited', color: '#E8A33D', border: 'rgba(232,163,61,.35)' },
    disabled: { text: 'Disabled', color: '#8A8E94', border: 'rgba(255,255,255,.14)' },
  };
  const v = map[status] || map.disabled;
  return (
    <span style={s(`font-family:${MONO};font-size:9.5px;letter-spacing:.5px;color:${v.color};border:1px solid ${v.border};padding:2px 7px`)}>
      {v.text}
    </span>
  );
}

export default function AdminView({ users: initialUsers, events, domain, mailProblem, me, viaBreakGlass }) {
  const [users, setUsers] = useState(initialUsers);
  const [msg, setMsg] = useState(null);          // { ok, text }
  const [editing, setEditing] = useState(null);  // user id
  const [busy, setBusy] = useState(null);        // user id or 'invite'

  // Server actions revalidate /admin, but this page is a client tree, so the
  // simplest correct refresh is a reload: it re-runs the gate too, which matters
  // if the acting admin just changed their own access.
  const after = (r) => {
    setMsg(r?.ok ? { ok: true, text: r.message || 'Done.' } : { ok: false, text: r?.error || 'Something went wrong.' });
    setBusy(null);
    if (r?.ok) setTimeout(() => window.location.reload(), 600);
  };

  const run = async (id, fn) => {
    setBusy(id);
    setMsg(null);
    try { after(await fn()); } catch (e) { after({ ok: false, error: String(e?.message || e) }); }
  };

  return (
    <div style={s('min-height:100vh;background:#0B0C0E')}>
      {/* header */}
      <div style={s('position:sticky;top:0;z-index:40;display:flex;align-items:center;height:44px;padding:0 14px;gap:14px;background:#0B0C0E;border-bottom:1px solid rgba(255,255,255,.09)')}>
        <div style={s('display:flex;align-items:center;gap:9px;padding-right:16px;border-right:1px solid rgba(255,255,255,.08);height:100%')}>
          <div style={s('width:15px;height:15px;border:1.5px solid #E8A33D;transform:rotate(45deg)')} />
          <span style={s(`font-family:${MONO};font-size:12px;font-weight:600;letter-spacing:1.5px;color:#E7E8EA`)}>ADINTEL</span>
        </div>
        <span style={s(`font-family:${MONO};font-size:11.5px;letter-spacing:1px;color:${A};text-transform:uppercase`)}>Users</span>
        <div style={s('flex:1')} />
        {me && <span style={s(`font-family:${MONO};font-size:10.5px;color:#6C7076`)}>{me.email}</span>}
        <Link href="/" style={s(`font-family:${MONO};font-size:10px;color:#8A8E94;border:1px solid rgba(255,255,255,.12);padding:4px 9px;text-decoration:none`)}>
          ← DASHBOARD
        </Link>
      </div>

      <div style={s('max-width:1180px;margin:0 auto;padding:22px 16px 60px')}>
        {viaBreakGlass && (
          <Banner tone="warn">
            You are signed in with the break-glass passcode. This grants user management only, expires in 30 minutes,
            and is logged. Fix the admin account you came here for, then sign in normally.
          </Banner>
        )}
        {mailProblem && <Banner tone="warn">{mailProblem} Invites and reset links cannot be sent until this is fixed.</Banner>}
        {msg && <Banner tone={msg.ok ? 'ok' : 'error'}>{msg.text}</Banner>}

        <InviteForm domain={domain} busy={busy === 'invite'} onSubmit={(data) => run('invite', () => inviteUser(data))} />

        {/* people */}
        <div style={s(`${PANEL};margin-top:20px`)}>
          <div style={s('display:flex;align-items:center;justify-content:space-between;height:36px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.06)')}>
            <span style={s(`font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:#6C7076`)}>PEOPLE</span>
            <span style={s(`font-family:${MONO};font-size:10px;color:#5A5E64`)}>{users.length}</span>
          </div>

          <div style={s('display:flex;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.06)')}>
            <div style={s(`${LABEL};flex:2;min-width:0`)}>Person</div>
            <div style={s(`${LABEL};width:74px;flex-shrink:0`)}>Role</div>
            <div style={s(`${LABEL};flex:2;min-width:0`)}>Permissions</div>
            <div style={s(`${LABEL};width:76px;flex-shrink:0`)}>Status</div>
            <div style={s(`${LABEL};width:88px;flex-shrink:0`)}>Last sign-in</div>
            <div style={s(`${LABEL};width:250px;flex-shrink:0;text-align:right`)}>Actions</div>
          </div>

          {users.map((u) => {
            const isSelf = me && me.id === u.id;
            const rowBusy = busy === u.id;
            return (
              <div key={u.id}>
                <div style={s(`display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.04);opacity:${u.status === 'disabled' ? '.55' : '1'}`)}>
                  <div style={s('flex:2;min-width:0')}>
                    <div style={s('font-size:12.5px;color:#E7E8EA;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>
                      {u.email}{isSelf && <span style={s(`color:${A};font-size:10px;margin-left:7px`)}>you</span>}
                    </div>
                    {u.name && <div style={s('font-size:11px;color:#6C7076;margin-top:2px')}>{u.name}</div>}
                  </div>
                  <div style={s(`width:74px;flex-shrink:0;font-family:${MONO};font-size:10.5px;color:#9CA0A6;text-transform:uppercase`)}>{u.role}</div>
                  <div style={s('flex:2;min-width:0;font-size:11.5px;color:#8A8E94;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{capSummary(u)}</div>
                  <div style={s('width:76px;flex-shrink:0')}>{statusPill(u.status)}</div>
                  <div style={s(`width:88px;flex-shrink:0;font-family:${MONO};font-size:10.5px;color:#6C7076`)}>
                    {u.last_login_at ? relTime(Date.now() - new Date(u.last_login_at).getTime()) : 'never'}
                  </div>
                  <div style={s('width:250px;flex-shrink:0;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap')}>
                    <button style={btn()} disabled={rowBusy} onClick={() => setEditing(editing === u.id ? null : u.id)}>
                      {editing === u.id ? 'CLOSE' : 'EDIT'}
                    </button>
                    {u.status !== 'disabled' && (
                      <button style={btn()} disabled={rowBusy} onClick={() => run(u.id, () => resendInvite(u.id))}>
                        {u.status === 'invited' ? 'RESEND' : 'RESET PW'}
                      </button>
                    )}
                    <button
                      style={btn()} disabled={rowBusy || isSelf}
                      title={isSelf ? 'You cannot disable your own account' : ''}
                      onClick={() => run(u.id, () => setUserDisabled(u.id, u.status !== 'disabled'))}
                    >
                      {u.status === 'disabled' ? 'ENABLE' : 'DISABLE'}
                    </button>
                    <button
                      style={btn('danger')} disabled={rowBusy || isSelf}
                      title={isSelf ? 'You cannot delete your own account' : ''}
                      onClick={() => {
                        if (confirm(`Permanently delete ${u.email}?\n\nDisabling keeps the account and its history. Deleting removes the account for good; the audit log of what they did is kept.`)) {
                          run(u.id, () => removeUser(u.id));
                        }
                      }}
                    >
                      DELETE
                    </button>
                  </div>
                </div>

                {editing === u.id && (
                  <EditPanel
                    user={u}
                    busy={rowBusy}
                    onCancel={() => setEditing(null)}
                    onSave={(data) => run(u.id, () => updateUser(u.id, data))}
                  />
                )}
              </div>
            );
          })}

          {!users.length && (
            <div style={s('padding:18px 14px;font-size:12px;color:#6C7076')}>Nobody yet. Invite someone above.</div>
          )}
        </div>

        <ActivityLog events={events} />
      </div>
    </div>
  );
}

// ── invite ───────────────────────────────────────────────────────────────────

function InviteForm({ domain, busy, onSubmit }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('viewer');
  const [caps, setCaps] = useState({ ...ROLE_DEFAULTS.viewer });

  // Changing the role resets the checkboxes to that role's defaults, so the
  // form always shows what the person would actually get.
  const pickRole = (r) => { setRole(r); setCaps({ ...ROLE_DEFAULTS[r] }); };

  const submit = (e) => {
    e.preventDefault();
    onSubmit({ email, name, role, capabilities: caps });
    setEmail(''); setName(''); pickRole('viewer'); setOpen(false);
  };

  if (!open) {
    return (
      <button style={btn('primary')} onClick={() => setOpen(true)}>+ INVITE SOMEONE</button>
    );
  }

  return (
    <form onSubmit={submit} style={s(`${PANEL};padding:18px`)}>
      <div style={s('font-size:13px;font-weight:600;color:#E7E8EA;margin-bottom:4px')}>Invite someone</div>
      <div style={s('font-size:11.5px;color:#8A8E94;margin-bottom:16px')}>
        They get an email with a link to set their own password.
        {domain && <> Only <span style={s('color:#C6C9CE')}>@{domain}</span> addresses can be added.</>}
      </div>

      <div style={s('display:flex;gap:12px;flex-wrap:wrap')}>
        <div style={s('flex:2;min-width:220px')}>
          <div style={s(`${LABEL};margin-bottom:6px`)}>Email</div>
          <input
            type="email" value={email} required autoFocus onChange={(e) => setEmail(e.target.value)}
            placeholder={domain ? `name@${domain}` : 'name@company.com'}
            style={s(`width:100%;background:#0B0C0E;border:1px solid rgba(255,255,255,.12);color:#E7E8EA;font-family:${MONO};font-size:12px;padding:8px 10px;outline:none;box-sizing:border-box`)}
          />
        </div>
        <div style={s('flex:1;min-width:150px')}>
          <div style={s(`${LABEL};margin-bottom:6px`)}>Name (optional)</div>
          <input
            type="text" value={name} onChange={(e) => setName(e.target.value)}
            style={s(`width:100%;background:#0B0C0E;border:1px solid rgba(255,255,255,.12);color:#E7E8EA;font-size:12px;padding:8px 10px;outline:none;box-sizing:border-box`)}
          />
        </div>
      </div>

      <div style={s('margin-top:16px')}>
        <RolePicker role={role} onPick={pickRole} />
      </div>
      <div style={s('margin-top:16px')}>
        <CapabilityPicker role={role} caps={caps} setCaps={setCaps} />
      </div>

      <div style={s('display:flex;gap:8px;margin-top:18px')}>
        <button type="submit" disabled={busy || !email} style={btn('primary')}>
          {busy ? 'SENDING...' : 'SEND INVITE'}
        </button>
        <button type="button" style={btn()} onClick={() => setOpen(false)}>CANCEL</button>
      </div>
    </form>
  );
}

// ── edit ─────────────────────────────────────────────────────────────────────

function EditPanel({ user, busy, onCancel, onSave }) {
  const [name, setName] = useState(user.name || '');
  const [role, setRole] = useState(user.role);
  const [caps, setCaps] = useState(() => resolveCapabilities({ ...user, status: 'active' }));

  const pickRole = (r) => { setRole(r); setCaps({ ...ROLE_DEFAULTS[r] }); };

  return (
    <div style={s('padding:16px 14px 20px;background:#0B0C0E;border-bottom:1px solid rgba(255,255,255,.06)')}>
      <div style={s('display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end')}>
        <div style={s('flex:1;min-width:200px')}>
          <div style={s(`${LABEL};margin-bottom:6px`)}>Name</div>
          <input
            type="text" value={name} onChange={(e) => setName(e.target.value)}
            style={s('width:100%;background:#0D0E11;border:1px solid rgba(255,255,255,.12);color:#E7E8EA;font-size:12px;padding:8px 10px;outline:none;box-sizing:border-box')}
          />
        </div>
      </div>
      <div style={s('margin-top:14px')}><RolePicker role={role} onPick={pickRole} /></div>
      <div style={s('margin-top:14px')}><CapabilityPicker role={role} caps={caps} setCaps={setCaps} /></div>
      <div style={s('display:flex;gap:8px;margin-top:16px')}>
        <button style={btn('primary')} disabled={busy} onClick={() => onSave({ name, role, capabilities: caps })}>
          {busy ? 'SAVING...' : 'SAVE'}
        </button>
        <button style={btn()} onClick={onCancel}>CANCEL</button>
      </div>
    </div>
  );
}

// ── shared pickers ───────────────────────────────────────────────────────────

function RolePicker({ role, onPick }) {
  return (
    <div>
      <div style={s(`${LABEL};margin-bottom:8px`)}>Role</div>
      <div style={s('display:flex;gap:8px;flex-wrap:wrap')}>
        {ROLE_META.map((r) => {
          const on = role === r.key;
          return (
            <button
              key={r.key} type="button" onClick={() => onPick(r.key)}
              style={s(`text-align:left;padding:9px 12px;min-width:190px;background:${on ? 'rgba(232,163,61,.07)' : '#0B0C0E'};border:1px solid ${on ? 'rgba(232,163,61,.45)' : 'rgba(255,255,255,.1)'};cursor:pointer`)}
            >
              <div style={s(`font-family:${MONO};font-size:11px;color:${on ? A : '#C6C9CE'};letter-spacing:.5px`)}>{r.label}</div>
              <div style={s('font-size:10.5px;color:#6C7076;margin-top:3px')}>{r.hint}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CapabilityPicker({ role, caps, setCaps }) {
  const defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.viewer;
  return (
    <div>
      <div style={s(`${LABEL};margin-bottom:8px`)}>Permissions</div>
      <div style={s('display:flex;flex-direction:column;gap:2px')}>
        {CAPABILITIES.map((c) => {
          // Managing users is not a toggle: it follows the admin role, which is
          // what stops a non-admin from being handed the keys to everything.
          const locked = c.key === FIXED_ADMIN_ONLY;
          const on = locked ? role === 'admin' : Boolean(caps[c.key]);
          const changed = !locked && on !== defaults[c.key];
          return (
            <label
              key={c.key}
              style={s(`display:flex;align-items:flex-start;gap:9px;padding:7px 9px;background:${changed ? 'rgba(232,163,61,.05)' : 'transparent'};cursor:${locked ? 'default' : 'pointer'}`)}
            >
              <input
                type="checkbox" checked={on} disabled={locked}
                onChange={(e) => setCaps((p) => ({ ...p, [c.key]: e.target.checked }))}
                style={s('margin-top:2px')}
              />
              <span style={s('flex:1;min-width:0')}>
                <span style={s(`font-size:12px;color:${on ? '#E7E8EA' : '#8A8E94'}`)}>{c.label}</span>
                {changed && <span style={s(`color:${A};font-size:9.5px;margin-left:7px;font-family:${MONO}`)}>CUSTOM</span>}
                {locked && <span style={s('color:#5A5E64;font-size:9.5px;margin-left:7px')}>follows the Admin role</span>}
                <span style={s('display:block;font-size:10.5px;color:#5A5E64;margin-top:2px')}>{c.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ── activity ─────────────────────────────────────────────────────────────────

const EVENT_TEXT = {
  login_ok: 'signed in',
  login_failed: 'failed sign-in',
  login_locked: 'locked out',
  logout: 'signed out',
  invite_sent: 'was invited',
  invite_accepted: 'accepted their invite',
  reset_sent: 'was sent a reset link',
  reset_done: 'changed their password',
  user_created: 'was created',
  user_updated: 'was updated',
  user_disabled: 'was disabled',
  user_enabled: 'was enabled',
  user_deleted: 'was deleted',
  break_glass: 'break-glass sign-in',
};

function ActivityLog({ events }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={s(`${PANEL};margin-top:20px`)}>
      <button
        onClick={() => setOpen(!open)}
        style={s('display:flex;align-items:center;justify-content:space-between;width:100%;height:36px;padding:0 14px;background:transparent;border:none;cursor:pointer')}
      >
        <span style={s(`font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:#6C7076`)}>RECENT ACTIVITY</span>
        <span style={s('color:#5A5E64;font-size:11px')}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={s('border-top:1px solid rgba(255,255,255,.06);max-height:340px;overflow-y:auto')}>
          {events.map((e) => (
            <div key={e.id} style={s('display:flex;gap:12px;padding:6px 14px;border-bottom:1px solid rgba(255,255,255,.03)')}>
              <span style={s(`font-family:${MONO};font-size:10px;color:#5A5E64;width:90px;flex-shrink:0`)}>
                {relTime(Date.now() - new Date(e.ts).getTime())}
              </span>
              <span style={s('font-size:11.5px;color:#9CA0A6;flex:1;min-width:0')}>
                <span style={s('color:#C6C9CE')}>{e.email || 'unknown'}</span>{' '}
                {EVENT_TEXT[e.type] || e.type}
                {e.actor_email && e.actor_email !== e.email && <span style={s('color:#5A5E64')}> by {e.actor_email}</span>}
                {e.detail && <span style={s('color:#5A5E64')}> ({e.detail})</span>}
              </span>
            </div>
          ))}
          {!events.length && <div style={s('padding:12px 14px;font-size:11.5px;color:#5A5E64')}>Nothing yet.</div>}
        </div>
      )}
    </div>
  );
}

// ── banner ───────────────────────────────────────────────────────────────────

function Banner({ tone, children }) {
  const tones = {
    ok: { bg: 'rgba(123,196,127,.07)', border: 'rgba(123,196,127,.3)', color: '#9AD49E' },
    error: { bg: 'rgba(255,120,120,.07)', border: 'rgba(255,120,120,.3)', color: '#ff8a80' },
    warn: { bg: 'rgba(232,163,61,.07)', border: 'rgba(232,163,61,.3)', color: '#D8C08A' },
  };
  const t = tones[tone] || tones.warn;
  return (
    <div style={s(`background:${t.bg};border:1px solid ${t.border};color:${t.color};font-size:11.5px;line-height:1.6;padding:10px 13px;margin-bottom:16px`)}>
      {children}
    </div>
  );
}
