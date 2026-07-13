"""
backfill_resolved_url.py - populate ads.resolved_url for rows scraped before the
column existed.

Why this exists
    The Predicto feed's searched phrase lives in an ad's post-redirect landing
    URL. New scrapes capture it (ScrapingBee's Spb-Resolved-Url header, stored in
    ads.resolved_url); this one-off job fills it in for rows already in the table.
    It follows each ad's link_url with a plain request - these are ordinary
    server-side 302s (verified 2026-07-13), so no ScrapingBee, no credits, no cost.

    Only rows with an empty resolved_url are touched, so the job is safe to re-run:
    a row that failed to resolve stays null and is retried next time; a row already
    resolved is skipped.

Usage
    python backfill_resolved_url.py                 # Predicto ads, live
    python backfill_resolved_url.py --dry-run       # print what would change
    python backfill_resolved_url.py --limit 50      # first 50 only (throttle)
    python backfill_resolved_url.py --all-feeds     # every feed, not just Predicto
    python backfill_resolved_url.py --delay 0.5     # seconds between requests

Needs DATABASE_URL (from .env / .env.local or the environment).
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import requests

# Load local secrets the same way run_scrape.py does, so the script works from a
# checkout without exporting env vars by hand.
try:
    from dotenv import load_dotenv
    _here = Path(__file__).resolve().parent
    load_dotenv(_here / '.env')
    load_dotenv(_here / '.env.local', override=True)
except ImportError:
    pass

import db

# A browser UA matches the request that resolved these redirects by hand; some
# trackers serve a different (or no) redirect to an empty/bot agent.
_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'


def first_url(link_url: str) -> str:
    """The canonical destination of a (possibly ' | '-joined DCO) link_url - the
    first one, matching web/lib/ui.js firstUrl."""
    return str(link_url or '').split(' | ')[0].strip()


def resolve(url: str, timeout: float = 15.0) -> str:
    """Follow redirects and return the final URL, or '' on any failure. stream=True
    so we read the resolved URL without downloading the page body."""
    if not url.startswith('http'):
        return ''
    resp = requests.get(url, allow_redirects=True, timeout=timeout,
                        headers={'User-Agent': _UA}, stream=True)
    try:
        return resp.url or ''
    finally:
        resp.close()


def main():
    ap = argparse.ArgumentParser(description='Backfill ads.resolved_url by following link_url redirects')
    ap.add_argument('--dry-run', action='store_true', help='print changes, write nothing')
    ap.add_argument('--limit', type=int, help='process at most N rows')
    ap.add_argument('--all-feeds', action='store_true', help='every feed, not just Predicto')
    ap.add_argument('--delay', type=float, default=0.3, help='seconds to wait between requests (politeness)')
    args = ap.parse_args()

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
        print(f'{len(rows)} {scope} row(s) with no resolved_url')

        updated = failed = 0
        for i, row in enumerate(rows, 1):
            src = first_url(row.get('link_url'))
            try:
                resolved = resolve(src)
            except Exception as e:
                resolved = ''
                print(f'  [{i}/{len(rows)}] error {row["ad_archive_id"]}: {e}')

            if not resolved:
                failed += 1
                continue

            changed = resolved != src
            print(f'  [{i}/{len(rows)}] {"REDIRECT" if changed else "direct  "} '
                  f'{row["ad_archive_id"]}  {resolved[:90]}')

            if not args.dry_run:
                with conn.cursor() as cur:
                    cur.execute(
                        "update ads set resolved_url = %s where ad_archive_id = %s",
                        (resolved, row['ad_archive_id']))
            updated += 1

            if args.delay and i < len(rows):
                time.sleep(args.delay)

        verb = 'would update' if args.dry_run else 'updated'
        print(f'\n{verb} {updated} row(s); {failed} could not be resolved')


if __name__ == '__main__':
    main()
