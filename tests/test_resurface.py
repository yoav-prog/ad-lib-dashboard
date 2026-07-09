"""Re-surfacing: ads the scraper already has stored must be cheaply re-touched
on every re-sighting (no enrichment spend) so they re-enter the fresh window,
rejected ads reopen as pending, and the run's found counter includes them.
"""

from contextlib import contextmanager

import db
import run_scrape


OLD_START = 1_000_000_000   # 2001 - safely past the recency filter
NEW_START = 4_000_000_000   # 2096 - safely inside the recency filter


def _ad(aid, link_url, start=OLD_START):
    return {'ad_archive_id': aid, 'start_date': start,
            'snapshot': {'link_url': link_url, 'body': {'text': 'copy'}}}


@contextmanager
def _fake_connect():
    yield object()


# ── scrape_query splits known ads onto the cheap path ─────────────────────────
async def test_scrape_query_resurfaces_known_ads(fb, monkeypatch):
    ads = [_ad('new-1', 'https://castofnotes.com/a'),
           _ad('known-match', 'https://castofnotes.com/b'),
           _ad('known-junk', 'https://www.temu.com/x')]

    async def fake_fetch(params, max_retries, retry_delay):
        return ads

    processed = []

    async def fake_process_ad(ad, rank, bucket, verticals, feed, domain,
                              gpt_session, review_status='approved'):
        processed.append(ad['ad_archive_id'])
        return {'ad_archive_id': ad['ad_archive_id'], 'review_status': review_status}

    resurface_calls = []

    def fake_resurface(conn, run_id, ad_ids, domain=None):
        resurface_calls.append((run_id, list(ad_ids), domain))
        return (len(ad_ids), 0)

    monkeypatch.setattr(run_scrape.fb, 'fetch_facebook_ads_apify_with_resume', fake_fetch)
    monkeypatch.setattr(run_scrape, 'process_ad', fake_process_ad)
    monkeypatch.setattr(run_scrape.db, 'connect', _fake_connect)
    monkeypatch.setattr(run_scrape.db, 'resurface_ads', fake_resurface)
    monkeypatch.setattr(run_scrape.db, 'upsert_ads', lambda conn, run_id, rows: (len(rows), len(rows)))

    params = {'query': 'castofnotes.com', 'country': 'ALL',
              'activeStatus': 'active', 'max_target_results': 10}
    progress = {'ads_found_so_far': 0}
    found, new = await run_scrape.scrape_query(
        'run-id', None, [], {'known-match', 'known-junk'}, params, '',
        'castofnotes.com', 1, progress)

    # Only the never-seen ad pays for enrichment.
    assert processed == ['new-1']
    # Matching known ads get the domain re-stamp; junk keeps its stored row.
    assert resurface_calls == [('run-id', ['known-match'], 'castofnotes.com'),
                               ('run-id', ['known-junk'], None)]
    # found = 2 re-surfaced + 1 upserted; new counts fresh inserts only.
    assert (found, new) == (3, 1)
    assert progress['ads_found_so_far'] == 3


async def test_scrape_query_all_known_short_circuits(fb, monkeypatch):
    ads = [_ad('known-1', 'https://castofnotes.com/a')]

    async def fake_fetch(params, max_retries, retry_delay):
        return ads

    async def fail_process_ad(*args, **kwargs):
        raise AssertionError('known ads must never reach process_ad')

    monkeypatch.setattr(run_scrape.fb, 'fetch_facebook_ads_apify_with_resume', fake_fetch)
    monkeypatch.setattr(run_scrape, 'process_ad', fail_process_ad)
    monkeypatch.setattr(run_scrape.db, 'connect', _fake_connect)
    monkeypatch.setattr(run_scrape.db, 'resurface_ads',
                        lambda conn, run_id, ad_ids, domain=None: (len(ad_ids), 0))

    params = {'query': 'castofnotes.com', 'country': 'ALL',
              'activeStatus': 'active', 'max_target_results': 10}
    found, new = await run_scrape.scrape_query(
        'run-id', None, [], {'known-1'}, params, '', 'castofnotes.com', 1)

    assert (found, new) == (1, 0)


async def test_week_filter_applies_to_known_ads_too(fb, monkeypatch):
    ads = [_ad('known-too-new', 'https://castofnotes.com/a', start=NEW_START)]

    async def fake_fetch(params, max_retries, retry_delay):
        return ads

    def fail_resurface(conn, run_id, ad_ids, domain=None):
        raise AssertionError('too-new ads must not be re-surfaced')

    monkeypatch.setattr(run_scrape.fb, 'fetch_facebook_ads_apify_with_resume', fake_fetch)
    monkeypatch.setattr(run_scrape.db, 'connect', _fake_connect)
    monkeypatch.setattr(run_scrape.db, 'resurface_ads', fail_resurface)

    params = {'query': 'castofnotes.com', 'country': 'ALL',
              'activeStatus': 'active', 'max_target_results': 10}
    found, new = await run_scrape.scrape_query(
        'run-id', None, [], {'known-too-new'}, params, '', 'castofnotes.com', 1)

    assert (found, new) == (0, 0)


# ── resurface_ads SQL semantics ───────────────────────────────────────────────
class _Cur:
    def __init__(self, rows):
        self.rows = rows
        self.sql = ''
        self.params = None
        self.calls = 0

    def execute(self, sql, params=None):
        self.sql = sql
        self.params = params
        self.calls += 1

    def fetchall(self):
        return self.rows

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Conn:
    def __init__(self, rows):
        self.cur = _Cur(rows)

    def cursor(self):
        return self.cur


def test_resurface_reopens_only_rejected():
    conn = _Conn([{'old_status': 'rejected'}, {'old_status': 'approved'},
                  {'old_status': 'pending'}])
    touched, reopened = db.resurface_ads(conn, 'run-id', ['a', 'b', 'c'])
    assert (touched, reopened) == (3, 1)
    # The one allowed transition is rejected -> pending; approved/pending rows
    # keep their status (no blanket overwrite of a human decision).
    assert "when a.review_status = 'rejected'" in conn.cur.sql
    assert 'last_seen_at' in conn.cur.sql and 'last_run_id' in conn.cur.sql


def test_resurface_restamps_domain_only_when_given():
    with_domain = _Conn([{'old_status': 'approved'}])
    db.resurface_ads(with_domain, 'run-id', ['a'], domain='castofnotes.com')
    assert 'domain = %s,' in with_domain.cur.sql
    assert with_domain.cur.params[0] == 'castofnotes.com'

    without_domain = _Conn([{'old_status': 'approved'}])
    db.resurface_ads(without_domain, 'run-id', ['a'])
    assert 'domain = %s,' not in without_domain.cur.sql
    assert without_domain.cur.params == ['run-id', ['a']]


def test_resurface_empty_ids_is_a_noop():
    conn = _Conn([])
    assert db.resurface_ads(conn, 'run-id', []) == (0, 0)
    assert conn.cur.calls == 0
