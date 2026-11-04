"""Where an ad's link lands (landing.py), and the two callers that rely on it.

Bug #311: ads that link through a click tracker could not be matched to their
TONIC RSOC campaign, because when ScrapingBee failed the scraper stored the
tracker itself as the landing page. These tests pin the rule that replaced it: a
landing is found by walking redirects, '' means unknown, and a tracker is never
passed off as its own landing - not by the walk, not by the scraper, not by the
backfill.
"""

import requests

import backfill_resolved_url as backfill
import landing

TRACKER = 'https://qcviwxfqmc.com/17?sc=hYwyvdbJ&subid1={{campaign.id}}&ad_id={{ad.id}}'
ARTICLE = 'https://talkglimpse.com/it/articles/guida-al-mini-prestito?dest=a200&network=facebook'


# ── Fakes ─────────────────────────────────────────────────────────────────────
class FakeResponse:
    def __init__(self, status, location=None):
        self.status_code = status
        self.headers = {'Location': location} if location else {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeSession:
    """Answers each URL from a script: (status, location) or an exception to raise.
    Records every request, so a test can prove which sites were never asked."""

    def __init__(self, script):
        self.script = script
        self.asked = []

    def get(self, url, **kwargs):
        self.asked.append(url)
        assert kwargs['allow_redirects'] is False and kwargs['timeout'], 'must walk by hand, with a timeout'
        answer = self.script[url]
        if isinstance(answer, Exception):
            raise answer
        return FakeResponse(*answer)


# ── resolve_landing ───────────────────────────────────────────────────────────
def test_one_hop_tracker_resolves_to_the_article():
    s = FakeSession({TRACKER: (302, ARTICLE), ARTICLE: (200,)})
    assert landing.resolve_landing(TRACKER, session=s) == ARTICLE


def test_stop_site_never_asks_the_ads_own_site():
    s = FakeSession({TRACKER: (307, ARTICLE)})
    assert landing.resolve_landing(TRACKER, session=s, stop_site='talkglimpse.com') == ARTICLE
    assert s.asked == [TRACKER]


def test_a_rate_limited_article_is_still_where_the_link_lands():
    s = FakeSession({TRACKER: (302, ARTICLE), ARTICLE: (429,)})
    assert landing.resolve_landing(TRACKER, session=s) == ARTICLE


def test_relative_location_resolves_against_the_current_hop():
    s = FakeSession({'https://t.com/a': (302, '/b?x=1'), 'https://t.com/b?x=1': (301, ARTICLE), ARTICLE: (200,)})
    assert landing.resolve_landing('https://t.com/a', session=s) == ARTICLE


def test_a_first_hop_that_gets_no_answer_is_unknown_never_the_tracker():
    for answer in (requests.ConnectionError('refused'), requests.Timeout('slow'), (403,), (429,), (500,), (302,)):
        s = FakeSession({TRACKER: answer})
        assert landing.resolve_landing(TRACKER, session=s) == '', answer


def test_a_link_that_answers_without_redirecting_lands_on_itself():
    s = FakeSession({ARTICLE: (200,)})
    assert landing.resolve_landing(ARTICLE, session=s) == ARTICLE


def test_a_chain_that_dies_midway_keeps_the_furthest_url_reached():
    s = FakeSession({TRACKER: (302, ARTICLE), ARTICLE: requests.Timeout('slow')})
    assert landing.resolve_landing(TRACKER, session=s) == ARTICLE


def test_a_non_http_location_is_never_followed():
    s = FakeSession({TRACKER: (302, 'fb://page/123')})
    assert landing.resolve_landing(TRACKER, session=s) == ''
    s = FakeSession({TRACKER: (302, ARTICLE), ARTICLE: (302, 'intent://open')})
    assert landing.resolve_landing(TRACKER, session=s) == ARTICLE


def test_a_redirect_loop_stops_after_max_hops():
    s = FakeSession({'https://t.com/a': (302, 'https://t.com/b'), 'https://t.com/b': (302, 'https://t.com/a')})
    assert landing.resolve_landing('https://t.com/a', session=s) in ('https://t.com/a', 'https://t.com/b')
    assert len(s.asked) == landing.MAX_HOPS


def test_non_urls_are_unknown_without_a_request():
    s = FakeSession({})
    for value in ('', None, 'facebook://x', 'talkglimpse.com/it/articles/x'):
        assert landing.resolve_landing(value, session=s) == ''
    assert s.asked == []


def test_site_of_reads_a_tracked_query_as_a_bare_domain():
    assert landing.site_of('intuitionlink.com') == 'intuitionlink.com'
    assert landing.site_of('https://www.Foo.com/path?q=1') == 'foo.com'
    assert landing.site_of('solar panels') == ''
    assert landing.site_of('') == ''
    assert landing.site_of(None) == ''


def test_on_site_counts_subdomains_but_not_lookalikes():
    assert landing.on_site('https://talkglimpse.com/x', 'talkglimpse.com')
    assert landing.on_site('https://go.talkglimpse.com/x', 'talkglimpse.com')
    assert not landing.on_site('https://nottalkglimpse.com/x', 'talkglimpse.com')
    assert not landing.on_site('https://talkglimpse.com/x', '')


# ── backfill_resolved_url: which rows need work, and what counts as an answer ──
def test_a_link_on_the_ads_own_site_is_its_own_landing():
    assert backfill.link_kind(ARTICLE, 'talkglimpse.com') == 'own'
    assert backfill.link_kind(TRACKER, 'talkglimpse.com') == 'redirect'
    assert backfill.link_kind(ARTICLE, '') == 'redirect'   # a keyword query owns no site


def test_predicto_kinds_are_unchanged_by_the_own_site_rule():
    # A bare /asrsearch is dead and a phrase-carrying link is direct, even on the ad's own site.
    assert backfill.link_kind('https://funniesnow.com/asrsearch', 'funniesnow.com') == 'dead'
    assert backfill.link_kind('https://funniesnow.com/asrsearch?search=cheap+flights', 'funniesnow.com') == 'direct'


def test_a_tracker_stored_as_its_own_landing_is_stuck():
    echoed = 'https://qcviwxfqmc.com/17?sc=hYwyvdbJ&subid1=%7B%7Bcampaign.id%7D%7D&ad_id=%7B%7Bad.id%7D%7D'
    assert backfill.stuck_on_tracker(TRACKER, echoed)       # re-encoded macros, same host + path
    assert not backfill.stuck_on_tracker(TRACKER, ARTICLE)
    assert not backfill.stuck_on_tracker(TRACKER, '')
    # A redirect to another path on the same host is progress, not an echo (Predicto's own-host hops).
    assert not backfill.stuck_on_tracker('https://t.com/r?x=1', 'https://t.com/asrsearch?search=x')


def test_resolve_pays_scrapingbee_only_when_the_free_walk_gets_no_answer(monkeypatch):
    monkeypatch.setattr(backfill, 'resolve_landing', lambda url, stop_site='': ARTICLE)
    monkeypatch.setattr(backfill, 'resolve_via_scrapingbee', lambda client, url: 'https://spb.example/never')
    assert backfill.resolve(None, TRACKER, 'talkglimpse.com') == (ARTICLE, False)

    monkeypatch.setattr(backfill, 'resolve_landing', lambda url, stop_site='': '')
    monkeypatch.setattr(backfill, 'resolve_via_scrapingbee', lambda client, url: ARTICLE)
    assert backfill.resolve(None, TRACKER, 'talkglimpse.com') == (ARTICLE, True)


def test_resolve_never_returns_the_tracker_from_either_path(monkeypatch):
    monkeypatch.setattr(backfill, 'resolve_landing', lambda url, stop_site='': url)   # 200 at the tracker
    monkeypatch.setattr(backfill, 'resolve_via_scrapingbee', lambda client, url: url)   # no Spb header
    assert backfill.resolve(None, TRACKER, 'talkglimpse.com') == ('', True)


# ── Scraper: a failed ScrapingBee fetch no longer stores the tracker ──────────
class FakeSpbResponse:
    def __init__(self, status, headers=None, text=''):
        self.status_code = status
        self.ok = 200 <= status < 300
        self.headers = headers or {}
        self.text = text


def fake_client(response):
    class FakeClient:
        def __init__(self, api_key):
            pass

        def get(self, url, params=None, **kwargs):
            assert kwargs.get('timeout'), 'the ScrapingBee call needs a client-side socket timeout'
            if isinstance(response, Exception):
                raise response
            return response
    return FakeClient


def test_scrapingbee_failure_resolves_the_landing_instead_of_echoing_the_tracker(fb, monkeypatch):
    monkeypatch.setattr(fb, 'ScrapingBeeClient', fake_client(FakeSpbResponse(500)))
    monkeypatch.setattr(fb, 'resolve_landing', lambda url: ARTICLE)
    assert fb._scrape_article_sync(TRACKER) == ('', '', ARTICLE)


def test_scrapingbee_failure_with_no_answer_leaves_the_landing_unknown(fb, monkeypatch):
    monkeypatch.setattr(fb, 'ScrapingBeeClient', fake_client(FakeSpbResponse(500)))
    monkeypatch.setattr(fb, 'resolve_landing', lambda url: '')
    assert fb._scrape_article_sync(TRACKER) == ('', '', '')


def test_scrapingbee_exception_also_resolves_the_landing(fb, monkeypatch):
    monkeypatch.setattr(fb, 'ScrapingBeeClient', fake_client(requests.Timeout('stalled')))
    monkeypatch.setattr(fb, 'resolve_landing', lambda url: ARTICLE)
    assert fb._scrape_article_sync(TRACKER) == ('', '', ARTICLE)


def test_scrapingbee_success_keeps_its_own_landing_and_never_walks(fb, monkeypatch):
    def no_walk(url):
        raise AssertionError('a successful fetch must not trigger the redirect walk')
    monkeypatch.setattr(fb, 'resolve_landing', no_walk)
    ok = FakeSpbResponse(200, {'Spb-Resolved-Url': ARTICLE}, '# Title\nBody text')
    monkeypatch.setattr(fb, 'ScrapingBeeClient', fake_client(ok))
    assert fb._scrape_article_sync(TRACKER) == ('Title', 'Body text', ARTICLE)
    # A failed fetch that did report where it landed keeps that landing, still no walk.
    monkeypatch.setattr(fb, 'ScrapingBeeClient', fake_client(FakeSpbResponse(500, {'Spb-Resolved-Url': ARTICLE})))
    assert fb._scrape_article_sync(TRACKER) == ('', '', ARTICLE)
