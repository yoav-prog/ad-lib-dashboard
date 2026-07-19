"""brand.py - the single source of truth for brand classification of a creative.

The scraper (facebookadscraperapify2026-v2.gpt_detect_brand), the one-off
backfill (backfill_brand.py), and the unit tests all import from here, so the
prompt and the answer-parsing can never drift between the live path and the
backfill. This module is deliberately dependency-free (no API keys, no network)
so a lightweight script can import it without pulling in the whole scraper.

The three buckets, from BOTH the image (logos, packaging, wordmarks) and the ad
copy (brand names):
    none       no recognizable brand - a generic / unbranded creative
    brand      some recognizable commercial brand is present
    car_brand  the brand is an automobile manufacturer - its own bucket because
               car brands are a lighter compliance category than the rest
"""

from __future__ import annotations

import re

# Valid brand buckets. NULL/'' in the DB means "not classified yet".
BRAND_VALUES = ('none', 'brand', 'car_brand')

# gpt-4.1-mini vision model shared by the live path and the backfill.
BRAND_MODEL = 'gpt-4.1-mini'

_SYSTEM_PROMPT = (
    "You classify whether an advertising CREATIVE features a commercial brand, "
    "using BOTH the image (logos, product packaging, wordmarks) and the ad copy "
    "(brand names). Reply with EXACTLY ONE token, nothing else:\n"
    "- car_brand : the brand shown or named is an automobile manufacturer "
    "(e.g. Toyota, BMW, Ford, Tesla, Mercedes)\n"
    "- brand : any other recognizable commercial brand is present\n"
    "- none : no recognizable brand; a generic or unbranded creative\n"
    "Respond with only one of: car_brand, brand, none"
)


def normalize_brand(raw: str) -> str:
    """Map a model answer to one of BRAND_VALUES, or '' if it is unusable.

    Order matters: 'car' is checked before the bare 'brand' so 'car_brand' is not
    swallowed by the brand branch. Junk / empty answers return '' so a hiccup never
    writes a wrong label."""
    ans = re.sub(r'[^a-z]', '', (raw or '').lower())
    if not ans:
        return ''
    if 'car' in ans:
        return 'car_brand'
    # Check none/no BEFORE bare 'brand': "no brand" / "not a brand" strip to
    # 'nobrand' / 'notabrand', which contain 'brand' as a substring and would
    # otherwise be misread as a positive brand hit.
    if 'none' in ans or 'no' in ans:
        return 'none'
    if 'brand' in ans:
        return 'brand'
    return ''


def build_brand_messages(ad_copy: str, image_url: str) -> list | None:
    """The chat `messages` for one brand call, or None when there is nothing to look
    at (no copy and no image). The image, when present, is sent at low detail to keep
    the per-ad cost to a fraction of a cent."""
    text = (ad_copy or '').strip()
    image_url = (image_url or '').strip()
    if not text and not image_url:
        return None
    user_content = [{"type": "text", "text": f"Ad copy:\n{text[:800] or '(none)'}"}]
    if image_url.startswith(('http://', 'https://')):
        user_content.append({"type": "image_url",
                             "image_url": {"url": image_url, "detail": "low"}})
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]
