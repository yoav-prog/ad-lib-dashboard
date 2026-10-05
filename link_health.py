"""
link_health.py - the pure rules behind the dead-link check.

Shared by check_links.py (the job) and its tests. The dashboard mirrors
DEAD_STATUSES in web/lib/ui.js (isDeadLink) and in the feed SQL (lib/queries.js);
change all three together.

The rule is deliberately narrow. Marking a link dead hides a real ad from anyone
using HIDE DEAD, so only an answer that unambiguously means "this page does not
exist" counts. Bot walls (Cloudflare's 403, the 202 challenge pages several
competitor CMSs serve), rate limits (429) and server errors (5xx) say nothing
about whether the article is there, so they are recorded but never called dead.
"""

from __future__ import annotations

from urllib.parse import urlparse

# 404 Not Found and 410 Gone. Nothing else.
DEAD_STATUSES = frozenset({404, 410})

# "Slow down" answers: rate limits (429), the 406 Tarzo's sites switch to once they
# notice a burst, and a busy server (503). Worth one polite retry after a pause,
# because the real answer behind them is usually a plain 200 or 404.
RETRY_STATUSES = frozenset({406, 429, 503})

# A JavaScript proof-of-work wall, served with 202 in front of EVERY page of a site
# (sousvideguy.com answers its homepage and a made-up URL identically). A plain
# request can never see past it from any IP, so check_links.py re-asks these
# through ScrapingBee with JS rendering, which solves it and reports the real
# status.
CHALLENGE_STATUSES = frozenset({202})


def first_url(link_url: str | None) -> str:
    """The canonical destination of a (possibly ' | '-joined DCO) link_url - the
    first one, matching web/lib/ui.js firstUrl and the dashboard's URL column."""
    return str(link_url or '').split(' | ')[0].strip()


def checkable(url: str) -> bool:
    """True for an absolute http(s) URL with a host. Anything else (a bare domain,
    a facebook:// deep link, an empty string) is skipped rather than guessed at."""
    try:
        parts = urlparse(url)
    except ValueError:
        return False
    return parts.scheme in ('http', 'https') and bool(parts.hostname)


def host_of(url: str) -> str:
    """Lowercased host without www. ('' when unparseable) - the key the job uses to
    cap concurrent requests per site."""
    try:
        host = (urlparse(url).hostname or '').lower()
    except ValueError:
        return ''
    return host[4:] if host.startswith('www.') else host


def is_dead(status: int | None) -> bool:
    """True only for a definitive "page does not exist" answer."""
    return status in DEAD_STATUSES


def is_conclusive(status: int | None) -> bool:
    """True when the status settles the question: the page opened (a plain 200
    after redirects) or it is dead. Anything else - a bot wall (including the 202
    challenge page several competitor CMSs serve in place of the article), a rate
    limit, an error, silence - is worth asking again soon rather than trusting
    for a week. check_links.py mirrors this in its due-query SQL."""
    return status == 200 or is_dead(status)


def group_by_url(rows) -> dict[str, list[str]]:
    """Fold ad rows ({ad_archive_id, link_url}) into {checkable url: [ad ids]}, so
    every distinct URL is requested once however many ads share it. Rows whose
    link is not checkable are dropped."""
    out: dict[str, list[str]] = {}
    for r in rows:
        url = first_url(r.get('link_url'))
        if checkable(url):
            out.setdefault(url, []).append(r['ad_archive_id'])
    return out
