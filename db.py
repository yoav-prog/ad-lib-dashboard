"""
db.py - Supabase / Postgres data-access layer for the ad-intelligence pipeline.

The scraper is a trusted server-side job. It talks to Postgres directly through
the Supabase transaction pooler (Supavisor, port 6543). Transaction-mode pooling
requires server-side prepared statements to be disabled, which we do by passing
prepare_threshold=None to psycopg.

State lives in three tables (see supabase/migrations/0001_initial_schema.sql):
    runs     one row per scrape run; the concurrency lock + integrity boundary
    domains  the management-zone config (what to scrape, how many, how often)
    ads      one row per competitor ad, keyed on ad_archive_id (dedup)

The connection string comes from the DATABASE_URL environment variable, e.g.
    postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
"""

from __future__ import annotations

import os
import re
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row

# Columns written for every ad. Order matters: it maps positionally to the
# values list built in upsert_ads(). Provenance/pipeline columns are handled
# separately below.
AD_COLUMNS = [
    'ad_archive_id',
    'page_id', 'page_name', 'domain', 'feed',
    'caption', 'cta_text', 'body_text', 'cta_type', 'title',
    'link_description', 'link_url', 'display_format', 'extra_texts',
    'original_image_urls', 'video_hd_url', 'video_preview_url',
    'extra_image_urls', 'extra_video_urls',
    'publisher_platform', 'start_date', 'total_active_time',
    'article_title', 'article_content', 'resolved_url', 'rank',
    'language', 'country', 'vertical', 'brand', 'review_status',
]

# Refreshed every time an ad is re-seen (everything except its identity), with
# one deliberate exception: review_status is set on insert only, so a later
# scrape can never overwrite a human's approve/reject decision.
_UPDATE_COLUMNS = [c for c in AD_COLUMNS if c not in ('ad_archive_id', 'review_status')]


# ═════════════════════════════════════════════════════════════════════════════
# CONNECTION
# ═════════════════════════════════════════════════════════════════════════════
def _dsn() -> str:
    dsn = os.environ.get('DATABASE_URL')
    if not dsn:
        raise RuntimeError(
            'DATABASE_URL is not set. Use the Supabase transaction pooler '
            'connection string (port 6543). See SETUP.md.'
        )
    return dsn


@contextmanager
def connect():
    """Yield a psycopg connection configured for the transaction pooler."""
    conn = psycopg.connect(
        _dsn(),
        autocommit=True,
        prepare_threshold=None,     # required for transaction-mode pooling
        row_factory=dict_row,
    )
    try:
        yield conn
    finally:
        conn.close()


# ═════════════════════════════════════════════════════════════════════════════
# RUNS - concurrency lock + integrity boundary
# ═════════════════════════════════════════════════════════════════════════════
def claim_run(conn, trigger_source: str = 'schedule', stale_minutes: int = 10):
    """
    Start a run and take the single-active-run lock.

    First, any run whose heartbeat has been silent longer than stale_minutes
    (a crashed job - a live one heartbeats every 2s) is marked 'failed' so it
    stops blocking. Judged on last_heartbeat_at, not started_at: a healthy run
    may legitimately live past 30 minutes under the time budget, and its age
    says nothing about whether it is alive. Then a new run is inserted. If
    another run is genuinely active, the runs_single_active index rejects the
    insert and we return None (caller should exit quietly).
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            update runs
               set status = 'failed',
                   finished_at = now(),
                   error_detail = 'reclaimed as stale'
             where status = 'running'
               and coalesce(last_heartbeat_at, started_at) < now() - make_interval(mins => %s)
            """,
            (stale_minutes,),
        )
        try:
            cur.execute(
                'insert into runs (trigger_source) values (%s) returning id',
                (trigger_source,),
            )
            return cur.fetchone()['id']
        except psycopg.errors.UniqueViolation:
            return None


def finish_run(conn, run_id, ads_found: int, ads_new: int, errors: int = 0):
    """Mark a run completed. Its ads become the new 'fresh finds' baseline.

    Scoped to status='running' so a run that was stopped from the dashboard (set
    to 'failed' mid-scrape) is not flipped back to 'completed' when the runner,
    still executing until GitHub actually kills it, reaches its own finish call.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            update runs
               set status = 'completed', finished_at = now(),
                   ads_found = %s, ads_new = %s, errors = %s
             where id = %s and status = 'running'
            """,
            (ads_found, ads_new, errors, run_id),
        )


def fail_run(conn, run_id, error_detail):
    """Mark a run failed. Its partial data never becomes the baseline."""
    with conn.cursor() as cur:
        cur.execute(
            """
            update runs
               set status = 'failed', finished_at = now(), error_detail = %s
             where id = %s
            """,
            (str(error_detail)[:2000], run_id),
        )


# ═════════════════════════════════════════════════════════════════════════════
# RUN LOGS + PROGRESS - live visibility for the dashboard
# ═════════════════════════════════════════════════════════════════════════════
# Secrets never reach run_logs. We redact at the write boundary, so no matter what
# a caller buffers, nothing sensitive is persisted. Known secret values (pulled
# from the environment) are replaced verbatim; a couple of patterns catch DSN
# passwords and Bearer tokens as defense in depth.
_SECRET_ENV_KEYS = (
    'DATABASE_URL', 'APIFY_API_TOKEN', 'SCRAPINGBEE_API_KEY', 'OPENAI_API_KEY',
    'GCS_PRIVATE_KEY', 'GCS_PRIVATE_KEY_ID', 'GCS_CLIENT_ID', 'GH_DISPATCH_TOKEN',
)
_DSN_PASSWORD = re.compile(r'(postgres(?:ql)?://[^:\s/]+:)[^@\s]+(@)')
_BEARER_TOKEN = re.compile(r'(Bearer\s+)[A-Za-z0-9._\-]+', re.IGNORECASE)
_ANSI_ESCAPE = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')   # CSI sequences (colors etc.)
_secret_values_cache: list[str] | None = None


def _secret_values() -> list[str]:
    """Distinct env secret values worth redacting (cached; env is fixed per run)."""
    global _secret_values_cache
    if _secret_values_cache is None:
        vals = set()
        for key in _SECRET_ENV_KEYS:
            v = os.environ.get(key)
            if v and len(v) >= 6:
                vals.add(v)
        _secret_values_cache = sorted(vals, key=len, reverse=True)  # longest first
    return _secret_values_cache


def redact(text: str) -> str:
    """Strip known secret values and credential patterns from a log line."""
    if not text:
        return text
    for value in _secret_values():
        if value in text:
            text = text.replace(value, '[redacted]')
    text = _DSN_PASSWORD.sub(r'\1[redacted]\2', text)
    text = _BEARER_TOKEN.sub(r'\1[redacted]', text)
    return text


def strip_ansi(text: str) -> str:
    """Remove ANSI terminal escape sequences from a log line. The Apify actor's
    streamed log is full of color codes, which the dashboard's log console would
    otherwise render as escape-character garbage."""
    return _ANSI_ESCAPE.sub('', text) if text else text


def insert_run_logs(conn, run_id, rows) -> None:
    """Batch-insert buffered log lines, cleaned (ANSI stripped) and redacted at
    this write boundary so nothing garbled or sensitive is ever persisted.
    rows: iterable of (ts, level, message)."""
    values = [(run_id, ts, level, redact(strip_ansi(message))) for (ts, level, message) in rows]
    if not values:
        return
    with conn.cursor() as cur:
        cur.executemany(
            'insert into run_logs (run_id, ts, level, message) values (%s, %s, %s, %s)',
            values,
        )


def update_progress(conn, run_id, *, current_domain=None, domains_total=None,
                    domains_done=None, ads_found_so_far=None) -> None:
    """Refresh the heartbeat and any provided progress fields in one UPDATE.

    last_heartbeat_at is always bumped so liveness can be judged on the DB clock.
    A field left as None is not touched (so an early call before the first domain
    does not wipe current_domain).
    """
    sets = ['last_heartbeat_at = now()']
    params: list = []
    if current_domain is not None:
        sets.append('current_domain = %s'); params.append(current_domain)
    if domains_total is not None:
        sets.append('domains_total = %s'); params.append(domains_total)
    if domains_done is not None:
        sets.append('domains_done = %s'); params.append(domains_done)
    if ads_found_so_far is not None:
        sets.append('ads_found_so_far = %s'); params.append(ads_found_so_far)
    params.append(run_id)
    with conn.cursor() as cur:
        cur.execute(f'update runs set {", ".join(sets)} where id = %s', params)


def prune_run_logs(conn, keep_days: int = 30) -> None:
    """Delete logs for runs that finished more than keep_days ago (bounded growth)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            delete from run_logs
             where run_id in (
                 select id from runs
                  where finished_at is not null
                    and finished_at < now() - make_interval(days => %s)
             )
            """,
            (keep_days,),
        )


# ═════════════════════════════════════════════════════════════════════════════
# DOMAINS - management-zone config + scheduling
# ═════════════════════════════════════════════════════════════════════════════
def any_domain_due(conn) -> bool:
    """Cheap check for the GitHub Actions self-check step: is anything due?"""
    with conn.cursor() as cur:
        cur.execute(
            """
            select 1 from domains
             where enabled and next_run_at <= now()
             limit 1
            """
        )
        return cur.fetchone() is not None


def get_due_domains(conn) -> list[dict]:
    """Domains whose next_run_at has passed, soonest first."""
    with conn.cursor() as cur:
        cur.execute(
            """
            select * from domains
             where enabled and next_run_at <= now()
             order by next_run_at asc
            """
        )
        return cur.fetchall()


def get_domains_by_ids(conn, ids: list[str]) -> list[dict]:
    """Specific domains by id - used by targeted manual runs ("run these rows").

    Unlike get_due_domains this ignores enabled / next_run_at: an explicit
    request runs the row regardless, so you can one-off a paused competitor.
    Ids not present in the table are simply absent from the result.
    """
    if not ids:
        return []
    with conn.cursor() as cur:
        # ids arrive as strings; cast the array to uuid[] so it compares against the
        # uuid id column (there is no uuid = text operator). Ids are validated as
        # UUIDs upstream, so the cast is safe.
        cur.execute('select * from domains where id = any(%s::uuid[])', (list(ids),))
        return cur.fetchall()


def bump_domain_schedule(conn, domain_id, interval_days: int):
    """Advance a domain's next_run_at by its interval (in days) after a run."""
    with conn.cursor() as cur:
        cur.execute(
            """
            update domains
               set last_run_at = now(),
                   next_run_at = now() + make_interval(days => %s)
             where id = %s
            """,
            (interval_days, domain_id),
        )


def mark_domains_due(conn, ids: list[str]) -> None:
    """Make the given domains due immediately - used when a run's time budget
    expires before it reaches them, so the next scheduled tick picks them up
    (targeted rows included, which are otherwise not necessarily due)."""
    if not ids:
        return
    with conn.cursor() as cur:
        # Cast to uuid[]: ids are validated upstream; there is no uuid = text operator.
        cur.execute(
            'update domains set next_run_at = now() where id = any(%s::uuid[])',
            (list(ids),),
        )


# ═════════════════════════════════════════════════════════════════════════════
# ADS - dedup upsert
# ═════════════════════════════════════════════════════════════════════════════
def upsert_ads(conn, run_id, ads: list[dict]) -> tuple[int, int]:
    """
    Upsert a batch of ad dicts (keys = AD_COLUMNS; missing keys default to NULL).

    first_seen_at / first_run_id are set only on insert; last_seen_at /
    last_run_id are refreshed on every sighting. Returns (found, new); a row is
    counted 'new' when Postgres reports it as a fresh insert (xmax = 0).

    Array columns (original_image_urls, extra_image_urls, extra_video_urls,
    publisher_platform) expect Python lists. start_date expects a datetime or
    None.
    """
    if not ads:
        return (0, 0)

    cols = AD_COLUMNS + ['first_run_id', 'last_run_id']
    placeholders = ', '.join(['%s'] * len(cols))
    update_set = ', '.join(f'{c} = excluded.{c}' for c in _UPDATE_COLUMNS)
    sql = f"""
        insert into ads ({', '.join(cols)})
        values ({placeholders})
        on conflict (ad_archive_id) do update
           set {update_set},
               last_seen_at = now(),
               last_run_id  = excluded.last_run_id
        returning (xmax = 0) as inserted
    """

    found = new = 0
    with conn.cursor() as cur:
        for ad in ads:
            values = [ad.get(c) for c in AD_COLUMNS] + [run_id, run_id]
            cur.execute(sql, values)
            found += 1
            if cur.fetchone()['inserted']:
                new += 1
    return (found, new)


def resurface_ads(conn, run_id, ad_ids: list[str], domain: str | None = None) -> tuple[int, int]:
    """
    Cheap re-sighting for ads the scraper fetched but already has stored: bump
    last_seen_at / last_run_id so the dashboard's fresh window ("what the
    latest run saw") picks them up again - no ScrapingBee, GPT, or media cost.

    A rejected ad reopens as pending: Meta still running it means it deserves
    another human look (product decision 2026-07-09). Approved and pending
    rows keep their status - this is deliberately the only transition here.

    Pass domain to re-stamp rows whose destination matches the scraped domain;
    without it the stored domain stays (shared junk-pool ads keep the row that
    first dragged them in). Returns (touched, reopened).
    """
    if not ad_ids:
        return (0, 0)
    restamp = 'domain = %s,' if domain is not None else ''
    sql = f"""
        update ads a
           set {restamp}
               review_status = case when a.review_status = 'rejected'
                                    then 'pending' else a.review_status end,
               last_seen_at  = now(),
               last_run_id   = %s
          from (select ad_archive_id, review_status as old_status
                  from ads where ad_archive_id = any(%s)) o
         where a.ad_archive_id = o.ad_archive_id
     returning o.old_status
    """
    params = ([domain] if domain is not None else []) + [run_id, ad_ids]
    with conn.cursor() as cur:
        cur.execute(sql, params)
        old = [row['old_status'] for row in cur.fetchall()]
    return (len(old), sum(1 for status in old if status == 'rejected'))


def existing_ad_ids(conn) -> set[str]:
    """All ad_archive_ids already stored - routes known ads to the cheap
    resurface path (resurface_ads) instead of the full pipeline."""
    with conn.cursor() as cur:
        cur.execute('select ad_archive_id from ads')
        return {row['ad_archive_id'] for row in cur.fetchall()}
