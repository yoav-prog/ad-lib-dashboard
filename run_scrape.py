"""
run_scrape.py - DB-native scrape orchestrator.

Replaces the old Google Sheets flow. Reads config from the database, reuses the
existing scraper's proven functions (Apify fetch, ScrapingBee article scrape,
GPT enrichment, GCS media upload), and upserts results into the ads table with
run tracking.

Modes:
  python run_scrape.py                        process every due domain (scheduled)
  python run_scrape.py --domain-ids "id,id"   run only those tracked rows (targeted)
  python run_scrape.py --query "acme.com"     ad-hoc single query (testing)
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
import threading
import time
import traceback
import uuid
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

# ── The existing scraper (reused for its Apify / ScrapingBee / GPT / GCS
#    functions) is loaded lazily via _load_scraper(), not at import, and only
#    after a run has been claimed. Its module-level code calls _require_env for
#    the API keys, so a missing secret raises the moment it is exec'd. Deferring
#    that load until inside the claimed run's try/except is what lets the failure
#    surface in the dashboard as a FAILED run with the traceback in its log,
#    instead of crashing before there is a run to show. Its filename has hyphens,
#    so it can't be imported normally - hence the spec/exec dance.
fb = None


def _load_scraper():
    """Exec the hyphen-named scraper module once and expose it as the global `fb`.

    Kept out of module import on purpose: the module validates required API keys
    at import time, and we want that validation to happen inside a claimed run so
    any failure is recorded, not silent. Idempotent - safe to call more than once.
    """
    global fb
    if fb is not None:
        return fb
    spec = importlib.util.spec_from_file_location(
        'fb_scraper', Path(__file__).resolve().parent / 'facebookadscraperapify2026-v2.py'
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fb = module
    return fb


# ═════════════════════════════════════════════════════════════════════════════
# Live run logging - mirror everything the run prints into run_logs, keep a fresh
# heartbeat, and stream progress, so the dashboard shows exactly what is happening
# without anyone opening GitHub Actions. Every part of this is fail-open: a logging
# hiccup must never take the scrape down with it.
# ═════════════════════════════════════════════════════════════════════════════
class RunLogger:
    """Thread-safe in-memory buffer of (ts, level, message) lines awaiting flush."""

    def __init__(self):
        self._buf = []
        self._lock = threading.Lock()

    def add_line(self, message, level='info'):
        if not message:
            return
        ts = datetime.now(timezone.utc)
        with self._lock:
            self._buf.append((ts, level, message))

    def drain(self):
        with self._lock:
            rows, self._buf = self._buf, []
        return rows


class _Tee:
    """Mirror a text stream to the real console AND capture whole lines to a logger.

    Partial writes (no trailing newline) are held until the line completes, so a
    log row is always a full line. Redaction happens later at the DB boundary.
    """

    def __init__(self, stream, logger, level='info'):
        self._stream = stream
        self._logger = logger
        self._level = level
        self._partial = ''

    def write(self, s):
        try:
            n = self._stream.write(s)
        except Exception:
            n = len(s) if s else 0
        try:
            self._capture(s)
        except Exception:
            pass
        return n

    def _capture(self, s):
        if not s:
            return
        parts = (self._partial + s).split('\n')
        self._partial = parts.pop()
        for line in parts:
            self._logger.add_line(line.rstrip('\r'), self._level)

    def flush_partial(self):
        """Emit any buffered incomplete line (called at teardown)."""
        if self._partial.strip():
            self._logger.add_line(self._partial.rstrip('\r'), self._level)
        self._partial = ''

    def flush(self):
        try:
            self._stream.flush()
        except Exception:
            pass

    def __getattr__(self, name):
        return getattr(self._stream, name)


def _flush_once(run_id, logger, progress):
    """Persist buffered logs + a heartbeat/progress snapshot. Never raises."""
    rows = logger.drain()
    try:
        with db.connect() as conn:
            if rows:
                db.insert_run_logs(conn, run_id, rows)
            db.update_progress(
                conn, run_id,
                current_domain=progress.get('current_domain'),
                domains_total=progress.get('domains_total'),
                domains_done=progress.get('domains_done'),
                ads_found_so_far=progress.get('ads_found_so_far'),
            )
    except Exception as e:
        # Fail-open: a dropped flush loses a few log lines, never the scrape.
        print(f'[run-log flush failed: {e}]', file=sys.__stderr__)


async def _run_heartbeat(run_id, logger, progress, stop_event, interval=2.0):
    """Flush logs + heartbeat every `interval`s until stopped, then flush once more.

    A dedicated task, so the heartbeat stays fresh even while a domain's Apify
    fetch is running. A stale heartbeat therefore means the process died, not that
    it is merely busy - which is what lets the dashboard flip to STALLED honestly.
    """
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass
        await asyncio.to_thread(_flush_once, run_id, logger, progress)
    await asyncio.to_thread(_flush_once, run_id, logger, progress)


def _install_thread_excepthook():
    """Replace a crashed apify log-forwarding thread's traceback with one calm line.

    apify-client streams the actor's log in a helper thread that can die on a
    stream timeout (seen live: impit.TimeoutException). That only stops live
    actor-log forwarding for the current attempt - the scrape itself is
    unaffected and forwarding resumes on the next actor call - so a 10-line
    traceback in the run log is pure alarm noise. Every other thread keeps
    Python's default excepthook behavior untouched.
    """
    default_hook = threading.excepthook

    def hook(args):
        if '_stream_log' in (getattr(args.thread, 'name', '') or ''):
            name = getattr(args.exc_type, '__name__', 'error')
            print(f'[apify] live actor-log stream dropped ({name}); '
                  f'the scrape continues, forwarding resumes on the next actor call')
            return
        default_hook(args)

    threading.excepthook = hook


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
                  language, country, vertical, brand, review_status='approved'):
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
        'brand': brand,
        'review_status': review_status,
    }


_EMPTY_MEDIA = {'main_images': [], 'video_hd': '', 'video_preview': '',
                'extra_images': [], 'extra_videos': []}


def _primary_image_url(media):
    """A representative still for brand vision: the first main image, else the video
    poster. Empty when the ad has neither (brand then falls back to copy-only)."""
    imgs = media.get('main_images') or []
    if imgs:
        return imgs[0]
    return media.get('video_preview') or ''


async def process_ad(ad, rank, bucket, verticals, feed, domain, gpt_session,
                     review_status='approved'):
    """Scrape article, run GPT enrichment, upload media, return a db row dict."""
    snapshot = ad.get('snapshot', {})
    body_obj = snapshot.get('body', {})
    body_text = body_obj.get('text', '') if isinstance(body_obj, dict) else ''
    link_url = snapshot.get('link_url', '')
    if not link_url and snapshot.get('cards'):
        link_url = snapshot['cards'][0].get('link_url', '')

    # Pending ads (destination does not match the domain) skip the paid article
    # scrape - a junk landing page is not worth a ScrapingBee call. Media still
    # uploads so the Review tab has thumbnails after the FB CDN links expire.
    article_title, article_content = '', ''
    if link_url and review_status == 'approved':
        article_title, article_content = await fb.scrape_article_async(link_url)

    language, country, vertical = await asyncio.gather(
        # Language from the ad's OWN copy, never the (often English) landing page.
        fb.gpt_detect_language(gpt_session, fb.ad_copy_text(snapshot)),
        fb.gpt_detect_country(gpt_session, article_title, body_text, article_content),
        fb.gpt_detect_vertical(gpt_session, article_title, body_text, article_content, verticals),
    )

    media = await fb.process_ad_media(ad, bucket, {}) if bucket is not None else dict(_EMPTY_MEDIA)

    # Brand needs the creative image, so it runs after upload and reads the permanent
    # GCS URL - the same source backfill_brand.py uses, so live and backfill agree.
    brand_image = _primary_image_url(media)
    brand = await fb.gpt_detect_brand(gpt_session, fb.ad_copy_text(snapshot), brand_image)

    return build_ad_dict(ad, media, article_title, article_content, rank,
                         feed, domain, language, country, vertical, brand, review_status)


# ═════════════════════════════════════════════════════════════════════════════
# Per-query scrape
# ═════════════════════════════════════════════════════════════════════════════
async def scrape_query(run_id, bucket, verticals, existing_ids, params, feed, domain, retries, progress=None):
    ads = await fb.fetch_facebook_ads_apify_with_resume(params, max_retries=retries, retry_delay=90)
    if not ads:
        print(f'  no ads returned for "{domain}"')
        return (0, 0)

    old_enough = [a for a in ads if fb.is_ad_at_least_week_old(a)]
    known = [a for a in old_enough if str(a.get('ad_archive_id', '')) in existing_ids]
    new_ads = [a for a in old_enough if str(a.get('ad_archive_id', '')) not in existing_ids]

    # Already-stored ads get a cheap re-sighting (db.resurface_ads: a pure DB
    # touch, no ScrapingBee / GPT / media spend) so everything Meta still runs
    # re-enters the fresh window - including ads that had fallen off the feed.
    # Rejected ones reopen for review; destination matches are re-stamped to
    # this domain on the way.
    resurfaced = reopened = 0
    if known:
        matched_known = {str(a.get('ad_archive_id', '')) for a in known
                         if fb.ad_matches_domain(a, domain)}
        other_known = [str(a.get('ad_archive_id', '')) for a in known
                       if str(a.get('ad_archive_id', '')) not in matched_known]
        with db.connect() as conn:
            t_m, r_m = db.resurface_ads(conn, run_id, sorted(matched_known), domain=domain)
            t_o, r_o = db.resurface_ads(conn, run_id, other_known)
        resurfaced, reopened = t_m + t_o, r_m + r_o
        if progress is not None:
            progress['ads_found_so_far'] += resurfaced

    # Relevance gate (see fb.ad_matches_domain): ads whose destination points at
    # the tracked domain enter the feed as approved; the rest are stored as
    # pending and only surface in the dashboard's Review tab until a human
    # approves or rejects them. The keyword search is what drags the junk in.
    review_of = {str(a.get('ad_archive_id', '')):
                 'approved' if fb.ad_matches_domain(a, domain) else 'pending'
                 for a in new_ads}
    matched = sum(1 for v in review_of.values() if v == 'approved')
    print(f'  {len(ads)} fetched, {len(old_enough)} old-enough, '
          f'{resurfaced} re-surfaced ({reopened} reopened for review), '
          f'{len(new_ads)} new to process '
          f'({matched} match "{domain}", {len(new_ads) - matched} sent to review)')
    if not new_ads:
        return (resurfaced, 0)

    total_found, total_new = resurfaced, 0
    batch_size = fb.AD_BATCH_SIZE
    async with aiohttp.ClientSession() as gpt_session:
        for start in range(0, len(new_ads), batch_size):
            batch = new_ads[start:start + batch_size]
            results = await asyncio.gather(*[
                process_ad(ad, start + i + 1, bucket, verticals, feed, domain, gpt_session,
                           review_of[str(ad.get('ad_archive_id', ''))])
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
                if progress is not None:
                    progress['ads_found_so_far'] += n   # cumulative across all domains
                print(f'    upserted batch: {n} new (running total {total_new})')

    return (total_found, total_new)


# ═════════════════════════════════════════════════════════════════════════════
# Orchestration
# ═════════════════════════════════════════════════════════════════════════════
DEFAULT_TIME_BUDGET_MINUTES = 45


def _time_budget_minutes() -> float:
    """The run's soft time budget in minutes (RUN_TIME_BUDGET_MINUTES env,
    default 45). Once exhausted the run stops starting new domains and finishes
    cleanly as completed - well before the workflow's hard timeout would kill it
    mid-scrape, leave the run-lock hanging, and hide everything it captured
    behind a 'failed' status. Invalid or non-positive values fall back to the
    default, so a bad env value can never disable the guard."""
    raw = os.environ.get('RUN_TIME_BUDGET_MINUTES', '')
    try:
        minutes = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIME_BUDGET_MINUTES
    return minutes if minutes > 0 else DEFAULT_TIME_BUDGET_MINUTES


async def _scrape_domain_rows(run_id, bucket, verticals, existing_ids, rows,
                              retries, progress, deadline, clock=time.monotonic):
    """Scrape the given domain rows in order until done or `deadline` (a
    `clock()` timestamp; time.monotonic by default) passes. Returns
    (total_found, total_new, deferred_rows): deferred_rows are the rows the
    deadline cut off, which the caller marks due so the next scheduled tick
    continues exactly where this run stopped. The check runs before each
    domain, so a domain is never abandoned midway - the budget bounds when
    work starts, not how it ends. `clock` is injectable for tests."""
    total_found = total_new = 0
    for i, dom in enumerate(rows):
        if clock() >= deadline:
            return total_found, total_new, rows[i:]
        progress['current_domain'] = dom['query']
        params = {'query': dom['query'], 'country': dom['country'],
                  'activeStatus': dom['active_status'],
                  'max_target_results': dom['max_ads']}
        print(f'scraping "{dom["query"]}" (max {dom["max_ads"]})...')
        f, n = await scrape_query(run_id, bucket, verticals, existing_ids,
                                  params, dom.get('feed') or '', dom['query'], retries, progress)
        total_found += f
        total_new += n
        progress['domains_done'] += 1
        with db.connect() as conn:
            db.bump_domain_schedule(conn, dom['id'], dom['interval_days'])
    return total_found, total_new, []


def _target_domain_ids(args) -> list[str]:
    """Domain ids for a targeted run: the --domain-ids arg or the DOMAIN_IDS env
    (set by the dashboard's "Run selected" dispatch). Comma-separated; each token
    is validated as a UUID and invalid ones are dropped, so a malformed input can
    never reach a query.
    """
    raw = args.domain_ids or os.environ.get('DOMAIN_IDS', '') or ''
    ids: list[str] = []
    for tok in raw.split(','):
        tok = tok.strip()
        if not tok:
            continue
        try:
            ids.append(str(uuid.UUID(tok)))
        except ValueError:
            print(f'  ignoring invalid domain id: {tok!r}')
    return ids


async def run(args):
    target_ids = _target_domain_ids(args)

    # Scheduled mode (no --query, no targeted ids): skip cheaply if nothing is due,
    # so an hourly cron does not create an empty run record every hour. This check
    # needs only the database - not the scraper or its API keys - so it stays before
    # the load. A targeted run always proceeds: its rows may not be "due".
    if not args.query and not target_ids:
        with db.connect() as conn:
            if not db.any_domain_due(conn):
                print('nothing due; exiting')
                return

    # Claim the run and load config (short-lived connection). The claim happens
    # BEFORE the scraper is loaded and the GCS client is built, so that if either
    # of those fails (a missing API key, a bad service-account cred) it fails
    # inside a claimed run - recorded as FAILED with the traceback in run_logs -
    # instead of crashing before the dashboard has any run to show.
    with db.connect() as conn:
        verticals = [r['name'] for r in _all_verticals(conn)]
        existing_ids = db.existing_ad_ids(conn)
        run_id = db.claim_run(conn, trigger_source='manual')
    if not run_id:
        print('another run is already active; exiting')
        return

    # The soft time budget starts at the claim. When it runs out, the run stops
    # starting new domains, marks the rest due, and finishes as COMPLETED - so
    # its ads surface immediately and the lock is released cleanly, instead of
    # the workflow's hard timeout killing it mid-scrape.
    budget_minutes = _time_budget_minutes()
    deadline = time.monotonic() + budget_minutes * 60

    # ── Live visibility: from here on, everything printed is mirrored into
    #    run_logs, the heartbeat stays fresh, and progress streams to the
    #    dashboard. Tees are installed before the first print so the console the
    #    user sees starts at "run ... claimed".
    logger = RunLogger()
    progress = {'current_domain': None, 'domains_total': 0,
                'domains_done': 0, 'ads_found_so_far': 0}
    tee_out = _Tee(sys.stdout, logger, 'info')
    tee_err = _Tee(sys.stderr, logger, 'error')
    sys.stdout, sys.stderr = tee_out, tee_err
    _install_thread_excepthook()
    stop_event = asyncio.Event()
    hb_task = asyncio.create_task(_run_heartbeat(run_id, logger, progress, stop_event))
    try:
        with db.connect() as conn:
            db.prune_run_logs(conn)          # bound table growth; cheap, best-effort
    except Exception:
        pass

    print(f'run {run_id} claimed | {len(verticals)} verticals | {len(existing_ids)} ads already stored')
    print(f'[budget] time budget: {budget_minutes:g}m - domains not started by then stay due for the next tick')

    total_found = total_new = 0
    try:
        # Now that we are inside the claimed run's failure boundary, load the
        # scraper and build the media client. A missing API key or a bad GCS cred
        # raises here and is captured as a FAILED run (with the traceback in the
        # log), not a silent crash before there was anything to show.
        _load_scraper()
        fb.GPT_SEMAPHORE = asyncio.Semaphore(10)
        fb.SCRAPING_SEMAPHORE = asyncio.Semaphore(10)

        bucket = None
        if not args.no_media:
            bucket = get_bucket()
            print(f'GCS bucket ready: {bucket.name}')
        else:
            print('media upload disabled (--no-media)')

        if args.query:
            progress['domains_total'] = 1
            progress['current_domain'] = args.query
            params = {'query': args.query, 'country': args.country,
                      'activeStatus': 'active', 'max_target_results': args.max}
            print(f'scraping query "{args.query}" (max {args.max})...')
            f, n = await scrape_query(run_id, bucket, verticals, existing_ids,
                                      params, args.feed, args.query, args.retries, progress)
            total_found, total_new = f, n
            progress['domains_done'] = 1
        else:
            # Targeted run scrapes exactly the selected rows (regardless of their
            # due-ness / paused state); otherwise it is the scheduled due-sweep.
            with db.connect() as conn:
                rows = (db.get_domains_by_ids(conn, target_ids) if target_ids
                        else db.get_due_domains(conn))
            progress['domains_total'] = len(rows)
            print(f'{len(rows)} selected domain(s) to run' if target_ids
                  else f'{len(rows)} domain(s) due')
            total_found, total_new, deferred = await _scrape_domain_rows(
                run_id, bucket, verticals, existing_ids, rows,
                args.retries, progress, deadline)
            if deferred:
                names = ', '.join(d['query'] for d in deferred)
                print(f'[budget] time budget ({budget_minutes:g}m) reached after '
                      f'{progress["domains_done"]}/{len(rows)} domains; marking '
                      f'{len(deferred)} remaining domain(s) due for the next tick: {names}')
                # Fail-open: the scraped data is good even if this write hiccups.
                # Due-sweep leftovers are still due regardless; only a targeted
                # row would lose its instant re-queue, which the log records.
                try:
                    with db.connect() as conn:
                        db.mark_domains_due(conn, [d['id'] for d in deferred])
                except Exception as e:
                    print(f'[budget] could not mark deferred domains due: {e}')

        with db.connect() as conn:
            db.finish_run(conn, run_id, total_found, total_new)
        print(f'\nDONE: found={total_found} new={total_new}')
        _notify_slack(total_found, total_new)
    except Exception as e:
        # Print the traceback first so it lands in run_logs (redacted), then record
        # the failure. The full traceback is exactly what you want for a failed run.
        print(f'\nrun FAILED: {e}\n{traceback.format_exc()}')
        with db.connect() as conn:
            db.fail_run(conn, run_id, e)
        raise
    finally:
        # Flush trailing partial lines, stop the heartbeat (its final tick drains
        # the buffer, capturing the DONE/FAILED line), and restore the streams.
        try:
            tee_out.flush_partial()
            tee_err.flush_partial()
        except Exception:
            pass
        stop_event.set()
        try:
            await hb_task
        except Exception:
            pass
        sys.stdout, sys.stderr = tee_out._stream, tee_err._stream


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
    ap.add_argument('--domain-ids',
                    help='comma-separated tracked-domain UUIDs to run in isolation '
                         '(also read from the DOMAIN_IDS env var)')
    ap.add_argument('--max', type=int, default=5, help='max ads for the ad-hoc query')
    ap.add_argument('--country', default='ALL')
    ap.add_argument('--feed', default='')
    ap.add_argument('--retries', type=int, default=1, help='Apify resume attempts')
    ap.add_argument('--no-media', action='store_true', help='skip GCS media upload')
    asyncio.run(run(ap.parse_args()))


if __name__ == '__main__':
    main()
