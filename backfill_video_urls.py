"""
backfill_video_urls.py - restore video links that a re-scrape dropped.

Why this exists
    Facebook eventually stops serving the source URL of older videos, so when a
    video ad was re-processed the scraper saw only a preview image, stored the
    row with video_hd_url = NULL, and the mp4 we had already uploaded to GCS was
    orphaned. The scraper is now fixed (process_ad_media falls back to storage
    when Apify returns no video URL), but rows written before the fix keep the
    missing link. This one-off job finds each broken row's stored video in the
    bucket (public listing, no credentials needed) and writes the URL back.

Usage
    python backfill_video_urls.py             # repair every video ad missing its link
    python backfill_video_urls.py --dry-run   # print changes, write nothing
    python backfill_video_urls.py --limit 50  # cap rows (for a test run first)

Needs DATABASE_URL (from .env / .env.local or the environment). The GCS bucket
is read anonymously; override the name with GCS_BUCKET if it ever changes.
"""

from __future__ import annotations

import argparse
import asyncio
import os
from pathlib import Path
from urllib.parse import quote

# Load local secrets the same way run_scrape.py does, so the script works from a
# checkout without exporting env vars by hand.
try:
    from dotenv import load_dotenv
    _here = Path(__file__).resolve().parent
    load_dotenv(_here / '.env')
    load_dotenv(_here / '.env.local', override=True)
except ImportError:
    pass

import aiohttp

import db

BUCKET = os.environ.get('GCS_BUCKET', 'aporia-unleash')
LIST_URL = f'https://storage.googleapis.com/storage/v1/b/{BUCKET}/o'
CONCURRENCY = 8


def stored_media_url(items, suffix) -> str | None:
    """The public URL of the first listed object whose name ends with `suffix`,
    e.g. '_vid1.mp4' for an ad's primary video. `items` is the `items` array of
    a GCS JSON listing response."""
    for item in items or []:
        name = item.get('name', '')
        if name.endswith(suffix):
            return f'https://storage.googleapis.com/{BUCKET}/{quote(name)}'
    return None


async def list_objects(session, sem, prefix):
    """All object entries under `prefix` (anonymous read; the bucket is public)."""
    async with sem:
        async with session.get(
            LIST_URL, params={'prefix': prefix},
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            if resp.status != 200:
                print(f'  GCS list {resp.status} for {prefix}')
                return []
            return (await resp.json()).get('items', [])


def fetch_rows(limit):
    """Video ads whose video link is missing. The preview-only condition also
    catches DCO rows that are not marked VIDEO but clearly had a video."""
    sql = """
        select ad_archive_id, video_hd_url, video_preview_url
          from ads
         where coalesce(video_hd_url, '') = ''
           and (display_format = 'VIDEO' or coalesce(video_preview_url, '') <> '')
         order by first_seen_at desc nulls last
    """
    params: list = []
    if limit:
        sql += ' limit %s'
        params.append(int(limit))
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()


def write_updates(hd_updates, preview_updates):
    with db.connect() as conn:
        with conn.cursor() as cur:
            if hd_updates:
                cur.executemany(
                    'update ads set video_hd_url = %s where ad_archive_id = %s',
                    [(url, aid) for (aid, url) in hd_updates],
                )
            if preview_updates:
                cur.executemany(
                    'update ads set video_preview_url = %s where ad_archive_id = %s',
                    [(url, aid) for (aid, url) in preview_updates],
                )


async def main(args):
    rows = fetch_rows(args.limit)
    print(f'{len(rows)} video ad(s) missing their video link')
    if not rows:
        return

    sem = asyncio.Semaphore(CONCURRENCY)
    hd_updates: list[tuple[str, str]] = []
    preview_updates: list[tuple[str, str]] = []
    not_found = 0

    async with aiohttp.ClientSession() as session:
        async def work(row):
            nonlocal not_found
            aid = row['ad_archive_id']
            videos = await list_objects(session, sem, f'facebook_ads/videos/{aid}-')
            video_url = stored_media_url(videos, '_vid1.mp4')
            if not video_url:
                not_found += 1
                return
            hd_updates.append((aid, video_url))
            print(f'  {aid}: video -> {video_url}')
            if not (row.get('video_preview_url') or '').strip():
                images = await list_objects(session, sem, f'facebook_ads/images/{aid}-')
                preview_url = stored_media_url(images, '_vidpreview1.jpg')
                if preview_url:
                    preview_updates.append((aid, preview_url))
                    print(f'  {aid}: preview -> {preview_url}')

        await asyncio.gather(*(work(r) for r in rows))

    print(f'\n{len(hd_updates)} video link(s) recovered, {len(preview_updates)} '
          f'preview(s) recovered, {not_found} not in storage (video was never uploaded)')
    if args.dry_run:
        print('dry run - nothing written.')
        return
    if hd_updates or preview_updates:
        write_updates(hd_updates, preview_updates)
        print(f'updated {len(hd_updates) + len(preview_updates)} value(s).')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description='Restore video links dropped by re-scrapes.')
    p.add_argument('--dry-run', action='store_true', help='print changes, write nothing')
    p.add_argument('--limit', type=int, default=0, help='cap number of rows (testing)')
    asyncio.run(main(p.parse_args()))
