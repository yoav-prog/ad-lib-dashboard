// Unit tests for the permission rules in lib/capabilities.js. Run with
// `npm test`. These matter more than the other suites: every case here is a
// security boundary, so the emphasis is on the fail-closed paths (bad role,
// junk overrides, non-active accounts) rather than the happy path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, CAPABILITY_KEYS, ROLE_DEFAULTS, FIXED_ADMIN_ONLY,
  resolveCapabilities, can, overridesFor, isReadOnly,
} from '../lib/capabilities.js';

const user = (over = {}) => ({ status: 'active', role: 'viewer', capabilities: {}, ...over });
const allFalse = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false]));

test('every role has a default for every capability', () => {
  for (const role of ROLES) {
    for (const key of CAPABILITY_KEYS) {
      assert.equal(typeof ROLE_DEFAULTS[role][key], 'boolean', `${role}.${key}`);
    }
  }
});

test('role defaults resolve as documented', () => {
  assert.deepEqual(resolveCapabilities(user({ role: 'admin' })), {
    edit_ads: true, manage_domains: true, run_scrapes: true, export_data: true, manage_users: true,
  });
  assert.deepEqual(resolveCapabilities(user({ role: 'editor' })), {
    edit_ads: true, manage_domains: false, run_scrapes: false, export_data: true, manage_users: false,
  });
  assert.deepEqual(resolveCapabilities(user({ role: 'viewer' })), allFalse);
});

test('overrides grant and revoke on top of the role default', () => {
  const granted = resolveCapabilities(user({ role: 'editor', capabilities: { run_scrapes: true } }));
  assert.equal(granted.run_scrapes, true);
  assert.equal(granted.edit_ads, true, 'other defaults are untouched');

  const revoked = resolveCapabilities(user({ role: 'editor', capabilities: { edit_ads: false } }));
  assert.equal(revoked.edit_ads, false);
  assert.equal(revoked.export_data, true);
});

// ── fail-closed paths ────────────────────────────────────────────────────────

test('a non-active account has no capabilities, whatever its role says', () => {
  for (const status of ['invited', 'disabled', 'unknown', '', null, undefined]) {
    assert.deepEqual(
      resolveCapabilities(user({ role: 'admin', status })),
      allFalse,
      `status=${String(status)} must resolve to nothing`,
    );
  }
});

test('a missing or malformed user resolves to nothing', () => {
  assert.deepEqual(resolveCapabilities(null), allFalse);
  assert.deepEqual(resolveCapabilities(undefined), allFalse);
  assert.deepEqual(resolveCapabilities({}), allFalse);
});

test('an unrecognised role falls back to viewer, not to admin', () => {
  assert.deepEqual(resolveCapabilities(user({ role: 'superuser' })), allFalse);
  assert.deepEqual(resolveCapabilities(user({ role: '' })), allFalse);
  assert.deepEqual(resolveCapabilities(user({ role: null })), allFalse);
});

test('non-boolean overrides are ignored rather than coerced', () => {
  const caps = resolveCapabilities(user({
    role: 'viewer',
    capabilities: { edit_ads: 'true', manage_domains: 1, run_scrapes: {}, export_data: 'yes' },
  }));
  assert.deepEqual(caps, allFalse, 'truthy non-booleans must not grant access');
});

test('unknown keys in the overrides object are dropped', () => {
  const caps = resolveCapabilities(user({ role: 'viewer', capabilities: { delete_everything: true } }));
  assert.deepEqual(caps, allFalse);
  assert.equal('delete_everything' in caps, false);
});

test('capabilities arriving as a JSON string are parsed; junk strings are ignored', () => {
  assert.equal(resolveCapabilities(user({ role: 'viewer', capabilities: '{"edit_ads":true}' })).edit_ads, true);
  assert.deepEqual(resolveCapabilities(user({ role: 'viewer', capabilities: 'not json' })), allFalse);
  assert.deepEqual(resolveCapabilities(user({ role: 'viewer', capabilities: '[1,2,3]' })), allFalse);
  assert.deepEqual(resolveCapabilities(user({ role: 'viewer', capabilities: null })), allFalse);
});

// ── the escalation guard ─────────────────────────────────────────────────────

test('manage_users tracks role=admin and cannot be granted by override', () => {
  const sneaky = resolveCapabilities(user({ role: 'editor', capabilities: { manage_users: true } }));
  assert.equal(sneaky[FIXED_ADMIN_ONLY], false, 'a non-admin must never gain user management');

  const viewer = resolveCapabilities(user({ role: 'viewer', capabilities: { manage_users: true } }));
  assert.equal(viewer.manage_users, false);
});

test('manage_users cannot be revoked from an admin by override either', () => {
  const caps = resolveCapabilities(user({ role: 'admin', capabilities: { manage_users: false } }));
  assert.equal(caps.manage_users, true);
});

// ── can() ────────────────────────────────────────────────────────────────────

test('can() answers a single capability and rejects unknown names', () => {
  const editor = user({ role: 'editor' });
  assert.equal(can(editor, 'edit_ads'), true);
  assert.equal(can(editor, 'run_scrapes'), false);
  assert.equal(can(editor, 'not_a_capability'), false);
  assert.equal(can(editor, ''), false);
  assert.equal(can(null, 'edit_ads'), false);
});

// ── overridesFor() ───────────────────────────────────────────────────────────

test('overridesFor stores only what differs from the role default', () => {
  assert.deepEqual(
    overridesFor('editor', { edit_ads: true, manage_domains: false, run_scrapes: false, export_data: true }),
    {},
    'matching the defaults stores nothing',
  );
  assert.deepEqual(
    overridesFor('editor', { edit_ads: true, manage_domains: false, run_scrapes: true, export_data: true }),
    { run_scrapes: true },
  );
  assert.deepEqual(
    overridesFor('admin', { edit_ads: false, manage_domains: true, run_scrapes: true, export_data: true }),
    { edit_ads: false },
  );
});

test('overridesFor never stores manage_users and ignores junk', () => {
  assert.deepEqual(overridesFor('viewer', { manage_users: true }), {});
  assert.deepEqual(overridesFor('viewer', { edit_ads: 'true' }), {});
  assert.deepEqual(overridesFor('viewer', null), {});
  assert.deepEqual(overridesFor('nonsense', { edit_ads: true }), { edit_ads: true }, 'bad role is treated as viewer');
});

test('overridesFor round-trips through resolveCapabilities', () => {
  const desired = { edit_ads: false, manage_domains: true, run_scrapes: true, export_data: false };
  const stored = overridesFor('editor', desired);
  const back = resolveCapabilities(user({ role: 'editor', capabilities: stored }));
  for (const key of Object.keys(desired)) assert.equal(back[key], desired[key], key);
});

// ── isReadOnly() ─────────────────────────────────────────────────────────────

test('isReadOnly is true only when nothing at all is granted', () => {
  assert.equal(isReadOnly(resolveCapabilities(user({ role: 'viewer' }))), true);
  assert.equal(isReadOnly(resolveCapabilities(user({ role: 'editor' }))), false);
  assert.equal(isReadOnly(resolveCapabilities(user({ role: 'viewer', capabilities: { export_data: true } }))), false);
  assert.equal(isReadOnly(null), true);
});
