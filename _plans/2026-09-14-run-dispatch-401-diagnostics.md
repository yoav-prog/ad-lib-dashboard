# Fix: "Run now / Run selected" dispatch fails with 401 and misdiagnoses the cause

Date: 2026-09-14
Branch: `fix-run-dispatch-401`
Worktree: `c:\Projects\adintel-fix-run-dispatch-401`

## The report

Clicking "Run 1" (Run selected) on a specific Control Room row returns:

> Could not dispatch (status 401); the workflow input may not be on main yet. Marked the row due instead.

## Root cause (brutally honest)

Two separate things, only one of which is a code bug:

1. **The 401 itself is a config problem, not a code bug.** GitHub returns `401 Bad
   credentials` when it rejects the token value. `GH_DISPATCH_TOKEN` in the Vercel
   production env is expired, revoked, or lacks the `workflow` scope (classic PAT)
   / `Actions: read & write` (fine-grained). No code change to headers or body can
   make a rejected token accepted. The user must rotate the secret.

2. **The error message is a genuine code bug.** `scrape.yml` on `main` already
   declares the `domain_ids` workflow_dispatch input (lines 10-14), so
   "the workflow input may not be on main yet" is simply false. The UI hardcodes
   that sentence for every `dispatch-failed`, sending the user to chase the wrong
   problem. And GitHub's response body (which literally says why) is thrown away,
   so there is nothing to diagnose from (violates observability rule).

## Scope

In scope (this PR):
- Accurate, status-aware failure messages (401 / 403 / 404 / 422 / other).
- Log GitHub's real response body on any dispatch failure.
- Trim whitespace/newlines off `GH_DISPATCH_TOKEN` + `GH_REPO` (a pasted token
  with a trailing newline is a real, code-fixable cause of a 401).
- Consolidate the 3 duplicated inline dispatch fetches into one helper (SSOT).
- Doc the required token scope in `.env.example`.
- Unit tests for the pure mapping helpers.

Out of scope (user must do in their deploy env, cannot be a code change):
- Rotating / re-scoping the actual `GH_DISPATCH_TOKEN` secret in Vercel. This PR
  makes the failure honest and diagnosable; it does not conjure a valid token.

## Approach

Single source of truth, layered cleanly:

- `web/lib/ui.js` (pure, already unit-tested): add
  - `dispatchFailReason(status)` -> reason code (`bad-token`|`forbidden`|
    `repo-not-found`|`input-missing`|`dispatch-failed`)
  - `dispatchFailMessage(reason, status, subject)` -> the human sentence, always
    ending by noting the rows were still marked due (a failed click is never a
    silent no-op).
- `web/app/actions.js` (server): add one `dispatchScrapeWorkflow(inputs)` helper
  that trims the token/repo, POSTs, logs the body on failure, and returns a
  status-aware reason via `dispatchFailReason`. Rewire `triggerScrape`,
  `runDomains`, and `refreshAds` onto it.
- `web/components/ControlRoom.jsx` (presentation): render `dispatchFailMessage`
  in both `runNow` and `runSelected`.

## Security

- No new attack surface. The token is still server-only (never returned to the
  client). We log only the first 500 chars of GitHub's error body and the repo
  slug + status; the token value is never logged.

## Observability

- `console.error('[scrape dispatch] failed', { repo, status, reason, detail })`
  on every non-2xx, plus `[scrape dispatch] error` on network throw. This is the
  line that was missing when the user reported "it just says 401".

## Testing

- `web/tests/ui.test.mjs`: cover `dispatchFailReason` for 401/403/404/422/500 and
  `dispatchFailMessage` for the token case (must name `GH_DISPATCH_TOKEN`, must
  not blame "on main") and the 422 case (must not blame the token). Run full
  `npm test` in `web/`.

## Deploy

- Standard flow: push branch, open one PR into `main`, CI runs, merge triggers the
  Vercel deploy. Nothing promoted by hand. Does not touch `main` directly.
- After merge, the user still needs to rotate `GH_DISPATCH_TOKEN` for dispatch to
  actually fire; until then the button honestly reports the auth failure and falls
  back to marking rows due.

## Rejected alternatives

- Retry the dispatch on 401: pointless, a bad token stays bad on retry.
- Silently keep the marking-due fallback with no message change: hides the real
  problem, the exact failure the user hit.
