// Unit tests for lib/timeout.js. The subtle requirements are that a timeout is
// reported as its own outcome rather than as a failure, and that an action which
// rejects after we stopped waiting does not become an unhandled rejection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { raceTimeout, TIMED_OUT, ACTION_TIMEOUT_MS, TIMEOUT_MESSAGE } from '../lib/timeout.js';

const later = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));
const rejectLater = (ms, err) => new Promise((_, r) => setTimeout(() => r(err), ms));

test('a fast action resolves with its own value', async () => {
  assert.equal(await raceTimeout(later(5, 'done'), 200), 'done');
  assert.deepEqual(await raceTimeout(Promise.resolve({ ok: true }), 200), { ok: true });
});

test('a falsy result is passed through, not mistaken for a timeout', async () => {
  assert.equal(await raceTimeout(Promise.resolve(null), 200), null);
  assert.equal(await raceTimeout(Promise.resolve(undefined), 200), undefined);
  assert.equal(await raceTimeout(Promise.resolve(false), 200), false);
});

test('a slow action resolves with the TIMED_OUT sentinel', async () => {
  assert.equal(await raceTimeout(later(500, 'too late'), 30), TIMED_OUT);
});

test('the sentinel is distinguishable from anything an action could return', () => {
  assert.equal(typeof TIMED_OUT, 'symbol');
  assert.notEqual(TIMED_OUT, Symbol('action-timed-out'));   // symbols are unique
});

test('a rejection that beats the timeout still reaches the caller', async () => {
  await assert.rejects(
    () => raceTimeout(rejectLater(5, new Error('boom')), 200),
    /boom/,
  );
});

test('a rejection arriving after the timeout does not go unhandled', async () => {
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.equal(await raceTimeout(rejectLater(20, new Error('late boom')), 5), TIMED_OUT);
    // Give the late rejection time to land and any unhandled handler to fire.
    await later(80);
    assert.deepEqual(seen, [], 'a late rejection must be swallowed, not reported');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the timer is cleared, so a fast action does not hold the process open', async () => {
  // If the timer leaked, node --test would hang past this point on a long timeout.
  const t0 = Date.now();
  await raceTimeout(Promise.resolve('quick'), 60_000);
  assert.ok(Date.now() - t0 < 1000, 'returned immediately despite a long timeout');
});

test('the shared copy tells the user not to just retry', () => {
  assert.equal(ACTION_TIMEOUT_MS, 20_000);
  assert.match(TIMEOUT_MESSAGE, /cannot tell whether it went through/);
  assert.match(TIMEOUT_MESSAGE, /before trying again/);
});
