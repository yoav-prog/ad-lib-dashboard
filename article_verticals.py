"""article_verticals.py - the single source of truth for "which of OUR verticals
does this competitor ad's landing article belong with, and does one of our domains
already cover it".

Two databases are involved and nothing can join them:

    adintel  (DATABASE_URL)           the competitor ads
    articles (ARTICLES_DATABASE_URL)  the ~250k articles we publish, a.k.a. the
                                      Mega Uploader database

The verticals the adintel app assigns ("Car & Auto Parts", "Mobility Aids") and the
verticals the articles database uses ("Car Deals", "Stair Lift", "Autos & Vehicles")
are different vocabularies for the same subjects, so an equality test between them
mostly fails. This module derives, from the ad's OWN landing article, a family of
verticals drawn *verbatim from the articles database vocabulary* - so the comparison
downstream is exact by construction.

Two stages, both here so the backfill and any future live path cannot drift:

    1. shortlist  embed the article and every vertical descriptor, keep the closest
                  SHORTLIST_SIZE. Embeddings rather than keyword overlap (which is
                  what the scraper's gpt_detect_vertical uses) because 38% of our
                  ads have a non-English article while every vertical name is
                  English - token overlap scores those all-zero.
    2. choose     one gpt-4.1-mini call reads the article and the shortlist and
                  returns up to MAX_FAMILY verticals from it. Anything not verbatim
                  in the shortlist is dropped, so the output is always real
                  vocabulary and never a hallucinated label.

The locale rules below (country aliasing, language normalization) mirror
web/lib/ourmatch.js exactly. If you change one, change the other; both are covered
by tests that assert the same cases.

Deliberately dependency-light: no database, no network, no API keys. numpy is
imported lazily inside the one function that needs it so the pure helpers (and the
tests over them) run without it.
"""

from __future__ import annotations

import re

# ═════════════════════════════════════════════════════════════════════════════
# LOCALE - mirrors web/lib/ourmatch.js
# ═════════════════════════════════════════════════════════════════════════════

# The two databases spell one country differently: the articles DB stores UK
# (14,573 rows), adintel stores the ISO code GB (914 ads). Left alone every UK ad
# matches nothing at all. GB is the only such alias across all 84 country codes
# adintel carries, so this is a map of one rather than an ISO-3166 exception table -
# add to it only when a second genuine mismatch shows up in the data.
COUNTRY_ALIASES = {'GB': 'UK'}

# adintel stores a language NAME ("English"), the articles DB an ISO code ("en").
# Same list as LANG_CODES in web/lib/ui.js.
LANG_CODES = {
    'english': 'en', 'spanish': 'es', 'portuguese': 'pt', 'french': 'fr', 'german': 'de',
    'italian': 'it', 'dutch': 'nl', 'hungarian': 'hu', 'polish': 'pl', 'romanian': 'ro',
    'turkish': 'tr', 'arabic': 'ar', 'russian': 'ru', 'ukrainian': 'uk', 'greek': 'el',
    'czech': 'cs', 'slovak': 'sk', 'swedish': 'sv', 'norwegian': 'no', 'danish': 'da',
    'finnish': 'fi', 'japanese': 'ja', 'chinese': 'zh', 'korean': 'ko', 'hindi': 'hi',
    'thai': 'th', 'vietnamese': 'vi', 'indonesian': 'id', 'hebrew': 'he', 'catalan': 'ca',
}


def country_key(country) -> str:
    """Uppercased country, with the GB -> UK alias applied. '' when unknown."""
    c = (country or '').strip().upper()
    if not c:
        return ''
    return COUNTRY_ALIASES.get(c, c)


def language_key(value) -> str:
    """A language name or code -> the lowercase ISO code the articles DB stores.
    An unknown value falls back to its first two letters, exactly like langCode in
    web/lib/ui.js, so a value never normalizes to ''  when it carried something."""
    v = (value or '').strip().lower()
    if not v:
        return ''
    if v in LANG_CODES:
        return LANG_CODES[v]
    for name, code in LANG_CODES.items():
        if name in v:
            return code
    return v[:2]


def ad_locale(row) -> tuple[str, str]:
    """(country, language) for matching. `language` wins over `creative_language`
    here - the opposite of Client Kits' scoreLink - because that matcher pairs a
    link WITH a creative (so the creative's language rules) while this one asks what
    market the offer is in, which is the language of the landing article."""
    return (
        country_key(row.get('country')),
        language_key(row.get('language') or row.get('creative_language')),
    )


# ═════════════════════════════════════════════════════════════════════════════
# VOCABULARY + PROMPT
# ═════════════════════════════════════════════════════════════════════════════

EMBED_MODEL = 'text-embedding-3-small'
# The same model every other classifier in this repo uses (brand.py, the scraper's
# gpt_detect_vertical), so its Chat Completions parameters are known-good here.
VERTICAL_MODEL = 'gpt-4.1-mini'

SHORTLIST_SIZE = 25     # candidates the model chooses from
MAX_FAMILY = 8          # verticals we keep per ad
EXCERPT_CHARS = 1200    # of the article body, for both the embedding and the prompt


def vocabulary_descriptor(vertical: str, category: str | None) -> str:
    """What we embed for one vertical. A bare name like "Bras" or "Tires" is a thin
    signal on its own; pairing it with the category it mostly appears under gives
    the embedding the context that makes a car article land near "Tires"."""
    v = (vertical or '').strip()
    c = (category or '').strip()
    return f'{v} - {c}' if c and c.lower() != v.lower() else v


# ScrapingBee returns markdown, and the pipeline stores its first non-empty line as the
# article title. On these landing pages that line is very often the site logo - a nested
# image-inside-link whose href is a 500-character tracking URL. Left in, it eats half the
# excerpt budget with a base64 blob and pushes the actual article out of the prompt, so
# markdown images, link chrome, bare URLs and setext rules are stripped before the excerpt is
# cut. Verified against live rows: the worst title seen was 601 characters of tracking URL and
# reduces to nothing at all here.
_MD_IMAGE = re.compile(r'!\[[^\]]*\]\([^)]*\)')
_MD_LINK = re.compile(r'\[([^\]]*)\]\([^)]*\)')
_BARE_URL = re.compile(r'https?://\S+')
_MD_RULE = re.compile(r'^\s*[=\-*_]{3,}\s*$', re.M)


def _clean(text: str) -> str:
    out = _MD_IMAGE.sub(' ', text)
    out = _MD_LINK.sub(r'\1', out)
    out = _MD_RULE.sub(' ', out)
    out = _BARE_URL.sub(' ', out)
    return re.sub(r'\s+', ' ', out).strip()


def article_excerpt(title: str | None, content: str | None) -> str:
    """The text we read the ad's topic from: headline first (it carries the most
    signal per token), then the head of the body, both stripped of markdown chrome."""
    parts = [c for c in (_clean(p) for p in (title, content) if p) if c]
    if not parts:
        return ''
    return ' . '.join(parts)[:EXCERPT_CHARS]


_SYSTEM_PROMPT = (
    "You match an advertising article to the vertical categories a publisher already "
    "writes about. You are given the article and a numbered list of candidate verticals.\n"
    "Return every candidate that covers the SAME subject family as the article - not just "
    "the single closest one. Two verticals are the same family when an article written for "
    "one would be a sensible substitute for the other in the same ad campaign: "
    "\"Used Cars\", \"Car Deals\" and \"SUV Deals\" are one family; \"Car Insurance\" and "
    "\"Personal Loans\" are a different one.\n"
    "Rules:\n"
    "- Choose ONLY from the candidates given. Never invent a vertical.\n"
    "- Copy each chosen vertical EXACTLY as written, including capitalisation.\n"
    f"- Return at most {MAX_FAMILY}, best first, one per line, nothing else.\n"
    "- The article may be in any language; the candidates are always English. Match on "
    "meaning, not on shared words.\n"
    "- If no candidate covers the article's subject, return the single word NONE."
)


def build_messages(excerpt: str, candidates: list[str]) -> list[dict] | None:
    """The Chat Completions messages for one ad, or None when there is nothing to
    classify (no article text, or no candidates survived the shortlist)."""
    if not excerpt or not candidates:
        return None
    listed = '\n'.join(f'- {c}' for c in candidates)
    return [
        {'role': 'system', 'content': _SYSTEM_PROMPT},
        {'role': 'user', 'content': f'Article:\n{excerpt}\n\nCandidate verticals:\n{listed}'},
    ]


# A list marker the model may prefix its answer with. The trailing \s+ is load-bearing:
# a bare character class would eat the "24" out of the real vertical "24/7 Nurse", which
# would then match no article for as long as the value sat in the database.
_BULLET_RE = re.compile(r'^(?:[-*•]|\d+[.)])\s+')


def parse_family(reply: str, candidates: list[str]) -> list[str]:
    """The model's reply -> verticals verbatim from `candidates`.

    Everything that is not an exact (case-insensitive) candidate is dropped rather
    than guessed at, so a hallucinated or paraphrased label can never reach the
    database and silently fail to match an article row forever after. Order and
    de-duplication follow the model's ranking; the result is capped at MAX_FAMILY.
    """
    by_lower = {c.lower(): c for c in candidates}
    out: list[str] = []
    for raw in (reply or '').splitlines():
        line = _BULLET_RE.sub('', raw.strip()).strip()
        if not line or line.upper() == 'NONE':
            continue
        hit = by_lower.get(line.lower())
        if hit and hit not in out:
            out.append(hit)
        if len(out) >= MAX_FAMILY:
            break
    return out


# ═════════════════════════════════════════════════════════════════════════════
# SHORTLIST
# ═════════════════════════════════════════════════════════════════════════════

def shortlist_indices(article_vec, vocab_matrix, top_n: int = SHORTLIST_SIZE):
    """Indices of the `top_n` closest vocabulary rows to one article vector.

    Both sides are already L2-normalized by the embedding API, so a dot product IS
    the cosine similarity and no further normalization is needed. numpy is imported
    here rather than at module scope so the pure helpers above stay importable
    without it (the unit tests never reach this function).
    """
    import numpy as np

    scores = vocab_matrix @ np.asarray(article_vec, dtype='float32')
    n = min(int(top_n), scores.shape[0])
    if n <= 0:
        return []
    # argpartition finds the top n without sorting all ~2k rows, then only those n
    # are sorted. At 30k ads the difference is minutes.
    part = np.argpartition(-scores, n - 1)[:n]
    return part[np.argsort(-scores[part])].tolist()
