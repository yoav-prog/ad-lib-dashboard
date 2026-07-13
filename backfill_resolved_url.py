"""
backfill_resolved_url.py - populate ads.resolved_url for rows scraped before the
column existed.

Why this exists
    The Predicto feed's searched phrase lives in an ad's post-redirect landing
    URL. New scrapes capture it (ScrapingBee's Spb-Resolved-Url header, stored in
    ads.resolved_url); this one-off job fills it in for rows already in the table.

    Each link falls into one of three kinds:
      direct   - the phrase is already in ?search= (e.g. .../asrsearch?search=x).
                 No network: resolved_url is set to the link itself.
      redirect - a tracker (wildflares.com/teleport?..., aglisburn.com/cf/r/...?...)
                 that 302s to the search page. Followed through ScrapingBee - many
                 of these hosts tarpit/block datacenter IPs and time out on a plain
                 request, but resolve through ScrapingBee's proxy, the same path
                 the scraper uses. 1 credit each, render_js off.
      dead     - a bare .../asrsearch with no query string at all. The search term
                 was injected client-side and never captured, so there is nothing
                 to recover; these are skipped (left null, reported).

    Writes are per row and committed immediately (autocommit), so the job is
    interruptible: stop it any time and re-run to finish - only rows still missing
    resolved_url are retried, and a resolved row is never re-fetched.

Usage
    python backfill_resolved_url.py                 # Predicto ads, live
    python backfill_resolved_url.py --dry-run       # resolve + print, write nothing
    python backfill_resolved_url.py --limit 50      # first 50 rows only
    python backfill_resolved_url.py --all-feeds     # every feed, not just Predicto
    python backfill_resolved_url.py --workers 12    # concurrent redirect fetches

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


def link_kind(url: str) -> str:
    """Classify a link: 'direct' (phrase already in ?search=), 'dead' (bare
    /asrsearch with no query to recover), 'redirect' (a tracker to follow), or
    'skip' (not an http url)."""
    if not url.startswith('http'):
        return 'skip'
    if search_param(url):
        return 'direct'
    parts = urlparse(url)
    if not parts.query and _BARE_SEARCH.search(parts.path or ''):
        return 'dead'
    return 'redirect'


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


def main():
    ap = argparse.ArgumentParser(description='Backfill ads.resolved_url by following link_url redirects')
    ap.add_argument('--dry-run', action='store_true', help='resolve and print, write nothing')
    ap.add_argument('--limit', type=int, help='process at most N rows')
    ap.add_argument('--all-feeds', action='store_true', help='every feed, not just Predicto')
    ap.add_argument('--workers', type=int, default=8, help='concurrent redirect fetches')
    args = ap.parse_args()

    if not os.environ.get('SCRAPINGBEE_API_KEY'):
        raise SystemExit('SCRAPINGBEE_API_KEY is not set (needed to follow redirect trackers). See SETUP.md.')

    where_feed = '' if args.all_feeds else "and lower(feed) = 'predicto'"
    limit_sql = f'limit {int(args.limit)}' if args.limit else ''

    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"select ad_archive_id, link_url from ads "
                f"where (resolved_url is null or resolved_url = '') "
                f"  and link_url is not null and link_url <> '' {where_feed} "
                f"order by last_seen_at desc nulls last {limit_sql}")
            rows = cur.fetchall()

        buckets = {'direct': [], 'redirect': [], 'dead': [], 'skip': []}
        for r in rows:
            buckets[link_kind(first_url(r['link_url']))].append((r['ad_archive_id'], first_url(r['link_url'])))
        direct, redirects, dead, skipped = (buckets['direct'], buckets['redirect'],
                                            buckets['dead'], buckets['skip'])

        scope = 'all feeds' if args.all_feeds else 'Predicto'
        print(f'{len(rows)} {scope} row(s) with no resolved_url: '
              f'{len(direct)} direct (free), {len(redirects)} redirects '
              f'(~{len(redirects)} ScrapingBee credits), '
              f'{len(dead)} bare /asrsearch with no query (skipped), '
              f'{len(skipped)} non-http (skipped)')

        def write(ad_id, url):
            if args.dry_run:
                return
            with conn.cursor() as cur:  # autocommit: persists immediately, so the job is resumable
                cur.execute('update ads set resolved_url = %s where ad_archive_id = %s', (url, ad_id))

        # Direct links carry the phrase already - store the link as its own resolved
        # URL (free) so re-runs skip them.
        for ad_id, url in direct:
            write(ad_id, url)
        print(f'  direct: set {len(direct)} row(s)')

        # Trackers, resolved concurrently and written the moment each returns.
        client = ScrapingBeeClient(api_key=os.environ['SCRAPINGBEE_API_KEY'])
        resolved = failed = 0
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = {pool.submit(resolve_via_scrapingbee, client, url): (ad_id, url)
                       for ad_id, url in redirects}
            for fut in as_completed(futures):
                ad_id, src = futures[fut]
                final = fut.result()
                if final:
                    write(ad_id, final)
                    resolved += 1
                    print(f'  [{resolved + failed}/{len(redirects)}] ok    {ad_id}  search={search_param(final)!r}')
                else:
                    failed += 1
                    print(f'  [{resolved + failed}/{len(redirects)}] FAIL  {ad_id}  {src[:60]}')

        verb = 'would set' if args.dry_run else 'set'
        print(f'\n{verb} resolved_url on {len(direct) + resolved} row(s) '
              f'({len(direct)} direct + {resolved} resolved redirects); '
              f'{failed} redirect(s) unresolved, {len(dead)} dead link(s) left blank')


if __name__ == '__main__':
    main()
