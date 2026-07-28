// Unit tests for the pure TTL cache in lib/ttl-cache.js. Run with `npm test`
// (Node's built-in runner, no dependencies). These pin the feed-cache behaviour:
// a value is served for its TTL and no longer, an explicit bust drops it early,
// and a refill restarts the clock. The clock is injected so the TTL is exercised
// without any real waiting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from '../lib/ttl-cache.js';

// A hand-cranked clock: tests advance `t` to move time forward deterministically.
function fakeClock() {
  let t = 1000;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  now.set = (ms) => { t = ms; };
  return now;
}

test('a fresh cache holds nothing', () => {
  const cache = createTtlCache(60_000, fakeClock());
  assert.equal(cache.peek(), null);
});

test('after fill, peek returns the value with age zero', () => {
  const cache = createTtlCache(60_000, fakeClock());
  cache.fill(['a', 'b']);
  const hit = cache.peek();
  assert.deepEqual(hit.value, ['a', 'b']);
  assert.equal(hit.ageMs, 0);
});

test('peek serves the value within the TTL and reports its age', () => {
  const clock = fakeClock();
  const cache = createTtlCache(60_000, clock);
  cache.fill(42);
  clock.advance(59_999);
  const hit = cache.peek();
  assert.equal(hit.value, 42);
  assert.equal(hit.ageMs, 59_999);
});

test('peek misses once the TTL has elapsed (boundary is exclusive)', () => {
  const clock = fakeClock();
  const cache = createTtlCache(60_000, clock);
  cache.fill(42);
  clock.advance(60_000);            // exactly at the TTL: expired
  assert.equal(cache.peek(), null);
  clock.set(1000);
  cache.fill(42);
  clock.advance(60_001);            // past the TTL: still expired
  assert.equal(cache.peek(), null);
});

test('bust drops the value before the TTL is up', () => {
  const clock = fakeClock();
  const cache = createTtlCache(60_000, clock);
  cache.fill('feed');
  clock.advance(1_000);
  cache.bust();
  assert.equal(cache.peek(), null);
});

test('a refill restarts the TTL from the refill time', () => {
  const clock = fakeClock();
  const cache = createTtlCache(60_000, clock);
  cache.fill('first');
  clock.advance(59_000);
  cache.fill('second');             // restart the clock with a new value
  clock.advance(59_000);            // 118s since first fill, but only 59s since second
  const hit = cache.peek();
  assert.equal(hit.value, 'second');
  assert.equal(hit.ageMs, 59_000);
});

test('falsy values (empty feed) are cached, not treated as absent', () => {
  const cache = createTtlCache(60_000, fakeClock());
  cache.fill([]);
  const hit = cache.peek();
  assert.notEqual(hit, null);
  assert.deepEqual(hit.value, []);
});
