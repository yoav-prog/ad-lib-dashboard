"""
backfill_resolved_url.py - populate ads.resolved_url where the scrape could not.

Why this exists
    An ad's post-redirect landing URL carries what its tracker hides: the Predicto
    feed's searched phrase, and the article a TONIC RSOC campaign is keyed by in
    the metrics sheet (web/lib/metrics.js matches on it). New scrapes capture it
    (ScrapingBee's Spb-Resolved-Url header, stored in ads.resolved_url); this job
    fills it in for rows that have none - and for rows whose stored landing never
    left the tracker's own host, which the scraper used to write when ScrapingBee
    failed (bug #311: such a row is as unresolved as an empty one).

    Each link falls into one of these kinds:
      direct   - the phrase is already in ?search= (e.g. .../asrsearch?search=x).
                 No network: resolved_url is set to the link itself.
      redirect - a tracker (wildflares.com/teleport?..., checkbeforesearch.com/
                 cqe7l8k.php?..., trk.s2sengine.com/cf/r/...) that 302s onward.
                 Walked by hand first, free (landing.resolve_landing), stopping as
                 soon as a hop points at the ad's own site, so that rate-limited
                 site is never asked. Hosts that tarpit or block a plain request
                 fall back to ScrapingBee's proxy, the same path the scraper uses:
                 1 credit each, render_js off.
      own      - already on the ad's own tracked site: the link is its own landing,
                 nothing to resolve. Skipped (reported).
      dead     - a bare .../asrsearch with no query string at all. The search term
                 was injected client-side and never captured, so there is nothing
                 to recover; these are skipped (left null, reported).

    Writes are per row and committed immediately (autocommit), so the job is
    interruptible: stop it any time and re-run to finish - only rows still
    unresolved are retried, and a resolved row is never re-fetched.

Usage
    python backfill_resolved_url.py                      # Predicto ads, live
    python backfill_resolved_url.py --feed "TONIC RSOC"  # one feed by name
    python backfill_resolved_url.py --all-feeds          # every feed
    python backfill_resolved_url.py --dry-run            # resolve + print, write nothing
    python backfill_resolved_url.py --limit 50           # first 50 unresolved rows only
    python backfill_resolved_url.py --workers 12         # concurrent redirect fetches

Needs DATABASE_URL and SCRAPINGBEE_API_KEY (from .env / .env.local or the
environment).
"""

from __future__ import annotations

import argparse
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# Load local secrets the same way run_scrape.py does, so the script works from a
# checkout without exporting env vars by hand.
try:
    from dotenv import load_dotenv
    _here = Path(__file__).resolve().parent
    load_dotenv(_here / '.env')
    load_dotenv(_here / '.env.local', override=True)
except ImportError:
    pass

from scrapingbee import ScrapingBeeClient

import db
from landing import on_site, resolve_landing, site_of
from link_health import host_of

# A bare search endpoint (no query) can never yield a phrase - it is the search
# page itself, waiting on a term that was never captured.
_BARE_SEARCH = re.compile(r'/asrsearch/?$', re.I)


def first_url(link_url: str) -> str:
    """The canonical destination of a (possibly ' | '-joined DCO) link_url - the
    first one, matching web/lib/ui.js firstUrl."""
    return str(link_url or '').split(' | ')[0].strip()


def search_param(url: str) -> str:
    """The `search` query param of a URL ('' when absent/unparseable)."""
    try:
        return (parse_qs(urlparse(url).query).get('search') or [''])[0]
    except Exception:
        return ''


def link_kind(url: str, site: str = '') -> str:
    """Classify a link: 'direct' (phrase already in ?search=), 'dead' (bare
    /asrsearch with no query to recover), 'own' (already on the ad's own site
    `site`, so it is its own landing), 'redirect' (a tracker to follow), or
    'skip' (not an http url)."""
    if not url.startswith('http'):
        return 'skip'
    if search_param(url):
        return 'direct'
    parts = urlparse(url)
    if not parts.query and _BARE_SEARCH.search(parts.path or ''):
        return 'dead'
    if on_site(url, site):
        return 'own'
    return 'redirect'


def _host_path(url: str) -> str:
    try:
        path = urlparse(url).path
    except ValueError:
        path = ''
    return host_of(url) + path.rstrip('/')


def stuck_on_tracker(link: str, landing: str) -> bool:
    """True when a landing is the link itself (same host and path; the query string
    may differ, since ScrapingBee re-encodes {{ad.id}}-style macros). On its own
    that is ambiguous - a direct article link really does land on itself - so
    callers pair it with other evidence: a stored echo counts as unresolved only
    when ScrapingBee also captured no article, and ScrapingBee echoing the link
    back means it could not tell. A redirect to another path on the same host is
    progress, not an echo."""
    return bool(landing) and _host_path(landing) == _host_path(link)


def resolve_via_scrapingbee(client: ScrapingBeeClient, url: str) -> str:
    """Follow redirects through ScrapingBee and return the final URL (its
    Spb-Resolved-Url header), or '' on failure. render_js off + block_resources
    keeps it at 1 credit; we only need the header, not the page body.

    params['timeout'] (20s) bounds ScrapingBee's wait on the target host; the
    top-level timeout (90s) is the client-side socket cap so a tarpit host that
    ScrapingBee keeps retrying can never hang the worker forever - the row just
    fails and is retried on the next run."""
    if not url.startswith('http'):
        return ''
    try:
        resp = client.get(url, params={'render_js': False, 'block_resources': True, 'timeout': 20000}, timeout=90)
        if not resp.ok:
            return ''
        return resp.headers.get('Spb-Resolved-Url') or url
    except Exception:
        return ''


def resolve(client: ScrapingBeeClient, url: str, site: str) -> tuple[str, bool]:
    """Where a link lands, and whether a ScrapingBee credit was spent finding out.
    The free redirect walk goes first, stopping as soon as a hop points at the ad's
    own site. Its answer stands, including "lands on itself" (a 2xx with no
    redirect - an article linked straight from an ad found under another query).
    ScrapingBee's proxy is asked only when the walk gets no answer at all (hosts
    that tarpit or block a plain request); there an echo of the link means it
    could not tell, so the landing is '' rather than the link passed off as one."""
    landing = resolve_landing(url, stop_site=site)
    if landing:
        return landing, False
    landing = resolve_via_scrapingbee(client, url)
    return ('' if stuck_on_tracker(url, landing) else landing), True


def main():
    ap = argparse.ArgumentParser(description='Backfill ads.resolved_url by following link_url redirects')
    ap.add_argument('--dry-run', action='store_true', help='resolve and print, write nothing')
    ap.add_argument('--limit', type=int, help='process at most N unresolved rows')
    scope_arg = ap.add_mutually_exclusive_group()
    scope_arg.add_argument('--feed', default='Predicto', help='the one feed to backfill, by name (default: Predicto)')
    scope_arg.add_argument('--all-feeds', action='store_true', help='every feed')
    ap.add_argument('--workers', type=int, default=8, help='concurrent redirect fetches')
    args = ap.parse_args()

    if not os.environ.get('SCRAPINGBEE_API_KEY'):
        raise SystemExit('SCRAPINGBEE_API_KEY is not set (needed to follow redirect trackers). See SETUP.md.')

    where_feed = '' if args.all_feeds else 'and lower(trim(feed)) = lower(trim(%s))'
    params = () if args.all_feeds else (args.feed,)

    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"select ad_archive_id, domain, link_url, resolved_url, "
                f"       (article_content is not null and article_content <> '') as has_article "
                f"from ads "
                f"where link_url is not null and link_url <> '' {where_feed} "
                f"order by last_seen_at desc nulls last", params)
            rows = cur.fetchall()

        # A row needs work when it has no landing, or when its stored landing is an
        # echo of a failed fetch: the link itself, with no article captured. When
        # ScrapingBee did fetch the page, a link stored as its own landing really did
        # not redirect; a 'direct' link stored as its own landing is right by design.
        todo, echoes = [], 0
        for r in rows:
            link, site = first_url(r['link_url']), site_of(r['domain'])
            kind = link_kind(link, site)
            stored = r['resolved_url'] or ''
            if stored:
                if not (kind == 'redirect' and stuck_on_tracker(link, stored) and not r['has_article']):
                    continue
                echoes += 1
            todo.append((kind, r['ad_archive_id'], link, site))
        if args.limit:
            todo = todo[:args.limit]

        buckets = {'direct': [], 'redirect': [], 'own': [], 'dead': [], 'skip': []}
        for kind, ad_id, link, site in todo:
            buckets[kind].append((ad_id, link, site))
        direct, redirects, own, dead, skipped = (buckets['direct'], buckets['redirect'], buckets['own'],
                                                 buckets['dead'], buckets['skip'])

        scope = 'all feeds' if args.all_feeds else f'feed {args.feed!r}'
        print(f'{len(todo)} unresolved row(s) in {scope}, {echoes} of them a failed fetch stored as its own landing: '
              f'{len(direct)} direct (free), {len(redirects)} redirects (free walk first, '
              f'at most {len(redirects)} ScrapingBee credits), '
              f'{len(own)} already on their own site (skipped), '
              f'{len(dead)} bare /asrsearch with no query (skipped), '
              f'{len(skipped)} non-http (skipped)')

        def write(ad_id, url):
            if args.dry_run:
                return
            with conn.cursor() as cur:  # autocommit: persists immediately, so the job is resumable
                cur.execute('update ads set resolved_url = %s where ad_archive_id = %s', (url, ad_id))

        # Direct links carry the phrase already - store the link as its own resolved
        # URL (free) so re-runs skip them.
        for ad_id, url, _ in direct:
            write(ad_id, url)
        print(f'  direct: set {len(direct)} row(s)')

        # Trackers, resolved concurrently and written the moment each returns.
        client = ScrapingBeeClient(api_key=os.environ['SCRAPINGBEE_API_KEY'])
        resolved = failed = credits = 0
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = {pool.submit(resolve, client, url, site): (ad_id, url)
                       for ad_id, url, site in redirects}
            for fut in as_completed(futures):
                ad_id, src = futures[fut]
                final, paid = fut.result()
                credits += paid
                if final:
                    write(ad_id, final)
                    resolved += 1
                    print(f'  [{resolved + failed}/{len(redirects)}] ok    {ad_id}  -> {final[:90]}')
                else:
                    failed += 1
                    print(f'  [{resolved + failed}/{len(redirects)}] FAIL  {ad_id}  {src[:60]}')

        verb = 'would set' if args.dry_run else 'set'
        print(f'\n{verb} resolved_url on {len(direct) + resolved} row(s) '
              f'({len(direct)} direct + {resolved} resolved redirects); '
              f'{failed} redirect(s) unresolved, {len(dead)} dead link(s) left blank; '
              f'{credits} ScrapingBee credit(s) used')


if __name__ == '__main__':
    main()
