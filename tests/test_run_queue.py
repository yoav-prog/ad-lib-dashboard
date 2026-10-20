"""The dashboard's "Run selected" during a live run: the running job takes the
requested rows next, right after the domain it is on, then carries on with its own
list. Before this the button was locked for the whole run (up to 45 minutes), and
the only way to get a few rows scraped was STOP, RUN, and wait an hour for the big
run to resume.
"""

from contextlib import contextmanager

import pytest

import run_scrape
from run_scrape import _scrape_domain_rows


def _row(name):
    return {'id': f'id-{name}', 'query': f'{name}.com', 'country': 'ALL',
            'active_status': 'active', 'max_ads': 10, 'interval_days': 3,
            'feed': ''}


def _progress(total):
    return {'current_domain': None, 'domains_total': total,
            'domains_done': 0, 'ads_found_so_far': 0}


def _requests(*batches):
    """A take_requested stub: each call hands out the next waiting request. A batch
    becomes visible only once the runner has asked `after` times, which models a
    click that lands mid-run."""
    waiting, calls = [], {'n': 0}

    def take():
        calls['n'] += 1
        for after, rows in batches:
            if calls['n'] == after:
                waiting.extend(rows)
        return waiting.pop(0) if waiting else None
    return take


@pytest.fixture
def bumped(monkeypatch):
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
    calls = []

    async def fake_scrape_query(run_id, bucket, verticals, existing_ids,
                                params, feed, domain, retries, progress=None):
        calls.append(domain)
        return (2, 1)

    monkeypatch.setattr(run_scrape, 'scrape_query', fake_scrape_query)
    return calls


async def _run(rows, take, progress, deadline=1_000_000, clock=lambda: 0):
    return await _scrape_domain_rows('run-id', None, [], set(), rows, 1, progress,
                                     deadline=deadline, clock=clock, take_requested=take)


# ── requests jump the line ────────────────────────────────────────────────────
async def test_a_request_runs_right_after_the_current_domain(bumped, scraped):
    # The click lands while big1 is scraping (the 2nd check), so x runs next.
    rows = [_row('big1'), _row('big2'), _row('big3')]
    progress = _progress(3)
    await _run(rows, _requests((2, [_row('x')])), progress)

    assert scraped == ['big1.com', 'x.com', 'big2.com', 'big3.com']
    assert bumped == ['id-big1', 'id-x', 'id-big2', 'id-big3']
    assert progress['domains_total'] == 4
    assert progress['domains_done'] == 4


async def test_several_requests_run_in_order_before_the_list_continues(bumped, scraped):
    rows = [_row('big1'), _row('big2')]
    await _run(rows, _requests((2, [_row('a'), _row('b'), _row('c')])), _progress(2))

    assert scraped == ['big1.com', 'a.com', 'b.com', 'c.com', 'big2.com']


async def test_a_requested_row_already_in_the_list_is_not_scraped_twice(bumped, scraped):
    rows = [_row('big1'), _row('big2'), _row('big3')]
    progress = _progress(3)
    await _run(rows, _requests((2, [_row('big3')])), progress)

    assert scraped == ['big1.com', 'big3.com', 'big2.com']
    assert progress['domains_total'] == 3   # moved up, not added


async def test_a_request_with_an_empty_list_still_runs(bumped, scraped):
    # A sweep that started with nothing due but finds a waiting request.
    progress = _progress(0)
    found, new, deferred = await _run([], _requests((1, [_row('x')])), progress)

    assert scraped == ['x.com']
    assert (found, new, deferred) == (2, 1, [])
    assert progress['domains_total'] == 1


async def test_no_requests_keeps_the_list_order(bumped, scraped):
    rows = [_row('a'), _row('b')]
    await _run(rows, lambda: None, _progress(2))

    assert scraped == ['a.com', 'b.com']


# ── the time budget ───────────────────────────────────────────────────────────
async def test_the_deadline_leaves_unclaimed_requests_for_the_next_run(bumped, monkeypatch):
    # Each scrape costs 100; the deadline stops the run after two domains. The
    # request was never taken, so it must stay flagged (not taken = not cleared).
    clock = {'t': 0.0}
    domains = []

    async def slow_scrape_query(run_id, bucket, verticals, existing_ids,
                                params, feed, domain, retries, progress=None):
        domains.append(domain)
        clock['t'] += 100
        return (2, 1)

    monkeypatch.setattr(run_scrape, 'scrape_query', slow_scrape_query)

    def take():
        if len(domains) == 2:
            pytest.fail('a request must not be taken after the deadline')
        return None

    rows = [_row('a'), _row('b'), _row('c')]
    found, new, deferred = await _run(rows, take, _progress(3),
                                      deadline=150, clock=lambda: clock['t'])

    assert domains == ['a.com', 'b.com']
    assert deferred == [rows[2]]


# ── the request reader fails open ─────────────────────────────────────────────
async def test_a_failing_request_read_does_not_stop_the_run(bumped, scraped, monkeypatch, capsys):
    def boom(conn):
        raise RuntimeError('pooler hiccup')

    monkeypatch.setattr(run_scrape.db, 'take_next_requested_domain', boom)
    rows = [_row('a'), _row('b')]
    await _scrape_domain_rows('run-id', None, [], set(), rows, 1, _progress(2),
                              deadline=1_000_000, clock=lambda: 0)

    assert scraped == ['a.com', 'b.com']
    assert '[run queue] could not read run requests' in capsys.readouterr().out
