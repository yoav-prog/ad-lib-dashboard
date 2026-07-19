"""Review-queue routing: mismatched ads must be stored as pending (not fed to
the dashboard as approved), pending ads must not spend a ScrapingBee call on
their junk landing page, and the upsert must never overwrite a human's
approve/reject decision. (The one sanctioned status change on re-sighting is
the resurface path reopening rejected ads as pending - see test_resurface.py.)
"""

from contextlib import contextmanager

import pytest

import db
import run_scrape


OLD_START = 1_000_000_000   # 2001 - safely past the recency filter


def _ad(aid, link_url):
    return {'ad_archive_id': aid, 'start_date': OLD_START,
            'snapshot': {'link_url': link_url, 'body': {'text': 'copy'}}}


# ── scrape_query routes by destination ────────────────────────────────────────
async def test_scrape_query_routes_mismatches_to_review(fb, monkeypatch):
    ads = [_ad('real-1', 'https://castofnotes.com/article'),
           _ad('junk-1', 'https://www.temu.com/castofnotes.com-thing'),
           _ad('junk-2', 'https://api.whatsapp.com/send')]

    async def fake_fetch(params, max_retries, retry_delay):
        return ads

    seen = {}

    async def fake_process_ad(ad, rank, bucket, verticals, feed, domain,
                              gpt_session, review_status='approved'):
        seen[ad['ad_archive_id']] = review_status
        return {'ad_archive_id': ad['ad_archive_id'], 'review_status': review_status}

    upserted = []

    @contextmanager
    def fake_connect():
        yield object()

    monkeypatch.setattr(run_scrape.fb, 'fetch_facebook_ads_apify_with_resume', fake_fetch)
    monkeypatch.setattr(run_scrape, 'process_ad', fake_process_ad)
    monkeypatch.setattr(run_scrape.db, 'connect', fake_connect)
    monkeypatch.setattr(run_scrape.db, 'upsert_ads',
                        lambda conn, run_id, rows: (upserted.extend(rows), (len(rows), len(rows)))[1])

    params = {'query': 'castofnotes.com', 'country': 'ALL',
              'activeStatus': 'active', 'max_target_results': 10}
    found, new = await run_scrape.scrape_query(
        'run-id', None, [], set(), params, '', 'castofnotes.com', 1)

    assert seen == {'real-1': 'approved', 'junk-1': 'pending', 'junk-2': 'pending'}
    assert {r['ad_archive_id']: r['review_status'] for r in upserted} == seen
    assert (found, new) == (3, 3)


async def test_scrape_query_keyword_query_approves_everything(fb, monkeypatch):
    ads = [_ad('a1', 'https://anything.com/x')]

    async def fake_fetch(params, max_retries, retry_delay):
        return ads

    seen = {}

    async def fake_process_ad(ad, rank, bucket, verticals, feed, domain,
                              gpt_session, review_status='approved'):
        seen[ad['ad_archive_id']] = review_status
        return {'ad_archive_id': ad['ad_archive_id']}

    @contextmanager
    def fake_connect():
        yield object()

    monkeypatch.setattr(run_scrape.fb, 'fetch_facebook_ads_apify_with_resume', fake_fetch)
    monkeypatch.setattr(run_scrape, 'process_ad', fake_process_ad)
    monkeypatch.setattr(run_scrape.db, 'connect', fake_connect)
    monkeypatch.setattr(run_scrape.db, 'upsert_ads', lambda conn, run_id, rows: (1, 1))

    params = {'query': 'life insurance', 'country': 'ALL',
              'activeStatus': 'active', 'max_target_results': 10}
    await run_scrape.scrape_query('run-id', None, [], set(), params, '', 'life insurance', 1)

    assert seen == {'a1': 'approved'}


# ── pending ads skip the paid article scrape ──────────────────────────────────
@pytest.mark.parametrize('review_status,scrape_calls', [('approved', 1), ('pending', 0)])
async def test_article_scrape_only_for_approved(fb, monkeypatch, review_status, scrape_calls):
    calls = []

    async def fake_scrape_article(url):
        calls.append(url)
        return ('title', 'content', url)

    async def fake_gpt(*args, **kwargs):
        return ''

    monkeypatch.setattr(run_scrape.fb, 'scrape_article_async', fake_scrape_article)
    monkeypatch.setattr(run_scrape.fb, 'gpt_detect_language', fake_gpt)
    monkeypatch.setattr(run_scrape.fb, 'gpt_detect_country', fake_gpt)
    monkeypatch.setattr(run_scrape.fb, 'gpt_detect_vertical', fake_gpt)
    monkeypatch.setattr(run_scrape.fb, 'gpt_detect_brand', fake_gpt)

    row = await run_scrape.process_ad(
        _ad('x', 'https://example.com/page'), 1, None, [], '', 'example.com',
        None, review_status)

    assert len(calls) == scrape_calls
    assert row['review_status'] == review_status


# ── human decisions are permanent ─────────────────────────────────────────────
def test_review_status_is_inserted_but_never_updated():
    assert 'review_status' in db.AD_COLUMNS
    assert 'review_status' not in db._UPDATE_COLUMNS


def test_upsert_sql_does_not_touch_review_status_on_conflict():
    class Cur:
        sql = ''
        def execute(self, sql, params=None): Cur.sql = sql
        def fetchone(self): return {'inserted': True}
        def __enter__(self): return self
        def __exit__(self, *exc): return False

    class Conn:
        def cursor(self): return Cur()

    db.upsert_ads(Conn(), 'run-id', [{'ad_archive_id': 'a', 'review_status': 'pending'}])
    set_clause = Cur.sql.split('do update')[1]
    assert 'review_status = excluded.review_status' not in set_clause
