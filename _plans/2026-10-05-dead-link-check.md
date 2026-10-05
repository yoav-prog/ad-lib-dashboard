# Dead landing links: check them, mark them, let people hide them

Date: 2026-10-05. Asked for by Oz (via Yoav): "when I filter by Tarzo, the article links I
checked so far lead to 404".

## What we found

Not a bug in our link handling. Tarzo deleted its whole `/dcg/<id>/<slug>` article section
around 2026-08-25..30 and stopped every ad that pointed at it.

- Every `/dcg/` URL 404s on every Tarzo domain, including the raw ad link with all its params,
  and including requests dressed as the Facebook app (mobile UA, facebook referrer, fbclid). So
  it is not cloaking and not our `cleanLink` stripping a param.
- No redirect, no copy at the bare slug or `/trending/<slug>`, nothing in site search.
- 8,940 of the 10,760 approved Tarzo ads are `/dcg/` links. None has been seen since 2026-08-30,
  although every Tarzo domain was scraped in the last two days.
- Since 2026-08-31 Tarzo ads use `/trending/<slug>-<id>?utm_...`, and those return 200.
- We kept the article text for most of them (scraped while live), shown in the Detail panel.

The dashboard keeps every ad forever and nothing says a landing page is gone, so a stopped ad
with a deleted page looks exactly like a live one.

## Goal

A person clicking a landing link should know before they click that the page is gone, and be
able to take dead links out of the view. Works for every competitor, not only Tarzo.

## Approach (chosen)

Check the links themselves.

1. Migration `0019_link_status.sql`: `ads.link_status smallint` (final HTTP status, NULL = not
   checked or no answer) and `ads.link_checked_at timestamptz`, plus a partial index for the
   dead rows.
2. `check_links.py`: plain `requests` GET (no ScrapingBee, free) of each ad's first landing URL,
   redirects followed like a browser, body not downloaded. One request per distinct URL, written
   to every ad that shares it. Bounded per host so no competitor gets hammered. Order: never
   checked first, then the stalest. Re-checks after 7 days (pages can come back). Time budget so
   a scheduled run always finishes cleanly; every write commits on its own, so it is resumable.
3. `link_health.py`: the pure rule, unit-tested. **Dead means 404 or 410 and nothing else.**
   Bot walls (202/403/429), 5xx and timeouts are "unknown", never dead. Being wrong in the
   "dead" direction hides a real ad from someone, so the rule is conservative on purpose.
4. Workflow `check-links.yml`: daily cron + manual button. Free (public repo, standard runner).
5. Dashboard:
   - URL cell: a red `DEAD` chip before the link, tooltip says when it was checked and that
     the saved copy is in the ad's detail.
   - Detail panel: a line under the link saying the page is gone (status + date), and the saved
     article shows in full instead of the first 12 paragraphs, since it is now the only copy.
   - Rail: "Landing Page" control, ALL / HIDE DEAD / ONLY DEAD, default ALL. Works on both the
     server feed (SQL) and the client fallback, since the status rides on the row.
   - Clear resets it and it counts as an active filter.
6. Backfill: run the full check over every approved ad before merging, so the chips are there
   on day one.

## Rejected

- **Tarzo `/dcg/` rule only** (client-side regex). Ships in an hour, fixes this one case, rots
  the next time anyone deletes a section.
- **"Still running" from last_seen_at.** Each domain is capped at 100 ads per scrape and the
  Tarzo domains hit the cap, so "not seen lately" does not reliably mean "stopped".
- **Default to HIDE DEAD.** Tempting for the lazy user, but it silently changes every count and
  hides proven winners' copy, which is still useful research. The chip makes the state obvious;
  hiding is one click.

## Security

- Outbound GETs only, to URLs competitors already put in public ads. No credentials, no cookies,
  no body stored. Redirects capped (requests default 30). Timeouts on connect and read, so a
  tarpit host cannot hang the run (see the ScrapingBee timeout lesson).
- The job runs in GitHub Actions with the existing `DATABASE_URL` secret, nothing new.
- New rail value is validated server-side against a fixed set; anything else is ignored.
- Logs print host + status, never secrets.

## Activation

1. `python apply_migration.py supabase/migrations/0019_link_status.sql` BEFORE the app deploys
   (FEED_COLUMNS selects the new columns).
2. `python check_links.py` for the backfill.
3. Merge. The daily workflow keeps it current.

## Learned during the backfill (and changed because of it)

- **Not every 404 is a deleted article.** Of the first ~2,850 dead links: Tarzo's are deleted
  `/dcg/` articles, TONIC's (108) are tracker campaigns that no longer exist (filling the
  `{{ad.id}}` macros changes nothing, live trackers return 200 either way), and Predicto's are
  almost all (1,823 of 1,844) bare `/asrsearch` links stored without their search term - known
  since `backfill_resolved_url.py`, the term is filled in client-side and never captured. All of
  them really do not open a page, so they are dead links, but the wording says only that
  ("Dead link: returned 404 when checked on ...") and never claims the competitor removed it.
- **Competitors rate-limit.** A 24-worker burst got 429s from the TONIC sites and 406s from
  Tarzo's, and Tarzo's network then blocked this machine's IP outright (406 on live pages too).
  Now: one request at a time per site with a 1s gap, one retry after 15s on 429/406/503, and
  any inconclusive answer is re-asked after 20 hours instead of a week.
- **202 is not "opens".** Several Tarzo sites serve a 202 challenge page in place of the
  article. Only 200 counts as a conclusive "opens"; only 404/410 as dead.
- Tarzo's backfill runs from GitHub Actions (fresh runner IPs) after merge, not locally.

## Known limits

- A "soft 404" (a 200 page that says not found) is not detected.
- A page that 404s only for a US datacenter IP would read as dead. Not seen in validation.
- A site that blocks the checker gets no verdict at all (406/429 stay "unknown"), so a dead
  link there stays unmarked until a later run gets through.
