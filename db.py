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
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row

# Cadence → interval used to schedule the next run for a domain.
CADENCE_INTERVAL = {
    'hourly': '1 hour',
    'daily':  '1 day',
    'weekly': '7 days',
}

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
    'article_title', 'article_content', 'rank',
    'language', 'country', 'vertical',
]

# Refreshed every time an ad is re-seen (everything except its identity).
_UPDATE_COLUMNS = [c for c in AD_COLUMNS if c != 'ad_archive_id']


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
def claim_run(conn, trigger_source: str = 'schedule', stale_minutes: int = 30):
    """
    Start a run and take the single-active-run lock.

    First, any run left 'running' longer than stale_minutes (a crashed job) is
    marked 'failed' so it stops blocking. Then a new run is inserted. If another
    run is genuinely active, the runs_single_active index rejects the insert and
    we return None (caller should exit quietly).
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            update runs
               set status = 'failed',
                   finished_at = now(),
                   error_detail = 'reclaimed as stale'
             where status = 'running'
               and started_at < now() - make_interval(mins => %s)
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
    """Mark a run completed. Its ads become the new 'fresh finds' baseline."""
    with conn.cursor() as cur:
        cur.execute(
            """
            update runs
               set status = 'completed', finished_at = now(),
                   ads_found = %s, ads_new = %s, errors = %s
             where id = %s
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
# DOMAINS - management-zone config + scheduling
# ═════════════════════════════════════════════════════════════════════════════
def any_domain_due(conn) -> bool:
    """Cheap check for the GitHub Actions self-check step: is anything due?"""
    with conn.cursor() as cur:
        cur.execute(
            """
            select 1 from domains
             where enabled and cadence <> 'paused' and next_run_at <= now()
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
             where enabled and cadence <> 'paused' and next_run_at <= now()
             order by next_run_at asc
            """
        )
        return cur.fetchall()


def bump_domain_schedule(conn, domain_id, cadence: str):
    """Advance a domain's next_run_at by its cadence after a run."""
    interval = CADENCE_INTERVAL.get(cadence, '1 day')   # cadence is CHECK-constrained
    with conn.cursor() as cur:
        cur.execute(
            """
            update domains
               set last_run_at = now(),
                   next_run_at = now() + %s::interval
             where id = %s
            """,
            (interval, domain_id),
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


def existing_ad_ids(conn) -> set[str]:
    """All ad_archive_ids already stored - lets the scraper skip known ads."""
    with conn.cursor() as cur:
        cur.execute('select ad_archive_id from ads')
        return {row['ad_archive_id'] for row in cur.fetchall()}
