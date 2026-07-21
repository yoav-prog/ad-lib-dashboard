"""
backfill_content_flag.py - screen existing ads against the prohibited-content topics
from their stored creative, so the ones that predate the feature also leave the feed.

Why this exists
    The `content_flag` column is filled by gpt_detect_prohibited during a scrape, but
    a normal scrape skips ads it already has, so every row that predates the feature
    stays NULL (and therefore still shows). This one-off job looks at each ad's stored
    creative image + copy and writes the flag in place. It shares the prompt and
    answer-parsing with the live scraper via content_flag.py, so the two can never
    disagree.

Usage
    python backfill_content_flag.py                 # classify every ad not yet classified
    python backfill_content_flag.py --all           # re-classify every ad (even set ones)
    python backfill_content_flag.py --dry-run       # print changes, write nothing
    python backfill_content_flag.py --limit 50      # cap rows (for a test run first)

Needs DATABASE_URL and OPENAI_API_KEY (from .env / .env.local or the environment).
Cost: one gpt-4.1-mini vision call per processed ad - a fraction of a cent each.

Safety note: this only ever fills a NULL (or, with --all, re-derives) the model's
own classification. It never touches a human's 'none' override from the Filtered view
unless you pass --all, so a re-run of the default mode cannot re-hide an ad someone
already cleared (those rows read 'none', not NULL, so the default filter skips them).
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

import content_flag
import db

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
# Vision calls run several seconds each, so throughput is concurrency-bound; keep it
# high but within a normal account's rate limits (a 429 just leaves that ad for the
# next run, so overshooting self-heals but wastes calls).
CONCURRENCY = 64
# Rows are written to the DB after each batch, not once at the very end, so a long
# run is crash-safe: if the process dies (or a runner times out) mid-way, every
# completed batch is already saved and a re-run resumes from the first row still
# unclassified. A wide batch keeps the per-batch barrier from dominating; at most
# one in-flight batch is re-done after a kill.
BATCH_SIZE = 512

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


async def detect_prohibited(session, sem, ad_copy, image_url):
    """Mirror of facebookadscraperapify2026-v2.gpt_detect_prohibited, built on the same
    content_flag.py prompt + parser so live and backfill never drift."""
    messages = content_flag.build_content_flag_messages(ad_copy, image_url)
    if messages is None:
        return ''
    async with sem:
        try:
            payload = {
                "model": content_flag.CONTENT_FLAG_MODEL,
                "messages": messages,
                "max_tokens": 4,
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
                    return content_flag.normalize_content_flag(data['choices'][0]['message']['content'])
                print(f"  OpenAI {resp.status}: {(await resp.text())[:120]}")
                return ''
        except Exception as e:
            print(f"  prohibited error: {e}")
            return ''


def fetch_rows(do_all, limit):
    cols = ('ad_archive_id, content_flag, original_image_urls, video_preview_url, '
            + ', '.join(_COPY_COLUMNS))
    sql = f'select {cols} from ads'
    params: list = []
    if not do_all:
        sql += " where content_flag is null or btrim(content_flag) = ''"
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
                'update ads set content_flag = %s where ad_archive_id = %s',
                [(flag, aid) for (aid, flag) in updates],
            )


def _fmt_tally(tally) -> str:
    """A compact per-category histogram, hidden categories first then the clean count,
    skipping any category with no hits so the line stays readable."""
    hidden = sum(tally.get(k, 0) for k in content_flag.PROHIBITED_VALUES)
    parts = [f'{k}={tally[k]}' for k in content_flag.PROHIBITED_VALUES if tally.get(k)]
    return f'hidden={hidden}' + (f' ({", ".join(parts)})' if parts else '') + f'  none={tally.get("none", 0)}'


async def main(args):
    if not OPENAI_API_KEY:
        raise SystemExit('OPENAI_API_KEY is not set (put it in .env.local).')

    rows = fetch_rows(args.all, args.limit)
    print(f'{len(rows)} ad(s) to screen'
          + ('' if args.all else ' (not yet classified)'), flush=True)
    if not rows:
        return

    sem = asyncio.Semaphore(CONCURRENCY)
    tally = {k: 0 for k in content_flag.CONTENT_FLAG_VALUES}
    written = skipped = unchanged = 0

    async def classify(session, row):
        copy = copy_from_row(row)
        image = image_from_row(row)
        if not copy and not image:
            return ('skip', None)
        new = await detect_prohibited(session, sem, copy, image)
        old = row.get('content_flag') or ''
        if new and new != old:
            return ('update', (row['ad_archive_id'], new))
        return ('nochange', None)

    async with aiohttp.ClientSession() as session:
        # One batch at a time, flushing each to the DB before the next, so progress
        # is durable and a re-run resumes from wherever this one stopped.
        for start in range(0, len(rows), BATCH_SIZE):
            chunk = rows[start:start + BATCH_SIZE]
            results = await asyncio.gather(*(classify(session, r) for r in chunk))
            updates = [u for (kind, u) in results if kind == 'update']
            skipped += sum(1 for (kind, _) in results if kind == 'skip')
            unchanged += sum(1 for (kind, _) in results if kind == 'nochange')
            for (_aid, new) in updates:
                tally[new] = tally.get(new, 0) + 1
            if updates and not args.dry_run:
                write_updates(updates)
                written += len(updates)
            done = min(start + BATCH_SIZE, len(rows))
            print(f'  [{done}/{len(rows)}] +{len(updates)} classified'
                  + (' (dry run, nothing saved)' if args.dry_run else '')
                  + f'  | {_fmt_tally(tally)}',
                  flush=True)

    print(f'\ndone: {written} written, {skipped} skipped (no copy or image), '
          f'{unchanged} unchanged'
          + (' [dry run - nothing saved]' if args.dry_run else ''), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description='Screen existing ads against prohibited content topics.')
    p.add_argument('--all', action='store_true',
                   help='re-classify every ad, not only unclassified ones (overwrites human overrides)')
    p.add_argument('--dry-run', action='store_true', help='print changes, write nothing')
    p.add_argument('--limit', type=int, default=0, help='cap number of rows (testing)')
    asyncio.run(main(p.parse_args()))
