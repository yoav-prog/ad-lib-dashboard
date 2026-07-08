# Configurable scrape frequency + Fresh Finds improvements

Date: 2026-07-08
Branch: per-row-manual-run
Status: implemented

Decisions taken at go-ahead:
- Frequency model: flexible "every N days" per domain (not fixed presets).
- Migration auto-sets all currently-enabled domains (mytips.com) to every 3 days;
  paused/disabled rows keep the faithful daily->1 / weekly->7 mapping.
- CSV export = current filtered view. Date format = compact "Jul 8, 26".
- Verification: `next build` compiles/lints clean; `py_compile` clean on db.py and
  run_scrape.py. Not run against the live Supabase DB (no credentials here).

## Goals

1. Let the scrape frequency be set per domain from the Control Room as "every N days"
   (the user wants mytips.com on every 3 days instead of daily).
2. Make new findings appear in Fresh Finds automatically after a scrape, with no
   duplicates (only genuinely new ads).
3. Add a "First Added Date" column to the Fresh Finds feed.
4. Add an "Export CSV" of the current (filtered) feed.

## Key finding: what already works (do not rebuild)

- **Dedup is already correct.** `db.upsert_ads` upserts on `ad_archive_id`
  (`on conflict do update`). A re-seen ad refreshes `last_seen_at` in place and is
  never inserted twice; only fresh inserts (`xmax = 0`) count as "new". So
  "duplicates don't get added, only new ones" is already the behavior.
- **New ads already surface in Fresh Finds.** `getAds` returns ads tied to a
  completed run; the feed flags fresh ones (`first_seen_at >= last completed run
  start`). The only gap is that the feed does not refresh itself the instant a run
  completes; today you click "SEE N NEW ADS" or reload. Fix: auto-refresh on
  completion (one small change), so it is truly automatic.

## The two frequencies (important context)

- The GitHub Actions cron (`.github/workflows/scrape.yml`, `17 * * * *`) is only a
  cheap hourly *poll*: `run_scrape.py` exits in seconds when nothing is due. It is
  NOT scraping hourly. It stays hourly.
- The real "how often do we scrape this domain" lever is the per-domain schedule.
  Today that is the `cadence` enum (`hourly/daily/weekly/paused`). We replace it
  with a numeric "every N days".

## Chosen approach

### Data model (replace the cadence enum with a day interval)

New migration `supabase/migrations/0005_domain_interval_days.sql`:
- Add `interval_days int not null default 3 check (interval_days between 1 and 365)`.
  Default 3 matches the user's stated preference for new domains.
- Backfill from the old cadence: `hourly`/`daily` -> 1, `weekly` -> 7.
- Preserve pauses: rows with `cadence = 'paused'` -> `enabled = false`. Pause now
  lives only on the `enabled` flag (the Status toggle), removing the redundant
  second pause mechanism.
- Deliver the request: `update domains set interval_days = 3 where enabled` so the
  active domain(s) (mytips.com) move to every 3 days immediately. Clearly commented;
  adjustable per row in the UI afterward.
- Swap the partial index predicate from `where enabled and cadence <> 'paused'` to
  `where enabled`.
- Drop the `cadence` column last.

Deploy order (their Supabase, applied by them): run the migration, THEN deploy the
code. The code reads `interval_days`, so it must not run against the old schema.

### Runner + data access (`db.py`, `run_scrape.py`)

- Remove `CADENCE_INTERVAL`.
- `any_domain_due` / `get_due_domains`: predicate becomes
  `where enabled and next_run_at <= now()`.
- `bump_domain_schedule(conn, domain_id, interval_days)`:
  `next_run_at = now() + make_interval(days => %s)`.
- `run_scrape.py`: `bump_domain_schedule(conn, dom['id'], dom['interval_days'])`.

### Server actions + queries (`web/app/actions.js`, `web/lib/queries.js`)

- `getDomains`: return `interval_days` instead of `cadence`.
- `DOMAIN_FIELDS`: replace `'cadence'` with `'interval_days'`.
- `updateDomain`: when the patch changes `interval_days`, also recompute
  `next_run_at = coalesce(last_run_at, now()) + make_interval(days => N)` in the
  same UPDATE, so "Next Due" reflects the new cadence immediately (lazy-user clear).
- `addDomain` / `refreshAds` auto-track: insert `interval_days` (default 3) instead
  of `cadence`.
- `triggerScrape`: predicate `where enabled` (drop `cadence <> 'paused'`).

### Control Room UI (`web/components/ControlRoom.jsx`)

- Replace the click-to-cycle cadence badge with a small number input: `every [N] days`
  (min 1). On change, `updateDomain(d.id, { interval_days: N })`.
- Rename the column header "Cadence" -> "Frequency".
- Replace every `d.cadence !== 'paused'` filter with `d.enabled` (activeDomains,
  dueTimes, scope text).
- Read-only viewers see plain "every N days" text.
- Note: this removes the hourly/daily/weekly presets. Sub-day (hourly) scheduling
  goes away. There are no hourly domains today, so nothing changes in practice.

### Fresh Finds feed (`web/components/Dashboard.jsx`, `web/lib/ui.js`)

- Add a `fmtDate(iso)` helper in `ui.js` (compact, e.g. "Jul 8, 26"; full ISO on hover).
- Add a "First Added" column to the feed header + rows showing
  `fmtDate(a.first_seen_at)`. Bump the header/row `min-width` so the layout stays
  horizontally scrollable, not squeezed.
- Add a pure `buildCsv(rows, NOW)` helper in `ui.js`; the download side-effect
  (Blob + temporary anchor, UTF-8 BOM for Excel) stays inline in the client
  component. Columns: page, domain, headline, body, CTA, link, format, rank,
  days running, first added date, last seen, vertical, country, language, feed,
  status, ad_archive_id. Export respects current filters/search (the `filtered` list).
  Filename `fresh-finds-YYYY-MM-DD.csv`.
- Auto-refresh: in the status poller, when the active run transitions to none,
  call `router.refresh()` once so new finds appear without clicking.

## Alternatives considered and rejected

- **Add a fixed "3 days" cadence preset** (keep the enum). Rejected: user chose
  flexible N days; a preset can't express arbitrary intervals.
- **Change the GitHub Actions cron to every 3 days.** Rejected: crude, not editable
  from the UI, and breaks the per-domain due model.
- **Keep both `cadence` and `interval_days`.** Rejected: dual source of truth invites
  drift; the codebase standard is clean and single-source.
- **Store `interval_minutes` (preserve sub-day granularity).** Rejected for now:
  the product is day-grained and the user asked for days; days-only keeps storage ==
  UI with no rounding weirdness. Revisit if hourly is ever needed (UI-only change if
  we later widen the unit).

## Security / safety (rule 13)

- `interval_days` is bounded by a CHECK (1..365) at the DB and clamped in the UI, so a
  bad value can't create a runaway (more-frequent) scrape. This change only ever makes
  scraping less frequent than daily for mytips.com.
- All writes stay behind `requireAdmin()` and the existing allowlist `pick()`; adding
  `interval_days` to `DOMAIN_FIELDS` keeps arbitrary-column writes blocked.
- CSV export is client-side over data already loaded in the browser; no new endpoint,
  no new data exposure. Fields are quote-escaped to avoid broken/injected cells.

## Cost (rule 8)

- No new paid services. This is a cost *reducer*: every 3 days is ~1/3 the scrape
  spend (Apify + ScrapingBee + OpenAI) of daily. The hourly GH Actions poll stays and
  remains within free minutes (unchanged).

## Lazy-user walkthrough (rule 10)

- Control Room: the Frequency column shows "every 3 days" as an editable number. Type
  2, press enter, Next Due updates. Obvious, one interaction.
- Fresh Finds: a new "First Added" column shows the date each ad entered the DB. An
  "Export CSV" button downloads exactly what's on screen (filters applied).
- After a scrape finishes, new ads appear on their own; no hunting for a refresh.

## Open questions

1. OK to auto-set the active domain(s) to every 3 days in the migration (delivers the
   request), or leave the faithful daily->1 mapping and let you set 3 in the UI?
2. "First Added" date format: compact "Jul 8, 26" (recommended) vs full "2026-07-08"?
3. CSV scope: current filtered view (recommended) vs the entire ad database?
