// Stop-waiting helper for server actions called from client components.
//
// A server action that never returns leaves a button spinning forever. On
// Vercel that is not hypothetical: a function can outlive the client connection
// and the response never lands, even though the work completed. The first admin
// bootstrap hit exactly this, sitting on "SENDING..." after the invite had
// already been emailed.
//
// The important part is what a timeout MEANS. It is not failure. The action may
// have succeeded, failed, or still be running, and the client cannot tell which.
// So this resolves with a distinct sentinel rather than throwing, and callers
// are expected to say "we do not know, check before retrying" instead of
// inviting the user to click again and do the thing twice.

export const ACTION_TIMEOUT_MS = 20_000;

export const TIMED_OUT = Symbol('action-timed-out');

// Copy for the message every caller shows on a timeout. One wording, so the
// advice cannot drift between the invite form and the setup button.
export const TIMEOUT_MESSAGE =
  'This is taking longer than expected, and we cannot tell whether it went through. '
  + 'Reload and check before trying again, so you do not do it twice.';

export function raceTimeout(promise, ms = ACTION_TIMEOUT_MS) {
  let timer;
  const tracked = Promise.resolve(promise);

  // If the action rejects AFTER the timeout already won the race, nobody is
  // listening on that branch any more. Attach a no-op handler so it does not
  // surface as an unhandled rejection. The race below still sees the real
  // rejection when it arrives first, so genuine errors reach the caller.
  tracked.catch(() => {});

  return Promise.race([
    tracked,
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
  ]).finally(() => clearTimeout(timer));
}
