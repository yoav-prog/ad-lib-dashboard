// A single-slot, time-to-live cache for a value that is the same for every viewer
// and expensive to build - the ad feed is the motivating case: ~14k rows that cost
// ~1.3s to query and serialize, rebuilt on every navigation today.
//
// This is deliberately NOT Next.js's Data Cache (unstable_cache): that caps a single
// entry at 2 MB, and the feed is ~25 MB, so it would silently refuse to store it and
// the cache would be a no-op. Instead the value is held in memory on the warm server
// instance, mirroring the metrics-index cache in lib/metrics.js. It follows that the
// cache is per-instance: two warm instances hold their own copies, and each expires or
// busts on its own. That is fine here because ad edits use optimistic client updates,
// so the editor never waits on this cache, and everyone else sees a change within one
// TTL (or immediately, on the instance that served the mutation and called bust()).
//
// `now` is injectable so the TTL is unit-testable without a real clock (see
// tests/ttl-cache.test.mjs).
export function createTtlCache(ttlMs, now = Date.now) {
  let held = null; // { value, at } | null

  return {
    // The live value and its age, or null when nothing is held or it has expired.
    peek() {
      if (!held) return null;
      const ageMs = now() - held.at;
      return ageMs < ttlMs ? { value: held.value, ageMs } : null;
    },
    // Store a freshly built value, stamped at the current time.
    fill(value) {
      held = { value, at: now() };
    },
    // Drop the held value so the next peek() misses and the caller rebuilds.
    bust() {
      held = null;
    },
  };
}
