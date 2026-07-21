"""content_flag.py - the single source of truth for prohibited-content classification
of a creative, used to keep policy-violating competitor ads OUT of the feed.

The scraper (facebookadscraperapify2026-v2.gpt_detect_prohibited), the one-off
backfill (backfill_content_flag.py), and the unit tests all import from here, so the
prompt and the answer-parsing can never drift between the live path and the backfill.
This module is deliberately dependency-free (no API keys, no network) so a lightweight
script can import it without pulling in the whole scraper.

The categories come from Google Publisher Policies "Prohibited Content Topics", looking
at BOTH the image (what the creative depicts) and the ad copy (what it says):
    none          nothing prohibited - a clean creative, stays in the feed
    adult         adult or sexual content
    weapons       weapons or violence
    gambling      gambling, casino, betting
    political     political content or election material
    hate          hate speech or discrimination
    dangerous     dangerous products or services
    before_after  before-and-after (weight loss, cosmetic) themes
    drugs         marijuana/cannabis, ketamine, psilocybin
    egg_donation  egg donation
    policy_other  some other Google Publisher Policy violation not covered above

A single most-severe slug is returned (not a set): it is enough to hide the ad and to
group it in the Filtered view, and it keeps the model output a single token like
`brand`. NULL/'' in the DB means "not classified yet"; '' is also what a failed call
returns, so a hiccup leaves the ad unclassified (and still visible) rather than
mislabelling it. The feed hides only real category slugs, never NULL/none.
"""

from __future__ import annotations

import re

# Valid buckets. 'none' means classified-clean; NULL/'' means not-classified-yet.
# Every value except 'none' is a prohibited category that gets hidden from the feed.
CONTENT_FLAG_VALUES = (
    'none', 'adult', 'weapons', 'gambling', 'political', 'hate',
    'dangerous', 'before_after', 'drugs', 'egg_donation', 'policy_other',
)

# The prohibited categories only (everything but 'none') - the set the feed hides and
# the Filtered view surfaces. Kept as a tuple derived from the source of truth above.
PROHIBITED_VALUES = tuple(v for v in CONTENT_FLAG_VALUES if v != 'none')

# gpt-4.1-mini vision model, shared by the live path and the backfill (same model the
# brand + creative-language detectors already use).
CONTENT_FLAG_MODEL = 'gpt-4.1-mini'

# Negation words that mean "clean" even when a category name trails them, so a stray
# "not gambling" / "no weapons" resolves to none instead of a false-positive hide.
_NEGATIONS = frozenset(('no', 'not', 'nothing', 'clean', 'safe', 'ok', 'na', 'n'))

_SYSTEM_PROMPT = (
    "You screen advertising creatives against Google Publisher Policies' Prohibited "
    "Content Topics, using BOTH the image (what it depicts) and the ad copy (what it "
    "says). Reply with EXACTLY ONE token, nothing else - the single most clearly "
    "applicable category, or 'none' if the ad is clean:\n"
    "- adult : adult or sexual content\n"
    "- weapons : weapons or violence\n"
    "- gambling : gambling, casino, betting\n"
    "- political : political content or election material\n"
    "- hate : hate speech or discrimination against a protected group\n"
    "- dangerous : dangerous products or services (illegal, harmful)\n"
    "- before_after : before-and-after imagery (weight loss, cosmetic results)\n"
    "- drugs : marijuana, cannabis, ketamine, psilocybin or similar\n"
    "- egg_donation : egg donation\n"
    "- policy_other : some other clear Publisher Policy violation not listed above\n"
    "- none : nothing prohibited; a clean, ordinary ad\n"
    "Only flag a category when it clearly applies. When unsure, answer none. "
    "Respond with only one of: adult, weapons, gambling, political, hate, dangerous, "
    "before_after, drugs, egg_donation, policy_other, none"
)


def normalize_content_flag(raw: str) -> str:
    """Map a model answer to one of CONTENT_FLAG_VALUES, or '' if it is unusable.

    The answer is lower-cased and reduced to letters + underscores (so "Before-After",
    "before after", "'drugs.'" all resolve). An exact match against a known slug wins
    (this covers the two-word slugs before_after / egg_donation, which arrive as one
    token). A wordy answer is parsed, but a negation anywhere ("not gambling", "no
    weapons") resolves to none FIRST so a category name trailing a negation never
    becomes a false-positive hide. Anything unusable returns '' so a hiccup leaves the
    ad unclassified and visible, to be retried, rather than mislabelled."""
    ans = re.sub(r'[^a-z_]', '', (raw or '').lower().replace('-', '_').replace(' ', '_'))
    if not ans:
        return ''
    # Fast path: the model normally returns exactly one slug (incl. the two-word ones).
    if ans in CONTENT_FLAG_VALUES:
        return ans
    parts = [p for p in ans.split('_') if p]
    # Negation / "none" anywhere wins over a trailing category name -> clean, not a hide.
    if 'none' in parts or any(p in _NEGATIONS for p in parts):
        return 'none'
    # A two-word slug embedded in a phrase ("category egg donation") - check the more
    # specific pair before falling back to single-word slugs.
    for a, b in zip(parts, parts[1:]):
        if f'{a}_{b}' in CONTENT_FLAG_VALUES:
            return f'{a}_{b}'
    # A single-word category embedded in a phrase ("the answer is gambling").
    for part in reversed(parts):
        if part in CONTENT_FLAG_VALUES:
            return part
    return ''


def build_content_flag_messages(ad_copy: str, image_url: str) -> list | None:
    """The chat `messages` for one prohibited-content call, or None when there is
    nothing to look at (no copy and no image). The image, when present, is sent at low
    detail to keep the per-ad cost to a fraction of a cent - same shape as brand."""
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
