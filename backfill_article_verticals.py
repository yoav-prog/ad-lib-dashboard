"""
backfill_article_verticals.py - work out, for every ad, which of OUR verticals its
landing article belongs with, and which of our domains already covers it.

Why this exists
    The dashboard's "do we already have an article for this?" column needs two facts
    that live in two different databases and cannot be joined:

        ads.article_verticals     the vertical family of this ad's landing article,
                                  in the ARTICLES database's own vocabulary
        ads.our_article_domains   which of our 47 domains hold at least one article
                                  matching this ad on country + language + one of
                                  those verticals

    Pass 1 derives the family from the article text (embedding shortlist, then
    gpt-4.1-mini picks from it - see article_verticals.py, which the live path would
    share). Pass 2 turns that into the per-domain answer the feed's SQL filter reads.
    The columns are additive (migration 0017); a row that has never been through here
    is NULL, which the UI reads as "not derived yet", not as "we have nothing".

    The article text is usually already stored: 25,913 of 29,966 approved ads carry
    `article_content` from their original scrape. Only the ~4,053 that do not get a
    ScrapingBee fetch (cheap first, JS-rendered only if that came back too short - see
    scrape_article), and the result is written back so it is never fetched twice.
    An ad whose landing page has no article at all - an RSOC search page, a dead link -
    is classified from the vertical the pipeline already assigned it, plus a short slice
    of its own copy; never from an error stub.

Usage
    python backfill_article_verticals.py                  # derive + map everything outstanding
    python backfill_article_verticals.py --all            # re-derive every ad, even done ones
    python backfill_article_verticals.py --limit 50       # cap rows (do a small run first)
    python backfill_article_verticals.py --dry-run        # print, write nothing, call no LLM
    python backfill_article_verticals.py --no-scrape      # skip ads with no stored article
    python backfill_article_verticals.py --domains-only   # pass 2 only (after new articles land)
    python backfill_article_verticals.py --no-article-only --no-scrape   # redo just the RSOC rows
    python backfill_article_verticals.py --model gpt-4o-mini   # cheaper, ~3x less

Needs DATABASE_URL, ARTICLES_DATABASE_URL, OPENAI_API_KEY, and (unless --no-scrape)
SCRAPINGBEE_API_KEY, from .env / .env.local or the environment.

Cost, measured against the real row counts (see _plans/2026-08-19-our-articles-by-domain.md):
~$8 of gpt-4.1-mini + ~$0.25 of embeddings + a few dollars of ScrapingBee (4,053 plain
fetches, plus a 5-credit render for the ones that come back JS-gated) for a full
29,966-ad backfill. About $0.0003 per ad after that.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
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
import psycopg
from psycopg.rows import dict_row

import article_verticals as av
import db

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
SCRAPINGBEE_API_KEY = os.environ.get('SCRAPINGBEE_API_KEY')
ARTICLES_DATABASE_URL = os.environ.get('ARTICLES_DATABASE_URL')

# Embedding calls are cheap and batched; the chat calls are the slow leg, so
# concurrency is tuned for them and stays inside a normal account's rate limits (a
# 429 just leaves that ad for the next run, so overshooting self-heals but wastes
# calls). Rows are written after every batch, not once at the end, so a long run is
# crash-safe and a re-run resumes from the first row still undone.
CONCURRENCY = 32
BATCH_SIZE = 256
EMBED_BATCH = 256          # inputs per embeddings request (the API caps at 2048)
MIN_ARTICLE_CHARS = 200    # below this a stored article is treated as absent

# (connect, read) seconds for the ScrapingBee HTTP call itself, and the ceiling on one ad's
# whole scrape step.
#
# These are not belt-and-braces, they are load-bearing. The `timeout` inside the params dict
# is ScrapingBee's OWN page-load timeout - it is sent to their API as a query parameter and
# says nothing about our socket. Only a top-level `timeout=` reaches requests (the SDK passes
# **kwargs straight through to session.request). Without it requests waits forever, and one
# stalled connection wedges the executor thread, then the asyncio.gather over the batch, then
# the entire run: observed live, a full backfill sat dead for 65 minutes mid-batch having
# printed nothing. The read budget is comfortably above ScrapingBee's own 30s page timeout so
# a legitimate JS render is never cut short.
HTTP_TIMEOUT = (15, 90)
SCRAPE_DEADLINE = 240      # seconds for one ad: a plain fetch plus a rendered retry, with slack


# ═════════════════════════════════════════════════════════════════════════════
# ARTICLES DATABASE - read-only
# ═════════════════════════════════════════════════════════════════════════════
def articles_connect():
    """A read-only connection to the articles (Mega Uploader) database. Separate
    from db.connect(), which owns the adintel side; this script is the only thing in
    the pipeline that needs both at once. The URL may arrive in SQLAlchemy form
    (postgresql+asyncpg://) since that is how the credential is stored elsewhere."""
    if not ARTICLES_DATABASE_URL:
        raise SystemExit('ARTICLES_DATABASE_URL is not set (see .env.example).')
    dsn = re.sub(r'^(postgresql|postgres)\+\w+://', r'\1://', ARTICLES_DATABASE_URL.strip())
    return psycopg.connect(dsn, row_factory=dict_row, connect_timeout=db.CONNECT_TIMEOUT_SECONDS)


def load_vocabulary():
    """Every vertical we actually publish under, with the category it most often
    carries. ~2k rows. Only our own articles (is_external = false) count: an
    external row is a competitor's, and matching an ad to one would be pointless."""
    with articles_connect() as conn, conn.cursor() as cur:
        cur.execute("""
            select vertical, mode() within group (order by category) as category, count(*)::int as n
              from articles
             where is_external = false and url like 'http%%'
               and vertical is not null and btrim(vertical) <> ''
             group by vertical
             order by n desc
        """)
        return cur.fetchall()


def load_domain_index():
    """Every (domain, country, language, vertical) we hold at least one article for.
    61,505 rows today - small enough to answer pass 2 for all 30k ads in memory
    rather than issuing a query per ad. Returns {(country, language, vertical): {domains}}."""
    index: dict[tuple[str, str, str], set[str]] = {}
    with articles_connect() as conn, conn.cursor() as cur:
        cur.execute("""
            select distinct domain, country, language, vertical
              from articles
             where is_external = false and url like 'http%%'
               and domain is not null and country is not null
               and language is not null and vertical is not null
        """)
        for r in cur:
            key = (av.country_key(r['country']), av.language_key(r['language']), r['vertical'])
            index.setdefault(key, set()).add(r['domain'])
    return index


# ═════════════════════════════════════════════════════════════════════════════
# OPENAI
# ═════════════════════════════════════════════════════════════════════════════
async def embed_batch(session, texts, model=av.EMBED_MODEL):
    """Embeddings for a batch of strings, in the order given. Returns None on any
    failure so the caller can skip that batch rather than write half an answer."""
    try:
        async with session.post(
            'https://api.openai.com/v1/embeddings',
            headers={'Authorization': f'Bearer {OPENAI_API_KEY}', 'Content-Type': 'application/json'},
            json={'model': model, 'input': texts},
            timeout=aiohttp.ClientTimeout(total=120),
        ) as resp:
            if resp.status != 200:
                print(f'  OpenAI embeddings {resp.status}: {(await resp.text())[:160]}', flush=True)
                return None
            data = await resp.json()
            return [d['embedding'] for d in sorted(data['data'], key=lambda d: d['index'])]
    except Exception as e:
        print(f'  embedding error: {e}', flush=True)
        return None


async def choose_family(session, sem, excerpt, candidates, model):
    """One chat call: the article plus its shortlist in, the vertical family out.

    Returns None on ANY failure, and a list (possibly empty) on a real answer. The
    distinction matters more than it looks: an empty list is written to the database
    and means "we looked, nothing fits", which stops the ad being reconsidered. If a
    rate limit or a dropped connection also produced an empty list, one bad afternoon
    would permanently mark thousands of ads as checked-and-empty.
    """
    messages = av.build_messages(excerpt, candidates)
    if messages is None:
        return None
    async with sem:
        try:
            async with session.post(
                'https://api.openai.com/v1/chat/completions',
                headers={'Authorization': f'Bearer {OPENAI_API_KEY}', 'Content-Type': 'application/json'},
                json={'model': model, 'messages': messages, 'max_tokens': 160, 'temperature': 0},
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return av.parse_family(data['choices'][0]['message']['content'], candidates)
                print(f'  OpenAI {resp.status}: {(await resp.text())[:160]}', flush=True)
                return None
        except Exception as e:
            # The type matters as much as the message: the common failure here is an
            # asyncio/aiohttp timeout, whose str() is empty, so "vertical error: " alone
            # tells you nothing about a run that left rows behind.
            print(f'  vertical error: {type(e).__name__}: {e}', flush=True)
            return None


# ═════════════════════════════════════════════════════════════════════════════
# SCRAPINGBEE - only for ads with no stored article
# ═════════════════════════════════════════════════════════════════════════════
def _fetch(url, render_js):
    """One ScrapingBee call -> (title, body, ok). `ok` distinguishes "the page answered,
    and this is what it said" from "the request failed", which is what decides whether a
    five-credit render retry is worth paying for. The non-render parameters are deliberately
    identical to facebookadscraperapify2026-v2._scrape_article_sync, so the markdown shape
    here is the same one the live pipeline stores."""
    try:
        from scrapingbee import ScrapingBeeClient
        client = ScrapingBeeClient(api_key=SCRAPINGBEE_API_KEY)
        resp = client.get(url, params={
            'render_js': render_js, 'return_page_markdown': True,
            'block_resources': not render_js, 'timeout': 30000,
        }, timeout=HTTP_TIMEOUT)
        if not resp.ok:
            return '', '', False
        title, body = '', []
        for line in resp.text.strip().split('\n'):
            stripped = line.strip()
            if not title and stripped:
                title = stripped.lstrip('#').strip()
            elif title:
                body.append(line)
        return title[:500], '\n'.join(body).strip(), True
    except Exception as e:
        print(f'  scrape error for {url[:70]}: {e}', flush=True)
        return '', '', False


def scrape_article(url):
    """(title, body) for one landing page, cheapest-first.

    A plain fetch costs one credit; JS rendering costs five. Many of these landings are
    client-rendered and answer a plain fetch with a 78-character "JavaScript Required"
    stub - measured live, three of five sampled hosts do exactly that, and rendering
    returns 3,000+ characters of real article. So: try plain, and pay for a render only
    when the page ANSWERED and what it said was too short to be an article. A request that
    failed outright is a dead link (the two remaining sampled hosts 500 either way), and
    rendering it again just burns five more credits for the same nothing.

    Anything still under MIN_ARTICLE_CHARS comes back as nothing at all, because an
    interstitial stub is worse than an empty result: it would be embedded and classified
    into a confident, completely wrong vertical family.
    """
    if not url or not url.startswith('http'):
        return '', ''
    title, body, ok = _fetch(url, False)
    if ok and len(body) < MIN_ARTICLE_CHARS:
        title, body, ok = _fetch(url, True)
    return (title, body) if ok and len(body) >= MIN_ARTICLE_CHARS else ('', '')


# ═════════════════════════════════════════════════════════════════════════════
# ADINTEL DATABASE
# ═════════════════════════════════════════════════════════════════════════════
def fetch_ads(do_all, limit, no_article_only=False):
    """Approved ads needing a vertical family. Approved only: the feed shows nothing
    else, so classifying a pending or rejected ad would spend money on a row nobody
    can see. Newest first, so a capped run works on what matters most.

    `no_article_only` selects exactly the ads with no readable landing article,
    whether or not they already have a family. That is the re-run to reach for after
    the fallback itself changes: the ~3.4k RSOC rows are the only ones it affects, and
    re-deriving all 30k to fix them would cost thirty times as much.
    """
    sql = """
        select ad_archive_id, article_title, article_content, link_url, resolved_url,
               title, body_text, caption, vertical, country, language, creative_language
          from ads
         where review_status = 'approved'
    """
    params: list = []
    if no_article_only:
        sql += ' and (article_content is null or length(article_content) <= %s)'
        params.append(MIN_ARTICLE_CHARS)
    elif not do_all:
        sql += ' and article_verticals is null'
    sql += ' order by first_seen_at desc nulls last'
    if limit:
        sql += ' limit %s'
        params.append(int(limit))
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def write_families(updates):
    """(ad_archive_id, [verticals]) -> ads. An empty list is written as an empty
    array, not NULL: "we looked and found nothing" is a different fact from "never
    looked", and only the latter should be retried by the next run."""
    with db.connect() as conn, conn.cursor() as cur:
        cur.executemany(
            'update ads set article_verticals = %s, article_verticals_at = now() '
            'where ad_archive_id = %s',
            [(verts, aid) for (aid, verts) in updates],
        )


def write_article_text(updates):
    """Persist what ScrapingBee fetched, so the next run reads it for free."""
    with db.connect() as conn, conn.cursor() as cur:
        cur.executemany(
            'update ads set article_title = coalesce(nullif(%s, \'\'), article_title), '
            'article_content = coalesce(nullif(%s, \'\'), article_content) '
            'where ad_archive_id = %s',
            [(t, b, aid) for (aid, t, b) in updates],
        )


def write_domains(updates):
    with db.connect() as conn, conn.cursor() as cur:
        cur.executemany(
            'update ads set our_article_domains = %s where ad_archive_id = %s',
            [(doms, aid) for (aid, doms) in updates],
        )


async def scrape_one(url):
    """One ad's scrape, off the event loop and under a hard deadline.

    Defence in depth behind HTTP_TIMEOUT: a thread that somehow still overruns cannot hold
    up the batch's gather, and therefore cannot stall the run. Cancelling does not kill the
    underlying thread - Python cannot - but it does free the loop, and the thread dies when
    its own socket timeout fires. Returns ('', '') on anything unusable, which drops the ad
    to the vertical/copy fallback rather than losing it.
    """
    loop = asyncio.get_running_loop()
    try:
        return await asyncio.wait_for(loop.run_in_executor(None, scrape_article, url), SCRAPE_DEADLINE)
    except asyncio.TimeoutError:
        print(f'  scrape deadline hit for {url[:70]}', flush=True)
        return '', ''
    except Exception as e:
        print(f'  scrape failed for {url[:70]}: {type(e).__name__}: {e}', flush=True)
        return '', ''


def excerpt_for(row):
    """The text we classify one ad from.

    The landing article when we have a real one - that is the whole point of the feature.
    When we do not (an RSOC search page, a dead link, a render that still came back empty),
    fall back to the ad's already-assigned VERTICAL, plus a short slice of its own copy; see
    article_verticals.fallback_excerpt for why the vertical leads. A stored body under
    MIN_ARTICLE_CHARS is treated as absent, so a "JavaScript Required" interstitial never
    gets classified as if it were an article about JavaScript.
    """
    content = row.get('article_content') or ''
    if len(content) >= MIN_ARTICLE_CHARS:
        return av.article_excerpt(row.get('article_title') or row.get('title'), content)
    return av.fallback_excerpt(
        row.get('vertical'),
        (row.get('title'), row.get('body_text'), row.get('caption')),
    )


def landing_url(row):
    """The URL to scrape when an ad has no stored article: the followed destination
    first, then the first of link_url's pipe-joined DCO destinations."""
    if row.get('resolved_url'):
        return row['resolved_url']
    return (row.get('link_url') or '').split(' | ')[0].strip()


# ═════════════════════════════════════════════════════════════════════════════
# PASS 1 - derive the vertical family
# ═════════════════════════════════════════════════════════════════════════════
async def derive_families(args):
    import numpy as np

    rows = fetch_ads(args.all, args.limit, args.no_article_only)
    label = (' with no readable landing article' if args.no_article_only
             else '' if args.all else ' (no family yet)')
    print(f'{len(rows)} approved ad(s) to classify{label}', flush=True)
    if not rows:
        return 0

    vocab = load_vocabulary()
    print(f'{len(vocab)} distinct vertical(s) in our articles vocabulary', flush=True)
    descriptors = [av.vocabulary_descriptor(v['vertical'], v['category']) for v in vocab]
    names = [v['vertical'] for v in vocab]

    if args.dry_run:
        missing = sum(1 for r in rows if len((r.get('article_content') or '')) < MIN_ARTICLE_CHARS)
        print(f'DRY RUN: would embed {len(vocab)} verticals + {len(rows)} articles, '
              f'scrape {missing}, and make {len(rows)} {args.model} call(s).', flush=True)
        return 0

    async with aiohttp.ClientSession() as session:
        # The vocabulary is embedded once per run and reused by every ad.
        vecs = []
        for i in range(0, len(descriptors), EMBED_BATCH):
            got = await embed_batch(session, descriptors[i:i + EMBED_BATCH])
            if got is None:
                raise SystemExit('Could not embed the vocabulary; aborting before spending on ads.')
            vecs.extend(got)
        vocab_matrix = np.asarray(vecs, dtype='float32')
        print(f'vocabulary embedded: {vocab_matrix.shape[0]} x {vocab_matrix.shape[1]}', flush=True)

        sem = asyncio.Semaphore(CONCURRENCY)
        done = scraped = classified = 0

        for start in range(0, len(rows), BATCH_SIZE):
            batch = rows[start:start + BATCH_SIZE]
            # Announce each phase before entering it. A batch takes under a minute, so silence
            # for longer than that now names the stage it is stuck in - the earlier hang printed
            # nothing at all for 65 minutes and looked identical to slow progress.
            print(f'  batch {start // BATCH_SIZE + 1}: scraping...', flush=True)

            # 1. make sure each ad has article text, fetching only the ones that lack it.
            fetched: list[tuple[str, str, str]] = []
            if not args.no_scrape:
                need = [r for r in batch if len(r.get('article_content') or '') < MIN_ARTICLE_CHARS
                        and landing_url(r)]
                if need:
                    if not SCRAPINGBEE_API_KEY:
                        raise SystemExit('SCRAPINGBEE_API_KEY is not set (or pass --no-scrape).')
                    results = await asyncio.gather(*[scrape_one(landing_url(r)) for r in need])
                    for r, (t, b) in zip(need, results):
                        if b:
                            r['article_title'] = r.get('article_title') or t
                            r['article_content'] = b
                            fetched.append((r['ad_archive_id'], t, b))
                    scraped += len(fetched)
                    if fetched:
                        write_article_text(fetched)

            # 2. embed each ad's article, in the same order, and shortlist against the vocabulary.
            print(f'  batch {start // BATCH_SIZE + 1}: embedding...', flush=True)
            excerpts = [excerpt_for(r) for r in batch]
            usable = [i for i, e in enumerate(excerpts) if e]
            shortlists: dict[int, list[str]] = {}
            for i in range(0, len(usable), EMBED_BATCH):
                idx = usable[i:i + EMBED_BATCH]
                got = await embed_batch(session, [excerpts[j] for j in idx])
                if got is None:
                    continue     # leave this slice for the next run rather than guessing
                for j, vec in zip(idx, got):
                    picks = av.shortlist_indices(vec, vocab_matrix, av.SHORTLIST_SIZE)
                    shortlists[j] = [names[p] for p in picks]

            # 3. one chat call per ad, from its own shortlist.
            print(f'  batch {start // BATCH_SIZE + 1}: classifying {len(shortlists)}...', flush=True)
            order = sorted(shortlists)
            families = await asyncio.gather(*[
                choose_family(session, sem, excerpts[j], shortlists[j], args.model) for j in order
            ])
            # None means the call failed; drop those so the row stays NULL and is retried.
            by_index = {j: f for j, f in zip(order, families) if f is not None}

            # Only rows we have a real answer for are written. Two answers count as real:
            # a family the model chose, and "this ad has no article text at all" (an empty
            # family, so the next run does not pay to look at it again - a true re-check is
            # --all). A row whose embedding or chat call failed is left NULL instead, so a
            # rate limit or a dropped connection cannot permanently mark an ad as "checked,
            # nothing found" - the next run picks it up exactly as if it had never run.
            updates = [
                (batch[i]['ad_archive_id'], by_index.get(i, []))
                for i in range(len(batch))
                if i in by_index or not excerpts[i]
            ]
            write_families(updates)
            skipped = len(batch) - len(updates)
            classified += sum(1 for _, f in updates if f)
            done += len(batch)
            print(f'  [{done}/{len(rows)}] scraped {scraped}, with a family {classified}'
                  + (f', left for a later run {skipped}' if skipped else ''), flush=True)

    print(f'pass 1 done: {done} ad(s), {scraped} scraped, {classified} with a vertical family',
          flush=True)
    return done


# ═════════════════════════════════════════════════════════════════════════════
# PASS 2 - which of our domains covers each ad
# ═════════════════════════════════════════════════════════════════════════════
def map_domains(args):
    """Turn each ad's family into the list of our domains that actually hold a
    matching article, using the same country + language + vertical rule
    web/lib/ourmatch.js applies live. Pure lookups against an in-memory index, so
    this costs nothing and can be re-run whenever new articles are published."""
    index = load_domain_index()
    print(f'{len(index)} (country, language, vertical) combination(s) across our domains',
          flush=True)

    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("""
            select ad_archive_id, country, language, creative_language, article_verticals
              from ads
             where review_status = 'approved' and article_verticals is not null
        """)
        rows = cur.fetchall()
    print(f'{len(rows)} ad(s) with a vertical family', flush=True)

    updates = []
    matched = 0
    for r in rows:
        country, language = av.ad_locale(r)
        domains: set[str] = set()
        if country and language:
            for v in (r['article_verticals'] or []):
                domains |= index.get((country, language, v), set())
        if domains:
            matched += 1
        updates.append((r['ad_archive_id'], sorted(domains)))

    if args.dry_run:
        print(f'DRY RUN: would map {len(updates)} ad(s); {matched} have at least one domain.',
              flush=True)
        return

    for i in range(0, len(updates), BATCH_SIZE):
        write_domains(updates[i:i + BATCH_SIZE])
    print(f'pass 2 done: {matched} of {len(updates)} ad(s) have at least one of our domains',
          flush=True)


# ═════════════════════════════════════════════════════════════════════════════
async def main(args):
    if not args.domains_only:
        if not OPENAI_API_KEY:
            raise SystemExit('OPENAI_API_KEY is not set (put it in .env.local).')
        await derive_families(args)
    map_domains(args)


if __name__ == '__main__':
    # A full run is a couple of hours of unattended work, and the rows it touches carry text
    # in 40-odd languages. On a Windows console with a legacy code page a single print of a
    # non-Latin character raises UnicodeEncodeError and takes the whole job down, so
    # unrepresentable characters are replaced rather than fatal.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except Exception:
            pass

    p = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    p.add_argument('--all', action='store_true', help='re-derive every ad, not just the undone ones')
    p.add_argument('--limit', type=int, default=0, help='cap how many ads pass 1 processes')
    p.add_argument('--dry-run', action='store_true', help='print what would happen, write nothing')
    p.add_argument('--no-scrape', action='store_true', help='never call ScrapingBee; skip ads with no stored article')
    p.add_argument('--no-article-only', action='store_true', help='re-derive only the ads with no readable landing article (the RSOC rows), family or not')
    p.add_argument('--domains-only', action='store_true', help='run pass 2 only (after new articles are published)')
    p.add_argument('--model', default=av.VERTICAL_MODEL, help=f'chat model for the family choice (default {av.VERTICAL_MODEL})')
    asyncio.run(main(p.parse_args()))
