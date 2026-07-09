import os
import sys
import requests
import json
import logging
import random
import asyncio
import aiohttp
from datetime import datetime, timedelta
from io import BytesIO
from PIL import Image
from google.oauth2 import service_account
from googleapiclient.discovery import build
from google.cloud import storage
from google.cloud.exceptions import GoogleCloudError
from concurrent.futures import ThreadPoolExecutor
from apify_client import ApifyClient
from urllib.parse import quote, urlparse
from scrapingbee import ScrapingBeeClient
import re
import time

# ── Secrets & configuration (loaded from the environment) ─────────────────────
# Nothing sensitive is hardcoded. Copy .env.example to .env and fill it in, or
# set these as GitHub Actions / Vercel secrets. See SETUP.md.
def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"Missing required environment variable: {name}. "
            f"See .env.example / SETUP.md."
        )
    return value

# ── Google Sheets configuration ───────────────────────────────────────────────
SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
SERVICE_ACCOUNT_FILE_SHEETS  = os.environ.get('SERVICE_ACCOUNT_FILE_SHEETS',  'smart-surf-295322-88ad90affe77.json')
SERVICE_ACCOUNT_FILE_STORAGE = os.environ.get('SERVICE_ACCOUNT_FILE_STORAGE', 'uplift-283910-79cf8c0b12d4.json')
SPREADSHEET_ID           = os.environ.get('SPREADSHEET_ID',           '1KA-szj-MEkgK0MBjzSNd7JafG74DfXReNPRw9h6AWGg')
REFERENCE_SPREADSHEET_ID = os.environ.get('REFERENCE_SPREADSHEET_ID', '1PATnzIw3rqtzvyCzoDqaeGIuNM3v8fdSXgRCLVbjnoQ')
VERTICALS_SPREADSHEET_ID = os.environ.get('VERTICALS_SPREADSHEET_ID', '14Ce_OCOqRQxVxox2MPUteIkRV772O8Ri0NVygO1f-G8')
BUCKET_NAME = os.environ.get('BUCKET_NAME', 'aporia-unleash')

# ── Apify configuration ───────────────────────────────────────────────────────
APIFY_API_TOKEN = _require_env('APIFY_API_TOKEN')
APIFY_ACTOR_ID  = os.environ.get('APIFY_ACTOR_ID', 'memo23/facebook-ads-library-scraper-cheerio')

# ── ScrapingBee configuration ─────────────────────────────────────────────────
SCRAPINGBEE_API_KEY = _require_env('SCRAPINGBEE_API_KEY')

# ── OpenAI configuration ──────────────────────────────────────────────────────
OPENAI_API_KEY = _require_env('OPENAI_API_KEY')

MAX_CONCURRENT_UPLOADS  = 10
AD_BATCH_SIZE           = 10   # ← process N ads fully in parallel
DOMAIN_CONCURRENCY      = 3    # ← process N domains in parallel
SEVEN_DAYS_AGO = datetime.now() - timedelta(days=3)

# Global semaphore — limits total simultaneous OpenAI + ScrapingBee calls
GPT_SEMAPHORE       = None   # created in main_async()
SCRAPING_SEMAPHORE  = None
DOMAIN_SEMAPHORE    = None   # limits concurrent domain processing
SHEETS_LOCK         = None   # protects Google Sheets writes from races

# ═════════════════════════════════════════════════════════════════════════════
# GOOGLE SHEETS / STORAGE HELPERS
# ═════════════════════════════════════════════════════════════════════════════
def get_sheets_service():
    creds = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_FILE_SHEETS, scopes=SCOPES)
    return build('sheets', 'v4', credentials=creds)

def get_storage_client():
    return storage.Client.from_service_account_json(SERVICE_ACCOUNT_FILE_STORAGE)

def truncate_cell_content(content, max_length=49000):
    if not content:
        return content
    s = str(content)
    return s if len(s) <= max_length else s[:max_length] + '... [TRUNCATED]'

# ═════════════════════════════════════════════════════════════════════════════
# LOAD WEBSITES SHEET  →  { domain: feed }
# ═════════════════════════════════════════════════════════════════════════════
def read_websites_sheet(service):
    try:
        result = service.spreadsheets().values().get(
            spreadsheetId=REFERENCE_SPREADSHEET_ID,
            range='Websites!A:B'
        ).execute()
        values = result.get('values', [])
        if not values or len(values) < 2:
            print("ℹ️  Websites sheet is empty")
            return {}
        websites = {}
        for row in values[1:]:
            if len(row) < 2:
                continue
            feed   = str(row[0]).strip()
            domain = str(row[1]).strip().lower().replace('www.', '')
            if domain:
                websites[domain] = feed
        print(f"✅ Loaded {len(websites)} domain→feed mappings from Websites sheet")
        return websites
    except Exception as e:
        print(f"⚠️  Error reading Websites sheet: {e}")
        return {}

def get_feed_for_query(query, websites_map):
    q = query.lower().replace('www.', '')
    if q in websites_map:
        return websites_map[q]
    for domain, feed in websites_map.items():
        if q in domain or domain in q:
            return feed
    return ''

# ═════════════════════════════════════════════════════════════════════════════
# LOAD VERTICALS LIST
# ═════════════════════════════════════════════════════════════════════════════
def read_verticals(service):
    try:
        result = service.spreadsheets().values().get(
            spreadsheetId=VERTICALS_SPREADSHEET_ID,
            range='Offer Naming!A2:A'
        ).execute()
        values = result.get('values', [])
        verticals = [row[0].strip() for row in values if row and row[0].strip()]
        print(f"✅ Loaded {len(verticals)} verticals from Offer Naming sheet")
        return verticals
    except Exception as e:
        print(f"⚠️  Error reading verticals: {e}")
        return []

# ═════════════════════════════════════════════════════════════════════════════
# GPT-4.1-MINI HELPERS  (semaphore-guarded)
# ═════════════════════════════════════════════════════════════════════════════
def ad_copy_text(snapshot):
    """The ad's OWN creative text - body, caption, title, link description, extra
    texts, plus any DCO card variants. This is the language the ad is written in,
    so language detection must read this and NOT the landing-page article (which is
    frequently English even for Spanish / Portuguese ads - the cause of everything
    showing up as 'English')."""
    if not isinstance(snapshot, dict):
        return ''
    parts = []

    def add(v):
        if isinstance(v, dict):
            v = v.get('text', '')
        if isinstance(v, str) and v.strip():
            parts.append(v.strip())

    add(snapshot.get('body'))
    add(snapshot.get('caption'))
    add(snapshot.get('title'))
    add(snapshot.get('link_description'))
    for t in snapshot.get('extra_texts') or []:
        add(t)
    for card in snapshot.get('cards') or []:
        if isinstance(card, dict):
            add(card.get('body'))
            add(card.get('caption'))
            add(card.get('title'))
            add(card.get('link_description'))
    return ' | '.join(parts)


async def gpt_detect_language(session, ad_copy):
    """Detect the language the ad is written in from its own copy (see ad_copy_text).
    Never pass the landing-page article here - that was the bug that made non-English
    ads read as English."""
    text = (ad_copy or '').strip()
    if not text:
        return ''
    async with GPT_SEMAPHORE:
        try:
            payload = {
                "model": "gpt-4.1-mini",
                "messages": [
                    {"role": "system", "content":
                        "You detect the language of text. Respond with ONLY the language name "
                        "in English, nothing else. Examples: English, Spanish, French, German, Portuguese"},
                    {"role": "user", "content": f"What language is this text?\n\n{text[:500]}"}
                ],
                "max_tokens": 10,
                "temperature": 0,
            }
            async with session.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
                json=payload,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                if response.status == 200:
                    result = await response.json()
                    return result['choices'][0]['message']['content'].strip()
                return ''
        except Exception as e:
            print(f"  ⚠️  GPT language error: {e}")
            return ''

async def gpt_detect_country(session, article_title, body_text, article_content):
    combined = ' | '.join(filter(None, [article_title, body_text, article_content]))
    if not combined.strip():
        return ''
    async with GPT_SEMAPHORE:
        try:
            payload = {
                "model": "gpt-4.1-mini",
                "messages": [
                    {"role": "system", "content":
                        "You identify the most likely TARGET AUDIENCE country for an advertisement — "
                        "meaning the country where the people being sold to live, NOT the country the "
                        "content is about.\n\n"
                        "Key rules:\n"
                        "- If the ad is about visas, immigration, or moving TO a country, the audience "
                        "is people OUTSIDE that country (e.g. Australia visa → US, IN, GB, PH, not AU)\n"
                        "- If the ad is about travel, tourism, or safaris TO a destination, the audience "
                        "is travelers FROM wealthy English-speaking countries (US, GB, AU, CA)\n"
                        "- If the ad is in English and targets an expensive product/service, default to US\n"
                        "- Only return the destination country itself if the ad is clearly selling "
                        "something LOCAL to residents there (e.g. local insurance, local delivery)\n\n"
                        "Respond with ONLY the single most likely 2-letter ISO country code. "
                        "Examples: US, GB, IN, CA, AU, PH"},
                    {"role": "user", "content":
                        f"Who is this ad targeting (country of the BUYER, not the subject)?\n\n{combined[:1000]}"}
                ],
                "max_tokens": 5,
                "temperature": 0,
            }
            async with session.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
                json=payload,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                if response.status == 200:
                    result = await response.json()
                    return result['choices'][0]['message']['content'].strip().upper()
                return ''
        except Exception as e:
            print(f"  ⚠️  GPT country error: {e}")
            return ''

_VERTICAL_STOPWORDS = {
    'and', 'the', 'for', 'with', 'your', 'our', 'you', 'get', 'now',
    'services', 'service', 'deals', 'deal', 'online', 'best', 'top', 'new',
}


def _shortlist_verticals(text, verticals, top_n=25):
    """Rank verticals by keyword overlap with the ad text and return the top N,
    so GPT chooses from a focused shortlist instead of all ~2,200 (cheaper +
    sharper). Falls back to the first N verticals if there is no overlap."""
    low = (text or '').lower()
    words = set(re.findall(r'[a-z]{3,}', low)) - _VERTICAL_STOPWORDS
    scored = []
    for v in verticals:
        vwords = set(re.findall(r'[a-z]{3,}', v.lower())) - _VERTICAL_STOPWORDS
        if not vwords:
            continue
        score = len(vwords & words) + (3 if v.lower() in low else 0)
        scored.append((score, v))
    scored.sort(key=lambda x: x[0], reverse=True)
    shortlist = [v for s, v in scored[:top_n] if s > 0]
    return shortlist or [v for _, v in scored[:top_n]]


async def gpt_detect_vertical(session, article_title, body_text, article_content, verticals):
    if not verticals:
        return ''
    combined = ' | '.join(filter(None, [article_title, body_text, article_content]))
    if not combined.strip():
        return ''
    shortlist = _shortlist_verticals(combined[:2000], verticals, top_n=25)
    if not shortlist:
        return ''
    verticals_list = '\n'.join(f'- {v}' for v in shortlist)
    async with GPT_SEMAPHORE:
        try:
            payload = {
                "model": "gpt-4.1-mini",
                "messages": [
                    {"role": "system", "content":
                        "You classify advertising content into a vertical category. "
                        "You must choose EXACTLY ONE vertical from the provided list. "
                        "Respond with ONLY the vertical name, nothing else."},
                    {"role": "user", "content":
                        f"Choose the single most relevant vertical for this ad:\n\n{combined[:1000]}\n\n"
                        f"Available verticals:\n{verticals_list}"}
                ],
                "max_tokens": 30,
                "temperature": 0,
            }
            async with session.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
                json=payload,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                if response.status == 200:
                    result = await response.json()
                    gpt_result = result['choices'][0]['message']['content'].strip()
                    gpt_lower = gpt_result.lower()
                    for v in verticals:
                        if v.lower() == gpt_lower:
                            return v
                    for v in verticals:
                        if gpt_lower in v.lower() or v.lower() in gpt_lower:
                            return v
                    return gpt_result
                return ''
        except Exception as e:
            print(f"  ⚠️  GPT vertical error: {e}")
            return ''

# ═════════════════════════════════════════════════════════════════════════════
# SCRAPINGBEE ARTICLE SCRAPING  (async wrapper with semaphore)
# ═════════════════════════════════════════════════════════════════════════════
def _scrape_article_sync(url):
    """Sync ScrapingBee call — run in thread executor."""
    if not url or not url.startswith('http'):
        return '', ''
    try:
        client = ScrapingBeeClient(api_key=SCRAPINGBEE_API_KEY)
        response = client.get(url, params={
            'render_js': False,
            'return_page_markdown': True,
            'block_resources': True,
            'timeout': 30000,
        })
        if not response.ok:
            print(f"  ⚠️  ScrapingBee {response.status_code} for {url}")
            return '', ''
        markdown_content = response.text.strip()
        if not markdown_content:
            return '', ''
        title = ''
        body_lines = []
        title_found = False
        for line in markdown_content.split('\n'):
            stripped = line.strip()
            if not title_found and stripped:
                title = stripped.lstrip('#').strip()
                title_found = True
            elif title_found:
                body_lines.append(line)
        return (
            truncate_cell_content(title, max_length=500),
            truncate_cell_content('\n'.join(body_lines).strip())
        )
    except Exception as e:
        print(f"  ⚠️  ScrapingBee error for {url}: {e}")
        return '', ''

async def scrape_article_async(url):
    """Non-blocking ScrapingBee scrape with concurrency limit."""
    async with SCRAPING_SEMAPHORE:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _scrape_article_sync, url)

# ═════════════════════════════════════════════════════════════════════════════
# REFERENCE SHEET
# ═════════════════════════════════════════════════════════════════════════════
def read_reference_sheet(service):
    try:
        result = service.spreadsheets().values().get(
            spreadsheetId=REFERENCE_SPREADSHEET_ID,
            range='Data!A:AH'
        ).execute()
        values = result.get('values', [])
        if not values or len(values) < 2:
            print("ℹ️  Reference sheet is empty")
            return {}
        header = values[0]
        try:
            ad_id_col_index = header.index('ad_archive_id')
            print(f"✅ 'ad_archive_id' found at column index {ad_id_col_index}")
        except ValueError:
            ad_id_col_index = 33
            print(f"⚠️  Header not found, defaulting to column AD (index 29)")
        reference_data = {}
        for row in values[1:]:
            if len(row) <= ad_id_col_index:
                continue
            ad_archive_id = str(row[ad_id_col_index]).strip()
            if not ad_archive_id:
                continue
            padded = row + [''] * (25 - len(row))
            reference_data[ad_archive_id] = padded[2:25]
        print(f"✅ Loaded {len(reference_data)} records from Reference sheet")
        return reference_data
    except Exception as e:
        print(f"⚠️  Error reading Reference sheet: {e}")
        return {}

def read_existing_ad_ids_and_media(service):
    try:
        result = service.spreadsheets().values().get(
            spreadsheetId=SPREADSHEET_ID, range='DB!A:W').execute()
        values = result.get('values', [])
        if not values:
            return set(), {}
        existing_ids, media_cache = set(), {}
        for row in values[1:]:
            if not row or not row[0]:
                continue
            aid = str(row[0])
            existing_ids.add(aid)
            media_cache[aid] = {
                'main_images':   [u.strip() for u in row[11].split(',') if u.strip()] if len(row) > 11 and row[11] else [],
                'video_hd':      row[14].strip() if len(row) > 14 and row[14] else '',
                'video_preview': row[15].strip() if len(row) > 15 and row[15] else '',
                'extra_images':  [u.strip() for u in row[18].split(',') if u.strip()] if len(row) > 18 and row[18] else [],
                'extra_videos':  [u.strip() for u in row[19].split(',') if u.strip()] if len(row) > 19 and row[19] else [],
            }
        print(f"✅ Loaded {len(existing_ids)} existing ad IDs from DB sheet")
        return existing_ids, media_cache
    except Exception as e:
        print(f"⚠️  Error reading DB sheet: {e}")
        return set(), {}

def is_ad_at_least_week_old(ad):
    raw = ad.get('start_date')
    if not raw:
        return False
    try:
        return datetime.fromtimestamp(int(raw)) <= SEVEN_DAYS_AGO
    except Exception:
        return False

# ═════════════════════════════════════════════════════════════════════════════
# AD ↔ DOMAIN RELEVANCE
# ═════════════════════════════════════════════════════════════════════════════
# The Ad Library query is a keyword search over ad text, so it returns plenty of
# ads that merely MENTION the queried domain (or match its tokens) without
# advertising it. These helpers are the single source of truth for "does this ad
# actually belong to this domain": the scrape pipeline routes mismatches to the
# review queue, and backfill_review_status.py applies the same rule to stored
# rows. Matching is host-based on purpose - a plain substring test would approve
# junk like temu.com/motorcycle.com-storage-box where the domain only appears in
# the URL path.

def normalize_domain(query):
    """The tracked query as a bare lowercase host, or '' when the query is not
    domain-shaped (a keyword query has no meaningful destination to check)."""
    q = (query or '').strip().lower()
    q = re.sub(r'^[a-z][a-z0-9+.-]*://', '', q)   # tolerate a pasted URL
    q = q.split('/')[0].split('?')[0].split(':')[0]
    if q.startswith('www.'):
        q = q[4:]
    if '.' not in q or ' ' in q or not q:
        return ''
    return q


def _host_of(text):
    """The lowercase host of a URL or of bare display text like 'DOMAIN.COM/path'.
    Non-URL-ish text simply yields something that will never host-match."""
    t = str(text or '').strip().lower()
    if not t:
        return ''
    if '://' not in t:
        t = '//' + t
    try:
        host = urlparse(t).netloc
    except ValueError:
        return ''
    host = host.split('@')[-1].split(':')[0]
    return host[4:] if host.startswith('www.') else host


def _host_matches(host, domain):
    return bool(host) and (host == domain or host.endswith('.' + domain))


def ad_matches_domain(ad, query):
    """True when any destination field of the ad - link_url, card link_urls, or
    the display captions - points at the tracked domain (subdomains included).
    Keyword (non-domain) queries always match: relevance is undefined for them.
    Accepts raw Apify ads and the synthetic snapshots the backfill builds from
    stored rows, whose multi-card fields are ' | '-joined strings."""
    domain = normalize_domain(query)
    if not domain:
        return True
    snapshot = ad.get('snapshot') or {}
    candidates = [snapshot.get('link_url'), snapshot.get('caption')]
    for card in snapshot.get('cards') or []:
        if isinstance(card, dict):
            candidates.append(card.get('link_url'))
            candidates.append(card.get('caption'))
    for value in candidates:
        if isinstance(value, dict):
            value = value.get('text', '')
        if not isinstance(value, str):
            continue
        for part in value.split(' | '):
            if _host_matches(_host_of(part), domain):
                return True
    return False

# ═════════════════════════════════════════════════════════════════════════════
# MEDIA UPLOAD HELPERS
# ═════════════════════════════════════════════════════════════════════════════
def check_media_exists_in_storage(bucket, ad_archive_id, media_type, index):
    try:
        if media_type in ['img', 'extra']:
            folder, suffix = 'images', f'_{media_type}{index}.jpg'
        elif media_type in ['vid', 'extravid']:
            folder, suffix = 'videos', f'_{media_type}{index}.mp4'
        elif media_type == 'vidpreview':
            folder, suffix = 'images', f'_{media_type}{index}.jpg'
        else:
            return None
        for blob in bucket.list_blobs(prefix=f'facebook_ads/{folder}/{ad_archive_id}-'):
            if blob.name.endswith(suffix):
                blob.make_public()
                return blob.public_url
        return None
    except Exception as e:
        print(f"  ⚠️  Storage check error {media_type}{index}: {e}")
        return None

async def check_media_exists_async(bucket, ad_archive_id, media_type, index):
    """Threaded wrapper for check_media_exists_in_storage: the GCS list call is
    sync network I/O and must not block the event loop (heartbeats/log flushes
    run on it — see process_ad_media)."""
    return await asyncio.to_thread(
        check_media_exists_in_storage, bucket, ad_archive_id, media_type, index)

def generate_filename(ad_archive_id, display_format, extension):
    date_str  = datetime.now().strftime('%y%m%d')
    clean_fmt = display_format.lower().replace(' ', '_') if display_format else 'unknown'
    return f"{ad_archive_id}-{date_str}-{clean_fmt}-{random.randint(1000,9999)}.{extension}"

async def async_upload_image(session, bucket, image_url, filename):
    try:
        if not image_url or image_url.startswith('data:'):
            return None
        async with session.get(image_url, timeout=aiohttp.ClientTimeout(total=30),
                headers={'User-Agent': 'Mozilla/5.0'}) as r:
            if r.status != 200:
                return None
            content = await r.read()
        return await asyncio.get_event_loop().run_in_executor(
            None, _process_and_upload_image, content, bucket, filename)
    except Exception as e:
        print(f"❌ Upload image error {filename}: {e}")
        return None

def _process_and_upload_image(content, bucket, filename):
    try:
        img = Image.open(BytesIO(content))
        if img.mode != 'RGB':
            img = img.convert('RGB')
        buf = BytesIO()
        img.save(buf, format='JPEG', quality=85, optimize=True)
        buf.seek(0)
        blob = bucket.blob(f'facebook_ads/images/{filename}')
        blob.upload_from_file(buf, content_type='image/jpeg')
        blob.make_public()
        return blob.public_url
    except Exception as e:
        print(f"❌ Process image error {filename}: {e}")
        return None

async def async_upload_video(session, bucket, video_url, filename):
    try:
        if not video_url:
            return None
        async with session.get(video_url, timeout=aiohttp.ClientTimeout(total=120),
                headers={'User-Agent': 'Mozilla/5.0'}) as r:
            if r.status != 200:
                return None
            content = await r.read()
        return await asyncio.get_event_loop().run_in_executor(
            None, _upload_video_to_storage, content, bucket, filename)
    except Exception as e:
        print(f"❌ Upload video error {filename}: {e}")
        return None

def _upload_video_to_storage(content, bucket, filename):
    try:
        blob = bucket.blob(f'facebook_ads/videos/{filename}')
        blob.upload_from_string(content, content_type='video/mp4')
        blob.make_public()
        return blob.public_url
    except Exception as e:
        print(f"❌ Storage video error {filename}: {e}")
        return None

async def process_ad_media(ad, bucket, media_cache):
    snapshot       = ad.get('snapshot', {})
    ad_archive_id  = ad.get('ad_archive_id', '')
    display_format = snapshot.get('display_format', '')

    if str(ad_archive_id) in media_cache:
        cached = media_cache[str(ad_archive_id)]
        if cached['main_images'] or cached['video_hd']:
            print(f"  ♻️  Using cached media for ad {ad_archive_id}")
            return cached

    upload_tasks, media_map, storage_checks = [], {}, {}
    connector = aiohttp.TCPConnector(limit=MAX_CONCURRENT_UPLOADS)
    async with aiohttp.ClientSession(connector=connector) as session:
        image_counter = 1
        for img in snapshot.get('images', []):
            url = img.get('original_image_url', '')
            if url:
                ex = await check_media_exists_async(bucket, ad_archive_id, 'img', image_counter)
                if ex:
                    storage_checks[('image', 'main', image_counter)] = ex
                else:
                    fn = generate_filename(ad_archive_id, display_format, 'jpg').replace('.jpg', f'_img{image_counter}.jpg')
                    upload_tasks.append(async_upload_image(session, bucket, url, fn))
                    media_map[len(upload_tasks) - 1] = ('image', 'main', image_counter)
                image_counter += 1

        for card in snapshot.get('cards', []):
            url = card.get('original_image_url', '')
            if url:
                ex = await check_media_exists_async(bucket, ad_archive_id, 'img', image_counter)
                if ex:
                    storage_checks[('image', 'main', image_counter)] = ex
                else:
                    fn = generate_filename(ad_archive_id, display_format, 'jpg').replace('.jpg', f'_img{image_counter}.jpg')
                    upload_tasks.append(async_upload_image(session, bucket, url, fn))
                    media_map[len(upload_tasks) - 1] = ('image', 'main', image_counter)
                image_counter += 1

        video_counter = 1
        for src in [snapshot.get('videos', []), snapshot.get('cards', [])]:
            for item in src:
                hd   = item.get('video_hd_url', '')
                prev = item.get('video_preview_image_url', '')
                if hd:
                    ex = await check_media_exists_async(bucket, ad_archive_id, 'vid', video_counter)
                    if ex:
                        storage_checks[('video', 'hd', video_counter)] = ex
                    else:
                        fn = generate_filename(ad_archive_id, display_format, 'mp4').replace('.mp4', f'_vid{video_counter}.mp4')
                        upload_tasks.append(async_upload_video(session, bucket, hd, fn))
                        media_map[len(upload_tasks) - 1] = ('video', 'hd', video_counter)
                if prev:
                    ex = await check_media_exists_async(bucket, ad_archive_id, 'vidpreview', video_counter)
                    if ex:
                        storage_checks[('video', 'preview', video_counter)] = ex
                    else:
                        fn = generate_filename(ad_archive_id, display_format, 'jpg').replace('.jpg', f'_vidpreview{video_counter}.jpg')
                        upload_tasks.append(async_upload_image(session, bucket, prev, fn))
                        media_map[len(upload_tasks) - 1] = ('video', 'preview', video_counter)
                video_counter += 1

        # Facebook eventually stops serving the source URLs of older videos, so a
        # re-scrape can see a VIDEO ad with only a preview image (or no video item
        # at all). The loops above only consult storage when Apify hands them a
        # URL, which would store the ad without the video we already own. Fall
        # back to whatever slot 1 already holds before giving up.
        planned = set(storage_checks) | set(media_map.values())
        has_video = any(k[:2] == ('video', 'hd') for k in planned)
        has_preview = any(k[:2] == ('video', 'preview') for k in planned)
        if not has_video and (display_format == 'VIDEO' or has_preview):
            ex = await check_media_exists_async(bucket, ad_archive_id, 'vid', 1)
            if ex:
                print(f"  ♻️  Recovered stored video for ad {ad_archive_id}")
                storage_checks[('video', 'hd', 1)] = ex
        if not has_preview and display_format == 'VIDEO':
            ex = await check_media_exists_async(bucket, ad_archive_id, 'vidpreview', 1)
            if ex:
                storage_checks[('video', 'preview', 1)] = ex

        extra_img_counter = 1
        for img in snapshot.get('extra_images', []):
            url = img.get('original_image_url', '')
            if url:
                ex = await check_media_exists_async(bucket, ad_archive_id, 'extra', extra_img_counter)
                if ex:
                    storage_checks[('image', 'extra', extra_img_counter)] = ex
                else:
                    fn = generate_filename(ad_archive_id, display_format, 'jpg').replace('.jpg', f'_extra{extra_img_counter}.jpg')
                    upload_tasks.append(async_upload_image(session, bucket, url, fn))
                    media_map[len(upload_tasks) - 1] = ('image', 'extra', extra_img_counter)
                extra_img_counter += 1

        extra_vid_counter = 1
        for video in snapshot.get('extra_videos', []):
            hd = video.get('video_hd_url', '')
            if hd:
                ex = await check_media_exists_async(bucket, ad_archive_id, 'extravid', extra_vid_counter)
                if ex:
                    storage_checks[('video', 'extra', extra_vid_counter)] = ex
                else:
                    fn = generate_filename(ad_archive_id, display_format, 'mp4').replace('.mp4', f'_extravid{extra_vid_counter}.mp4')
                    upload_tasks.append(async_upload_video(session, bucket, hd, fn))
                    media_map[len(upload_tasks) - 1] = ('video', 'extra', extra_vid_counter)
                extra_vid_counter += 1

        if upload_tasks:
            print(f"  ⬆️  Uploading {len(upload_tasks)} media files for {ad_archive_id}...")
            results = await asyncio.gather(*upload_tasks, return_exceptions=True)
        else:
            results = []

    main_images, extra_images, extra_videos = [], [], []
    video_hd = video_preview = None

    for (mt, cat, _), url in storage_checks.items():
        if mt == 'image':
            (main_images if cat == 'main' else extra_images).append(url)
        elif mt == 'video':
            if cat == 'hd':      video_hd = video_hd or url
            elif cat == 'preview': video_preview = video_preview or url

    for idx, result in enumerate(results):
        if isinstance(result, Exception) or result is None:
            continue
        mt, cat, _ = media_map[idx]
        if mt == 'image':
            (main_images if cat == 'main' else extra_images).append(result)
        elif mt == 'video':
            if cat == 'hd':
                if video_hd is None: video_hd = result
                else: extra_videos.append(result)
            elif cat == 'preview': video_preview = video_preview or result
            elif cat == 'extra':   extra_videos.append(result)

    return {
        'main_images':   main_images,
        'video_hd':      video_hd or '',
        'video_preview': video_preview or '',
        'extra_images':  extra_images,
        'extra_videos':  extra_videos,
    }

# ═════════════════════════════════════════════════════════════════════════════
# BUILD ROW
# ═════════════════════════════════════════════════════════════════════════════
def extract_ad_data(ad, media_urls, exist_flag='', article_title='', article_content='',
                    rank=1, feed='', domain='', language='', country='', vertical=''):
    snapshot = ad.get('snapshot', {})
    body     = snapshot.get('body', {})

    ad_archive_id  = ad.get('ad_archive_id', '')
    display_format = snapshot.get('display_format', '')
    caption        = snapshot.get('caption', '')
    cta_text       = snapshot.get('cta_text', '')
    body_text      = body.get('text', '') if isinstance(body, dict) else ''
    cta_type       = snapshot.get('cta_type', '')
    link_description = snapshot.get('link_description', '')
    link_url       = snapshot.get('link_url', '')
    title          = snapshot.get('title', '')

    dco_captions, dco_cta_texts, dco_bodies = [], [], []
    dco_cta_types, dco_link_descriptions, dco_link_urls, dco_titles = [], [], [], []

    for card in snapshot.get('cards', []):
        if card.get('caption'):          dco_captions.append(card['caption'])
        if card.get('cta_text'):         dco_cta_texts.append(card['cta_text'])
        if card.get('body'):             dco_bodies.append(card['body'])
        if card.get('cta_type'):         dco_cta_types.append(card['cta_type'])
        if card.get('link_description'): dco_link_descriptions.append(card['link_description'])
        if card.get('link_url'):         dco_link_urls.append(card['link_url'])
        if card.get('title'):            dco_titles.append(card['title'])

    if dco_captions:          caption = ' | '.join(dco_captions)
    if dco_cta_texts:         cta_text = ' | '.join(dco_cta_texts)
    if dco_bodies:            body_text = ' | '.join(dco_bodies)
    if dco_cta_types:         cta_type = ' | '.join(dco_cta_types)
    if dco_link_descriptions: link_description = ' | '.join(dco_link_descriptions)
    if dco_link_urls:         link_url = ' | '.join(dco_link_urls)
    if dco_titles:            title = ' | '.join(dco_titles)

    original_image_url = ', '.join(media_urls['main_images']) if media_urls['main_images'] else ''
    extra_texts        = ', '.join(snapshot.get('extra_texts', []))
    publisher_platform = ', '.join(ad.get('publisher_platform', []))

    start_date = ''
    if ad.get('start_date'):
        try:
            start_date = datetime.fromtimestamp(ad['start_date']).strftime('%Y-%m-%d %H:%M:%S')
        except:
            start_date = str(ad['start_date'])

    return [
        truncate_cell_content(ad_archive_id),                         # A
        truncate_cell_content(ad.get('page_id', '')),                 # B
        truncate_cell_content(ad.get('page_name', '')),               # C
        truncate_cell_content(caption),                                # D
        truncate_cell_content(cta_text),                               # E
        truncate_cell_content(body_text),                              # F
        truncate_cell_content(cta_type),                               # G
        truncate_cell_content(display_format),                         # H
        truncate_cell_content(link_description),                       # I
        truncate_cell_content(link_url),                               # J
        '',                                                            # K resized_image_url
        truncate_cell_content(original_image_url),                    # L
        truncate_cell_content(title),                                  # M
        '',                                                            # N videos
        truncate_cell_content(media_urls['video_hd']),                # O
        truncate_cell_content(media_urls['video_preview']),           # P
        '',                                                            # Q video_sd_url
        truncate_cell_content(extra_texts),                           # R
        truncate_cell_content(', '.join(media_urls['extra_images'])), # S
        truncate_cell_content(', '.join(media_urls['extra_videos'])), # T
        truncate_cell_content(publisher_platform),                    # U
        truncate_cell_content(start_date),                            # V
        truncate_cell_content(ad.get('total_active_time', '')),       # W
        exist_flag,                                                    # X
        truncate_cell_content(article_title, max_length=500),         # Y
        truncate_cell_content(article_content),                       # Z
        rank,                                                          # AA Rank
        truncate_cell_content(feed),                                  # AB Feed
        truncate_cell_content(domain),                                # AC Domain
        truncate_cell_content(language),                              # AD Language
        truncate_cell_content(country),                               # AE Country
        truncate_cell_content(vertical),                              # AF Vertical
    ]

# ═════════════════════════════════════════════════════════════════════════════
# SHEET MANAGEMENT
# ═════════════════════════════════════════════════════════════════════════════
def clear_data_sheet(service):
    for attempt in range(5):
        try:
            service.spreadsheets().values().clear(
                spreadsheetId=SPREADSHEET_ID, range='Data!A:AZ').execute()
            print("✅ Cleared Data sheet")
            return service
        except (ConnectionAbortedError, BrokenPipeError, OSError) as e:
            print(f"⚠️  Connection error clearing sheet (attempt {attempt+1}/5): {e}")
            if attempt < 4:
                time.sleep(15 * (attempt + 1))
                service = get_sheets_service()
            else:
                raise
        except Exception as e:
            print(f"⚠️  Error clearing Data sheet: {e}")
            return service

def initialize_data_sheet(service):
    headers = [
        'ad_archive_id','page_id','page_name','caption','cta_text',
        'body_text','cta_type','display_format','link_description',
        'link_url','resized_image_url','original_image_url','title',
        'videos','video_hd_url','video_preview_image_url','video_sd_url',
        'extra_texts','extra_images','extra_videos','publisher_platform',
        'start_date','total_active_time',
        'Exist', 'article_title', 'article_content',
        'Rank', 'Feed', 'Domain', 'Language', 'Country', 'Vertical',
    ]
    for attempt in range(5):
        try:
            service.spreadsheets().values().update(
                spreadsheetId=SPREADSHEET_ID, range='Data!A1',
                valueInputOption='RAW', body={'values': [headers]}
            ).execute()
            print("✅ Initialized Data sheet headers (A–AF)")
            return service
        except (ConnectionAbortedError, BrokenPipeError, OSError) as e:
            print(f"⚠️  Connection error initializing sheet (attempt {attempt+1}/5): {e}")
            if attempt < 4:
                time.sleep(15 * (attempt + 1))
                service = get_sheets_service()
            else:
                raise

def append_to_data_sheet(service, data, max_retries=5):
    if not data:
        return service
    for attempt in range(max_retries):
        try:
            result = service.spreadsheets().values().append(
                spreadsheetId=SPREADSHEET_ID, range='Data!A:AF',
                valueInputOption='RAW', insertDataOption='INSERT_ROWS',
                body={'values': data}
            ).execute()
            print(f"  ✅ Appended {result.get('updates',{}).get('updatedRows',0)} rows")
            return service
        except (ConnectionAbortedError, BrokenPipeError, OSError) as e:
            print(f"  ⚠️  Network error on append (attempt {attempt+1}/{max_retries}): {e}")
            if attempt < max_retries - 1:
                wait = 15 * (attempt + 1)
                print(f"  🔄 Reconnecting to Sheets in {wait}s...")
                time.sleep(wait)
                service = get_sheets_service()
            else:
                raise
        except Exception as e:
            print(f"  ❌ Unexpected error on append (attempt {attempt+1}/{max_retries}): {e}")
            if attempt < max_retries - 1:
                time.sleep(15 * (attempt + 1))
                service = get_sheets_service()
            else:
                raise
    return service

def read_wa_sheet(service):
    result = service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID, range='WA!A:D').execute()
    values = result.get('values', [])
    if not values or len(values) < 2:
        return []
    params_list = []
    for idx, row in enumerate(values[1:], start=2):
        if not row or not row[0]:
            continue
        params_list.append({
            'row_number':         idx,
            'query':              row[0] if len(row) > 0 else '',
            'country':            row[1] if len(row) > 1 else 'ALL',
            'activeStatus':       row[2] if len(row) > 2 else 'ALL',
            'max_target_results': int(row[3]) if len(row) > 3 and row[3] else 100,
        })
    return params_list

def build_facebook_ads_library_url(query, country='ALL', active_status='active'):
    status_map = {'ALL':'all','ACTIVE':'active','INACTIVE':'inactive',
                  'active':'active','inactive':'inactive','all':'all'}
    return (
        f"https://www.facebook.com/ads/library/"
        f"?active_status={status_map.get(active_status,'active')}"
        f"&ad_type=all&country={country}&is_targeted_country=false&media_type=all"
        f"&q={quote(query)}&search_type=keyword_unordered"
        f"&sort_data[mode]=total_impressions&sort_data[direction]=desc"
    )

class _ActorLogHandler(logging.Handler):
    """Write redirected actor-run log lines to the CURRENT sys.stdout/stderr,
    resolved per record - so the lines flow into run_scrape's tees when those
    are installed, and into the real console when running standalone. Warnings
    and errors go to stderr; routine progress goes to stdout, which is what
    keeps the dashboard from painting the whole actor log alarm-red."""

    def emit(self, record):
        try:
            stream = sys.stderr if record.levelno >= logging.WARNING else sys.stdout
            stream.write(self.format(record) + '\n')
        except Exception:
            pass  # a log line is never worth a crash


def _get_actor_logger():
    """Logger handed to ApifyClient.call() for the actor's redirected run log.

    Replaces apify-client's default redirect logger, which writes everything to
    stderr with ANSI colors - the dashboard log console would render that as a
    wall of red error lines full of escape-code garbage. apify-client guesses
    each line's level from its content, so genuine actor errors still arrive
    at ERROR and show red; everything else arrives at INFO and shows gray.

    Idempotent by construction: getLogger() returns a process-global object
    that outlives this module (which run_scrape loads via spec/exec and could
    re-exec), so any existing handlers are cleared before ours is attached -
    the same reset pattern apify-client's own create_redirect_logger uses.
    Guarantees exactly one output line per record no matter how many times
    this runs. Cheap enough to rebuild per call.
    """
    logger = logging.getLogger('apify_actor_run')
    logger.setLevel(logging.INFO)
    logger.propagate = False
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
    handler = _ActorLogHandler()
    handler.setFormatter(logging.Formatter('[apify] %(message)s'))
    logger.addHandler(handler)
    return logger


def fetch_facebook_ads_apify(params, resume_cursor=None):
    start_url = build_facebook_ads_library_url(
        query=params['query'], country=params['country'],
        active_status=params['activeStatus'])
    print(f"  🔗 {start_url}")
    if resume_cursor:
        print(f"  ↩️  Resuming from cursor: {resume_cursor[:40]}...")

    client    = ApifyClient(APIFY_API_TOKEN)
    run_input = {
        "startUrls":             [start_url],
        "includeAdReach":        False,
        "includeTotalActiveAds": False,
        "filterDuplicatePageIds": False,
        "categories":            [],
        "maxItems":              params['max_target_results'],
        "minDelay":              5,
        "maxDelay":              10,
        "maxConcurrency":        10,
        "minConcurrency":        1,
        "maxRequestRetries":     100,
        "proxy":                 {"useApifyProxy": True, "apifyProxyGroups": ["RESIDENTIAL"]},
        "debug":                 False,
    }
    if resume_cursor:
        run_input["startCursor"] = resume_cursor

    print(f"  🚀 Apify actor starting (maxItems={params['max_target_results']}"
          + (f", cursor=...{resume_cursor[-20:]}" if resume_cursor else "") + ")...")
    try:
        run = client.actor(APIFY_ACTOR_ID).call(run_input=run_input,
                                                logger=_get_actor_logger())
        if not run:
            return [], None
        # apify-client 3.x returns a Run model; convert to a camelCase dict so the
        # .get('defaultDatasetId') / .get('status') access below keeps working
        # (and stays compatible with the older dict-returning client).
        if not isinstance(run, dict):
            run = run.model_dump(mode='json', by_alias=True)
        print(f"  ✅ Actor status: {run.get('status', 'UNKNOWN')}")
        dataset_id = run.get('defaultDatasetId')
        if not dataset_id:
            return [], None
        items = list(client.dataset(dataset_id).iterate_items())
        print(f"  📦 {len(items)} ads retrieved")

        last_cursor = None
        try:
            kv_store_id = run.get('defaultKeyValueStoreId')
            if kv_store_id:
                kv_store      = client.key_value_store(kv_store_id)
                cursor_record = kv_store.get_record('LAST_CURSOR')
                if cursor_record and cursor_record.get('value'):
                    last_cursor = cursor_record['value']
                    print(f"  🔖 Got cursor for resume: {str(last_cursor)[:40]}...")
        except Exception as e:
            print(f"  ⚠️  Could not fetch cursor from KV store: {e}")

        if not last_cursor and items:
            last_item   = items[-1]
            last_cursor = (
                last_item.get('paginationCursor') or
                last_item.get('endCursor') or
                last_item.get('cursor') or
                last_item.get('_cursor')
            )
            if last_cursor:
                print(f"  🔖 Got cursor from last item: {str(last_cursor)[:40]}...")

        return items, last_cursor
    except Exception as e:
        print(f"  ❌ Apify error: {e}")
        return [], None

async def fetch_facebook_ads_apify_with_resume(params, max_retries=4, retry_delay=90,
                                               empty_retries=3, empty_delay=15):
    all_collected = []
    seen_ids      = set()
    cursor        = None
    attempts      = 0

    while attempts < max_retries:
        attempts  += 1
        remaining  = params['max_target_results'] - len(all_collected)
        if remaining <= 0:
            print(f"  ✅ Reached target of {params['max_target_results']} ads")
            break

        print(f"\n  🔄 Apify attempt {attempts}/{max_retries} — "
              f"need {remaining} more ads (have {len(all_collected)})")
        attempt_params       = {**params, 'max_target_results': remaining}
        # to_thread: the Apify client's call() blocks until the actor finishes
        # (minutes). Run it off the event loop so heartbeats/log flushes keep
        # ticking — otherwise the dashboard reads a healthy run as STALLED.
        items, new_cursor    = await asyncio.to_thread(
            fetch_facebook_ads_apify, attempt_params, resume_cursor=cursor)

        # A SUCCEEDED actor run that returns 0 ads is usually a transient miss - a
        # cold container start, a momentary Facebook block, or a proxy hiccup - not
        # proof the advertiser has none. Re-run fresh a few times before believing
        # the zero. Only fresh starts (no resume cursor) are retried; a
        # mid-pagination empty just means the pages genuinely ran out.
        empty_tries = 0
        while not items and not cursor and empty_tries < empty_retries:
            empty_tries += 1
            print(f"  ⚠️  Actor SUCCEEDED but returned 0 ads — likely transient. "
                  f"Retrying fresh ({empty_tries}/{empty_retries}) after {empty_delay}s...")
            await asyncio.sleep(empty_delay)
            items, new_cursor = await asyncio.to_thread(
                fetch_facebook_ads_apify, attempt_params, resume_cursor=None)

        new_items = []
        for item in items:
            aid = str(item.get('ad_archive_id', ''))
            if aid and aid not in seen_ids:
                seen_ids.add(aid)
                new_items.append(item)
        all_collected.extend(new_items)
        print(f"  📦 +{len(new_items)} new unique ads (total: {len(all_collected)})")

        if len(all_collected) >= params['max_target_results']:
            print(f"  ✅ Target reached")
            break
        if not new_cursor:
            print(f"  ℹ️  No cursor returned — no more pages available")
            break
        if new_cursor and attempts < max_retries:
            cursor = new_cursor
            print(f"  ⏳ Rate limited mid-run. Waiting {retry_delay}s before resuming "
                  f"from cursor (attempt {attempts+1}/{max_retries})...")
            await asyncio.sleep(retry_delay)
        else:
            break

    print(f"\n  📊 Final total across {attempts} attempt(s): {len(all_collected)} ads")
    return all_collected

# ═════════════════════════════════════════════════════════════════════════════
# ★ CORE CHANGE: process a single ad fully (scrape + GPT + media)
# ═════════════════════════════════════════════════════════════════════════════
async def process_single_ad(ad, rank, bucket, media_cache, reference_data,
                            feed, domain, verticals, gpt_session):
    """
    Handles one ad end-to-end: scrape → GPT (3 concurrent) → media upload.
    Returns the row list ready for Sheets, or None on hard failure.
    """
    ad_id    = str(ad.get('ad_archive_id', 'N/A'))
    snapshot = ad.get('snapshot', {})
    body_obj = snapshot.get('body', {})
    body_text = body_obj.get('text', '') if isinstance(body_obj, dict) else ''
    link_url  = snapshot.get('link_url', '')
    if not link_url and snapshot.get('cards'):
        link_url = snapshot['cards'][0].get('link_url', '')

    # ── 1. Scrape article (async, semaphore-limited) ──────────────────────
    article_title, article_content = '', ''
    if link_url:
        print(f"  [{ad_id}] 🌐 Scraping: {link_url[:70]}...")
        article_title, article_content = await scrape_article_async(link_url)
        if article_title:
            print(f"  [{ad_id}] 📰 '{article_title[:50]}' ({len(article_content)} chars)")

    # ── 2. GPT enrichment — all 3 in parallel ────────────────────────────
    print(f"  [{ad_id}] 🤖 GPT enrichment...")
    language, country_code, vertical = await asyncio.gather(
        # Language from the ad's OWN copy, never the (often English) landing page.
        gpt_detect_language(gpt_session, ad_copy_text(snapshot)),
        gpt_detect_country(gpt_session, article_title, body_text, article_content),
        gpt_detect_vertical(gpt_session, article_title, body_text, article_content, verticals),
    )
    print(f"  [{ad_id}] 🌍 lang={language}  country={country_code}  vertical={vertical}")

    # ── 3. Build row ──────────────────────────────────────────────────────
    if ad_id in reference_data:
        print(f"  [{ad_id}] 📋 Cache HIT")
        ref_cols = reference_data[ad_id]
        padded   = ref_cols + [''] * max(0, 22 - len(ref_cols))
        ad_data  = (
            [truncate_cell_content(ad_id),
             truncate_cell_content(ad.get('page_id', ''))]
            + [truncate_cell_content(v) for v in padded[:21]]
            + ['Yes']
            + [truncate_cell_content(article_title, 500),
               truncate_cell_content(article_content),
               rank, feed, domain,
               language, country_code, vertical]
        )
    else:
        print(f"  [{ad_id}] 📋 Cache MISS — uploading media")
        media_urls = await process_ad_media(ad, bucket, media_cache)
        ad_data    = extract_ad_data(
            ad, media_urls,
            exist_flag='',
            article_title=article_title,
            article_content=article_content,
            rank=rank,
            feed=feed,
            domain=domain,
            language=language,
            country=country_code,
            vertical=vertical,
        )

    return ad_data

# ═════════════════════════════════════════════════════════════════════════════
# PROCESS ONE QUERY  (now uses batch concurrency)
# ═════════════════════════════════════════════════════════════════════════════
async def process_query(params, bucket, sheets_holder, existing_ad_ids, media_cache,
                        reference_data, websites_map, verticals):
    """
    Process one domain. Uses DOMAIN_SEMAPHORE to limit how many domains run
    concurrently, and SHEETS_LOCK to serialise Google Sheets writes.
    sheets_holder is a mutable dict {'service': ...} so all coroutines share
    the same (possibly refreshed) service object.
    """
    async with DOMAIN_SEMAPHORE:
        domain = params['query']
        print(f"\n{'='*70}\nProcessing Row {params['row_number']}: {domain}")
        print(f"Country: {params['country']}, Status: {params['activeStatus']}, "
              f"Max: {params['max_target_results']}\n{'='*70}\n")

        feed = get_feed_for_query(domain, websites_map)
        print(f"  📂 Feed: '{feed}' for domain '{domain}'")

        all_ads = await fetch_facebook_ads_apify_with_resume(params, max_retries=4, retry_delay=90)
        if not all_ads:
            print("No ads found")
            return 0

        old_enough = [ad for ad in all_ads if is_ad_at_least_week_old(ad)]
        print(f"📅 {len(all_ads)-len(old_enough)} ads filtered (too new), {len(old_enough)} remaining")

        new_ads, skipped = [], 0
        for ad in old_enough:
            if str(ad.get('ad_archive_id', '')) in existing_ad_ids:
                skipped += 1
            else:
                new_ads.append(ad)

        if skipped:
            print(f"⏭️  Skipped {skipped} (already in DB)")
        print(f"📝 {len(new_ads)} new ads to process in batches of {AD_BATCH_SIZE}\n")

        if not new_ads:
            return 0

        processed_count = 0

        async with aiohttp.ClientSession() as gpt_session:

            for batch_start in range(0, len(new_ads), AD_BATCH_SIZE):
                batch = new_ads[batch_start: batch_start + AD_BATCH_SIZE]
                batch_ranks = list(range(batch_start + 1, batch_start + len(batch) + 1))

                print(f"\n  ▶ [{domain}] Batch {batch_start // AD_BATCH_SIZE + 1} "
                      f"— ads {batch_start+1}–{batch_start+len(batch)} "
                      f"of {len(new_ads)}")

                tasks = [
                    process_single_ad(
                        ad, rank, bucket, media_cache, reference_data,
                        feed, domain, verticals, gpt_session
                    )
                    for ad, rank in zip(batch, batch_ranks)
                ]
                results = await asyncio.gather(*tasks, return_exceptions=True)

                batch_data = []
                for ad, result in zip(batch, results):
                    ad_id = str(ad.get('ad_archive_id', ''))
                    if isinstance(result, Exception):
                        print(f"  ❌ [{ad_id}] Error: {result}")
                        continue
                    if result is None:
                        print(f"  ⚠️  [{ad_id}] Returned None, skipping")
                        continue
                    batch_data.append(result)
                    existing_ad_ids.add(ad_id)

                if batch_data:
                    async with SHEETS_LOCK:
                        sheets_holder['service'] = append_to_data_sheet(
                            sheets_holder['service'], batch_data)
                    processed_count += len(batch_data)
                    print(f"  ✅ [{domain}] Batch done — {len(batch_data)} rows written "
                          f"(total so far: {processed_count})")

        print(f"\n✅ {processed_count} ads processed for: {domain}\n")
        return processed_count

# ═════════════════════════════════════════════════════════════════════════════
# MAIN
# ═════════════════════════════════════════════════════════════════════════════
async def main_async():
    global GPT_SEMAPHORE, SCRAPING_SEMAPHORE, DOMAIN_SEMAPHORE, SHEETS_LOCK

    GPT_SEMAPHORE      = asyncio.Semaphore(10)
    SCRAPING_SEMAPHORE = asyncio.Semaphore(10)
    DOMAIN_SEMAPHORE   = asyncio.Semaphore(DOMAIN_CONCURRENCY)
    SHEETS_LOCK        = asyncio.Lock()

    print(f"Starting Facebook Ads Scraper (v3 — {DOMAIN_CONCURRENCY} domains async)...\n" + "="*70)
    service = get_sheets_service()
    print("✅ Connected to Google Sheets")
    bucket = get_storage_client().get_bucket(BUCKET_NAME)
    print(f"✅ Connected to GCS bucket: {BUCKET_NAME}")

    print("\n🗑️  Clearing Data sheet...")
    service = clear_data_sheet(service)
    service = initialize_data_sheet(service)

    print("\n📚 Reading DB sheet...")
    existing_ad_ids, media_cache = read_existing_ad_ids_and_media(service)

    print("\n🔍 Reading Reference sheet...")
    reference_data = read_reference_sheet(service)

    print("\n🌐 Reading Websites sheet...")
    websites_map = read_websites_sheet(service)

    print("\n📋 Reading Verticals...")
    verticals = read_verticals(service)

    params_list = read_wa_sheet(service)
    if not params_list:
        print("❌ No parameters in WA sheet")
        return

    print(f"\n✅ {len(params_list)} queries to process ({DOMAIN_CONCURRENCY} domains concurrently)")
    print(f"📅 Only ads with start_date <= {SEVEN_DAYS_AGO.strftime('%Y-%m-%d')} (7+ days old)")
    print(f"⚡ Batch size: {AD_BATCH_SIZE} ads processed concurrently per domain\n")

    # Shared mutable holder so all coroutines can see refreshed service
    sheets_holder = {'service': service}

    # Launch ALL domains — the DOMAIN_SEMAPHORE limits to N at a time
    tasks = [
        process_query(
            params, bucket, sheets_holder, existing_ad_ids, media_cache,
            reference_data, websites_map, verticals
        )
        for params in params_list
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    total = 0
    for params, result in zip(params_list, results):
        if isinstance(result, Exception):
            print(f"❌ Domain '{params['query']}' failed: {result}")
        else:
            total += result

    print(f"\n{'='*70}\n🎉 Done! Total ads processed: {total}\n{'='*70}")


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    main()