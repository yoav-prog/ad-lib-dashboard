"""Brand classification parsing (brand.py) - the single source of truth shared by
the live scraper (gpt_detect_brand) and the one-off backfill (backfill_brand.py).
A wrong parse would silently mislabel every ad, so pin the normalization here.
"""

import brand


# ── normalize_brand maps model answers to the three buckets ───────────────────
def test_car_brand_wins_over_bare_brand():
    # 'car_brand' contains 'brand'; the car check must come first.
    for raw in ('car_brand', 'Car_brand', 'CAR BRAND', ' car_brand.', 'car'):
        assert brand.normalize_brand(raw) == 'car_brand'


def test_plain_brand():
    for raw in ('brand', 'Brand', 'brand.', ' brand\n'):
        assert brand.normalize_brand(raw) == 'brand'


def test_none():
    for raw in ('none', 'None', 'no', 'none.'):
        assert brand.normalize_brand(raw) == 'none'


def test_natural_language_negations_are_none_not_brand():
    # "no brand" / "not a brand" contain 'brand' as a substring; they must still
    # resolve to none, never a false positive brand.
    for raw in ('no brand', 'No Brand', 'not a brand', 'no-brand'):
        assert brand.normalize_brand(raw) == 'none'


def test_unusable_answers_return_empty():
    for raw in ('', None, '   ', '123', '???', 'purple'):
        assert brand.normalize_brand(raw) == ''


def test_every_value_is_a_known_bucket():
    for v in ('none', 'brand', 'car_brand'):
        assert v in brand.BRAND_VALUES


# ── build_brand_messages assembles the vision request ─────────────────────────
def test_messages_none_when_nothing_to_look_at():
    assert brand.build_brand_messages('', '') is None
    assert brand.build_brand_messages(None, None) is None


def test_messages_include_image_only_for_http_urls():
    with_img = brand.build_brand_messages('some copy', 'https://cdn.example.com/a.jpg')
    parts = with_img[1]['content']
    assert any(p.get('type') == 'image_url' for p in parts)

    # A non-http value (expired/blank) must not become a bogus image part.
    text_only = brand.build_brand_messages('some copy', 'data:image/png;base64,xxx')
    assert all(p.get('type') != 'image_url' for p in text_only[1]['content'])


def test_messages_work_with_image_and_no_copy():
    msgs = brand.build_brand_messages('', 'https://cdn.example.com/a.jpg')
    assert msgs is not None
    assert any(p.get('type') == 'image_url' for p in msgs[1]['content'])
