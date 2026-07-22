// Who may do what. Pure functions only, so the rules can be unit-tested without
// a database or a session - getting these wrong is a security bug, not a glitch.
//
// A role sets the defaults; a user's `capabilities` jsonb holds only the explicit
// overrides on top ({"run_scrapes": true} for an editor who also kicks off
// scrapes). Everything resolves to a flat object of booleans that the server
// gates on and the UI reads to decide what to render.
//
// Every ambiguity here fails CLOSED: unknown role, unknown capability key,
// non-boolean override, or any account that is not 'active' resolves to no
// permission rather than to a permissive default.

export const ROLES = ['admin', 'editor', 'viewer'];

// The five gates, named for what they actually guard in app/actions.js rather
// than for abstract resource nouns. `label`/`hint` drive the /admin checkboxes.
export const CAPABILITIES = [
  { key: 'edit_ads', label: 'Edit ads', hint: 'Status, owner, notes, starring, bulk edits, deletes, review decisions' },
  { key: 'manage_domains', label: 'Manage tracked domains', hint: 'Add, edit, and delete tracked domains and feeds' },
  { key: 'run_scrapes', label: 'Run scrapes', hint: 'Run now, run selected, stop a run, and read run logs' },
  { key: 'export_data', label: 'Export data', hint: 'Push to Google Sheets and force a metrics refresh' },
  { key: 'manage_users', label: 'Manage users', hint: 'Admins only: invite, remove, and set permissions' },
];

export const CAPABILITY_KEYS = CAPABILITIES.map((c) => c.key);

// Managing users is admin-equivalent power (you could grant yourself anything),
// so it is deliberately NOT overridable: it tracks role === 'admin' and nothing
// else. That closes the privilege-escalation path instead of policing it.
export const FIXED_ADMIN_ONLY = 'manage_users';

export const ROLE_DEFAULTS = {
  admin:  { edit_ads: true,  manage_domains: true,  run_scrapes: true,  export_data: true,  manage_users: true },
  editor: { edit_ads: true,  manage_domains: false, run_scrapes: false, export_data: true,  manage_users: false },
  viewer: { edit_ads: false, manage_domains: false, run_scrapes: false, export_data: false, manage_users: false },
};

export const ROLE_META = [
  { key: 'admin', label: 'Admin', hint: 'Full access, including user management' },
  { key: 'editor', label: 'Editor', hint: 'Edit ads and export; no scrapes or domain changes by default' },
  { key: 'viewer', label: 'Viewer', hint: 'Read-only' },
];

function isRole(role) {
  return ROLES.includes(role);
}

// The effective permissions for a user row, as a flat { capability: boolean }.
// Accepts a raw database row (capabilities may arrive as jsonb or as a string,
// depending on the driver) and never throws on malformed input.
export function resolveCapabilities(user) {
  const none = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false]));
  if (!user) return none;

  // Only a live account carries permissions. An invited-but-not-accepted or a
  // disabled user resolves to nothing even if their stored role says admin, so
  // a stale session or a missed check still cannot act.
  if (user.status !== 'active') return none;

  const role = isRole(user.role) ? user.role : 'viewer';
  const base = ROLE_DEFAULTS[role];

  const overrides = parseOverrides(user.capabilities);
  const out = {};
  for (const key of CAPABILITY_KEYS) {
    if (key === FIXED_ADMIN_ONLY) {
      out[key] = role === 'admin';
      continue;
    }
    // Only a real boolean overrides the role default; anything else is ignored
    // rather than coerced, so a stray "false" string cannot grant access.
    out[key] = typeof overrides[key] === 'boolean' ? overrides[key] : base[key];
  }
  return out;
}

// jsonb can reach us as an object (postgres.js parses it) or as a string.
// Unknown keys are dropped so a hand-edited row cannot smuggle in a new gate.
function parseOverrides(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const key of CAPABILITY_KEYS) {
    if (typeof obj[key] === 'boolean') out[key] = obj[key];
  }
  return out;
}

export function can(user, capability) {
  if (!CAPABILITY_KEYS.includes(capability)) return false;
  return resolveCapabilities(user)[capability] === true;
}

// Turn a full set of desired permissions back into the sparse override object
// that gets stored, keeping only what actually differs from the role's defaults.
// Storing the diff (not the full set) means changing a role's defaults later
// automatically applies to everyone who never customised that capability.
export function overridesFor(role, desired) {
  const r = isRole(role) ? role : 'viewer';
  const base = ROLE_DEFAULTS[r];
  const out = {};
  for (const key of CAPABILITY_KEYS) {
    if (key === FIXED_ADMIN_ONLY) continue;          // not overridable, never stored
    const want = desired?.[key];
    if (typeof want !== 'boolean') continue;
    if (want !== base[key]) out[key] = want;
  }
  return out;
}

// True when the user has at least one capability that lets them change something.
// Used for the read-only badge in the UI, so "viewer" reads as viewer even if
// someone was granted a single narrow permission.
export function isReadOnly(caps) {
  return !CAPABILITY_KEYS.some((k) => caps?.[k] === true);
}
