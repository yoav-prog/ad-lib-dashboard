"""
backfill_rsoc_policy.py - grade existing ads for RSoC policy risk from their stored
creative + copy + domain, so rows that predate the feature also get a Policy tier.

Why this exists
    The rsoc_tier / rsoc_policy_area / rsoc_reason columns are filled by
    gpt_detect_rsoc_risk during a scrape, but a normal scrape skips ads it already has, so
    every row that predates the feature stays NULL (shown as "-" in the Policy column). This
    one-off job looks at each ad's stored creative image + copy + landing domain and writes
    the grade in place. It shares the rubric, the deny-list, and the answer-parsing with the
    live scraper via rsoc_policy.py, so the two can never disagree.

Usage
    python backfill_rsoc_policy.py                 # grade every ad not yet graded
    python backfill_rsoc_policy.py --all           # re-grade every ad (even graded ones)
    python backfill_rsoc_policy.py --dry-run       # print changes, write nothing
    python backfill_rsoc_policy.py --limit 50      # cap rows (run a small eval FIRST)

Needs DATABASE_URL and OPENAI_API_KEY (from .env / .env.local or the environment).
Cost: one gpt-4.1-mini vision call per processed ad - a fraction of a cent each; a full
backfill of the current corpus is roughly $10-40. Run --limit 50 first and eyeball the
result (especially any hazardous row that came back green) before spending on the whole set.

Safety note: this only fills a NULL grade (or, with --all, re-derives one). It writes only
the three rsoc_* columns and never touches review_status, content_flag, or any human field.
The deterministic deny-list floor in rsoc_policy.py applies here exactly as in the scraper,
so a hazardous vertical can never be written as green even if the model call fails.
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
import rsoc_policy

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
# Vision calls run several seconds each, so throughput is concurrency-bound; keep it high
# but within a normal account's rate limits (a 429 just leaves that ad for the next run).
CONCURRENCY = 64
# Rows are written after each batch, not once at the end, so a long run is crash-safe: if
# the process dies mid-way, every completed batch is saved and a re-run resumes from the
# first row still ungraded. At most one in-flight batch is re-done after a kill.
BATCH_SIZE = 512

# The ad's own creative text (mirrors ad_copy_text in the scraper, reading the already-stored
# columns instead of the raw Apify snapshot). Same tuple the content-flag backfill uses.
_COPY_COLUMNS = ('body_text', 'caption', 'title', 'link_description', 'extra_texts')


def copy_from_row(row) -> str:
    parts = [row.get(c) for c in _COPY_COLUMNS]
    return ' | '.join(p.strip() for p in parts if isinstance(p, str) and p.strip())


def image_from_row(row) -> str:
    """The still the vision call looks at: the first stored (permanent GCS) image, else the
    video poster. FB CDN links have long expired, so only these work."""
    imgs = row.get('original_image_urls') or []
    if imgs:
        return imgs[0]
    return row.get('video_preview_url') or ''


async def detect_rsoc(session, sem, ad_copy, image_url, domain):
    """Mirror of facebookadscraperapify2026-v2.gpt_detect_rsoc_risk, built on the same
    rsoc_policy.py rubric + deny-list + parser so live and backfill never drift. Returns a
    (tier, policy_area, reason) verdict, or (None, None, None) when neither the deny-list floor
    nor the model produced anything (the row stays ungraded and is retried next run)."""
    floor = rsoc_policy.hazard_floor(ad_copy, domain)
    messages = rsoc_policy.build_rsoc_messages(ad_copy, image_url, domain)
    if messages is None:
        return rsoc_policy.combine_verdict(None, floor)
    async with sem:
        try:
            payload = {
                "model": rsoc_policy.RSOC_MODEL,
                "messages": messages,
                "max_tokens": 40,
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
                    model_verdict = rsoc_policy.parse_rsoc_answer(data['choices'][0]['message']['content'])
                    return rsoc_policy.combine_verdict(model_verdict, floor)
                print(f"  OpenAI {resp.status}: {(await resp.text())[:120]}")
                return rsoc_policy.combine_verdict(None, floor)
        except Exception as e:
            print(f"  rsoc-policy error: {e}")
            return rsoc_policy.combine_verdict(None, floor)


def fetch_rows(do_all, limit):
    cols = ('ad_archive_id, rsoc_tier, domain, original_image_urls, video_preview_url, '
            + ', '.join(_COPY_COLUMNS))
    sql = f'select {cols} from ads'
    params: list = []
    if not do_all:
        sql += ' where rsoc_tier is null'
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
                'update ads set rsoc_tier = %s, rsoc_policy_area = %s, rsoc_reason = %s '
                'where ad_archive_id = %s',
                [(tier, area, reason, aid) for (aid, tier, area, reason) in updates],
            )


def _fmt_tally(tally) -> str:
    """A compact per-tier histogram (most-severe first), skipping empty tiers."""
    parts = [f'{t}={tally[t]}' for t in ('red', 'yellow', 'green') if tally.get(t)]
    return ' '.join(parts) or 'none'


async def main(args):
    if not OPENAI_API_KEY:
        raise SystemExit('OPENAI_API_KEY is not set (put it in .env.local).')

    rows = fetch_rows(args.all, args.limit)
    print(f'{len(rows)} ad(s) to grade'
          + ('' if args.all else ' (not yet graded)'), flush=True)
    if not rows:
        return

    sem = asyncio.Semaphore(CONCURRENCY)
    tally = {t: 0 for t in rsoc_policy.RSOC_TIERS}
    written = skipped = unchanged = 0

    async def classify(session, row):
        copy = copy_from_row(row)
        image = image_from_row(row)
        domain = row.get('domain') or ''
        tier, area, reason = await detect_rsoc(session, sem, copy, image, domain)
        if tier is None:
            return ('skip', None)          # nothing to look at and no deny-list hit
        if tier != row.get('rsoc_tier') or args.all:
            return ('update', (row['ad_archive_id'], tier, area, reason))
        return ('nochange', None)

    async with aiohttp.ClientSession() as session:
        # One batch at a time, flushing each to the DB before the next, so progress is durable
        # and a re-run resumes from wherever this one stopped.
        for start in range(0, len(rows), BATCH_SIZE):
            chunk = rows[start:start + BATCH_SIZE]
            results = await asyncio.gather(*(classify(session, r) for r in chunk))
            updates = [u for (kind, u) in results if kind == 'update']
            skipped += sum(1 for (kind, _) in results if kind == 'skip')
            unchanged += sum(1 for (kind, _) in results if kind == 'nochange')
            for (_aid, tier, _area, _reason) in updates:
                tally[tier] = tally.get(tier, 0) + 1
            if updates and not args.dry_run:
                write_updates(updates)
                written += len(updates)
            done = min(start + BATCH_SIZE, len(rows))
            print(f'  [{done}/{len(rows)}] +{len(updates)} graded'
                  + (' (dry run, nothing saved)' if args.dry_run else '')
                  + f'  | {_fmt_tally(tally)}',
                  flush=True)

    print(f'\ndone: {written} written, {skipped} skipped (no copy/image and no deny-list hit), '
          f'{unchanged} unchanged'
          + (' [dry run - nothing saved]' if args.dry_run else ''), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description='Grade existing ads for RSoC policy risk.')
    p.add_argument('--all', action='store_true',
                   help='re-grade every ad, not only ungraded ones')
    p.add_argument('--dry-run', action='store_true', help='print changes, write nothing')
    p.add_argument('--limit', type=int, default=0, help='cap number of rows (run a small eval first)')
    asyncio.run(main(p.parse_args()))
