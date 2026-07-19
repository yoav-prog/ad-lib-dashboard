"""creative_language.py - single source of truth for detecting the language of the
text shown ON a creative (the image, or a video's frame), as opposed to the ad's
copy fields (which db `language` already covers via ad_copy_text).

The scraper (facebookadscraperapify2026-v2.gpt_detect_creative_language), the one-off
backfill (backfill_creative_language.py), and the tests all import from here, so the
prompt and the answer-parsing never drift. Dependency-free (no API keys, no network)
so a lightweight script can import it without pulling in the whole scraper.

The model returns a language NAME ("Spanish", "Portuguese", ...) so the dashboard's
langCode badge works on both this and the copy `language`; it returns 'none' when the
creative carries no readable text, which normalize_language maps to '' (empty).
"""

from __future__ import annotations

# gpt-4.1-mini vision model, shared by the live path and the backfill.
CREATIVE_LANGUAGE_MODEL = 'gpt-4.1-mini'

# A reply meaning "the creative has no readable text" - stored as '' (empty), which
# is distinct from NULL (not classified yet).
_NO_TEXT = {'none', 'no text', 'notext', 'n/a', 'na', 'unknown', ''}

_SYSTEM_PROMPT = (
    "You are shown an advertising CREATIVE (an image, or a still frame from a video "
    "ad). Identify the language of the TEXT visible in it - headlines, overlaid "
    "captions, text on the product or packaging. Judge by the on-image text, not by "
    "what the image depicts.\n"
    "Respond with ONLY the language name in English (e.g. English, Spanish, French, "
    "German, Portuguese). If there is no readable text at all, respond with exactly: "
    "none"
)


def normalize_language(raw: str) -> str:
    """Clean a model reply to a language name, or '' when the creative has no readable
    text (or the reply is unusable). Keeps a real name as-is (title-cased) so it lines
    up with the copy `language` values and langCode can badge it."""
    name = ' '.join((raw or '').strip().split())
    if not name:
        return ''
    # Trim trailing punctuation the model sometimes adds ("Spanish.").
    name = name.strip('.,:;!?"\'')
    low = name.lower()
    # "none" / "no text" / "there is no readable text" all mean no on-creative text.
    if low in _NO_TEXT or 'no text' in low or 'notext' in low or 'no readable' in low:
        return ''
    # A stray sentence ("The text is Spanish") -> keep the last word as the language.
    if ' ' in name:
        tail = name.split()[-1].strip('.,:;!?"\'')
        if tail.lower() in _NO_TEXT:
            return ''
        name = tail
    return name[:1].upper() + name[1:].lower() if name.isalpha() else name


def build_creative_language_messages(image_url: str) -> list | None:
    """The chat `messages` for one creative-language call, or None when there is no
    image to look at. The image is sent at low detail to keep the per-ad cost to a
    fraction of a cent."""
    image_url = (image_url or '').strip()
    if not image_url.startswith(('http://', 'https://')):
        return None
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": [
            {"type": "text", "text": "What language is the text in this creative?"},
            {"type": "image_url", "image_url": {"url": image_url, "detail": "low"}},
        ]},
    ]
