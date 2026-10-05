"""
check_links.py - record whether each ad's landing page still exists.

Why this exists
    Competitors delete pages. Tarzo removed its whole /dcg/ article section in
    late August 2026 and ~9k ads in the feed kept pointing at 404s, with nothing
    in the dashboard to say so. This job requests each ad's first landing URL and
    stores the final HTTP status in ads.link_status (migration 0019); the
    dashboard marks 404/410 as DEAD (rule: link_health.py).

How it works
    - Plain requests first: free. Redirects are followed like a browser would;
      the body is never downloaded (stream=True, then closed).
    - A link the free request cannot settle is re-asked through ScrapingBee
      (link_health.spb_mode): a JavaScript challenge page (202) with JS rendering
      (5 credits), a block or no answer at all (406/429/503/timeout, after the
      free retry) through their proxy alone (1 credit). Tarzo's network blocks
      datacenter IPs outright, GitHub's runners included, so without this most of
      its links would never get a verdict. ScrapingBee's answer is kept only when
      conclusive (200/404/410); otherwise the free answer stands. --spb-credits
      caps the spend per run so a surprise can never run up the bill, and
      --no-scrapingbee (or no SCRAPINGBEE_API_KEY) skips it entirely.
    - One request per distinct URL, written to every ad that shares it.
    - Never-checked links first, then the stalest. A page that opened is
      re-checked after --recheck-days, a dead one after --recheck-dead-days (a
      deleted page almost never comes back, and re-asking thousands of them every
      week through the paid fallback would be the bulk of the bill), so a page
      that does come back stops being marked dead. An inconclusive answer (bot
      wall, rate limit, error, silence) is asked again after --retry-hours.
    - At most --per-host requests in flight per site, and the queue is
      interleaved across hosts, so no competitor gets hammered and one huge site
      cannot starve the rest. Each slot also waits --host-gap seconds before
      its next request, because Tarzo's sites block an IP that bursts (406 on
      every page, live ones included). A "slow down" answer (429/406/503) gets one retry
      after RETRY_PAUSE seconds, holding that site's slot so the whole site
      backs off, not just the one request.
    - Every request carries a connect + read timeout (a tarpit host would
      otherwise pin a worker forever), and --minutes caps the run: work not
      started by then is left for the next run. Each result is committed the
      moment it lands, so the job is safe to stop and re-run at any point.
    - A host that never answers stores NULL (unknown), not a status, and the
      link is retried on the normal re-check schedule.

Usage
    python check_links.py                    # check everything due, live
    python check_links.py --dry-run          # request + print, write nothing
    python check_links.py --limit 200        # at most 200 distinct URLs
    python check_links.py --feed tarzo       # one feed only
    python check_links.py --domain sousvideguy.com   # one tracked domain only
    python check_links.py --minutes 40       # stop starting new work after 40 min
    python check_links.py --host-gap 2       # gentler on rate-limited sites
    python check_links.py --no-scrapingbee   # free checks only, walled/blocked links stay unknown
    python check_links.py --spb-credits 2000 # spend at most 2,000 ScrapingBee credits
    python check_links.py --retry-hours 0    # re-ask every inconclusive link now

Needs DATABASE_URL, and SCRAPINGBEE_API_KEY for the paid fallback (from
.env / .env.local or the environment).
"""

from __future__ import annotations

import argparse
import os
import threading
import time
from collections import Counter, defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    from dotenv import load_dotenv
    _here = Path(__file__).resolve().parent
    load_dotenv(_here / '.env')
    load_dotenv(_here / '.env.local', override=True)
except ImportError:
    pass

import requests

import db
from link_health import RETRY_STATUSES, group_by_url, host_of, is_conclusive, is_dead, spb_mode

# A real browser's headers. Several competitor CMSs answer a bare python-requests
# UA with a bot wall, which would read as "unknown" for every link on that site.
HEADERS = {
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}

# (connect, read) seconds. Only the status line and headers are read, so a healthy
# page answers in well under a second; anything slower than this is a host we would
# rather record as unknown than wait on.
HTTP_TIMEOUT = (10, 20)

# Seconds to wait before the single retry of a "slow down" answer. Long enough for a
# per-minute rate window to reopen most of the way, short enough not to stall a run.
RETRY_PAUSE = 15

# ScrapingBee: their page timeout (ms, a query param) and our socket timeout, which
# must sit above it or a stalled render hangs the worker forever (the `timeout`
# param is theirs, not requests'). block_resources keeps a render cheap; a
# challenge only needs its own script to run.
SPB_PARAMS = {'block_resources': True, 'timeout': 30000}
SPB_TIMEOUT = (15, 90)
# Credits per lookup, by link_health.spb_mode.
SPB_CREDITS = {'js': 5, 'plain': 1}


def fetch_status(session: requests.Session, url: str) -> int | None:
    """The final HTTP status for url after redirects, or None when the host never
    gave one (timeout, refused connection, TLS failure, redirect loop)."""
    try:
        with session.get(url, headers=HEADERS, timeout=HTTP_TIMEOUT,
                         allow_redirects=True, stream=True) as resp:
            return resp.status_code
    except requests.RequestException:
        return None


def spb_status(client, url: str, mode: str) -> int | None:
    """The target's real status as seen through ScrapingBee ('js' renders the page,
    'plain' only routes the request through their proxy), or None when ScrapingBee
    itself failed. ScrapingBee forwards the target's status
    and stamps every proxied answer with Spb-Initial-Status-Code; an answer without
    it is ScrapingBee's own error (bad key, out of credits, could not render), which
    says nothing about the page."""
    try:
        resp = client.get(url, params={**SPB_PARAMS, 'render_js': mode == 'js'}, timeout=SPB_TIMEOUT)
    except Exception:
        return None
    if 'Spb-Initial-Status-Code' not in resp.headers:
        return None
    return resp.status_code


def interleave_by_host(urls: list[str]) -> list[str]:
    """Round-robin the URLs across hosts, keeping each host's own order. With the
    per-host cap, a queue that held 9k links to one site back to back would leave
    every other worker waiting on that site's slots."""
    queues: dict[str, deque] = defaultdict(deque)
    for u in urls:
        queues[host_of(u)].append(u)
    out: list[str] = []
    while queues:
        for host in list(queues):
            out.append(queues[host].popleft())
            if not queues[host]:
                del queues[host]
    return out


def main():
    ap = argparse.ArgumentParser(description="Record whether each ad's landing page still exists")
    ap.add_argument('--dry-run', action='store_true', help='request and print, write nothing')
    ap.add_argument('--limit', type=int, help='check at most N distinct URLs')
    ap.add_argument('--feed', help='only this feed (case-insensitive)')
    ap.add_argument('--domain', help='only this tracked domain (ads.domain, case-insensitive)')
    ap.add_argument('--recheck-days', type=int, default=7, help='re-check a page that opened after this long (default 7)')
    ap.add_argument('--recheck-dead-days', type=int, default=30, help='re-check a dead link after this long (default 30)')
    ap.add_argument('--retry-hours', type=int, default=20, help='re-check an inconclusive answer older than this (default 20)')
    ap.add_argument('--workers', type=int, default=24, help='concurrent requests overall (default 24)')
    ap.add_argument('--per-host', type=int, default=1, help='concurrent requests per site (default 1)')
    ap.add_argument('--host-gap', type=float, default=1.0, help='seconds between requests to one site, per slot (default 1)')
    ap.add_argument('--minutes', type=float, default=40, help='stop starting new work after this long (default 40)')
    ap.add_argument('--no-scrapingbee', action='store_true', help='never use the paid fallback')
    ap.add_argument('--spb-credits', type=int, default=10000, help='ScrapingBee credits to spend per run, at most (default 10000)')
    ap.add_argument('--spb-workers', type=int, default=10, help='concurrent ScrapingBee lookups (default 10)')
    args = ap.parse_args()

    spb = None
    if not args.no_scrapingbee and os.environ.get('SCRAPINGBEE_API_KEY'):
        from scrapingbee import ScrapingBeeClient
        spb = ScrapingBeeClient(api_key=os.environ['SCRAPINGBEE_API_KEY'])
    spb_slots = threading.Semaphore(max(1, args.spb_workers))
    spb_lock = threading.Lock()
    spb_spent: Counter = Counter()   # credits, and lookups by mode

    def spb_take(mode: str) -> bool:
        """Claim one lookup's credits from this run's --spb-credits budget."""
        cost = SPB_CREDITS[mode]
        with spb_lock:
            if spb_spent['credits'] + cost > args.spb_credits:
                return False
            spb_spent['credits'] += cost
            spb_spent[mode] += 1
            return True

    deadline = time.monotonic() + args.minutes * 60
    feed_sql = ('and lower(a.feed) = lower(%(feed)s) ' if args.feed else '')         + ('and lower(a.domain) = lower(%(domain)s)' if args.domain else '')

    with db.connect() as conn:
        rows = conn.execute(
            f"""select a.ad_archive_id, a.link_url from ads a
                where a.review_status = 'approved'
                  and a.link_url is not null and a.link_url <> ''
                  and (a.link_checked_at is null
                       or (a.link_status = 200
                           and a.link_checked_at < now() - make_interval(days => %(days)s))
                       or (a.link_status in (404, 410)
                           and a.link_checked_at < now() - make_interval(days => %(dead_days)s))
                       -- inconclusive answers (link_health.is_conclusive is false) come back sooner
                       or (not coalesce(a.link_status in (200, 404, 410), false)
                           and a.link_checked_at < now() - make_interval(hours => %(hours)s)))
                  {feed_sql}
                order by a.link_checked_at asc nulls first, a.last_seen_at desc nulls last""",
            {'days': args.recheck_days, 'dead_days': args.recheck_dead_days, 'hours': args.retry_hours,
             'feed': args.feed, 'domain': args.domain},
        ).fetchall()

        # dict preserves the query order, so the stalest URLs come first.
        by_url = group_by_url(rows)
        urls = list(by_url)
        if args.limit:
            urls = urls[:args.limit]
        urls = interleave_by_host(urls)
        hosts = {host_of(u) for u in urls}
        scope = ' '.join(filter(None, [f"feed '{args.feed}'" if args.feed else '',
                                       f"domain '{args.domain}'" if args.domain else ''])) or 'all feeds'
        print(f'{len(rows)} ad(s) due ({scope}) -> {len(by_url)} distinct URL(s); '
              f'checking {len(urls)} across {len(hosts)} site(s)'
              f'{" [DRY RUN]" if args.dry_run else ""}', flush=True)

        slots = {h: threading.Semaphore(max(1, args.per_host)) for h in hosts}
        local = threading.local()

        def check(url: str):
            if time.monotonic() > deadline:
                return url, 'skipped', False
            if not hasattr(local, 'session'):
                local.session = requests.Session()
            with slots[host_of(url)]:
                status = fetch_status(local.session, url)
                if status in RETRY_STATUSES and time.monotonic() + RETRY_PAUSE < deadline:
                    time.sleep(RETRY_PAUSE)
                    status = fetch_status(local.session, url)
                # Spacing is enforced while still holding the slot, so the site's next
                # request cannot start until the gap has passed.
                time.sleep(args.host_gap)
            # The paid fallback runs outside the site's slot: ScrapingBee's own
            # proxies make the request, so it does not count against our pacing.
            mode = spb_mode(status)
            if mode and spb and time.monotonic() < deadline and spb_take(mode):
                with spb_slots:
                    real = spb_status(spb, url, mode)
                if is_conclusive(real):
                    return url, real, True
            return url, status, False

        tally: Counter = Counter()
        dead_by_host: Counter = Counter()
        done = 0
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            for fut in as_completed([pool.submit(check, u) for u in urls]):
                url, status, via_spb = fut.result()
                if status == 'skipped':
                    tally['skipped (time budget)'] += 1
                    continue
                ids = by_url[url]
                if not args.dry_run:
                    # Writes stay on this thread, one autocommit statement per URL, so
                    # stopping the job at any point loses nothing already checked.
                    conn.execute(
                        'update ads set link_status = %s, link_checked_at = now() '
                        'where ad_archive_id = any(%s)', (status, ids))
                if via_spb:
                    tally['  of which answered through ScrapingBee'] += 1
                if is_dead(status):
                    tally['dead (404/410)'] += 1
                    dead_by_host[host_of(url)] += 1
                elif status is None:
                    tally['no answer'] += 1
                elif is_conclusive(status):
                    tally['ok'] += 1
                else:
                    tally[f'unknown ({status})'] += 1
                done += 1
                if done % 250 == 0 or (args.dry_run and done <= 50):
                    print(f'  [{done}/{len(urls)}] {status}  {url[:110]}', flush=True)

    verb = 'would record' if args.dry_run else 'recorded'
    print(f'\n{verb} {done} URL(s):', flush=True)
    for k, n in tally.most_common():
        print(f'  {n:>6}  {k}')
    if spb_spent['credits']:
        print(f"ScrapingBee: {spb_spent['plain']} proxy + {spb_spent['js']} JS lookups, "
              f"~{spb_spent['credits']:,} credits (budget {args.spb_credits:,})")
    elif not spb:
        print('ScrapingBee fallback off (--no-scrapingbee or no SCRAPINGBEE_API_KEY): walled/blocked links stay unknown')
    if dead_by_host:
        print('dead links by site:')
        for h, n in dead_by_host.most_common(25):
            print(f'  {n:>6}  {h}')


if __name__ == '__main__':
    main()
