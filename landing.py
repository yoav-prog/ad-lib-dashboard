"""
landing.py - where an ad's link actually lands, found by walking its redirects by hand.

Shared by the scraper (facebookadscraperapify2026-v2.py, when its ScrapingBee fetch
fails), backfill_resolved_url.py, and their tests.

Many competitors link their ads through a click tracker (checkbeforesearch.com/
cqe7l8k.php, qcviwxfqmc.com/17, trk.s2sengine.com/cf/r/...) that redirects to the
article. The article is what the campaign-metrics sheet and the RSOC comp rows name,
so an ad meets its campaign through its landing page, never the tracker
(web/lib/metrics.js adUrlKeys reads ads.resolved_url for exactly this). ScrapingBee
reports the landing (its Spb-Resolved-Url header) when it fetches the article, but a
failed fetch used to store the tracker itself as the landing instead: ~700 TONIC
RSOC ads that no campaign could ever match, and that the backfill then skipped
because the column was not empty (bug #311, 2026-11-04).

Walking the Location headers by hand is free, and for every Tonic tracker seen so
far it takes a single request: the tracker answers 302/307 straight to the article.
Only status lines and headers are read, never a body.
"""

from __future__ import annotations

from urllib.parse import urljoin

import requests

from link_health import checkable, host_of

# The HTTP answers that carry a Location to follow.
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})

# Hops before giving up on a chain. Trackers seen so far take one; a loop or a chain
# this long is not worth more requests.
MAX_HOPS = 5

# (connect, read) seconds per hop. Only the status line and headers are read, so a
# healthy tracker answers in well under a second.
HTTP_TIMEOUT = (10, 20)

# A real browser's headers, as check_links.py sends them: several trackers and CMSs
# answer a bare python-requests UA with a bot wall instead of their redirect.
HEADERS = {
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}


def site_of(query: str | None) -> str:
    """An ad's tracked query (ads.domain) as a bare lowercase domain, or '' when the
    query is a keyword rather than a site. Mirrors the scraper's normalize_domain."""
    q = str(query or '').strip().lower()
    q = q.split('://', 1)[-1].split('/')[0].split('?')[0].split(':')[0]
    if q.startswith('www.'):
        q = q[4:]
    return q if '.' in q and ' ' not in q else ''


def on_site(url: str, site: str) -> bool:
    """True when url's host is `site` or one of its subdomains. A keyword query
    (site '') owns no host, so nothing is on it."""
    host = host_of(url)
    return bool(site) and bool(host) and (host == site or host.endswith('.' + site))


def resolve_landing(url: str, session=None, stop_site: str = '') -> str:
    """The URL that `url` lands on after its HTTP redirects, or '' when that cannot
    be told. Never the link echoed back on a failure, so an unanswered tracker is
    never passed off as its own landing page:

      - a link that answers 2xx without redirecting lands on itself;
      - a link that errors, times out, or answers anything else on the first
        request leaves the landing unknown ('');
      - once a redirect has been seen, the furthest URL reached is the answer: an
        article that rate-limits us (429) is still where the link lands;
      - stop_site (a bare domain, typically the ad's own) ends the walk as soon as
        a hop points at it, so that site is never sent a request at all;
      - a non-http(s) Location, or a chain past MAX_HOPS, stops at the last
        http(s) URL reached.
    """
    if not checkable(url):
        return ''
    http = session or requests
    current = url
    for hop in range(MAX_HOPS):
        try:
            with http.get(current, headers=HEADERS, timeout=HTTP_TIMEOUT,
                          allow_redirects=False, stream=True) as resp:
                status, location = resp.status_code, resp.headers.get('Location')
        except requests.RequestException:
            return current if hop else ''
        if status not in REDIRECT_STATUSES or not location:
            return current if hop or 200 <= status < 300 else ''
        target = urljoin(current, location)
        if not checkable(target):
            return current if hop else ''
        current = target
        if on_site(current, stop_site):
            return current
    return current
