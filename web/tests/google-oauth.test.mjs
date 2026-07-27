// Unit tests for the Google sign-in checks in lib/google-oauth.js. Run with
// `npm test`.
//
// Like the capabilities suite, this is a security boundary rather than a
// feature, so the weight is on everything that must be REFUSED. validateIdToken
// Claims is the function standing between a stranger with a Google account and
// a session on this dashboard, and every one of its rejections has a test here.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Set before the module loads: googleMissing() and redirectUri() read these.
process.env.APP_URL = 'https://dash.example.com';
process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'secret-abc';
process.env.ALLOWED_EMAIL_DOMAIN = 'aporianetworks.com';

const {
  googleConfigured, googleMissing, clientId, redirectUri,
  newTransaction, authorizeUrl, statesMatch,
  decodeIdToken, validateIdTokenClaims,
} = await import('../lib/google-oauth.js');

const DOMAIN = 'aporianetworks.com';
const CLIENT = 'client-123.apps.googleusercontent.com';
const NONCE = 'nonce-value';
const NOW = 1_800_000_000_000;               // fixed, so exp tests never drift

// A token that passes everything. Each test below breaks exactly one thing.
const goodClaims = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT,
  sub: '110000000000000000001',
  email: 'sam@aporianetworks.com',
  email_verified: true,
  hd: DOMAIN,
  name: 'Sam Okonkwo',
  exp: Math.floor(NOW / 1000) + 3600,
  nonce: NONCE,
  ...over,
});

const check = (claims, opts = {}) => validateIdTokenClaims(claims, {
  nonce: NONCE, expectedClientId: CLIENT, domain: DOMAIN, now: NOW, ...opts,
});

// ── configuration ────────────────────────────────────────────────────────────

test('configuration is complete in this fixture', () => {
  assert.deepEqual(googleMissing(), []);
  assert.equal(googleConfigured(), true);
  assert.equal(clientId(), CLIENT);
});

test('the redirect URI is derived from APP_URL, not from a request', () => {
  assert.equal(redirectUri(), 'https://dash.example.com/api/auth/google/callback');
});

test('a missing client id or secret turns the whole flow off', () => {
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    const saved = process.env[key];
    delete process.env[key];
    assert.equal(googleConfigured(), false, key);
    assert.ok(googleMissing().includes(key), key);
    process.env[key] = saved;
  }
  assert.equal(googleConfigured(), true);
});

test('a missing domain lock turns the flow off rather than opening it', () => {
  const saved = process.env.ALLOWED_EMAIL_DOMAIN;
  delete process.env.ALLOWED_EMAIL_DOMAIN;
  assert.equal(googleConfigured(), false);
  assert.ok(googleMissing().includes('ALLOWED_EMAIL_DOMAIN'));
  process.env.ALLOWED_EMAIL_DOMAIN = saved;
});

// ── the outbound half ────────────────────────────────────────────────────────

test('newTransaction mints three unrelated secrets each time', () => {
  const a = newTransaction();
  const b = newTransaction();
  for (const key of ['state', 'nonce', 'verifier']) {
    assert.notEqual(a[key], b[key], key);
    // 32 random bytes, base64url encoded.
    assert.equal(a[key].length, 43, key);
    assert.match(a[key], /^[A-Za-z0-9_-]+$/, key);
  }
  assert.notEqual(a.state, a.nonce);
  assert.notEqual(a.state, a.verifier);
});

test('the PKCE challenge is the S256 hash of the verifier', () => {
  const tx = newTransaction();
  const expected = crypto.createHash('sha256').update(tx.verifier).digest('base64url');
  assert.equal(tx.challenge, expected);
  // The verifier itself must never travel in the redirect.
  assert.ok(!authorizeUrl(tx).includes(tx.verifier));
});

test('the authorize URL carries everything Google needs and nothing more', () => {
  const tx = newTransaction();
  const url = new URL(authorizeUrl(tx));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = url.searchParams;
  assert.equal(p.get('client_id'), CLIENT);
  assert.equal(p.get('redirect_uri'), 'https://dash.example.com/api/auth/google/callback');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('scope'), 'openid email profile');
  assert.equal(p.get('state'), tx.state);
  assert.equal(p.get('nonce'), tx.nonce);
  assert.equal(p.get('code_challenge'), tx.challenge);
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('hd'), DOMAIN);
  // Sign-in only: asking for offline access would hand us a refresh token we
  // have no use for and would then have to protect.
  assert.equal(p.get('access_type'), null);
});

test('statesMatch is exact, and refuses anything empty or the wrong length', () => {
  assert.equal(statesMatch('abc123', 'abc123'), true);
  assert.equal(statesMatch('abc123', 'abc124'), false);
  assert.equal(statesMatch('abc123', 'abc1234'), false);
  assert.equal(statesMatch('', ''), false);
  assert.equal(statesMatch(null, null), false);
  assert.equal(statesMatch(undefined, 'abc'), false);
  assert.equal(statesMatch('abc', undefined), false);
});

// ── decoding ─────────────────────────────────────────────────────────────────

const jwtOf = (payload) => [
  Buffer.from('{"alg":"RS256"}').toString('base64url'),
  Buffer.from(JSON.stringify(payload)).toString('base64url'),
  'signature-not-checked',
].join('.');

test('decodeIdToken reads the payload of a well-formed token', () => {
  assert.deepEqual(decodeIdToken(jwtOf({ sub: '1', email: 'a@b.com' })), { sub: '1', email: 'a@b.com' });
});

test('decodeIdToken returns null for anything malformed instead of throwing', () => {
  const cases = [
    undefined, null, '', 'not-a-jwt', 'only.two',
    'a.b.c.d',                                            // too many segments
    '..sig',                                              // empty payload
    `${Buffer.from('{}').toString('base64url')}..sig`,    // empty payload again
    'aaa.!!!not-base64!!!.sig',
    `aaa.${Buffer.from('[1,2,3]').toString('base64url')}.sig`,   // array, not an object
    `aaa.${Buffer.from('"a string"').toString('base64url')}.sig`,
    `aaa.${Buffer.from('null').toString('base64url')}.sig`,
    `aaa.${'A'.repeat(8193)}.sig`,                        // absurdly large
  ];
  for (const input of cases) {
    assert.equal(decodeIdToken(input), null, JSON.stringify(String(input).slice(0, 30)));
  }
});

// ── the checks that matter ───────────────────────────────────────────────────

test('a clean Workspace token is accepted, and the email is normalised', () => {
  const r = check(goodClaims({ email: '  Sam@Aporianetworks.COM ' }));
  assert.equal(r.ok, true);
  assert.equal(r.email, 'sam@aporianetworks.com');
  assert.equal(r.sub, '110000000000000000001');
  assert.equal(r.name, 'Sam Okonkwo');
});

test('the shorthand issuer Google also uses is accepted', () => {
  assert.equal(check(goodClaims({ iss: 'accounts.google.com' })).ok, true);
});

test('a token minted for another client is refused', () => {
  const r = check(goodClaims({ aud: 'someone-else.apps.googleusercontent.com' }));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'token');
});

test('an aud array is refused rather than searched for our client', () => {
  // A token carrying several audiences was not issued to us alone.
  assert.equal(check(goodClaims({ aud: [CLIENT, 'other'] })).ok, false);
});

test('a forged issuer is refused', () => {
  for (const iss of ['https://accounts.google.com.evil.test', 'evil.test', '', null, undefined]) {
    assert.equal(check(goodClaims({ iss })).ok, false, String(iss));
  }
});

test('an expired token is refused, but a minute of clock skew is forgiven', () => {
  assert.equal(check(goodClaims({ exp: Math.floor(NOW / 1000) - 3600 })).ok, false);
  assert.equal(check(goodClaims({ exp: Math.floor(NOW / 1000) - 30 })).ok, true);
  assert.equal(check(goodClaims({ exp: Math.floor(NOW / 1000) - 120 })).ok, false);
  for (const exp of [undefined, null, 'soon', NaN]) {
    assert.equal(check(goodClaims({ exp })).ok, false, String(exp));
  }
});

test('a token from a different sign-in attempt is refused (nonce)', () => {
  assert.equal(check(goodClaims({ nonce: 'someone-elses-nonce' })).ok, false);
  assert.equal(check(goodClaims({ nonce: undefined })).ok, false);
  // And an attempt that lost its own nonce cannot wave the check through.
  assert.equal(check(goodClaims(), { nonce: '' }).ok, false);
  assert.equal(check(goodClaims(), { nonce: undefined }).ok, false);
});

test('an unverified email is refused', () => {
  for (const v of [false, 'false', undefined, null, 0, 1, 'yes']) {
    const r = check(goodClaims({ email_verified: v }));
    assert.equal(r.ok, false, String(v));
    assert.equal(r.kind, 'domain');
  }
});

test('a consumer Google account holding a company address is refused (no hd)', () => {
  const r = check(goodClaims({ hd: undefined }));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'domain');
  assert.match(r.reason, /no hd/);
});

test('an account from another Workspace domain is refused', () => {
  assert.equal(check(goodClaims({ hd: 'someoneelse.com', email: 'sam@someoneelse.com' })).ok, false);
});

test('a lookalike domain cannot pass as the real one', () => {
  const lookalikes = [
    'evil-aporianetworks.com',
    'aporianetworks.com.evil.test',
    'sub.aporianetworks.com',
    'aporianetworks.co',
  ];
  for (const d of lookalikes) {
    // Both halves of the check, in turn: the hd claim...
    assert.equal(check(goodClaims({ hd: d })).ok, false, `hd=${d}`);
    // ...and the address, when hd itself is correct.
    assert.equal(check(goodClaims({ email: `sam@${d}` })).ok, false, `email=${d}`);
  }
});

test('an address with a second @ or no local part is refused', () => {
  for (const email of ['sam@evil.test@aporianetworks.com', '@aporianetworks.com', 'sam@', 'sam', '']) {
    assert.equal(check(goodClaims({ email })).ok, false, email);
  }
});

test('a token with no subject is refused', () => {
  for (const sub of [undefined, null, '', '   ', 42, {}]) {
    assert.equal(check(goodClaims({ sub })).ok, false, String(sub));
  }
});

test('a missing configuration is reported as config, never as a pass', () => {
  assert.equal(check(goodClaims(), { domain: '' }).kind, 'config');
  assert.equal(check(goodClaims(), { domain: undefined }).kind, 'config');
  assert.equal(check(goodClaims(), { expectedClientId: '' }).kind, 'config');
  assert.equal(check(goodClaims(), { expectedClientId: undefined }).kind, 'config');
});

test('junk in place of claims is refused', () => {
  for (const claims of [null, undefined, 'a string', 42]) {
    assert.equal(check(claims).ok, false, String(claims));
  }
});

test('the name is optional, trimmed, and bounded', () => {
  assert.equal(check(goodClaims({ name: undefined })).name, null);
  assert.equal(check(goodClaims({ name: '   ' })).name, null);
  assert.equal(check(goodClaims({ name: 42 })).name, null);
  assert.equal(check(goodClaims({ name: 'x'.repeat(500) })).name.length, 120);
});

test('every rejection carries a kind and a reason, and never leaks the token', () => {
  const r = check(goodClaims({ hd: 'someoneelse.com' }));
  assert.equal(r.ok, false);
  assert.ok(['config', 'domain', 'token'].includes(r.kind));
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0);
  // No email, sub, or name comes back on a refusal.
  assert.equal(r.email, undefined);
  assert.equal(r.sub, undefined);
});
