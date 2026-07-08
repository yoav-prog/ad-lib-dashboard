"""
backfill_language.py - re-detect the language of existing ads from their own copy.

Why this exists
    Language used to be detected from the scraped landing-page article, which is
    usually English even for Spanish / Portuguese ads, so almost every row was
    stored as "English". The scraper is now fixed (it reads the ad's own copy via
    ad_copy_text), but a normal scrape skips ads it already has, so existing rows
    keep the wrong value. This one-off job re-runs detection over each ad's stored
    creative text and updates the `language` column in place.

Usage
    python backfill_language.py                 # re-detect every ad that has copy
    python backfill_language.py --only-suspect  # only rows currently English / blank
    python backfill_language.py --dry-run       # print changes, write nothing
    python backfill_language.py --limit 50      # cap rows (for a test run first)

Needs DATABASE_URL and OPENAI_API_KEY (from .env / .env.local or the environment).
Cost: one gpt-4.1-mini call per processed ad - cents for a few hundred rows.
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

import db

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
CONCURRENCY = 8

# The ad's own creative text (mirrors ad_copy_text in the scraper, but reads the
# already-stored columns instead of the raw Apify snapshot).
_COPY_COLUMNS = ('body_text', 'caption', 'title', 'link_description', 'extra_texts')
# What counts as "probably wrong / unset" for --only-suspect.
_SUSPECT = ['', 'en', 'eng', 'english']


def ad_copy_from_row(row) -> str:
    parts = [row.get(c) for c in _COPY_COLUMNS]
    return ' | '.join(p.strip() for p in parts if isinstance(p, str) and p.strip())


async def detect_language(session, sem, text):
    """Mirror of facebookadscraperapify2026-v2.gpt_detect_language - keep in sync."""
    text = (text or '').strip()
    if not text:
        return ''
    async with sem:
        try:
            payload = {
                "model": "gpt-4.1-mini",
                "messages": [
                    {"role": "system", "content":
                        "You detect the language of text. Respond with ONLY the language name "
                        "in English, nothing else. Examples: English, Spanish, French, German, Portuguese"},
                    {"role": "user", "content": f"What language is this text?\n\n{text[:500]}"},
                ],
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
                    return data['choices'][0]['message']['content'].strip()
                print(f"  OpenAI {resp.status}: {(await resp.text())[:120]}")
                return ''
        except Exception as e:
            print(f"  language error: {e}")
            return ''


def fetch_rows(only_suspect, limit):
    cols = 'ad_archive_id, language, ' + ', '.join(_COPY_COLUMNS)
    sql = f'select {cols} from ads'
    params: list = []
    if only_suspect:
        sql += " where coalesce(btrim(lower(language)), '') = any(%s)"
        params.append(_SUSPECT)
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
                'update ads set language = %s where ad_archive_id = %s',
                [(lang, aid) for (aid, lang) in updates],
            )


async def main(args):
    if not OPENAI_API_KEY:
        raise SystemExit('OPENAI_API_KEY is not set (put it in .env.local).')

    rows = fetch_rows(args.only_suspect, args.limit)
    print(f'{len(rows)} ad(s) to check'
          + (' (only English / blank)' if args.only_suspect else ''))
    if not rows:
        return

    sem = asyncio.Semaphore(CONCURRENCY)
    updates: list[tuple[str, str]] = []
    skipped = 0

    async with aiohttp.ClientSession() as session:
        async def work(row):
            nonlocal skipped
            copy = ad_copy_from_row(row)
            if not copy:
                skipped += 1
                return
            lang = await detect_language(session, sem, copy)
            old = row.get('language') or ''
            if lang and lang.lower() != old.lower():
                updates.append((row['ad_archive_id'], lang))
                print(f"  {row['ad_archive_id']}: {old or '(none)'} -> {lang}")

        await asyncio.gather(*(work(r) for r in rows))

    unchanged = len(rows) - len(updates) - skipped
    print(f'\n{len(updates)} change(s), {skipped} skipped (no copy), {unchanged} unchanged')
    if args.dry_run:
        print('dry run - nothing written.')
        return
    if updates:
        write_updates(updates)
        print(f'updated {len(updates)} row(s).')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description='Re-detect ad language from stored ad copy.')
    p.add_argument('--only-suspect', action='store_true',
                   help='only rows whose language is currently English or blank')
    p.add_argument('--dry-run', action='store_true', help='print changes, write nothing')
    p.add_argument('--limit', type=int, default=0, help='cap number of rows (testing)')
    asyncio.run(main(p.parse_args()))
