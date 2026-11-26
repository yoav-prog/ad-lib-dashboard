"""A dead Apify token must fail the run loudly, not pass as "0 ads".

The 2026-11-12..25 incident: the APIFY_API_TOKEN secret stopped being valid, every
actor call came back 401 "User was not found or authentication token is not valid",
and the scraper caught it as a generic error, returned 0 ads, retried as if it were
a transient empty, then marked each domain scraped. 24 runs finished as COMPLETED
with nothing in them and no one was told. These tests pin the fix: account-level
Apify errors (401/402/403) raise ApifyAccountError, skip the empty retries, and stop
the domain loop before any schedule is bumped.
"""

from contextlib import contextmanager

import pytest
from apify_client.errors import ApifyApiError

import run_scrape
from run_scrape import _scrape_domain_rows


PARAMS = {'query': 'sousvideguy.com', 'country': 'ALL',
          'activeStatus': 'active', 'max_target_results': 100}


class _FakeResponse:
    """The slice of an Apify HttpResponse that ApifyApiError reads."""

    def __init__(self, status_code, message, error_type):
        self.status_code = status_code
        self._body = {'error': {'type': error_type, 'message': message}}
        self.text = str(self._body)

    def json(self):
        return self._body


def _api_error(status, message='User was not found or authentication token is not valid',
               error_type='user-or-token-not-found'):
    return ApifyApiError(_FakeResponse(status, message, error_type), attempt=1)


def _client_raising(error, calls):
    """An ApifyClient stand-in whose actor call raises `error`."""
    class _Actor:
        def call(self, run_input, logger):
            calls.append(run_input)
            raise error

    class _Client:
        def __init__(self, token):
            pass

        def actor(self, actor_id):
            return _Actor()

    return _Client


# ── fetch_facebook_ads_apify classifies the failure ───────────────────────────
@pytest.mark.parametrize('status, hint', [
    (401, 'APIFY_API_TOKEN'),
    (402, 'out of credit'),
    (403, 'access'),
])
def test_account_errors_raise_instead_of_returning_no_ads(fb, monkeypatch, status, hint):
    calls = []
    monkeypatch.setattr(fb, 'ApifyClient', _client_raising(_api_error(status), calls))

    with pytest.raises(fb.ApifyAccountError) as excinfo:
        fb.fetch_facebook_ads_apify(PARAMS)

    message = str(excinfo.value)
    assert hint in message
    assert f'HTTP {status}' in message
    assert 'authentication token is not valid' in message   # Apify's own words kept
    assert len(calls) == 1


def test_auth_error_message_leads_with_the_fix(fb):
    """The Control Room shows only the first 140 chars of error_detail, so the
    action to take has to come first."""
    error = fb.apify_account_error(_api_error(401))
    assert str(error)[:140].startswith(
        'Apify rejected the API token - set a valid APIFY_API_TOKEN GitHub secret')


@pytest.mark.parametrize('error', [
    _api_error(500, 'Internal server error', 'internal-error'),
    _api_error(404, 'Actor run not found', 'record-not-found'),
    RuntimeError('connection reset'),
])
def test_other_errors_still_count_as_an_empty_attempt(fb, monkeypatch, error):
    monkeypatch.setattr(fb, 'ApifyClient', _client_raising(error, []))
    assert fb.fetch_facebook_ads_apify(PARAMS) == ([], None)


def test_non_api_errors_are_never_account_errors(fb):
    assert fb.apify_account_error(RuntimeError('401 in the text only')) is None


# ── the resume loop does not retry a dead account ─────────────────────────────
async def test_resume_loop_stops_at_the_first_account_error(fb, monkeypatch):
    calls = []
    monkeypatch.setattr(fb, 'ApifyClient', _client_raising(_api_error(401), calls))

    async def no_sleep(seconds):
        raise AssertionError('must not wait to retry a rejected token')
    monkeypatch.setattr(fb.asyncio, 'sleep', no_sleep)

    with pytest.raises(fb.ApifyAccountError):
        await fb.fetch_facebook_ads_apify_with_resume(PARAMS, max_retries=4, empty_retries=3)
    assert len(calls) == 1


# ── the domain loop fails the run before marking anything scraped ─────────────
async def test_domain_loop_stops_without_bumping_schedules(fb, monkeypatch):
    bumped, scraped = [], []

    @contextmanager
    def fake_connect():
        yield object()

    async def failing_scrape_query(run_id, bucket, verticals, existing_ids,
                                   params, feed, domain, retries, progress=None):
        scraped.append(domain)
        raise fb.ApifyAccountError('Apify rejected the API token')

    monkeypatch.setattr(run_scrape.db, 'connect', fake_connect)
    monkeypatch.setattr(run_scrape.db, 'bump_domain_schedule',
                        lambda conn, domain_id, days: bumped.append(domain_id))
    monkeypatch.setattr(run_scrape, 'scrape_query', failing_scrape_query)

    rows = [{'id': f'id-{n}', 'query': f'{n}.com', 'country': 'ALL',
             'active_status': 'active', 'max_ads': 10, 'interval_days': 3,
             'feed': ''} for n in ('a', 'b', 'c')]
    progress = {'current_domain': None, 'domains_total': 3,
                'domains_done': 0, 'ads_found_so_far': 0}

    with pytest.raises(fb.ApifyAccountError):
        await _scrape_domain_rows('run-id', None, [], set(), rows, 1, progress,
                                  deadline=1_000_000, clock=lambda: 0,
                                  take_requested=lambda: None)
    assert scraped == ['a.com']     # stopped at the first domain
    assert bumped == []             # nothing marked as scraped, all stay due
    assert progress['domains_done'] == 0
