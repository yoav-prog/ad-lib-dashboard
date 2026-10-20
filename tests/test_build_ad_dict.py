"""The raw Apify ad -> db row mapping (run_scrape.build_ad_dict).

Apify sends some snapshot text fields (a DCO card's body, an extra_texts entry) as
{'text': ...} objects rather than plain strings. Joining one raw raised "sequence item
0: expected str instance, dict found", and the scraper dropped the whole ad. These pin
that every shape lands in the row as plain text.
"""

import run_scrape


def _row(snapshot):
    return run_scrape.build_ad_dict(
        {'ad_archive_id': 'a-1', 'snapshot': snapshot}, dict(run_scrape._EMPTY_MEDIA),
        '', '', '', 1, 'feed', 'example.com', '', '', '', 'none', '',
    )


# ── _text unwraps every shape Apify uses ───────────────────────────────────────
def test_text_passes_strings_through():
    assert run_scrape._text('hello') == 'hello'


def test_text_unwraps_a_text_object():
    assert run_scrape._text({'text': 'hello'}) == 'hello'
    assert run_scrape._text({'other': 'x'}) == ''


def test_text_turns_anything_else_into_empty():
    for value in (None, 42, ['a'], {'text': None}):
        assert run_scrape._text(value) == ''


# ── DCO cards ──────────────────────────────────────────────────────────────────
def test_card_bodies_sent_as_objects_are_joined_as_text():
    row = _row({'cards': [{'body': {'text': 'first'}}, {'body': {'text': 'second'}}]})
    assert row['body_text'] == 'first | second'


def test_card_fields_mixing_strings_and_objects_are_joined():
    row = _row({'cards': [{'title': 'plain', 'body': 'a'}, {'title': {'text': 'wrapped'}}]})
    assert row['title'] == 'plain | wrapped'
    assert row['body_text'] == 'a'


def test_empty_card_values_fall_back_to_the_snapshot_value():
    row = _row({'title': 'top', 'cards': [{'title': {'text': ''}}, {'title': None}]})
    assert row['title'] == 'top'


# ── extra_texts ────────────────────────────────────────────────────────────────
def test_extra_texts_sent_as_objects_are_joined_as_text():
    row = _row({'extra_texts': [{'text': 'one'}, 'two', {'text': ''}]})
    assert row['extra_texts'] == 'one, two'


def test_missing_or_null_extra_texts_is_empty():
    assert _row({})['extra_texts'] == ''
    assert _row({'extra_texts': None})['extra_texts'] == ''
