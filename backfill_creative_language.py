"""
backfill_creative_language.py - detect the language of the text ON existing ads'
creatives (the image, or a video's poster frame), from the stored media.

Why this exists
    The `creative_language` column is filled by gpt_detect_creative_language during
    a scrape, but a normal scrape skips ads it already has, so every row that
    predates the feature stays NULL. This one-off job looks at each ad's stored
    creative still and writes the language of the text on it. It shares the prompt
    and parsing with the live scraper via creative_language.py, so the two never
    disagree.

    Values: a language name ("Spanish") when the creative has text, '' (empty) when
    it has no readable text, NULL while still unclassified. A detection failure is
    left NULL (not written) so a re-run retries it rather than mislabelling it.

Usage
    python backfill_creative_language.py               # classify every unclassified ad
    python backfill_creative_language.py --all          # re-classify every ad
    python backfill_creative_language.py --dry-run       # print changes, write nothing
    python backfill_creative_language.py --limit 50      # cap rows (for a test run first)

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

import creative_language
import db

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
# Vision calls run several seconds each, so throughput is concurrency-bound; keep it
# high but within a normal account's rate limits (a failure just retries next run).
CONCURRENCY = 64
# Each batch is flushed to the DB before the next, so a long run is crash-safe and a
# re-run resumes from the first still-unclassified row.
BATCH_SIZE = 512


def image_from_row(row) -> str:
    """The still the vision call looks at: the first stored (permanent GCS) image,
    else the video poster. FB CDN links have long expired, so only these work."""
    imgs = row.get('original_image_urls') or []
    if imgs:
        return imgs[0]
    return row.get('video_preview_url') or ''


async def detect(session, sem, image_url):
    """Mirror of facebookadscraperapify2026-v2.gpt_detect_creative_language, built on
    the same creative_language.py prompt + parser. Returns a language name, '' for
    'no readable text', or None on failure (so the caller leaves it NULL to retry)."""
    messages = creative_language.build_creative_language_messages(image_url)
    if messages is None:
        return None
    async with sem:
        try:
            payload = {
                "model": creative_language.CREATIVE_LANGUAGE_MODEL,
                "messages": messages,
                "max_tokens": 10,
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
                    return creative_language.normalize_language(data['choices'][0]['message']['content'])
                print(f"  OpenAI {resp.status}: {(await resp.text())[:120]}")
                return None
        except Exception as e:
            print(f"  creative-language error: {e}")
            return None


def fetch_rows(do_all, limit):
    # Only NULL is "unclassified"; '' is a real result (no readable text), so it is
    # left alone unless --all forces a full re-classify.
    cols = 'ad_archive_id, creative_language, original_image_urls, video_preview_url'
    sql = f'select {cols} from ads'
    params: list = []
    if not do_all:
        sql += ' where creative_language is null'
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
                'update ads set creative_language = %s where ad_archive_id = %s',
                [(lang, aid) for (aid, lang) in updates],
            )


async def main(args):
    if not OPENAI_API_KEY:
        raise SystemExit('OPENAI_API_KEY is not set (put it in .env.local).')

    rows = fetch_rows(args.all, args.limit)
    print(f'{len(rows)} ad(s) to classify'
          + ('' if args.all else ' (not yet classified)'), flush=True)
    if not rows:
        return

    sem = asyncio.Semaphore(CONCURRENCY)
    written = failed = no_text = with_text = 0

    async def classify(session, row):
        aid = row['ad_archive_id']
        image = image_from_row(row)
        if not image:
            return ('update', (aid, ''))   # no creative to read -> no text, done
        new = await detect(session, sem, image)
        if new is None:
            return ('fail', None)          # leave NULL, retry next run
        return ('update', (aid, new))

    async with aiohttp.ClientSession() as session:
        for start in range(0, len(rows), BATCH_SIZE):
            chunk = rows[start:start + BATCH_SIZE]
            results = await asyncio.gather(*(classify(session, r) for r in chunk))
            updates = [u for (kind, u) in results if kind == 'update']
            failed += sum(1 for (kind, _) in results if kind == 'fail')
            no_text += sum(1 for (_aid, v) in updates if v == '')
            with_text += sum(1 for (_aid, v) in updates if v != '')
            if updates and not args.dry_run:
                write_updates(updates)
                written += len(updates)
            done = min(start + BATCH_SIZE, len(rows))
            print(f'  [{done}/{len(rows)}] +{len(updates)} classified'
                  + (' (dry run, nothing saved)' if args.dry_run else '')
                  + f'  | with_text={with_text} no_text={no_text} failed(retry)={failed}',
                  flush=True)

    print(f'\ndone: {written} written ({with_text} with text, {no_text} no text), '
          f'{failed} failed and left for a re-run'
          + (' [dry run - nothing saved]' if args.dry_run else ''), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description='Detect the language of text on ad creatives.')
    p.add_argument('--all', action='store_true',
                   help='re-classify every ad, not only unclassified ones')
    p.add_argument('--dry-run', action='store_true', help='print changes, write nothing')
    p.add_argument('--limit', type=int, default=0, help='cap number of rows (testing)')
    asyncio.run(main(p.parse_args()))
