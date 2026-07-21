"""Prohibited-content classification parsing (content_flag.py) - the single source of
truth shared by the live scraper (gpt_detect_prohibited) and the one-off backfill
(backfill_content_flag.py). A wrong parse would either leak a prohibited ad into the
feed (false negative) or silently hide a clean one (false positive), so the
normalization is pinned here - especially the negation guard, which is the difference
between "not gambling" reading clean and it wrongly hiding the ad.

Also guards the db wiring: content_flag must ride in AD_COLUMNS (or it never persists)
and must stay OUT of the update set (or a re-scrape re-hides an ad a human cleared).
"""

import content_flag
import db


# ── normalize_content_flag maps model answers to one category slug ────────────
def test_every_valid_slug_resolves_to_itself():
    for slug in content_flag.CONTENT_FLAG_VALUES:
        assert content_flag.normalize_content_flag(slug) == slug


def test_two_word_slugs_survive_casing_and_separators():
    for raw in ('before_after', 'Before-After', 'before after', 'BEFORE AFTER'):
        assert content_flag.normalize_content_flag(raw) == 'before_after'
    for raw in ('egg_donation', 'Egg Donation', 'egg-donation'):
        assert content_flag.normalize_content_flag(raw) == 'egg_donation'


def test_punctuation_and_casing_are_stripped():
    assert content_flag.normalize_content_flag('Gambling.') == 'gambling'
    assert content_flag.normalize_content_flag('  DRUGS\n') == 'drugs'
    assert content_flag.normalize_content_flag("'weapons'") == 'weapons'


def test_none_and_negations_resolve_to_none_not_a_category():
    # The critical guard: a category name trailing a negation must never become a
    # false-positive hide. "not gambling" is clean, not gambling.
    for raw in ('none', 'None', 'none.', 'no', 'nothing prohibited', 'clean'):
        assert content_flag.normalize_content_flag(raw) == 'none'
    for raw in ('not gambling', 'no weapons', 'not adult', 'no drugs'):
        assert content_flag.normalize_content_flag(raw) == 'none'


def test_a_category_embedded_in_a_phrase_still_resolves():
    assert content_flag.normalize_content_flag('category: gambling') == 'gambling'
    assert content_flag.normalize_content_flag('the answer is egg donation') == 'egg_donation'


def test_unusable_answers_return_empty_never_a_wrong_label():
    for raw in ('', None, '   ', '123', '???', 'purple', 'maybe', 'unsure'):
        assert content_flag.normalize_content_flag(raw) == ''


def test_prohibited_values_is_every_slug_but_none():
    assert 'none' not in content_flag.PROHIBITED_VALUES
    assert set(content_flag.PROHIBITED_VALUES) == set(content_flag.CONTENT_FLAG_VALUES) - {'none'}


# ── build_content_flag_messages assembles the vision request ──────────────────
def test_messages_none_when_nothing_to_look_at():
    assert content_flag.build_content_flag_messages('', '') is None
    assert content_flag.build_content_flag_messages(None, None) is None


def test_messages_include_image_only_for_http_urls():
    with_img = content_flag.build_content_flag_messages('some copy', 'https://cdn.example.com/a.jpg')
    assert any(p.get('type') == 'image_url' for p in with_img[1]['content'])

    # A non-http value (expired/blank) must not become a bogus image part.
    text_only = content_flag.build_content_flag_messages('some copy', 'data:image/png;base64,xxx')
    assert all(p.get('type') != 'image_url' for p in text_only[1]['content'])


def test_messages_work_with_image_and_no_copy():
    msgs = content_flag.build_content_flag_messages('', 'https://cdn.example.com/a.jpg')
    assert msgs is not None
    assert any(p.get('type') == 'image_url' for p in msgs[1]['content'])


# ── db wiring: content_flag persists, but is insert-only (protects the override) ─
def test_content_flag_is_a_persisted_column():
    assert 'content_flag' in db.AD_COLUMNS


def test_content_flag_is_insert_only_so_a_rescrape_never_re_hides_a_cleared_ad():
    # Like review_status, content_flag must not be in the ON CONFLICT update set: a
    # human clearing a false positive to 'none' must survive the next sighting.
    assert 'content_flag' not in db._UPDATE_COLUMNS
