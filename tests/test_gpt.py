"""The chat model's request shape (gpt.py).

Every mistake pinned here fails SILENTLY in production: gpt-6-luna answers 200 with
empty text, and the detectors store that as "not classified". Measured 2026-11-04 on
real ads: a plain model swap blanked every brand label (the 3-token cap was spent
before the answer) and default reasoning blanked everything (the cap was spent
thinking). So these tests fail loudly instead.
"""

import asyncio
import re
from pathlib import Path

import gpt

ROOT = Path(__file__).resolve().parent.parent


# ── the settings themselves ───────────────────────────────────────────────────
def test_chat_params_turn_reasoning_off_and_use_the_completion_cap():
    params = gpt.chat_params(3)
    assert params['reasoning_effort'] == 'none'
    assert params['temperature'] == 0
    assert 'max_tokens' not in params                 # rejected by the model (400)
    assert params['max_completion_tokens'] >= 3 + 5   # 'car_brand' alone costs 5


def test_headroom_rides_on_every_cap():
    for answer in (3, 4, 5, 10, 30, 40, 160):
        assert gpt.chat_params(answer)['max_completion_tokens'] == answer + gpt.ANSWER_HEADROOM


def test_no_python_call_site_still_sends_max_tokens():
    offenders = [
        p.name for p in ROOT.glob('*.py')
        if ' (1)' not in p.name   # the leaked pre-edit scraper copy, gitignored and unused
        and re.search(r'''["']max_tokens["']''', p.read_text(encoding='utf-8'))
    ]
    assert offenders == []


# ── the scraper's detectors send exactly these settings ───────────────────────
class _Response:
    def __init__(self, content):
        self.status = 200
        self._content = content

    async def json(self):
        return {'choices': [{'message': {'content': self._content}}]}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class CaptureSession:
    """Stands in for the aiohttp session; records every payload, answers `content`."""

    def __init__(self, content):
        self.content = content
        self.payloads = []

    def post(self, url, json=None, **kwargs):
        self.payloads.append(json)
        return _Response(self.content)


async def test_scraper_detectors_send_the_shared_model_and_settings(fb, monkeypatch):
    monkeypatch.setattr(fb, 'GPT_SEMAPHORE', asyncio.Semaphore(4))
    image = 'https://storage.googleapis.com/bucket/a.jpg'
    session = CaptureSession('none')
    await fb.gpt_detect_language(session, 'Descubre cómo solicitar un préstamo')
    await fb.gpt_detect_country(session, 'Title', 'Body', 'Article')
    await fb.gpt_detect_vertical(session, 'Title', 'Body', 'Article', ['Loans', 'Insurance'])
    await fb.gpt_detect_brand(session, 'Ad copy', image)
    await fb.gpt_detect_creative_language(session, image)
    await fb.gpt_detect_prohibited(session, 'Ad copy', image)
    await fb.gpt_detect_rsoc_risk(session, 'Ad copy', image, 'example.com')

    assert len(session.payloads) == 7
    for payload in session.payloads:
        assert payload['model'] == gpt.CHAT_MODEL
        assert payload['reasoning_effort'] == 'none'
        assert 'max_tokens' not in payload
        assert payload['max_completion_tokens'] > gpt.ANSWER_HEADROOM


async def test_brand_reads_the_answer_luna_returns(fb, monkeypatch):
    monkeypatch.setattr(fb, 'GPT_SEMAPHORE', asyncio.Semaphore(1))
    assert await fb.gpt_detect_brand(CaptureSession('car_brand'), 'Toyota Corolla deals', '') == 'car_brand'
