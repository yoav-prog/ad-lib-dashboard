# Sheet export: survive Google's transient failures

Date: 2026-08-17
Branch: `worktree-sheets-export-retry-transient`

## The bug

Exporting 100 rows from Fresh Finds to a Google Sheet died in the modal with:

```
Google Sheets error while opening the spreadsheet (503): The service is currently unavailable.
```

Nothing about the sheet, the credentials, or the selection was wrong. Google's backend
answered one request with a 503 and `lib/sheets.js` treats every non-2xx answer as fatal,
so the whole export was thrown away on a blip that would have cleared on the next try.

The same hole sits under three server actions (`exportToSheet`, `exportKitToSheet`,
`exportCompKitToSheet`) and under the campaign-metrics loader (`lib/metrics.js` →
`readSheetTab`), which silently serves a stale or empty index when a read 503s.

## Goal

A single transient answer from Google should never end an export. The user should only
ever see an error when something is actually wrong on their side, or when Google has been
failing for long enough that waiting is the honest advice.

## Constraints

- The export runs inside a Next.js server action on Vercel with a person watching a modal.
  Google's own guide allows backing off up to 32 to 64 seconds; we cannot. Retries have to
  stay inside a couple of seconds so the modal does not appear to hang.
- `getSheetMetricsIndex` calls into the same module on a page render. Retry latency there
  is paid by the dashboard, so the same tight bound applies.
- No new npm dependency. The module is deliberately hand-rolled (JWT signed with
  `node:crypto`, plain `fetch`), and that stays.

## What Google documents

Verified live, not from memory:

- Sheets API limits page: retry 429 with exponential backoff,
  `min(((2^n) + random_ms), maximum_backoff)`, jitter up to 1000 ms.
- Workspace "handle errors" guide: 500, 502, 503 and 504 are all "use exponential backoff
  to retry the request".

Neither page fixes a retry count; that is left to the caller's latency budget.

## Chosen approach

1. **Retry transient answers.** One `sendWithRetry` wrapper in front of every HTTP call the
   module makes (token grant, metadata read, values read, every `batchUpdate`). Retries on
   408 / 429 / 500 / 502 / 503 / 504 and on a thrown network fault. Four attempts total,
   backing off 400 ms, 800 ms, 1600 ms plus up to 250 ms of jitter: about 3 s of added
   latency in the worst case, and only when Google is already failing.

2. **Make the writes safe to retry.** Append mode wrote with `appendCells`, which is not
   idempotent: if Google committed the write and then failed the response, a retry would
   append the same rows a second time. The row offset is already known (`oldRows` from the
   dedupe read), so append now writes positionally with `updateCells` at
   `[oldRows, oldRows + n)`, exactly where `appendCells` would have put the rows, and grows
   the grid first the same way replace mode already does. Writing the same cells to the
   same range twice is a no-op, so every request in the module is now replay-safe.

3. **Say something useful when it really is down.** A 503 that survives every retry now
   reads "Google Sheets is temporarily unavailable... wait a minute and export again"
   instead of the raw API string. 429 gets its own rate-limit wording. Permission and
   not-found messages are unchanged. All three export modals already render
   `result.message`, so no UI change is needed.

## Alternatives rejected

- **Retry only the reads.** Would have fixed this exact screenshot (the 503 hit the
  metadata read) and needed no write changes. Rejected: the next 503 lands on the write
  instead and the user is back to a dead export after the slow part already ran.
- **Keep `appendCells` and retry it anyway.** Rejected: a duplicated block of exported rows
  is silent corruption in a client-facing sheet. Ad ID dedupe would hide it on the *next*
  export but only when the Ad ID column is included, which is optional.
- **Retry in the server action, around `writeToSheet`.** Rejected: a whole-export retry
  re-runs the DB read and the dedupe read, and in replace mode it would re-clear the tab.
  The right granularity is the single HTTP request.

## Residual edge, accepted knowingly

`batchUpdate` is atomic on Google's side, so a retried write either applies once or not at
all. One case is still imperfect: the formatting batch carries `deleteBanding` for the
tab's existing banded range, and if Google were to commit that batch and *then* fail the
response, the retry would ask it to delete a banded range that is already gone and get a
400 back. The user would see an error on an export whose data actually landed correctly.
That is a worse message, not corrupted data, and it needs a commit-then-fail from Google
(a 503 is refused at the front door, not half-applied). Making it airtight means swapping
delete-then-add banding for `updateBanding`, which risks a visible formatting regression in
every export to remove a rare wrong error message. Not worth it. Noted here so the next
person does not rediscover it as a surprise.

## Security

No change to the trust boundary. Same service account, same least-privilege scope (only
sheets shared with `GCS_CLIENT_EMAIL`), same `valueInputOption` behaviour and formula-safe
cell building. Retry logs record only the action label, attempt number and HTTP status:
no spreadsheet id, no token, no row content. The retry ceiling is fixed at four attempts,
so a failing Google cannot be turned into an unbounded request loop against it.

## QA

- Unit tests over the new pure helpers and the retry loop itself (injected sleep): retries
  a 503 then succeeds, gives up after four attempts, retries a thrown network fault, never
  retries a 404, prefers a real status over an earlier network fault, backoff grows and
  stays capped inside the latency budget, and 503/429/403/404/400 each classify to the
  right code and message.
- Integration tests that drive the real `writeToSheet` with `fetch` and the service-account
  key stubbed, asserting on the requests it emits: append lands at the first free row,
  append into an empty tab writes the header at row 0, the grid is grown before the data
  is written, `appendCells` is gone, an export survives a 503 on the metadata read, and a
  Google that never recovers produces the wait-and-retry message.
- Golden path re-verified by reading through both write modes: create tab, append into an
  empty tab, append with dedupe, append into a tab smaller than the write, replace shrink
  and grow, multi-chunk write past 5000 rows.
- Whole suite green: 228 tests.

## Open questions

None blocking. Possible follow-up: surface a "Google was flaky, retried" note in the modal
on a successful export that needed retries. Left out to keep the modal quiet on success.
