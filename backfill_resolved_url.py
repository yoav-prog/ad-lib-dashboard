"""
backfill_resolved_url.py - populate ads.resolved_url for rows scraped before the
column existed.

Why this exists
    The Predicto feed's searched phrase lives in an ad's post-redirect landing
    URL. New scrapes capture it (ScrapingBee's Spb-Resolved-Url header, stored in
    ads.resolved_url); this one-off job fills it in for rows already in the table.

    A direct link already carries the phrase in ?search=, so it needs no network:
    resolved_url is set to the link itself. A tracker link (e.g. wildflares.com/
    teleport, aglisburn.com/cf/r/...) hides it behind a 302, so we follow the
    redirect and store where it lands. The follow goes through ScrapingBee, not a
    plain request: many of these hosts (funniesnow, analogaudiohub, therockets-
    science, ...) tarpit or block datacenter IPs and time out on a direct fetch,
    but resolve fine through ScrapingBee's proxy - the same path the scraper uses
    for them every run. Cost: 1 ScrapingBee credit per redirect row, render_js off.

    Only rows with an empty resolved_url are touched, so the job is safe to re-run:
    a redirect that failed to resolve stays null and is retried next time.

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


def first_url(link_url: str) -> str:
    """The canonical destination of a (possibly ' | '-joined DCO) link_url - the
    first one, matching web/lib/ui.js firstUrl."""
    return str(link_url or '').split(' | ')[0].strip()


def search_param(url: str) -> str:
    """The `search` query param of a URL ('' when absent/unparseable). A URL that
    already has one is a direct link and needs no redirect follow."""
    try:
        return (parse_qs(urlparse(url).query).get('search') or [''])[0]
    except Exception:
        return ''


def resolve_via_scrapingbee(client: ScrapingBeeClient, url: str) -> str:
    """Follow redirects through ScrapingBee and return the final URL (its
    Spb-Resolved-Url header), or '' on failure. render_js off + block_resources
    keeps it at 1 credit; we only need the header, not the page body."""
    if not url.startswith('http'):
        return ''
    try:
        resp = client.get(url, params={'render_js': False, 'block_resources': True, 'timeout': 20000})
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

        scope = 'all feeds' if args.all_feeds else 'Predicto'
        # Direct links carry the phrase already (free); only trackers need a fetch.
        direct = [(r['ad_archive_id'], first_url(r['link_url'])) for r in rows
                  if search_param(first_url(r['link_url']))]
        redirects = [(r['ad_archive_id'], first_url(r['link_url'])) for r in rows
                     if not search_param(first_url(r['link_url'])) and first_url(r['link_url']).startswith('http')]
        skipped = len(rows) - len(direct) - len(redirects)
        print(f'{len(rows)} {scope} row(s) with no resolved_url: '
              f'{len(direct)} direct (free), {len(redirects)} redirects '
              f'(~{len(redirects)} ScrapingBee credits), {skipped} unresolvable link(s)')

        # Resolve the trackers concurrently - many are slow, but each is independent.
        client = ScrapingBeeClient(api_key=os.environ['SCRAPINGBEE_API_KEY'])
        resolved_redirects = []
        done = 0
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = {pool.submit(resolve_via_scrapingbee, client, url): (ad_id, url)
                       for ad_id, url in redirects}
            for fut in as_completed(futures):
                ad_id, src = futures[fut]
                final = fut.result()
                done += 1
                if final:
                    resolved_redirects.append((ad_id, final))
                    tag = 'REDIRECT' if final != src else 'no-redirect'
                    print(f'  [{done}/{len(redirects)}] {tag} {ad_id}  search={search_param(final)!r}')
                else:
                    print(f'  [{done}/{len(redirects)}] FAILED   {ad_id}  {src[:70]}')

        updates = [(ad_id, url) for ad_id, url in direct] + resolved_redirects
        failed = len(redirects) - len(resolved_redirects)

        if args.dry_run:
            print(f'\ndry run: would set resolved_url on {len(updates)} row(s); '
                  f'{failed} redirect(s) could not be resolved')
            return

        with conn.cursor() as cur:
            for ad_id, url in updates:
                cur.execute("update ads set resolved_url = %s where ad_archive_id = %s", (url, ad_id))
        print(f'\nupdated {len(updates)} row(s) '
              f'({len(direct)} direct + {len(resolved_redirects)} resolved redirects); '
              f'{failed} redirect(s) could not be resolved')


if __name__ == '__main__':
    main()
