"""
backfill_brand.py - classify the brand of existing ads from their stored creative.

Why this exists
    The `brand` column (none / brand / car_brand) is filled by gpt_detect_brand
    during a scrape, but a normal scrape skips ads it already has, so every row
    that predates the feature stays NULL. This one-off job looks at each ad's
    stored creative image + copy and writes the brand in place. It shares the
    prompt and answer-parsing with the live scraper via brand.py, so the two can
    never disagree.

Usage
    python backfill_brand.py                 # classify every ad not yet classified
    python backfill_brand.py --all           # re-classify every ad (even set ones)
    python backfill_brand.py --dry-run       # print changes, write nothing
    python backfill_brand.py --limit 50      # cap rows (for a test run first)

Needs DATABASE_URL and OPENAI_API_KEY (from .env / .env.local or the environment).
Cost: one gpt-4.1-mini vision call per processed ad - a fraction of a cent each.
"""

from __future__ import annotations

import argparse
import asyncio
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

import aiohttp

import brand
import db

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
CONCURRENCY = 8

# The ad's own creative text (mirrors ad_copy_text in the scraper, reading the
# already-stored columns instead of the raw Apify snapshot).
_COPY_COLUMNS = ('body_text', 'caption', 'title', 'link_description', 'extra_texts')


def copy_from_row(row) -> str:
    parts = [row.get(c) for c in _COPY_COLUMNS]
    return ' | '.join(p.strip() for p in parts if isinstance(p, str) and p.strip())


def image_from_row(row) -> str:
    """The still the vision call looks at: the first stored (permanent GCS) image,
    else the video poster. FB CDN links have long expired, so only these work."""
    imgs = row.get('original_image_urls') or []
    if imgs:
        return imgs[0]
    return row.get('video_preview_url') or ''


async def detect_brand(session, sem, ad_copy, image_url):
    """Mirror of facebookadscraperapify2026-v2.gpt_detect_brand, built on the same
    brand.py prompt + parser so live and backfill never drift."""
    messages = brand.build_brand_messages(ad_copy, image_url)
    if messages is None:
        return ''
    async with sem:
        try:
            payload = {
                "model": brand.BRAND_MODEL,
                "messages": messages,
                "max_tokens": 3,
                "temperature": 0,
            }
            async with session.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
                json=payload,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return brand.normalize_brand(data['choices'][0]['message']['content'])
                print(f"  OpenAI {resp.status}: {(await resp.text())[:120]}")
                return ''
        except Exception as e:
            print(f"  brand error: {e}")
            return ''


def fetch_rows(do_all, limit):
    cols = ('ad_archive_id, brand, original_image_urls, video_preview_url, '
            + ', '.join(_COPY_COLUMNS))
    sql = f'select {cols} from ads'
    params: list = []
    if not do_all:
        sql += " where brand is null or btrim(brand) = ''"
    sql += ' order by first_seen_at desc nulls last'
    if limit:
        sql += ' limit %s'
        params.append(int(limit))
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()


def write_updates(updates):
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                'update ads set brand = %s where ad_archive_id = %s',
                [(b, aid) for (aid, b) in updates],
            )


async def main(args):
    if not OPENAI_API_KEY:
        raise SystemExit('OPENAI_API_KEY is not set (put it in .env.local).')

    rows = fetch_rows(args.all, args.limit)
    print(f'{len(rows)} ad(s) to classify'
          + ('' if args.all else ' (not yet classified)'))
    if not rows:
        return

    sem = asyncio.Semaphore(CONCURRENCY)
    updates: list[tuple[str, str]] = []
    skipped = 0

    async with aiohttp.ClientSession() as session:
        async def work(row):
            nonlocal skipped
            copy = copy_from_row(row)
            image = image_from_row(row)
            if not copy and not image:
                skipped += 1
                return
            new = await detect_brand(session, sem, copy, image)
            old = row.get('brand') or ''
            if new and new != old:
                updates.append((row['ad_archive_id'], new))
                print(f"  {row['ad_archive_id']}: {old or '(none)'} -> {new}")

        await asyncio.gather(*(work(r) for r in rows))

    unchanged = len(rows) - len(updates) - skipped
    print(f'\n{len(updates)} change(s), {skipped} skipped (no copy or image), {unchanged} unchanged')
    if args.dry_run:
        print('dry run - nothing written.')
        return
    if updates:
        write_updates(updates)
        print(f'updated {len(updates)} row(s).')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description='Classify ad brand from stored creative.')
    p.add_argument('--all', action='store_true',
                   help='re-classify every ad, not only unclassified ones')
    p.add_argument('--dry-run', action='store_true', help='print changes, write nothing')
    p.add_argument('--limit', type=int, default=0, help='cap number of rows (testing)')
    asyncio.run(main(p.parse_args()))
