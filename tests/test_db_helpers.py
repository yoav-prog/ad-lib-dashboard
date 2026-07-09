"""db helpers the time budget relies on: mark_domains_due hands deferred
domains to the next scheduled tick, and claim_run's stale-reclaim must judge
liveness by heartbeat, not age - a healthy run may live past 30 minutes under
the budget, and failing it by age would hide every ad it captured.
"""

import psycopg
import pytest

import db


class FakeCursor:
    def __init__(self, fetchone_result=None, raise_on_insert=None):
        self.calls = []
        self._fetchone_result = fetchone_result
        self._raise_on_insert = raise_on_insert

    def execute(self, sql, params=None):
        normalized = ' '.join(sql.split())
        self.calls.append((normalized, params))
        if self._raise_on_insert and normalized.startswith('insert'):
            raise self._raise_on_insert

    def fetchone(self):
        return self._fetchone_result

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeConn:
    def __init__(self, **cursor_kwargs):
        self.cur = FakeCursor(**cursor_kwargs)

    def cursor(self):
        return self.cur


def test_mark_domains_due_makes_the_rows_due_now():
    conn = FakeConn()
    db.mark_domains_due(conn, ['id-a', 'id-b'])

    assert len(conn.cur.calls) == 1
    sql, params = conn.cur.calls[0]
    assert 'update domains set next_run_at = now()' in sql
    assert '::uuid[]' in sql          # uuid column; text ids must be cast
    assert params == (['id-a', 'id-b'],)


def test_mark_domains_due_empty_list_is_a_noop():
    conn = FakeConn()
    db.mark_domains_due(conn, [])
    assert conn.cur.calls == []


def test_claim_run_reclaims_by_heartbeat_not_age():
    conn = FakeConn(fetchone_result={'id': 'new-run-id'})
    run_id = db.claim_run(conn, stale_minutes=10)

    assert run_id == 'new-run-id'
    reclaim_sql, params = conn.cur.calls[0]
    assert "coalesce(last_heartbeat_at, started_at)" in reclaim_sql
    assert 'started_at < now()' not in reclaim_sql
    assert params == (10,)
    insert_sql, _ = conn.cur.calls[1]
    assert insert_sql.startswith('insert into runs')


def test_claim_run_yields_when_another_run_is_active():
    conn = FakeConn(raise_on_insert=psycopg.errors.UniqueViolation())
    assert db.claim_run(conn) is None
