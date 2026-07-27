"""Surviving a Supabase pooler blip (see _plans/2026-07-27-db-connection-resilience.md).

On 2026-07-27 the pooler stopped accepting connections mid-run. psycopg was dialling
with no connect_timeout, which means its 130s default applied to each of the pooler's
three addresses, so one db.connect() blocked for ~6.5 minutes. The heartbeat went
silent, the dashboard reported a live run as STALLED, and the failure handler's own
connect hung for 19 minutes and then masked the error that started it.

These pin the three things that stop that from recurring: a bounded connect, a
heartbeat that reuses one connection and survives the database going away, and
end-of-run writes that get retried instead of losing a whole run's work.
"""

import asyncio

import pytest

import db
import run_scrape


class FakeConn:
    """Stands in for a psycopg connection. `closed` mirrors the real attribute."""

    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


# ── a connect that cannot hang for minutes ────────────────────────────────────
def test_connections_are_dialled_with_a_bounded_timeout(monkeypatch):
    # The regression itself: an absent connect_timeout means 130s per address.
    seen = {}

    def fake_connect(dsn, **kwargs):
        seen.update(kwargs)
        return FakeConn()

    monkeypatch.setenv('DATABASE_URL', 'postgresql://u:p@pooler.example.com:6543/postgres')
    monkeypatch.setattr(db.psycopg, 'connect', fake_connect)

    db.open_connection()
    assert seen['connect_timeout'] == db.CONNECT_TIMEOUT_SECONDS
    assert db.CONNECT_TIMEOUT_SECONDS > 0

    seen.clear()
    with db.connect():
        pass
    assert seen['connect_timeout'] == db.CONNECT_TIMEOUT_SECONDS


def test_connect_closes_but_open_connection_leaves_it_to_the_caller(monkeypatch):
    conns = []

    def fake_connect(dsn, **kwargs):
        conns.append(FakeConn())
        return conns[-1]

    monkeypatch.setenv('DATABASE_URL', 'postgresql://u:p@pooler.example.com:6543/postgres')
    monkeypatch.setattr(db.psycopg, 'connect', fake_connect)

    with db.connect():
        pass
    assert conns[-1].closed is True

    held = db.open_connection()
    assert held.closed is False


# ── the heartbeat holds one connection instead of dialling every 2s ───────────
def test_flush_connection_dials_once_and_reuses_it(monkeypatch):
    dialled = []
    monkeypatch.setattr(db, 'open_connection', lambda: dialled.append(FakeConn()) or dialled[-1])

    holder = run_scrape._FlushConnection()
    assert holder.get() is holder.get() is dialled[0]
    assert len(dialled) == 1


def test_flush_connection_redials_after_a_drop_or_a_closed_connection(monkeypatch):
    dialled = []
    monkeypatch.setattr(db, 'open_connection', lambda: dialled.append(FakeConn()) or dialled[-1])

    holder = run_scrape._FlushConnection()
    first = holder.get()
    holder.drop()
    assert first.closed is True
    assert holder.get() is not first

    # A pooler that hangs up marks the connection closed; the next flush must redial.
    holder.get().closed = True
    assert holder.get() is dialled[-1]
    assert len(dialled) == 3


def test_dropping_a_connection_that_will_not_close_never_raises(monkeypatch):
    class Stubborn(FakeConn):
        def close(self):
            raise RuntimeError('socket already gone')

    monkeypatch.setattr(db, 'open_connection', Stubborn)
    holder = run_scrape._FlushConnection()
    holder.get()
    holder.drop()               # must not raise
    assert isinstance(holder.get(), Stubborn)


# ── a flush must never take the scrape down, and must not reuse a dead conn ───
def _progress():
    return {'current_domain': 'acme.com', 'domains_total': 3,
            'domains_done': 1, 'ads_found_so_far': 42}


def test_flush_survives_the_database_being_unreachable_and_drops_the_connection(monkeypatch):
    monkeypatch.setattr(db, 'open_connection', FakeConn)
    monkeypatch.setattr(db, 'update_progress',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('connection timeout expired')))

    logger = run_scrape.RunLogger()
    logger.add_line('a line that will be lost')
    holder = run_scrape._FlushConnection()
    held = holder.get()

    run_scrape._flush_once('run-1', logger, _progress(), holder)   # must not raise
    assert held.closed is True


def test_flush_bumps_the_heartbeat_even_when_the_log_insert_fails(monkeypatch):
    # Liveness outranks logs: a run whose log write fails must still read as alive,
    # or the dashboard calls a working run stalled all over again.
    beats = []
    monkeypatch.setattr(db, 'open_connection', FakeConn)
    monkeypatch.setattr(db, 'update_progress', lambda conn, run_id, **k: beats.append(k))
    monkeypatch.setattr(db, 'insert_run_logs',
                        lambda *a: (_ for _ in ()).throw(RuntimeError('log insert blew up')))

    logger = run_scrape.RunLogger()
    logger.add_line('some output')
    run_scrape._flush_once('run-1', logger, _progress(), run_scrape._FlushConnection())

    assert len(beats) == 1
    assert beats[0]['ads_found_so_far'] == 42


def test_flush_writes_progress_and_logs_on_the_same_held_connection(monkeypatch):
    used = []
    monkeypatch.setattr(db, 'open_connection', FakeConn)
    monkeypatch.setattr(db, 'update_progress', lambda conn, run_id, **k: used.append(conn))
    monkeypatch.setattr(db, 'insert_run_logs', lambda conn, run_id, rows: used.append(conn))

    logger = run_scrape.RunLogger()
    logger.add_line('some output')
    holder = run_scrape._FlushConnection()
    run_scrape._flush_once('run-1', logger, _progress(), holder)

    assert used == [holder.get(), holder.get()]


# ── end-of-run writes get retried rather than losing the run's work ───────────
async def test_a_write_that_works_first_time_is_not_retried(monkeypatch):
    calls = []
    monkeypatch.setattr(run_scrape, '_db_write_once', lambda write: calls.append(write))

    await run_scrape._db_write_with_retry('finish_run', 'the-write')
    assert calls == ['the-write']


async def test_a_transient_failure_is_retried_until_it_lands(monkeypatch):
    attempts = {'n': 0}

    def flaky(write):
        attempts['n'] += 1
        if attempts['n'] < 3:
            raise RuntimeError('connection timeout expired')

    monkeypatch.setattr(run_scrape, '_db_write_once', flaky)
    monkeypatch.setattr(asyncio, 'sleep', _no_sleep)

    await run_scrape._db_write_with_retry('finish_run', lambda conn: None)
    assert attempts['n'] == 3


async def test_the_last_error_is_raised_once_the_attempts_run_out(monkeypatch):
    attempts = {'n': 0}

    def always_down(write):
        attempts['n'] += 1
        raise RuntimeError('connection timeout expired')

    monkeypatch.setattr(run_scrape, '_db_write_once', always_down)
    monkeypatch.setattr(asyncio, 'sleep', _no_sleep)

    # Raising (rather than returning a flag) keeps run()'s control flow as it was:
    # a finish_run that truly cannot be written still marks the run failed.
    with pytest.raises(RuntimeError, match='connection timeout expired'):
        await run_scrape._db_write_with_retry('finish_run', lambda conn: None, attempts=4)
    assert attempts['n'] == 4


async def _no_sleep(_seconds):
    """Skip the backoff so the retry tests stay instant."""
    return None
