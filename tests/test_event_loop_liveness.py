"""The heartbeat must keep ticking while slow scraper I/O is in flight.

The July 2026 incident: the sync Apify client call ran directly on the asyncio
event loop and blocked it for minutes, the 2s heartbeat froze, and the
dashboard showed healthy runs as STALLED - which invited a STOP click that
killed a live, paid-for scrape. These tests pin the fix: slow fetches run off
the loop (asyncio.to_thread), so a concurrent ticker keeps advancing. The
resume-fetch test fails on the pre-fix code, where the ticker barely moves.
"""

import asyncio
import time

import run_scrape


async def _tick_while(coro, interval=0.02):
    """Await `coro` while a side task counts how often the loop lets it tick."""
    ticks = 0
    done = asyncio.Event()

    async def ticker():
        nonlocal ticks
        while not done.is_set():
            ticks += 1
            await asyncio.sleep(interval)

    task = asyncio.create_task(ticker())
    try:
        result = await coro
    finally:
        done.set()
        await task
    return result, ticks


async def test_resume_fetch_does_not_starve_the_loop(fb, monkeypatch):
    """fetch_facebook_ads_apify_with_resume must run its blocking Apify fetch
    off the event loop. With a 0.4s blocking stand-in, a 20ms ticker should
    tick ~20 times; on the pre-fix code it managed 1-2."""
    def slow_sync_fetch(params, resume_cursor=None):
        time.sleep(0.4)  # stands in for the minutes-long actor call
        return [], None

    monkeypatch.setattr(fb, 'fetch_facebook_ads_apify', slow_sync_fetch)
    params = {'query': 'example.com', 'country': 'ALL',
              'activeStatus': 'active', 'max_target_results': 5}

    result, ticks = await _tick_while(
        fb.fetch_facebook_ads_apify_with_resume(
            params, max_retries=1, empty_retries=0))

    assert result == []
    assert ticks >= 5, f'event loop starved during the Apify fetch (ticks={ticks})'


async def test_heartbeat_keeps_flushing_during_threaded_blocking_call(monkeypatch):
    """_run_heartbeat must keep persisting heartbeats while a blocking call
    runs in a worker thread - the pattern the scraper now uses for Apify."""
    flushes = []
    monkeypatch.setattr(
        run_scrape, '_flush_once',
        lambda run_id, logger, progress: flushes.append(time.monotonic()))

    stop = asyncio.Event()
    hb = asyncio.create_task(run_scrape._run_heartbeat(
        'run-id', run_scrape.RunLogger(), {}, stop, interval=0.03))
    await asyncio.to_thread(time.sleep, 0.3)
    stop.set()
    await hb

    assert len(flushes) >= 5, f'heartbeat starved (flushes={len(flushes)})'
