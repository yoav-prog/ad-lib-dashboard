"""Creative-language parsing (creative_language.py) - the single source of truth
shared by the live scraper (gpt_detect_creative_language) and the backfill. A wrong
parse would silently mislabel the on-creative language of every ad, so pin it here.
The '' vs None distinction matters: '' means 'no readable text' (a terminal answer),
None means the call failed (retry), and only the detector returns None - the parser
returns a name or ''.
"""

import creative_language as cl


def test_language_names_pass_through_titlecased():
    assert cl.normalize_language('Spanish') == 'Spanish'
    assert cl.normalize_language('spanish') == 'Spanish'
    assert cl.normalize_language('  PORTUGUESE  ') == 'Portuguese'
    assert cl.normalize_language('English.') == 'English'


def test_no_text_answers_become_empty():
    for raw in ('none', 'None', 'no text', 'N/A', '', '   ', None):
        assert cl.normalize_language(raw) == ''


def test_stray_sentence_keeps_the_language_word():
    assert cl.normalize_language('The text is French') == 'French'
    assert cl.normalize_language('Language: German') == 'German'
    # A sentence that ends in a no-text token still resolves to empty.
    assert cl.normalize_language('there is no text') == ''


def test_messages_none_without_an_image():
    assert cl.build_creative_language_messages('') is None
    assert cl.build_creative_language_messages(None) is None
    # A non-http value (expired/blank) must not become a bogus image request.
    assert cl.build_creative_language_messages('data:image/png;base64,xxx') is None


def test_messages_carry_the_image_at_low_detail():
    msgs = cl.build_creative_language_messages('https://cdn.example.com/a.jpg')
    assert msgs is not None
    parts = msgs[1]['content']
    img = next(p for p in parts if p.get('type') == 'image_url')
    assert img['image_url']['detail'] == 'low'
    assert img['image_url']['url'] == 'https://cdn.example.com/a.jpg'
