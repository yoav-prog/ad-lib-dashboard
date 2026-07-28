"""rsoc_policy.py - the single source of truth for the RSoC policy-risk classification
of a Fresh Finds row, used to tell us how much policy care a competitor ad's TOPIC/ANGLE
would demand if we turned it into our own article and monetised it via Google RSoC
(Related Search on Content / AdSense for Search).

The scraper (facebookadscraperapify2026-v2.gpt_detect_rsoc_risk), the one-off backfill
(backfill_rsoc_policy.py), and the unit tests all import from here, so the prompt, the
deny-list, and the answer-parsing can never drift between the live path and the backfill.
This module is deliberately dependency-free (no API keys, no network) so a lightweight
script can import it without pulling in the whole scraper - identical to content_flag.py.

WHAT THIS IS NOT
    This is a DIFFERENT axis from content_flag.py. content_flag hides ads that break
    Google Publisher *Policies* (Prohibited Content) - a binary hide. Everything visible
    in Fresh Finds already passed that screen. This module GRADES the survivors against
    Google Publisher *Restrictions* (limit-serving verticals) + RSoC-specific
    misleading/exaggerated-claim rules, and never hides anything.

THE HONEST FRAMING (read before touching the tiers)
    We can only see the competitor's AD. The strike lands on the ARTICLE we publish. So
    this scores ONE INPUT to the real risk, not the risk itself. `green` therefore means
    "no known RSoC restriction on this topic", NOT "safe to publish" - the article still
    needs a publish-time check (see _plans/2026-07-28-rsoc-policy-column.md, Phase 2).

THE TIERS
    green   no restricted vertical and no exaggerated/misleading angle detected
    yellow  sensitive - a restricted-adjacent vertical or an aggressive angle that CAN be
            written compliantly but needs a human to look
    red     a Publisher-Restriction vertical, or an angle that inherently violates
            (miracle cure, guaranteed income, before/after weight-loss claims)

Each verdict is (tier, policy_area, reason): the tier drives the chip colour, policy_area
is a short slug naming which rule tripped (mapped to a label in the UI), and reason is a
<=~12-word human sentence. NULL/'' on all three means "not classified yet"; a failed model
call returns Nones so a hiccup leaves the row unscored (and shown) rather than mislabelled.

THE DETERMINISTIC FLOOR (the cheap safety net)
    The catastrophic failure is a confident false-`green` on a genuinely hazardous vertical
    - and an LLM waffles exactly there. So a hard-coded deny-list (`HAZARD_RULES` below)
    forces the tier UP regardless of what the model says: the model grades on top of the
    floor, it cannot grade below it. Optimise the tail, not the average call.
"""

from __future__ import annotations

import re

# gpt-4.1-mini vision model, shared with the sibling detectors (brand / creative-language /
# content_flag). Adequate for vertical bucketing; the fuzzy misleading-claim judgement truly
# belongs to the not-yet-written article, so we do not overspend here (see the plan).
RSOC_MODEL = 'gpt-4.1-mini'

# The three tiers, least to most severe. Severity is what the deny-list floor and the
# model verdict are combined on: the more severe of the two always wins.
RSOC_TIERS = ('green', 'yellow', 'red')
_TIER_SEVERITY = {'green': 0, 'yellow': 1, 'red': 2}

# The policy-area slugs a verdict can carry, each mapped to a UI label. Grounded in Google
# Publisher Restrictions (the limit-serving verticals) + Publisher Policies "Misrepresentative
# content" + the AFS deceptive-implementation rules. Kept in sync with RSOC_POLICY_AREAS in
# web/lib/ui.js. 'none' is the clean/green area; 'other' is the catch-all.
POLICY_AREA_LABELS = {
    'none':          'Clear',
    'health_claims': 'Health / medical claims',
    'supplements':   'Unapproved supplements',
    'prescription':  'Prescription drugs',
    'weight_loss':   'Weight-loss / before-after',
    'financial':     'Financial / get-rich',
    'gambling':      'Online gambling',
    'alcohol':       'Alcohol',
    'tobacco':       'Tobacco / vaping',
    'drugs':         'Recreational drugs / CBD',
    'weapons':       'Weapons',
    'adult':         'Sexual / suggestive',
    'shocking':      'Shocking content',
    'political':     'Political / sensitive',
    'misleading':    'Misleading / clickbait',
    'other':         'Other policy',
}
POLICY_AREAS = tuple(POLICY_AREA_LABELS)

# ═════════════════════════════════════════════════════════════════════════════
# DETERMINISTIC DENY-LIST FLOOR  ***  EDIT ME  ***
# ═════════════════════════════════════════════════════════════════════════════
# A first-pass, model-independent floor. Each rule is (tier, area, reason, keywords):
# if any keyword matches the ad copy (whole-word, case-insensitive) OR the landing domain,
# the tier is forced to AT LEAST this rule's tier. The model can only push it higher.
#
# This is a STARTER list drafted from the Publisher-Restriction verticals + the classic
# RSoC-killer angles. It is meant to be edited: add the terms and domains you have seen get
# accounts struck, loosen anything too aggressive. Keep the most-severe (red) rules tight so
# they do not false-positive a clean article into red. Every rule is covered by a unit test.
HAZARD_RULES = (
    ('red', 'financial', 'Deny-list: get-rich / guaranteed-return angle', (
        'get rich', 'make money fast', 'guaranteed income', 'guaranteed returns',
        'double your money', 'passive income guaranteed', 'forex signals',
        'crypto profit', 'bitcoin profit', 'quit your job',
    )),
    ('red', 'weight_loss', 'Deny-list: miracle weight-loss / before-after claim', (
        'melts fat', 'melt fat', 'burn fat overnight', 'lose weight fast',
        'before and after', 'before & after', 'shocking results', 'doctors hate',
    )),
    ('red', 'health_claims', 'Deny-list: miracle-cure / disease claim', (
        'miracle cure', 'reverse diabetes', 'cure diabetes', 'cures cancer',
        'reverse aging', 'reverse ageing', 'cure for', 'natural remedy for',
    )),
    ('red', 'supplements', 'Deny-list: unapproved supplement', (
        'keto gummies', 'cbd', 'hemp oil', 'cannabidiol', 'male enhancement',
        'testosterone booster', 'weight loss pills', 'diet pills', 'appetite suppressant',
    )),
    ('red', 'prescription', 'Deny-list: prescription drug', (
        'ozempic', 'semaglutide', 'wegovy', 'viagra', 'cialis', 'xanax',
        'adderall', 'oxycodone', 'tramadol',
    )),
    ('red', 'drugs', 'Deny-list: recreational drug', (
        'cannabis', 'marijuana', 'thc', 'kratom', 'psilocybin', 'ketamine', 'delta-8',
    )),
    ('red', 'weapons', 'Deny-list: weapon / ammunition', (
        'ammo', 'ammunition', 'firearm', 'handgun', 'ar-15', 'silencer', 'ghost gun',
    )),
    ('red', 'gambling', 'Deny-list: real-money gambling', (
        'online casino', 'sports betting', 'sportsbook', 'real money slots',
        'poker real money', 'betting odds',
    )),
    ('red', 'adult', 'Deny-list: adult / sexual', (
        'escort', 'hookup', 'porn', 'onlyfans', 'nude photos', 'adult dating',
    )),
    ('yellow', 'tobacco', 'Deny-list: tobacco / vaping - restricted vertical', (
        'vape', 'e-cigarette', 'nicotine pouch', 'nicotine',
    )),
    ('yellow', 'alcohol', 'Deny-list: alcohol - restricted vertical', (
        'whiskey', 'vodka', 'tequila', 'wine deals', 'craft beer',
    )),
    ('yellow', 'political', 'Deny-list: political / sensitive - restricted vertical', (
        'vote for', 'election', 'political campaign', 'ballot',
    )),
)

# Landing-domain substrings that force a floor regardless of copy (e.g. known pharma /
# supplement / gambling domains). Domain matches are substring (not whole-word) so a
# subdomain or path-less host still trips. Starter list - add yours.
HAZARD_DOMAINS = (
    ('red', 'gambling', 'Deny-list: gambling domain', ('casino', 'bet365', 'sportsbook', 'stake')),
    ('red', 'supplements', 'Deny-list: supplement domain', ('keto', 'cbd', 'slimming')),
)


def _compile_rule_pattern(keywords):
    """A single whole-word, case-insensitive regex OR-ing a rule's keywords. Whole-word so
    'ammo' does not fire inside 'ammonia' and 'cbd' does not fire inside a random token; the
    boundaries still allow multi-word ('get rich') and hyphenated ('ar-15') phrases."""
    alts = '|'.join(re.escape(k) for k in keywords)
    return re.compile(rf'(?<!\w)(?:{alts})(?!\w)', re.IGNORECASE)


_COMPILED_HAZARDS = tuple(
    (tier, area, reason, _compile_rule_pattern(keywords))
    for (tier, area, reason, keywords) in HAZARD_RULES
)


def hazard_floor(ad_copy: str, domain: str) -> tuple | None:
    """The deterministic floor: the MOST SEVERE deny-list rule the copy or domain trips, as
    (tier, policy_area, reason), or None when nothing matches. Domain rules and keyword rules
    share the same severity comparison, so a red domain beats a yellow keyword and vice versa."""
    text = ad_copy or ''
    host = (domain or '').lower()
    best = None  # (severity, tier, area, reason)

    for (tier, area, reason, pattern) in _COMPILED_HAZARDS:
        if pattern.search(text):
            sev = _TIER_SEVERITY[tier]
            if best is None or sev > best[0]:
                best = (sev, tier, area, reason)

    for (tier, area, reason, subs) in HAZARD_DOMAINS:
        if host and any(sub in host for sub in subs):
            sev = _TIER_SEVERITY[tier]
            if best is None or sev > best[0]:
                best = (sev, tier, area, reason)

    return None if best is None else (best[1], best[2], best[3])


_SYSTEM_PROMPT = (
    "You assess how much Google RSoC (Related Search on Content / AdSense for Search) policy "
    "care an article built on this ad's TOPIC and ANGLE would need. Judge the topic and the "
    "claim style, using BOTH the image and the ad copy. Reply with EXACTLY ONE line in the "
    "form:\n"
    "tier | area | reason\n"
    "tier is one of:\n"
    "- red : a Google Publisher-Restriction vertical (unapproved supplements, prescription "
    "drugs, recreational drugs, weapons, online gambling, alcohol/tobacco, sexual content), "
    "OR an angle that inherently breaks policy (miracle cure, cures a disease, guaranteed "
    "income/returns, before/after weight-loss claims, shocking imagery).\n"
    "- yellow : a sensitive or restricted-adjacent topic that CAN be written compliantly but "
    "needs care (general health/finance/insurance advice, dating, mild claims).\n"
    "- green : an ordinary consumer topic with no restricted vertical and no exaggerated "
    "or misleading claim.\n"
    "area is ONE slug describing the main risk: health_claims, supplements, prescription, "
    "weight_loss, financial, gambling, alcohol, tobacco, drugs, weapons, adult, shocking, "
    "political, misleading, other, or none (for green).\n"
    "reason is <=12 words, plain, and MUST NOT contain a '|' character.\n"
    "When unsure between two tiers, choose the MORE severe one. Answer with only the single "
    "line, nothing else."
)


def build_rsoc_messages(ad_copy: str, image_url: str, domain: str = '') -> list | None:
    """The chat `messages` for one RSoC-risk call, or None when there is nothing for the model
    to look at (no copy and no image - the deny-list floor may still fire on the domain). The
    image is sent at low detail to keep the per-ad cost to a fraction of a cent, same as the
    sibling detectors. The landing domain rides along as extra topic context."""
    text = (ad_copy or '').strip()
    image_url = (image_url or '').strip()
    domain = (domain or '').strip()
    if not text and not image_url:
        return None
    header = f"Landing domain: {domain or '(unknown)'}\nAd copy:\n{text[:800] or '(none)'}"
    user_content = [{"type": "text", "text": header}]
    if image_url.startswith(('http://', 'https://')):
        user_content.append({"type": "image_url",
                             "image_url": {"url": image_url, "detail": "low"}})
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]


def _normalize_tier(raw: str) -> str:
    """Map a token to one of RSOC_TIERS, or '' if it is not a tier word."""
    t = re.sub(r'[^a-z]', '', (raw or '').lower())
    return t if t in _TIER_SEVERITY else ''


def _normalize_area(raw: str, tier: str) -> str:
    """Map a token to a POLICY_AREAS slug. Unknown/blank falls back to 'none' for green and
    'other' otherwise, so an off-list answer is still stored as a valid, honest slug."""
    a = re.sub(r'[^a-z_]', '', (raw or '').lower().replace('-', '_').replace(' ', '_'))
    if a in POLICY_AREA_LABELS:
        return a
    return 'none' if tier == 'green' else 'other'


def _clean_reason(raw: str, tier: str, area: str) -> str:
    """A tidy <=120-char reason. Falls back to the area label when the model omitted one."""
    reason = re.sub(r'\s+', ' ', (raw or '').replace('|', ' ')).strip()
    if not reason:
        reason = 'No restricted signal detected' if tier == 'green' else POLICY_AREA_LABELS.get(area, 'Policy risk')
    return reason[:120]


def parse_rsoc_answer(raw: str) -> tuple | None:
    """Parse a model answer into (tier, policy_area, reason), or None when it is unusable.

    The model is asked for a single `tier | area | reason` line. We scan the lines for the
    first whose leading token is a real tier (so a stray preamble line does not break it), then
    normalise the three fields. A missing area/reason is filled in rather than rejected; only a
    total absence of any tier word returns None, so a hiccup leaves the row unscored (NULL) and
    visible, to be retried, rather than mislabelled."""
    for line in (raw or '').splitlines():
        parts = [p.strip() for p in line.split('|')]
        tier = _normalize_tier(parts[0]) if parts else ''
        if tier:
            area = _normalize_area(parts[1] if len(parts) > 1 else '', tier)
            reason = _clean_reason(parts[2] if len(parts) > 2 else '', tier, area)
            return (tier, area, reason)
    # No pipe line worked - last resort: a bare tier word anywhere in the answer.
    for token in re.findall(r'[a-z]+', (raw or '').lower()):
        if token in _TIER_SEVERITY:
            area = 'none' if token == 'green' else 'other'
            return (token, area, _clean_reason('', token, area))
    return None


def combine_verdict(model_verdict: tuple | None, floor: tuple | None) -> tuple:
    """Merge the model verdict with the deterministic floor into a final (tier, area, reason).

    The more severe tier wins. The deny-list wins ties and whenever it is at least as severe as
    the model (a hard-coded red is never talked down to green by a waffling model); the model's
    more specific (area, reason) win only when the model is STRICTLY more severe than the floor.
    Returns (None, None, None) when neither source produced anything - the row stays unscored."""
    if floor is None and model_verdict is None:
        return (None, None, None)
    if floor is None:
        return model_verdict
    if model_verdict is None:
        return floor
    if _TIER_SEVERITY[model_verdict[0]] > _TIER_SEVERITY[floor[0]]:
        return model_verdict
    return floor
