"""Actor-log noise controls: the dashboard's log console must show the Apify
actor's stream as readable gray progress, not a wall of red error lines full of
ANSI escape garbage - and a dead log-forwarding thread must produce one calm
line, not a traceback.
"""

import io
import logging
import sys
import threading

import db
import run_scrape
from tests.test_db_helpers import FakeConn


# ── strip_ansi + the DB write boundary ────────────────────────────────────────
def test_strip_ansi_removes_color_codes():
    raw = '\x1b[36m[apify.scraper runId:abc]\x1b[0m -> \x1b[32mINFO\x1b[39m ok'
    assert db.strip_ansi(raw) == '[apify.scraper runId:abc] -> INFO ok'


def test_strip_ansi_leaves_plain_text_untouched():
    assert db.strip_ansi('plain line, no escapes') == 'plain line, no escapes'
    assert db.strip_ansi('') == ''


def test_insert_run_logs_stores_clean_text():
    conn = FakeConn()
    conn.cur.executemany = lambda sql, values: conn.cur.calls.append((sql, values))
    db.insert_run_logs(conn, 'run-id', [('ts', 'info', '\x1b[33mhello\x1b[0m')])

    _, values = conn.cur.calls[0]
    assert values == [('run-id', 'ts', 'info', 'hello')]


# ── the actor redirect logger (scraper) ───────────────────────────────────────
def _emit(fb, level, message):
    fb._get_actor_logger().log(level, message)


def test_actor_logger_routes_info_to_stdout_and_errors_to_stderr(fb, monkeypatch):
    out, err = io.StringIO(), io.StringIO()
    monkeypatch.setattr(sys, 'stdout', out)
    monkeypatch.setattr(sys, 'stderr', err)

    _emit(fb, logging.INFO, 'routine progress')
    _emit(fb, logging.ERROR, 'something broke')

    assert out.getvalue() == '[apify] routine progress\n'
    assert err.getvalue() == '[apify] something broke\n'


def test_actor_logger_binds_streams_per_record_not_at_creation(fb, monkeypatch):
    """run_scrape swaps sys.stdout for its tee AFTER the scraper is loaded, so
    the handler must resolve the stream when each record is emitted."""
    first, second = io.StringIO(), io.StringIO()
    monkeypatch.setattr(sys, 'stdout', first)
    _emit(fb, logging.INFO, 'one')
    monkeypatch.setattr(sys, 'stdout', second)
    _emit(fb, logging.INFO, 'two')

    assert first.getvalue() == '[apify] one\n'
    assert second.getvalue() == '[apify] two\n'


def test_actor_logger_never_duplicates_lines(fb, monkeypatch):
    """Repeated _get_actor_logger() calls (one per Apify fetch) must never
    stack handlers - one emitted record is exactly one output line. The
    contract is line count, NOT the handler list: CI showed pytest's own
    LogCaptureHandler instrumentation attached to this logger, so asserting
    internals fails on environment differences the code does not control."""
    logger = fb._get_actor_logger()
    fb._get_actor_logger()
    fb._get_actor_logger()

    out = io.StringIO()
    monkeypatch.setattr(sys, 'stdout', out)
    _emit(fb, logging.INFO, 'once only')

    assert out.getvalue() == '[apify] once only\n'
    assert logger.propagate is False


# ── the thread excepthook (run_scrape) ────────────────────────────────────────
class _HookArgs:
    def __init__(self, thread_name, exc_type=TimeoutError):
        self.thread = threading.Thread(name=thread_name)
        self.exc_type = exc_type
        self.exc_value = exc_type('boom')
        self.exc_traceback = None


def test_stream_log_thread_crash_prints_one_calm_line(monkeypatch, capsys):
    seen = []
    monkeypatch.setattr(threading, 'excepthook', seen.append)
    run_scrape._install_thread_excepthook()

    threading.excepthook(_HookArgs('Thread-3 (_stream_log)'))

    out = capsys.readouterr().out
    assert 'actor-log stream dropped (TimeoutError)' in out
    assert 'Traceback' not in out
    assert seen == []   # the default hook was NOT invoked for this thread


def test_other_thread_crashes_keep_the_default_hook(monkeypatch, capsys):
    seen = []
    monkeypatch.setattr(threading, 'excepthook', seen.append)
    run_scrape._install_thread_excepthook()

    args = _HookArgs('Thread-7 (worker)')
    threading.excepthook(args)

    assert seen == [args]                     # delegated to the default hook
    assert capsys.readouterr().out == ''      # and printed nothing itself
