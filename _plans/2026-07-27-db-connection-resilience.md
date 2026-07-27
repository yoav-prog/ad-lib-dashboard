# Survive a Supabase pooler blip instead of losing the whole run

2026-07-27. Approved and executed the same day.

## The incident this comes from

Scrape run `30260950347` (workflow_dispatch, started 11:10:51Z) showed STALLED on the
dashboard with 365 ads found across 4 of 14 domains, then died. Reconstructed from the
GitHub Actions log:

| time | what happened |
|---|---|
| ~11:19 | the Supabase transaction pooler stopped accepting connections from the runner |
| 11:25:45 | first `[run-log flush failed: connection timeout expired]` |
| 11:26:13 | `run FAILED: connection timeout expired` - the scrape's own DB work raised, entering the failure handler |
| 11:26:13 - 11:45:44 | the `fail_run` write at `run_scrape.py:643` blocked for **19.5 minutes**, then raised |
| 11:45:44 | job exits 1 |
| 11:36:50 | meanwhile the scheduled run reclaimed the lock as stale and started its own run |

Two separate things went wrong, and only one of them was Supabase's fault.

**Why a blip became a 19-minute hang.** `psycopg.connect()` was called with no
`connect_timeout`. Verified in the psycopg source (`conninfo.timeout_from_conninfo`),
an absent value means `_DEFAULT_CONNECT_TIMEOUT` = **130 seconds**, and per the libpq
documentation that timeout "applies separately to each host name or IP address". The
pooler host resolves to three addresses. So one unreachable pooler blocks a single
`db.connect()` call for 6.5 minutes, and the three logged flush failures were ~6.7
minutes apart, which is the arithmetic confirming it.

**Why the dashboard lied about it.** `_flush_once` writes the log lines and bumps
`last_heartbeat_at` in the same call, so when connecting blocked, both stopped
together. The dashboard reads liveness from `last_heartbeat_at` alone and rendered
STALLED with the message "The run may have died on the runner. Mark it failed to
clear the lock." The run had not died, and `markRunFailed` does not stop a runner.

**What it cost.** The 365 ads the run had already committed are stranded: the feed
only shows ads whose run reached `status = 'completed'`, so a run that fails takes its
committed work out of the feed until a later completed run re-sights those domains.

## Goals

1. A transient pooler failure must not cost more than the seconds it actually lasts.
2. A run that has done its work must not lose it because the final status write hit a
   blip.
3. Stop hammering the pooler with a new TCP + TLS connection every two seconds.

## Non-goals

Not fixing here, deliberately:

- The STALLED banner's wrong diagnosis and wrong button (its own change - it is UI
  copy plus pointing at `stopRun` rather than `markRunFailed`).
- Making a failed run's already-committed ads visible. Real, and the second time in a
  day it has bitten, but it is a feed-semantics decision, not a resilience fix.
- Re-queueing log lines that a failed flush drained. During the outage every log line
  was lost, which is why the console froze. Worth doing, needs a memory cap, separate.

## Chosen approach

### 1. A real connect timeout (`db.py`)

`CONNECT_TIMEOUT_SECONDS = 10`, passed to `psycopg.connect`. Per-address, so the worst
case for the three-address pooler is ~30s instead of ~390s. Ten seconds is far above a
warm connect (sub-second) and far below the 90s the dashboard uses to call a run
stalled, so an ordinary blip can no longer produce a false STALLED.

### 2. One held connection for the heartbeat (`db.py`, `run_scrape.py`)

`db.open_connection()` is split out of the `connect()` context manager, and the
heartbeat holds a single connection through a `_FlushConnection` holder rather than
dialling a new one every 2 seconds - roughly 1,350 connections per 45-minute run
before counting upserts. On any flush error the holder drops the connection so the
next tick redials.

Deliberately **no retry inside a flush**: with `autocommit=True` a retry after a
partially-applied `executemany` could duplicate log rows. The heartbeat already runs
every 2 seconds, so the loop itself is the retry.

The flush also now bumps the heartbeat **before** inserting log lines. If the log
insert is what fails, the run still reads as alive.

### 3. Retry the end-of-run writes, off the event loop (`run_scrape.py`)

`_db_write_with_retry` runs a write on a fresh connection via `asyncio.to_thread`, with
linear backoff, and raises the last error if every attempt fails.

- `finish_run` gets 5 attempts. By then the run has spent its Apify, OpenAI and
  ScrapingBee budget, and this single write is what decides whether any of it shows.
- `fail_run` gets 2. The stale reclaim in `claim_run` is the backstop, and a doomed
  status write should not add minutes to a job that is already dying.
- The `fail_run` attempt is wrapped so it can never mask the exception that actually
  killed the run. In this incident it did exactly that: the traceback in the log was
  the failure handler's own connect timing out, and the real error was only visible
  19 minutes earlier in the log.

`to_thread` matters as much as the retry: `run()` is async, so a bare `db.connect()`
inside it blocks the event loop, and the heartbeat task with it.

## Alternatives rejected

**`psycopg_pool`.** The proper fix for connection churn, and it handles liveness
checks and reconnects for us. Rejected for now: it is a new dependency and a new
failure mode for a runner whose DB use is a heartbeat plus batch upserts. One held
connection solves the observed problem with no new surface. Revisit if the upsert path
starts to hurt too.

**Retry every `db.connect()` call site.** More thorough, much larger diff, and mostly
unnecessary once the timeout is 10s per address rather than 130s. The end-of-run
writes are the ones where a loss is unrecoverable.

**Raise the dashboard's 90s stall threshold.** Treats the symptom, and would delay
detection of a genuinely dead runner.

## Security

No new surface. The change opens the same connections to the same host with the same
credentials, only fewer of them and with a bound on how long a dial may hang.

- The new retry messages print exception text that can carry a host and port but never
  a password: psycopg's `ConnectionTimeout` renders `host`, `port` and `hostaddr` only.
- Everything printed still goes through the tee into `insert_run_logs`, which applies
  `redact()` (known secret values, DSN passwords, bearer tokens) at the write boundary.
- The `_flush_once` failure notice still goes to `sys.__stderr__` (the GitHub log,
  which masks configured secrets) rather than to the database, since the database is
  by definition the thing that is not reachable at that moment.
- Holding one connection open for a run does not widen exposure: the runner already
  holds credentials for its whole lifetime.

## Testing

No live database needed; psycopg is faked.

- `connect()` and `open_connection()` pass `connect_timeout` (guards the regression
  directly - an unset timeout is the bug).
- `connect()` closes its connection; `open_connection()` leaves it open.
- `_FlushConnection` dials once and reuses; redials after `drop()`; redials when the
  held connection reports `closed`.
- `_flush_once` never raises when the DB is down, and drops the connection so the next
  tick redials.
- `_flush_once` bumps the heartbeat even when the log insert fails.
- `_db_write_with_retry` returns after a first-attempt success, retries a failing write
  and succeeds on a later attempt, and raises the last error once attempts run out.

Full `pytest` green before merge.

## Open questions

- Whether the pooler blip was Supabase-side or connection-count-driven. Fewer
  connections per run makes the second less likely either way, but if STALLED recurs
  after this, the next thing to look at is Supavisor's pool limits for the project.
