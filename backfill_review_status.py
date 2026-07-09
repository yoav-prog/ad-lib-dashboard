"""
backfill_review_status.py - re-classify stored ads with the relevance rule.

Why this exists
    The Ad Library query is a keyword search over ad text, so scrapes stored
    plenty of ads that merely mention a tracked domain without advertising it
    (a Temu ad under motorcycle.com, scholarship spam under castofnotes.com).
    New scrapes now route such mismatches to the review queue at ingest; this
    one-off job applies the same rule (fb.ad_matches_domain) to rows that are
    already in the table, flipping mismatched 'approved' rows to 'pending' so
    they move from the feed to the dashboard's Review tab.

    Rows a human already decided on ('rejected', or 'pending' awaiting review)
    are never touched, so the job is safe to re-run any time.

Usage
    python backfill_review_status.py            # re-classify all approved rows
    python backfill_review_status.py --dry-run  # print changes, write nothing
    python backfill_review_status.py --domain motorcycle.com   # one domain only

Needs DATABASE_URL (from .env / .env.local or the environment). No API calls,
no cost - the rule runs on the stored columns.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

# Load local secrets the same way run_scrape.py does, so the script works from a
# checkout without exporting env vars by hand.
try:
    from dotenv import load_dotenv
    _here = Path(__file__).resolve().parent
    load_dotenv(_here / '.env')
    load_dotenv(_here / '.env.local', override=True)
except ImportError:
    pass

# The scraper module validates its API keys at import time, but this job only
# uses its classifier, which calls no API. Placeholders satisfy the check
# without overriding real values (same pattern as tests/conftest.py).
os.environ.setdefault('APIFY_API_TOKEN', 'unused-by-backfill')
os.environ.setdefault('SCRAPINGBEE_API_KEY', 'unused-by-backfill')
os.environ.setdefault('OPENAI_API_KEY', 'unused-by-backfill')

import db
import run_scrape


def snapshot_from_row(row) -> dict:
    """A synthetic ad the classifier understands, built from stored columns.
    Multi-card values were ' | '-joined at ingest; ad_matches_domain splits them."""
    return {'snapshot': {'link_url': row.get('link_url') or '',
                         'caption': row.get('caption') or ''}}


def main():
    ap = argparse.ArgumentParser(description='Re-classify stored ads with the relevance rule')
    ap.add_argument('--dry-run', action='store_true', help='print changes, write nothing')
    ap.add_argument('--domain', help='limit to one tracked domain')
    args = ap.parse_args()

    fb = run_scrape._load_scraper()

    with db.connect() as conn:
        with conn.cursor() as cur:
            if args.domain:
                cur.execute(
                    "select ad_archive_id, domain, link_url, caption, page_name "
                    "from ads where review_status = 'approved' and domain = %s",
                    (args.domain,))
            else:
                cur.execute(
                    "select ad_archive_id, domain, link_url, caption, page_name "
                    "from ads where review_status = 'approved'")
            rows = cur.fetchall()

        print(f'{len(rows)} approved row(s) to check')
        to_pending = []
        for row in rows:
            domain = row.get('domain') or ''
            if fb.ad_matches_domain(snapshot_from_row(row), domain):
                continue
            to_pending.append(row['ad_archive_id'])
            print(f"  -> pending  {row['ad_archive_id']}  domain={domain}  "
                  f"page={(row.get('page_name') or '')[:30]!r}  "
                  f"link={(row.get('link_url') or '')[:60]}")

        print(f'\n{len(to_pending)} row(s) do not match their domain')
        if args.dry_run or not to_pending:
            print('dry run - nothing written' if args.dry_run else 'nothing to do')
            return

        with conn.cursor() as cur:
            cur.execute(
                "update ads set review_status = 'pending' "
                "where ad_archive_id = any(%s) and review_status = 'approved'",
                (to_pending,))
        print(f'updated {len(to_pending)} row(s) to pending')


if __name__ == '__main__':
    main()
