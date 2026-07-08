"""
run_scrape.py - DB-native scrape orchestrator.

Replaces the old Google Sheets flow. Reads config from the database, reuses the
existing scraper's proven functions (Apify fetch, ScrapingBee article scrape,
GPT enrichment, GCS media upload), and upserts results into the ads table with
run tracking.

Modes:
  python run_scrape.py                       process every due domain (scheduled)
  python run_scrape.py --query "acme.com"    ad-hoc single query (testing)
        [--max 5] [--country ALL] [--feed ""] [--retries 1] [--no-media]

Secrets come from .env.local/.env locally, or from injected env vars in CI.
"""

import sys

# Windows consoles may use a legacy code page (e.g. cp1255) that cannot encode
# the scraper's emoji output. Force UTF-8 on our streams so prints never crash.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

import argparse
import asyncio
import os
from datetime import datetime, timezone
from pathlib import Path

# ── Load local secrets before importing the scraper (its module-level code
#    requires the API keys to be present). In CI these come from the environment.
try:
    from dotenv import load_dotenv
    _here = Path(__file__).resolve().parent
    load_dotenv(_here / '.env')
    load_dotenv(_here / '.env.local', override=True)
except ImportError:
    pass

import importlib.util
import aiohttp
from google.oauth2 import service_account
from google.cloud import storage

import db

# ── Load the existing scraper as a module (its filename has hyphens, so it
#    can't be imported normally). We reuse its functions, not its Sheets flow.
_spec = importlib.util.spec_from_file_location(
    'fb_scraper', Path(__file__).resolve().parent / 'facebookadscraperapify2026-v2.py'
)
fb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fb)


# ═════════════════════════════════════════════════════════════════════════════
# GCS storage client (built from individual env vars, not a JSON file)
# ═════════════════════════════════════════════════════════════════════════════
def get_bucket():
    email = os.environ['GCS_CLIENT_EMAIL']
    project_id = email.split('@')[1].split('.')[0]   # name@<project>.iam.gserviceaccount.com
    info = {
        'type': 'service_account',
        'project_id': project_id,
        'private_key_id': os.environ.get('GCS_PRIVATE_KEY_ID', ''),
        'private_key': os.environ['GCS_PRIVATE_KEY'].replace('\\n', '\n'),
        'client_email': email,
        'client_id': os.environ.get('GCS_CLIENT_ID', ''),
        'token_uri': 'https://oauth2.googleapis.com/token',
    }
    creds = service_account.Credentials.from_service_account_info(info)
    client = storage.Client(project=project_id, credentials=creds)
    return client.get_bucket(os.environ.get('GCS_BUCKET', 'aporia-unleash'))


# ═════════════════════════════════════════════════════════════════════════════
# Ad -> database row
# ═════════════════════════════════════════════════════════════════════════════
def build_ad_dict(ad, media, article_title, article_content, rank, feed, domain,
                  language, country, vertical):
    """Map a raw Apify ad + enrichment + media to a db.AD_COLUMNS dict."""
    snapshot = ad.get('snapshot', {})
    body = snapshot.get('body', {})

    caption = snapshot.get('caption', '')
    cta_text = snapshot.get('cta_text', '')
    body_text = body.get('text', '') if isinstance(body, dict) else ''
    cta_type = snapshot.get('cta_type', '')
    link_description = snapshot.get('link_description', '')
    link_url = snapshot.get('link_url', '')
    title = snapshot.get('title', '')

    # DCO: fold multi-card variants into a single ' | '-joined value each.
    dco = {k: [] for k in ('caption', 'cta_text', 'body', 'cta_type',
                           'link_description', 'link_url', 'title')}
    for card in snapshot.get('cards', []):
        for k in dco:
            if card.get(k):
                dco[k].append(card[k])
    caption = ' | '.join(dco['caption']) or caption
    cta_text = ' | '.join(dco['cta_text']) or cta_text
    body_text = ' | '.join(dco['body']) or body_text
    cta_type = ' | '.join(dco['cta_type']) or cta_type
    link_description = ' | '.join(dco['link_description']) or link_description
    link_url = ' | '.join(dco['link_url']) or link_url
    title = ' | '.join(dco['title']) or title

    start_date = None
    raw = ad.get('start_date')
    if raw:
        try:
            start_date = datetime.fromtimestamp(int(raw), tz=timezone.utc)
        except Exception:
            start_date = None

    return {
        'ad_archive_id': str(ad.get('ad_archive_id', '')),
        'page_id': ad.get('page_id', ''),
        'page_name': ad.get('page_name', ''),
        'domain': domain,
        'feed': feed,
        'caption': caption,
        'cta_text': cta_text,
        'body_text': body_text,
        'cta_type': cta_type,
        'title': title,
        'link_description': link_description,
        'link_url': link_url,
        'display_format': snapshot.get('display_format', ''),
        'extra_texts': ', '.join(snapshot.get('extra_texts', [])),
        'original_image_urls': media['main_images'],
        'video_hd_url': media['video_hd'] or None,
        'video_preview_url': media['video_preview'] or None,
        'extra_image_urls': media['extra_images'],
        'extra_video_urls': media['extra_videos'],
        'publisher_platform': ad.get('publisher_platform', []),
        'start_date': start_date,
        'total_active_time': str(ad.get('total_active_time', '')),
        'article_title': article_title,
        'article_content': article_content,
        'rank': rank,
        'language': language,
        'country': country,
        'vertical': vertical,
    }


_EMPTY_MEDIA = {'main_images': [], 'video_hd': '', 'video_preview': '',
                'extra_images': [], 'extra_videos': []}


async def process_ad(ad, rank, bucket, verticals, feed, domain, gpt_session):
    """Scrape article, run GPT enrichment, upload media, return a db row dict."""
    snapshot = ad.get('snapshot', {})
    body_obj = snapshot.get('body', {})
    body_text = body_obj.get('text', '') if isinstance(body_obj, dict) else ''
    link_url = snapshot.get('link_url', '')
    if not link_url and snapshot.get('cards'):
        link_url = snapshot['cards'][0].get('link_url', '')

    article_title, article_content = '', ''
    if link_url:
        article_title, article_content = await fb.scrape_article_async(link_url)

    language, country, vertical = await asyncio.gather(
        fb.gpt_detect_language(gpt_session, article_title, body_text),
        fb.gpt_detect_country(gpt_session, article_title, body_text, article_content),
        fb.gpt_detect_vertical(gpt_session, article_title, body_text, article_content, verticals),
    )

    media = await fb.process_ad_media(ad, bucket, {}) if bucket is not None else dict(_EMPTY_MEDIA)

    return build_ad_dict(ad, media, article_title, article_content, rank,
                         feed, domain, language, country, vertical)


# ═════════════════════════════════════════════════════════════════════════════
# Per-query scrape
# ═════════════════════════════════════════════════════════════════════════════
async def scrape_query(run_id, bucket, verticals, existing_ids, params, feed, domain, retries):
    ads = await fb.fetch_facebook_ads_apify_with_resume(params, max_retries=retries, retry_delay=90)
    if not ads:
        print(f'  no ads returned for "{domain}"')
        return (0, 0)

    old_enough = [a for a in ads if fb.is_ad_at_least_week_old(a)]
    new_ads = [a for a in old_enough if str(a.get('ad_archive_id', '')) not in existing_ids]
    print(f'  {len(ads)} fetched, {len(old_enough)} old-enough, {len(new_ads)} new to process')
    if not new_ads:
        return (0, 0)

    total_found = total_new = 0
    batch_size = fb.AD_BATCH_SIZE
    async with aiohttp.ClientSession() as gpt_session:
        for start in range(0, len(new_ads), batch_size):
            batch = new_ads[start:start + batch_size]
            results = await asyncio.gather(*[
                process_ad(ad, start + i + 1, bucket, verticals, feed, domain, gpt_session)
                for i, ad in enumerate(batch)
            ], return_exceptions=True)

            rows = []
            for ad, res in zip(batch, results):
                if isinstance(res, Exception):
                    print(f'    error on {ad.get("ad_archive_id")}: {res}')
                elif res:
                    rows.append(res)
                    existing_ids.add(res['ad_archive_id'])

            if rows:
                with db.connect() as conn:
                    f, n = db.upsert_ads(conn, run_id, rows)
                total_found += f
                total_new += n
                print(f'    upserted batch: {n} new (running total {total_new})')

    return (total_found, total_new)


# ═════════════════════════════════════════════════════════════════════════════
# Orchestration
# ═════════════════════════════════════════════════════════════════════════════
async def run(args):
    fb.GPT_SEMAPHORE = asyncio.Semaphore(10)
    fb.SCRAPING_SEMAPHORE = asyncio.Semaphore(10)

    # Scheduled mode (no --query): skip cheaply if nothing is due, so an hourly
    # cron does not create an empty run record every hour.
    if not args.query:
        with db.connect() as conn:
            if not db.any_domain_due(conn):
                print('nothing due; exiting')
                return

    bucket = None
    if not args.no_media:
        bucket = get_bucket()
        print(f'GCS bucket ready: {bucket.name}')
    else:
        print('media upload disabled (--no-media)')

    # Claim the run and load config (short-lived connection).
    with db.connect() as conn:
        verticals = [r['name'] for r in _all_verticals(conn)]
        existing_ids = db.existing_ad_ids(conn)
        run_id = db.claim_run(conn, trigger_source='manual')
    if not run_id:
        print('another run is already active; exiting')
        return
    print(f'run {run_id} claimed | {len(verticals)} verticals | {len(existing_ids)} ads already stored')

    total_found = total_new = 0
    try:
        if args.query:
            params = {'query': args.query, 'country': args.country,
                      'activeStatus': 'active', 'max_target_results': args.max}
            print(f'scraping query "{args.query}" (max {args.max})...')
            f, n = await scrape_query(run_id, bucket, verticals, existing_ids,
                                      params, args.feed, args.query, args.retries)
            total_found, total_new = f, n
        else:
            with db.connect() as conn:
                due = db.get_due_domains(conn)
            print(f'{len(due)} domain(s) due')
            for dom in due:
                params = {'query': dom['query'], 'country': dom['country'],
                          'activeStatus': dom['active_status'],
                          'max_target_results': dom['max_ads']}
                print(f'scraping "{dom["query"]}" (max {dom["max_ads"]})...')
                f, n = await scrape_query(run_id, bucket, verticals, existing_ids,
                                          params, dom.get('feed') or '', dom['query'], args.retries)
                total_found += f
                total_new += n
                with db.connect() as conn:
                    db.bump_domain_schedule(conn, dom['id'], dom['cadence'])

        with db.connect() as conn:
            db.finish_run(conn, run_id, total_found, total_new)
        print(f'\nDONE: found={total_found} new={total_new}')
        _notify_slack(total_found, total_new)
    except Exception as e:
        with db.connect() as conn:
            db.fail_run(conn, run_id, e)
        print(f'\nrun FAILED: {e}')
        raise


def _notify_slack(found, new):
    """Post a Slack message when a run captures new ads (if SLACK_WEBHOOK_URL is set)."""
    url = os.environ.get('SLACK_WEBHOOK_URL')
    if not url or new <= 0:
        return
    try:
        import json as _json
        import urllib.request
        text = (f":mag: Ad Intel scrape complete. {new} new ad(s) captured "
                f"({found} seen this run). Open the dashboard to review fresh finds.")
        data = _json.dumps({'text': text}).encode('utf-8')
        req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=10).read()
        print('slack notified')
    except Exception as e:
        print(f'slack notify failed: {e}')


def _all_verticals(conn):
    with conn.cursor() as cur:
        cur.execute('select name from verticals order by name')
        return cur.fetchall()


def main():
    ap = argparse.ArgumentParser(description='DB-native Facebook Ad Library scrape')
    ap.add_argument('--query', help='ad-hoc single query (domain or keyword) for testing')
    ap.add_argument('--max', type=int, default=5, help='max ads for the ad-hoc query')
    ap.add_argument('--country', default='ALL')
    ap.add_argument('--feed', default='')
    ap.add_argument('--retries', type=int, default=1, help='Apify resume attempts')
    ap.add_argument('--no-media', action='store_true', help='skip GCS media upload')
    asyncio.run(run(ap.parse_args()))


if __name__ == '__main__':
    main()
