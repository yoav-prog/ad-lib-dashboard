# Live Run Logs and Status

Date: 2026-07-08
Status: approved design, not yet built
Area: Control Room (web dashboard) + scraper runner + Supabase schema

## Goal

When you press Run Now (or a scheduled run fires), you should be able to see, at a
glance and in plain words:

1. What the run is doing right now (which competitor, how far along, how many ads found).
2. Whether it is still going, finished, or died, without reloading or logging into GitHub.
3. The full logs, in the app, that survive leaving the page and coming back.
4. Before you even click Run Now: exactly what it will scrape and how many ads.

This closes the current gap: Run Now is fire and forget. It prints an optimistic
message and then goes silent. Silence reads as failure. The only real logs live in
GitHub Actions behind a login, and the results page never refreshes on its own.

## Who and scale

Internal tool, 1 to 3 admins. Not public. Viewers are read-only and do not run scrapes.

## Constraints (fixed architecture)

- The scraper (run_scrape.py) runs on GitHub Actions (hourly cron + manual dispatch)
  or locally. It is NOT part of the Next.js app. No shared process or filesystem.
- The ONLY channel between runner and dashboard is Supabase Postgres.
- The dashboard reads/writes Postgres directly via the transaction pooler (port 6543),
  prepared statements disabled, `postgres` JS driver, connecting as the privileged
  role (bypasses RLS). App-level auth is the real gate: requireAdmin / requireAuth.
- At most one run may be 'running' at a time, enforced by the runs_single_active
  unique index. claim_run returns None if a run is already active.
- Run Now fires the GitHub workflow immediately (GH_DISPATCH_TOKEN + GH_REPO are set),
  so there is a real run to watch within seconds, not an hour.

## What Run Now scrapes (the clarity requirement)

triggerScrape() marks every enabled, non-paused domain due. The runner then scrapes
each due domain up to its own Max Ads, keeps ads past the minimum age that are not
already stored, enriches and upserts those. So the run scope is: all ACTIVE domains,
each up to its Max Ads. The UI must state this, both before running and while running.

## Chosen approach

A hardened, DB-backed live status + full in-app log console. Progress is the hero;
the raw console sits right below it. No GitHub dependency for viewing logs.

### 1. Schema (new migration 0004_run_logs.sql)

- New table `run_logs` (append-only): id bigserial PK, run_id uuid FK (on delete
  cascade), ts timestamptz, level text check in (info, warn, error, success),
  message text. Index on (run_id, id).
- ALTER `runs` add: last_heartbeat_at timestamptz, current_domain text,
  domains_total int default 0, domains_done int default 0, ads_found_so_far int
  default 0.
- RLS parity with existing tables (team full access for authenticated), though the
  app connects as the privileged role and is gated at the app layer.

### 2. Runner (db.py + run_scrape.py)

- A RunLog buffer object: log(level, msg) redacts secrets, appends (ts, level, msg)
  to an in-memory list, AND prints (so GitHub Actions logs keep working).
- A background asyncio task started right after claim_run: every ~2s it runs, off the
  event loop via asyncio.to_thread, a flush that (a) batch-inserts all buffered log
  rows in one multi-row insert, and (b) updates runs heartbeat + progress snapshot
  (last_heartbeat_at = now(), current_domain, domains_total, domains_done,
  ads_found_so_far). Cancelled at finish/fail with a final flush.
- Progress is updated in memory by the orchestrator as it moves through domains and
  batches; the flusher persists the snapshot. This keeps the heartbeat fresh even
  during a long Apify fetch, so a stale heartbeat reliably means the process died.
- Fail-open: the entire flush path is wrapped so a DB blip logs to stderr but never
  raises into the scrape. Logging can never kill a run.
- Convert the existing print() call sites in run_scrape.py (run start, per-domain
  start with "scraping X up to N", per-batch "M new", per-ad errors, domain done,
  run done/failed) to also call log(). Pass the bare run_id and a logger down into
  scrape_query; do not build an elaborate callback abstraction.
- Secret redaction: before any message is buffered, replace literal occurrences of
  the known secret values pulled from the environment (DATABASE_URL, APIFY_API_TOKEN,
  OPENAI_API_KEY, SCRAPINGBEE_API_KEY, GCS_PRIVATE_KEY, etc.) with [redacted], plus a
  regex pass for postgres:// URLs and Bearer tokens as defense in depth. We only
  capture the runner's own intentional log lines, never raw stdout/stderr, so library
  debug output cannot smuggle secrets in.
- Retention: at run start, delete run_logs whose run finished more than 30 days ago.
  One cheap statement; prevents unbounded growth.

### 3. Dashboard read path

- One route handler GET /api/run-status?since=<lastLogId>. It checks the session
  cookie for admin, returns 403 JSON otherwise (no redirect). Returns:
  { active: bool, run: { id, status, started_at, current_domain, domains_total,
  domains_done, ads_found_so_far, stale, elapsed_seconds }, logs: [ {id, ts, level,
  message} ] since the cursor }.
- stale is computed in SQL on the DB clock: now() - last_heartbeat_at > 90s. Never
  diff the browser clock against a DB timestamp (three machines, three clocks).
- queries.js gains getActiveRun() and getRunLogs(runId, sinceId). getRunHistory
  reuses getRuns (already returns status/counts, includes failed runs).

### 4. Dashboard UI

- Polling lives at the top level (Dashboard client component), so it persists across
  tab switches and, because state is in the DB, resumes on a full page reload. Poll
  /api/run-status every 2.5s while a run is active (or just after Run Now); back off
  to a slow poll (or stop) when idle. Cursor kept in a useRef to avoid stale closures.
- Global banner: a slim strip under the top chrome, shown on every view when a run is
  active. Plain words: "Scrape running - used cars, competitor 1 of 1, 47 found".
  Click it to jump to Control Room. It disappears shortly after the run ends.
- Control Room live panel (the hero), progress-first:
  - Header line in plain words: RUNNING / STALLED / COMPLETED / FAILED.
  - Progress: current competitor, done/total bar, ads found so far, elapsed, and a
    rough "about X min left" only once at least one domain is done.
  - Full console right below: monospace, dark, auto-scrolls to bottom, level colors,
    shows every captured line. This is the full in-app raw console.
  - STALLED state (heartbeat older than 90s while status is still running): amber
    warning "No heartbeat for Xm, the run may have died", with a Mark as failed button
    (admin action calling fail_run) so you are not stuck watching a corpse for 30 min.
  - On completion: panel flips to "Completed: +N new ads" with a one-click
    "See new ads in Fresh Finds" button that switches to the Fresh tab and refreshes
    the data (router.refresh + syncing ads state from new props). No "refresh" chore.
- Run history: existing runs list, each row expandable to its stored logs and
  error_detail. Failed runs included and their logs fully visible (unlike ads, logs
  are never hidden by run status; debugging a failure is the whole point).
- Run Now scope clarity: the button and the panel state, before running, exactly what
  will run: "Run now: 1 active domain (used cars), up to 100 ads". While running,
  disable Run Now (prevents the mash-five-times problem) and show progress.

## Security (rule 13)

- Log read endpoint and the mark-as-failed action are admin-gated. Logs can contain
  competitor queries and landing-page URLs; keep them out of viewer reach.
- Secrets never reach run_logs: redact known secret values and token/DSN patterns
  before buffering; capture only intentional log lines, never raw stdout.
- Fail-open logging: a logging or heartbeat failure must never crash a scrape.
- Retention delete bounds table growth (30 days).
- Concurrency: the DB unique index already blocks a second concurrent run; the UI
  disables Run Now while active and tracks the single running row. No duplicate runs.

## Cost (rule 8)

No new paid service. Adds rows to the existing Supabase Postgres (tiny: a few runs a
day, 30-day retention, thousands of rows) and a polling endpoint. If the web app is on
Vercel Hobby, worst case is low thousands of function invocations per day during active
runs for 1 to 3 users, well under the 100k/month Hobby limit. Verify exact limits only
if usage grows. Net: negligible.

## Alternatives rejected

- Link to GitHub Actions logs only (leanest). Rejected by the user: logs must live in
  the app, no GitHub login, and it does not cover local runs. The council favored a
  hybrid; the user chose full in-app console. Honored, with hardening kept.
- One DB insert per log line. Rejected: from a GitHub Actions runner, tens of thousands
  of latency-bound round trips would dominate runtime. Batched flush instead.
- Trusting runs.status for the banner. Rejected: a dead run stays 'running' up to 30
  min until the next claim reclaims it, so the banner would lie exactly when it matters.
  Liveness is computed from last_heartbeat_at.
- Blocklist-scrubbing raw output for secrets. Rejected: you cannot enumerate every
  token. Capture only intentional lines and redact known secret values.
- Supabase Realtime streaming. Deferred: at 1 to 3 users, 2.5s polling looks identical
  and avoids a new browser-to-DB path and its security surface.
- Per-domain health scores, cost-per-run, anomaly alerts (Expansionist). Deferred: real
  value, wrong build order, answers a question not asked. The schema leaves the door
  open (per-run and eventually per-domain outcome rows) without building it now.

## Build order (thin slice first)

1. Migration 0004: run_logs + heartbeat/progress columns. Apply to Supabase.
2. db.py: RunLog buffer, log(), flush + heartbeat, redaction, retention, fail-open.
3. run_scrape.py: start the background flusher after claim_run; convert print sites to
   log(); maintain progress counters; final flush on finish/fail. Prove the loop end to
   end with just start / per-domain / finish lines visible live.
4. queries.js + /api/run-status route handler (admin-gated, SQL-computed stale).
5. Control Room live panel: progress header, full console, STALLED + mark-failed,
   completion -> See new ads.
6. Global banner + top-level poller + disable Run Now while active + pre-run scope text.
7. Run history expanders with stored logs, including failed runs.
8. QA: golden path (run, watch, complete, see ads), a forced failure (logs + error
   visible), a simulated stall (kill mid-run, panel flips to STALLED within 90s), leave
   and return mid-run (panel resumes from DB), viewer role (no logs, no Run Now),
   secret redaction check (grep run_logs for any token fragment).

## Open questions

- Exact stale threshold: starting at 90s (heartbeat every ~2s gives wide margin). Tune
  if long Apify fetches ever trip it.
- ETA accuracy: linear extrapolation from domains done. Good enough, shown only when
  we have a basis. Revisit if it feels wrong.
- Optional: fix trigger_source, currently hardcoded to 'manual' in run_scrape.py, so
  history can distinguish scheduled from manual. Out of scope unless wanted.
