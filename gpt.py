"""
gpt.py - the chat model every classifier in this repo calls, and how to call it.

Imported by the scraper's detectors, the backfills that share their prompts, and
the tests. Dependency-free (no API keys, no network), like brand.py and its
siblings. The web app's AI draft route (web/app/api/draft/route.js) sends the same
model with the same reasoning setting; keep the two in step.

gpt-6-luna replaced gpt-4.1-mini on 2026-11-04 (A/B on real ads in
_plans/2026-11-04-gpt-6-luna.md). Each quirk below fails SILENTLY - the API answers
200 with empty text, and every caller stores that as "not classified":
  - It is a reasoning model, medium effort by default. With answers capped at a
    few tokens, default reasoning spends the whole budget and returns nothing.
    reasoning_effort 'none' turns reasoning off, and is also the only setting
    that accepts temperature 0.
  - max_tokens is rejected outright (400); the cap is max_completion_tokens.
  - Even with reasoning off it spends ~3 completion tokens beyond the visible
    answer ('car_brand' costs 5, not 2), so every cap gets ANSWER_HEADROOM.
    Billing is per token actually generated, so the headroom costs nothing.
"""

from __future__ import annotations

CHAT_MODEL = 'gpt-6-luna'

# Completion tokens added to every answer cap (see the module docstring). Generous on
# purpose: a cap that is too tight returns an empty answer, never an error.
ANSWER_HEADROOM = 16


def chat_params(answer_tokens: int) -> dict:
    """The request settings for one deterministic classifier answer of up to
    `answer_tokens` visible tokens, to merge into a Chat Completions payload beside
    the model and the messages."""
    return {
        'max_completion_tokens': answer_tokens + ANSWER_HEADROOM,
        'reasoning_effort': 'none',
        'temperature': 0,
    }
