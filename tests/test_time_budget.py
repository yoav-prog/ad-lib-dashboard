"""The soft time budget: a run must stop starting new domains at the deadline,
hand the rest back as deferred, and never abandon a domain midway. This is what
replaced the workflow's 60-minute hard kill, which failed runs mid-scrape and
hid every ad they had captured behind a 'failed' status.
"""

from contextlib import contextmanager

import pytest

import run_scrape
from run_scrape import (DEFAULT_TIME_BUDGET_MINUTES, _scrape_domain_rows,
                        _time_budget_minutes)


def _row(i):
    return {'id': f'id-{i}', 'query': f'domain{i}.com', 'country': 'ALL',
            'active_status': 'active', 'max_ads': 10, 'interval_days': 3,
            'feed': ''}


def _progress():
    return {'current_domain': None, 'domains_total': 0,
            'domains_done': 0, 'ads_found_so_far': 0}


@pytest.fixture
def bumped(monkeypatch):
    """Stub the DB layer: no real connections, schedule bumps recorded."""
    calls = []

    @contextmanager
    def fake_connect():
        yield object()

    monkeypatch.setattr(run_scrape.db, 'connect', fake_connect)
    monkeypatch.setattr(run_scrape.db, 'bump_domain_schedule',
                        lambda conn, domain_id, days: calls.append(domain_id))
    return calls


@pytest.fixture
def scraped(monkeypatch):
    """Stub scrape_query: record the domain, report (found=2, new=1)."""
    calls = []

    async def fake_scrape_query(run_id, bucket, verticals, existing_ids,
                                params, feed, domain, retries, progress=None):
        calls.append(domain)
        return (2, 1)

    monkeypatch.setattr(run_scrape, 'scrape_query', fake_scrape_query)
    return calls


# ── _scrape_domain_rows ───────────────────────────────────────────────────────
async def test_ample_budget_processes_every_row(bumped, scraped):
    rows = [_row(0), _row(1), _row(2)]
    progress = _progress()
    found, new, deferred = await _scrape_domain_rows(
        'run-id', None, [], set(), rows, 1, progress,
        deadline=1_000_000, clock=lambda: 0)

    assert (found, new) == (6, 3)
    assert deferred == []
    assert scraped == ['domain0.com', 'domain1.com', 'domain2.com']
    assert bumped == ['id-0', 'id-1', 'id-2']
    assert progress['domains_done'] == 3


async def test_expired_budget_defers_everything(bumped, scraped):
    rows = [_row(0), _row(1)]
    found, new, deferred = await _scrape_domain_rows(
        'run-id', None, [], set(), rows, 1, _progress(),
        deadline=0, clock=lambda: 1)

    assert (found, new) == (0, 0)
    assert deferred == rows
    assert scraped == []
    assert bumped == []


async def test_budget_expiring_midway_defers_the_rest(bumped, monkeypatch):
    """Each scrape advances a fake clock by 100; with deadline 150 the third
    row must be deferred, and only processed rows get schedule bumps."""
    clock = {'t': 0.0}
    domains = []

    async def slow_scrape_query(run_id, bucket, verticals, existing_ids,
                                params, feed, domain, retries, progress=None):
        domains.append(domain)
        clock['t'] += 100
        return (2, 1)

    monkeypatch.setattr(run_scrape, 'scrape_query', slow_scrape_query)
    rows = [_row(0), _row(1), _row(2)]
    found, new, deferred = await _scrape_domain_rows(
        'run-id', None, [], set(), rows, 1, _progress(),
        deadline=150, clock=lambda: clock['t'])

    assert domains == ['domain0.com', 'domain1.com']
    assert deferred == [rows[2]]
    assert (found, new) == (4, 2)
    assert bumped == ['id-0', 'id-1']


# ── _time_budget_minutes ──────────────────────────────────────────────────────
def test_budget_defaults_when_unset(monkeypatch):
    monkeypatch.delenv('RUN_TIME_BUDGET_MINUTES', raising=False)
    assert _time_budget_minutes() == DEFAULT_TIME_BUDGET_MINUTES


def test_budget_reads_the_env_override(monkeypatch):
    monkeypatch.setenv('RUN_TIME_BUDGET_MINUTES', '75')
    assert _time_budget_minutes() == 75.0


@pytest.mark.parametrize('bad', ['', 'soon', '0', '-10'])
def test_budget_falls_back_on_bad_values(monkeypatch, bad):
    monkeypatch.setenv('RUN_TIME_BUDGET_MINUTES', bad)
    assert _time_budget_minutes() == DEFAULT_TIME_BUDGET_MINUTES
