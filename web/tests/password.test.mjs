// Unit tests for lib/password.js. Run with `npm test`. scrypt at the configured
// work factor costs a few hundred ms per call, so these use as few hashes as
// possible and reuse them across assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARAMS, MIN_PASSWORD_LENGTH,
  hashPassword, verifyPassword, needsRehash, validatePassword, fakeVerify,
} from '../lib/password.js';

const PW = 'correct horse battery staple';

test('a hash verifies against its own password and nothing else', async () => {
  const stored = await hashPassword(PW);
  assert.equal(await verifyPassword(PW, stored), true);
  assert.equal(await verifyPassword(PW + 'x', stored), false);
  assert.equal(await verifyPassword('', stored), false);
  assert.equal(await verifyPassword(PW.toUpperCase(), stored), false, 'case matters');
});

test('the stored format carries its parameters and a unique salt', async () => {
  const [a, b] = await Promise.all([hashPassword(PW), hashPassword(PW)]);
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(a, b, 'the same password must not produce the same hash twice');

  const parts = a.split('$');
  assert.equal(Number(parts[1]), PARAMS.N);
  assert.equal(Number(parts[2]), PARAMS.r);
  assert.equal(Number(parts[3]), PARAMS.p);
});

test('verify returns false for malformed stored values instead of throwing', async () => {
  for (const bad of [
    null, undefined, '', 'garbage', 42, {},
    'scrypt$16384$8$1',                          // too few fields
    'bcrypt$16384$8$1$c2FsdA==$aGFzaA==',        // wrong algorithm tag
    'scrypt$notanumber$8$1$c2FsdA==$aGFzaA==',   // unparseable N
    'scrypt$16385$8$1$c2FsdA==$aGFzaA==',        // N not a power of two
    'scrypt$16384$8$1$$aGFzaA==',                // empty salt
    'scrypt$16384$8$1$c2FsdA==$',                // empty hash
  ]) {
    assert.equal(await verifyPassword(PW, bad), false, `stored=${String(bad)}`);
  }
});

test('an absurd stored work factor is refused rather than allocated', async () => {
  // 128 * 2^30 * 8 bytes would be a terabyte; a tampered row must not try it.
  const hostile = 'scrypt$1073741824$8$1$c2FsdA==$aGFzaA==';
  assert.equal(await verifyPassword(PW, hostile), false);
});

test('needsRehash flags stale parameters and malformed values', async () => {
  const current = await hashPassword(PW);
  assert.equal(needsRehash(current), false);
  assert.equal(needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA=='), true, 'weaker N');
  assert.equal(needsRehash('garbage'), true);
  assert.equal(needsRehash(null), true);
});

test('unicode-equivalent passwords match after NFKC normalisation', async () => {
  const composed = 'café-password-2026';        // e + combining acute, precomposed
  const decomposed = composed.normalize('NFD'); // same string, different bytes
  assert.notEqual(composed, decomposed, 'precondition: the byte sequences differ');
  const stored = await hashPassword(composed);
  assert.equal(await verifyPassword(decomposed, stored), true);
});

test('fakeVerify always resolves false, for the unknown-email branch', async () => {
  assert.equal(await fakeVerify(), false);
});

// ── validatePassword ─────────────────────────────────────────────────────────

test('validatePassword accepts a reasonable password', () => {
  assert.equal(validatePassword(PW), null);
  assert.equal(validatePassword('x'.repeat(MIN_PASSWORD_LENGTH) + 'y'), null);
});

test('validatePassword enforces the length floor', () => {
  assert.match(validatePassword('short'), /at least 12/);
  assert.match(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)), /at least 12/);
  assert.equal(validatePassword(''), `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  assert.match(validatePassword('x'.repeat(201)), /too long/);
});

test('validatePassword rejects obvious and degenerate choices', () => {
  assert.match(validatePassword('password1234'), /too easy to guess/);
  assert.match(validatePassword('Password1234'), /too easy to guess/, 'case-insensitive');
  assert.match(validatePassword('changeme12345'), /too easy to guess/);
  assert.match(validatePassword('aaaaaaaaaaaaaa'), /repeated character/);
});

test('validatePassword rejects a password containing the email local part', () => {
  const err = validatePassword('yoavyoavyoavyoav', { email: 'yoav@aporianetworks.com' });
  assert.match(err, /email address/);
  // A short local part is not worth matching on; it would reject too much.
  assert.equal(validatePassword('correct horse battery', { email: 'ab@aporianetworks.com' }), null);
});

test('validatePassword handles junk input types without throwing', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.equal(typeof validatePassword(bad), 'string', `input=${String(bad)}`);
  }
});
