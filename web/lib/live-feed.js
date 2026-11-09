// Decides when the Fresh Finds table re-reads itself during a scrape. Pure, so the rules
// are unit tested without a browser (tests/live-feed.test.mjs).

// A batch of ads takes far longer than this, and each reload is a real feed query.
export const LIVE_FEED_MIN_GAP_MS = 15 * 1000;
// Polling rates for accounts that do not have the run-status poll.
export const FEED_PULSE_ACTIVE_MS = 5 * 1000;
export const FEED_PULSE_IDLE_MS = 30 * 1000;

export const EMPTY_LIVE_FEED = Object.freeze({ runId: null, seen: 0, reloadedAt: 0 });

// `active` is the live run ({ id, ads_found_so_far }) or null. `canShow` is false when the
// viewer could not see new rows anyway, or new rows would shift what they are reading.
// `reload` is 'none', 'live' (more ads landed) or 'final' (the watched run is over).
export function nextLiveFeedStep(prev, active, { now, canShow }) {
  if (!active) return { state: EMPTY_LIVE_FEED, reload: prev.runId ? 'final' : 'none' };

  const seen = Number(active.ads_found_so_far) || 0;
  if (active.id !== prev.runId) {
    return { state: { runId: active.id, seen, reloadedAt: 0 }, reload: prev.runId ? 'final' : 'none' };
  }

  // Leaving `state` alone keeps the update owed, so the next eligible poll delivers it.
  if (seen <= prev.seen || !canShow || now - prev.reloadedAt < LIVE_FEED_MIN_GAP_MS) {
    return { state: prev, reload: 'none' };
  }
  return { state: { runId: active.id, seen, reloadedAt: now }, reload: 'live' };
}
