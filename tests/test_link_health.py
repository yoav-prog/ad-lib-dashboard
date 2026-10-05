"""The dead-link rule (link_health.py) and the job's queue shaping (check_links.py).

Calling a live page dead hides a real ad from anyone using HIDE DEAD, so the rule
is pinned narrow here: only 404 and 410, never a bot wall, rate limit, server
error or silence.
"""

import check_links
import link_health


# ── is_dead: only a definitive "page does not exist" ─────────────────────────
def test_404_and_410_are_dead():
    assert link_health.is_dead(404)
    assert link_health.is_dead(410)


def test_bot_walls_errors_and_silence_are_never_dead():
    # 202 is the challenge page several competitor CMSs serve, 403 Cloudflare's wall.
    for status in (None, 200, 202, 301, 400, 401, 403, 429, 500, 502, 503):
        assert not link_health.is_dead(status), status


# ── is_conclusive: what can wait a week vs. what gets asked again tomorrow ────
def test_opens_and_dead_are_conclusive():
    for status in (200, 404, 410):
        assert link_health.is_conclusive(status), status


def test_walls_limits_errors_and_silence_are_inconclusive():
    # 202 is the challenge page served in place of the article; a final 3xx is a
    # redirect that never landed anywhere.
    for status in (None, 202, 204, 301, 302, 403, 406, 421, 429, 500, 503):
        assert not link_health.is_conclusive(status), status


def test_slow_down_answers_are_retried_and_never_dead():
    for status in link_health.RETRY_STATUSES:
        assert not link_health.is_dead(status)
        assert not link_health.is_conclusive(status)


# ── first_url / checkable ─────────────────────────────────────────────────────
def test_first_url_takes_the_first_dco_destination():
    assert link_health.first_url('https://a.com/x | https://b.com/y') == 'https://a.com/x'
    assert link_health.first_url('  https://a.com/x  ') == 'https://a.com/x'
    assert link_health.first_url(None) == ''


def test_only_absolute_http_urls_are_checkable():
    assert link_health.checkable('https://www.hometalk.com/dcg/1/slug?cid=1&adid={{ad.id}}')
    assert link_health.checkable('http://example.com')
    for bad in ('', 'example.com/path', 'fb://page/123', 'https://', 'mailto:x@y.com'):
        assert not link_health.checkable(bad), bad


def test_host_of_drops_www_and_case():
    assert link_health.host_of('https://WWW.Hometalk.com/dcg/1') == 'hometalk.com'
    assert link_health.host_of('not a url') == ''


# ── group_by_url: one request per distinct link ───────────────────────────────
def test_group_by_url_shares_one_request_and_drops_unusable_rows():
    rows = [
        {'ad_archive_id': '1', 'link_url': 'https://a.com/x | https://b.com/y'},
        {'ad_archive_id': '2', 'link_url': 'https://a.com/x'},
        {'ad_archive_id': '3', 'link_url': 'https://c.com/z'},
        {'ad_archive_id': '4', 'link_url': 'c.com/no-scheme'},
        {'ad_archive_id': '5', 'link_url': None},
    ]
    assert link_health.group_by_url(rows) == {
        'https://a.com/x': ['1', '2'],
        'https://c.com/z': ['3'],
    }


def test_group_by_url_keeps_query_order():
    rows = [{'ad_archive_id': str(i), 'link_url': f'https://s.com/{i}'} for i in (3, 1, 2)]
    assert list(link_health.group_by_url(rows)) == ['https://s.com/3', 'https://s.com/1', 'https://s.com/2']


# ── interleave_by_host: one big site cannot starve the rest ───────────────────
def test_interleave_round_robins_hosts_and_keeps_each_hosts_order():
    urls = ['https://big.com/1', 'https://big.com/2', 'https://big.com/3',
            'https://small.com/1', 'https://www.big.com/4']
    assert check_links.interleave_by_host(urls) == [
        'https://big.com/1', 'https://small.com/1',
        'https://big.com/2', 'https://big.com/3', 'https://www.big.com/4',
    ]


def test_interleave_keeps_every_url_exactly_once():
    urls = [f'https://h{i % 3}.com/{i}' for i in range(10)]
    out = check_links.interleave_by_host(urls)
    assert sorted(out) == sorted(urls)
    assert check_links.interleave_by_host([]) == []


# ── fetch_status: silence is None, never a status ─────────────────────────────
class _Resp:
    def __init__(self, status):
        self.status_code = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Session:
    def __init__(self, result):
        self.result = result
        self.kwargs = None

    def get(self, url, **kwargs):
        self.kwargs = kwargs
        if isinstance(self.result, Exception):
            raise self.result
        return _Resp(self.result)


def test_fetch_status_returns_the_final_status_with_a_real_timeout():
    s = _Session(404)
    assert check_links.fetch_status(s, 'https://a.com/x') == 404
    # A real socket timeout must reach requests, or a tarpit host hangs the run.
    assert s.kwargs['timeout'] == check_links.HTTP_TIMEOUT
    assert s.kwargs['allow_redirects'] is True
    assert s.kwargs['stream'] is True


def test_fetch_status_maps_network_failures_to_none():
    import requests
    for exc in (requests.Timeout(), requests.ConnectionError(), requests.TooManyRedirects()):
        assert check_links.fetch_status(_Session(exc), 'https://a.com/x') is None


# ── the paid fallback for challenge pages ─────────────────────────────────────
def test_only_the_challenge_status_goes_to_scrapingbee():
    assert link_health.CHALLENGE_STATUSES == frozenset({202})
    # A challenge is never a verdict on its own.
    for status in link_health.CHALLENGE_STATUSES:
        assert not link_health.is_dead(status)
        assert not link_health.is_conclusive(status)


class _SpbResp:
    def __init__(self, status, headers):
        self.status_code = status
        self.headers = headers


class _SpbClient:
    def __init__(self, result):
        self.result = result
        self.kwargs = None

    def get(self, url, **kwargs):
        self.kwargs = kwargs
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def test_spb_mode_renders_challenges_and_proxies_blocks():
    assert link_health.spb_mode(202) == 'js'
    for status in (None, 406, 429, 503):
        assert link_health.spb_mode(status) == 'plain', status
    # A settled answer, or one ScrapingBee cannot improve, is never paid for.
    for status in (200, 404, 410, 301, 400, 403, 500):
        assert link_health.spb_mode(status) is None, status


def test_spb_status_reports_the_targets_status_with_a_real_timeout():
    client = _SpbClient(_SpbResp(404, {'Spb-Initial-Status-Code': '404', 'Spb-Cost': '5'}))
    assert check_links.spb_status(client, 'https://a.com/x', 'js') == 404
    # JS rendering solves the challenge; a real socket timeout keeps a stalled render
    # from hanging the worker (the `timeout` in params is ScrapingBee's, not ours).
    assert client.kwargs['params']['render_js'] is True
    assert client.kwargs['timeout'] == check_links.SPB_TIMEOUT
    redirected = _SpbClient(_SpbResp(200, {'Spb-Initial-Status-Code': '301'}))
    assert check_links.spb_status(redirected, 'https://a.com/', 'js') == 200


def test_spb_status_plain_mode_skips_the_render():
    client = _SpbClient(_SpbResp(404, {'Spb-Initial-Status-Code': '404', 'Spb-Cost': '1'}))
    assert check_links.spb_status(client, 'https://a.com/x', 'plain') == 404
    assert client.kwargs['params']['render_js'] is False
    assert check_links.SPB_CREDITS == {'js': 5, 'plain': 1}


def test_spb_status_never_mistakes_scrapingbees_own_failure_for_the_page():
    # No Spb-Initial-Status-Code: ScrapingBee's own error (bad key, no credits,
    # render failed). A 404 or 500 from them says nothing about the page.
    for status in (401, 404, 429, 500):
        assert check_links.spb_status(_SpbClient(_SpbResp(status, {})), 'https://a.com/x', 'js') is None
    assert check_links.spb_status(_SpbClient(TimeoutError()), 'https://a.com/x', 'plain') is None


# ── a re-scrape with a new link_url drops the old link's status ───────────────
def test_upsert_clears_the_link_check_only_when_the_link_changes():
    import db

    class Cur:
        sql = ''
        def execute(self, sql, params=None): Cur.sql = sql
        def fetchone(self): return {'inserted': True}
        def __enter__(self): return self
        def __exit__(self, *exc): return False

    class Conn:
        def cursor(self): return Cur()

    db.upsert_ads(Conn(), 'run-id', [{'ad_archive_id': 'a', 'link_url': 'https://a.com/x'}])
    set_clause = ' '.join(Cur.sql.split('do update')[1].split())
    # The status described the OLD link; keep it only while the link is unchanged.
    assert ('link_status = case when ads.link_url is distinct from excluded.link_url '
            'then null else ads.link_status end') in set_clause
    assert ('link_checked_at = case when ads.link_url is distinct from excluded.link_url '
            'then null else ads.link_checked_at end') in set_clause
    # Never written from a scrape row directly.
    assert 'link_status' not in db.AD_COLUMNS
