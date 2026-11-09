# Ads appear during a run, and survive a stop

Date: 2026-11-09.

## Goals

1. New ads show up in the dashboard while a scrape is running, not only when it ends.
2. Stopping a run keeps everything it saved up to that moment.
3. Fix the bug where the end-of-run refresh never reached the Fresh Finds table.

## Constraints

- One run at a time, the runner, and the batch-of-10 upsert all stay as they are.
- No new service. Polling goes through the existing Vercel app.
- The live panel's logs stay restricted to `run_scrapes`.

## Findings that shaped this

- The "completed runs only" filter existed to hide half-enriched rows. `process_ad`
  finishes the article, GPT and media work before `upsert_ads`, and nothing in the
  scraper updates an ad afterwards apart from re-sightings. A saved row is a whole row,
  so the filter no longer protects anything.
- In server feed mode (the default) `feedPage` is set once from `initialFeed`, so
  `router.refresh()` updates the ticker but not the table.
- Editors and viewers do not have `run_scrapes`, so `/api/run-status` answers 403 and
  they had no live signal at all.

## Approach (chosen)

Remove the run-status filter from every read (feed, feed page, Review, Filtered,
Rejected, badge counts). `review_status` and the prohibited-content screen still apply.

Dashboard: when the run's `ads_found_so_far` rises, re-read the current page silently.
The decision lives in a pure function, `web/lib/live-feed.js`, with unit tests.

- At most one live reload per 15 seconds.
- Live reloads happen only on Fresh Finds, page 1, with the browser tab visible, so rows
  do not shift under someone reading page 3. Missed updates are picked up on the next
  poll that qualifies.
- When a run ends or is stopped, the current page reloads once whatever the position.
- A silent reload shows no loading state and is dropped if the user edited a row while
  it was in flight, so it cannot undo an optimistic change.
- Live reloads bypass the 60 second cache on the total, so the count keeps up.

New `GET /api/feed-pulse` for signed-in users without `run_scrapes`: 5 second poll during
a run, 30 seconds idle, paused while the tab is hidden.

## Alternatives rejected

- **Keep the filter, also allow `running` and stopped runs.** Same visible result with a
  more complicated query, and a crashed run would make ads vanish that people had
  already seen.
- **Scope the live view to the current run's ads, then merge.** A second code path for
  no benefit.
- **Supabase Realtime or websockets.** A new moving part. Polling already exists and a
  batch takes far longer than the poll interval.
- **Reload on every poll.** Heavy feed queries every 2.5 seconds for no visible gain.

## User's seat

- Ads arrive at the top of page 1 without a click and without a loading flash.
- Reading page 3: nothing moves. Going back to page 1 shows the new ads.
- Stop: the table updates once with what was saved.
- Closed browser or reload mid-run: the normal page load shows everything saved so far.

## Cost

No new paid service. `/api/feed-pulse` adds Vercel function calls: about 29,000 per month
for a tab visible 8 hours a day at the idle rate. Vercel Pro lists additional invocations
from $0.60 per 1M and Hobby includes 1M per month (vercel.com/pricing, checked 2026-11-09).

## Security

- Sensitive: run logs. Not exposed by the new route.
- `/api/feed-pulse` requires a signed-in session and returns only the run id and a count.
  Signed-in users can already read the ads themselves.
- `liveTotal` from the client only skips a cache for one count. It is compared with
  `true`, never reaches SQL, and the action stays signed-in only.
- A failed poll is ignored, so a network error cannot look like a run ending.
- Nothing new is logged.

## Known limits

- The batch in progress when a run is stopped is lost (up to 10 ads). Those ads are not
  in the database, so the next run picks them up as new.
- A batch can land in the seconds between Stop and GitHub killing the job. It shows on
  the next page load.
- Older failed or stopped runs had hidden ads. Those become visible too. They carry old
  `last_seen_at` values, so they sort low and do not count as fresh.
- Filter rail counts stay on their 5 minute cache.
- Rows in an already-opened Review tab are not re-read during a run. Its badge is.
- Client feed mode (`SERVER_SIDE_FEED=0`) gets the end-of-run refresh only.

## Open questions

None.
