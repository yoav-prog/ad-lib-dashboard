"""Vertical-family derivation (article_verticals.py) - the rules
backfill_article_verticals.py uses to decide which of OUR verticals a competitor
ad's landing article belongs with, and to line the two databases' locales up.

Two things make these worth pinning:

  * a wrong locale rule silently matches nothing forever (the GB/UK case below was
    exactly that bug, live, before this feature),
  * a loose parse would let the model write a vertical that does not exist in the
    articles database, which then never matches an article and looks like our data
    is missing rather than like the label is wrong.

The locale cases mirror web/tests/ourmatch.test.mjs one for one; if you change a
rule on one side and not the other, one of the two suites fails.
"""

import article_verticals as av


# ── country_key: the two databases spell one country differently ──────────────
def test_country_key_uppercases_and_trims():
    assert av.country_key(' us ') == 'US'
    assert av.country_key('de') == 'DE'


def test_country_key_maps_gb_to_uk():
    # adintel stores GB (914 ads); the articles DB stores UK (14,573 articles).
    # Without the alias the strict country gate matches nothing at all for the UK.
    for raw in ('GB', 'gb', ' Gb '):
        assert av.country_key(raw) == 'UK'
    assert av.country_key('UK') == 'UK'


def test_country_key_empty_for_nothing_usable():
    for raw in (None, '', '   '):
        assert av.country_key(raw) == ''


# ── language_key: names on one side, ISO codes on the other ───────────────────
def test_language_key_maps_names_to_iso_codes():
    assert av.language_key('English') == 'en'
    assert av.language_key('Spanish') == 'es'
    assert av.language_key('  German ') == 'de'


def test_language_key_passes_a_code_through():
    assert av.language_key('en') == 'en'
    assert av.language_key('PT') == 'pt'


def test_language_key_handles_multiword_and_unknown():
    assert av.language_key('Brazilian Portuguese') == 'pt'
    assert av.language_key('Klingon') == 'kl'      # first two letters, never blank
    assert av.language_key('') == ''


def test_language_key_matches_the_javascript_map():
    # article_verticals.LANG_CODES is a hand copy of LANG_CODES in web/lib/ui.js.
    # Spot-check the entries the feed actually leans on, so a drift is caught here.
    for name, code in (('portuguese', 'pt'), ('dutch', 'nl'), ('czech', 'cs'),
                       ('norwegian', 'no'), ('hebrew', 'he')):
        assert av.LANG_CODES[name] == code


# ── ad_locale: which language field wins ──────────────────────────────────────
def test_ad_locale_prefers_the_article_language():
    # The opposite of Client Kits' scoreLink on purpose: that matcher pairs a link
    # WITH a creative, this one asks what market the offer is in.
    row = {'country': 'GB', 'language': 'English', 'creative_language': 'German'}
    assert av.ad_locale(row) == ('UK', 'en')


def test_ad_locale_falls_back_to_the_creative_language():
    assert av.ad_locale({'country': 'MX', 'creative_language': 'Spanish'}) == ('MX', 'es')


def test_ad_locale_on_an_empty_row():
    assert av.ad_locale({}) == ('', '')


# ── vocabulary_descriptor: what we embed for each vertical ────────────────────
def test_vocabulary_descriptor_pairs_the_vertical_with_its_category():
    # A bare "Tires" is a thin embedding; the category gives it context.
    assert av.vocabulary_descriptor('Tires', 'Autos & Vehicles') == 'Tires - Autos & Vehicles'


def test_vocabulary_descriptor_drops_a_redundant_or_missing_category():
    assert av.vocabulary_descriptor('Health', 'Health') == 'Health'
    assert av.vocabulary_descriptor('Health', None) == 'Health'
    assert av.vocabulary_descriptor(' Bras ', '') == 'Bras'


# ── article_excerpt: what the model reads ─────────────────────────────────────
def test_article_excerpt_puts_the_headline_first_and_collapses_whitespace():
    assert av.article_excerpt('Best  Tires', 'Line one\n\n  Line two') == 'Best Tires . Line one Line two'


def test_article_excerpt_is_capped():
    assert len(av.article_excerpt('t', 'x' * 9000)) == av.EXCERPT_CHARS


def test_article_excerpt_handles_missing_parts():
    assert av.article_excerpt(None, None) == ''
    assert av.article_excerpt('Only a title', None) == 'Only a title'
    assert av.article_excerpt('', '   ') == ''


def test_article_excerpt_strips_the_logo_blob_that_passes_for_a_title():
    # Real shape from the live table: the stored "title" is the site logo, an image
    # nested in a link whose href is a ~500-character tracking URL. Left in, it eats
    # half the excerpt budget and pushes the actual article out of the prompt.
    title = '[![EvoSeekly](https://imagedelivery.net/x/logo.png/s1600x1600)](/?vid=8f81&ste=jY7BCsIwEE)'
    assert av.article_excerpt(title, 'Coût des dalles de sol') == 'Coût des dalles de sol'


def test_article_excerpt_keeps_link_text_but_drops_the_url():
    assert av.article_excerpt(None, 'See [our guide](https://x.test/a) now') == 'See our guide now'


def test_article_excerpt_drops_bare_urls_and_setext_rules():
    body = 'Best Tires 2026\n===============\nRead https://example.test/deals today'
    assert av.article_excerpt(None, body) == 'Best Tires 2026 Read today'


# ── fallback_excerpt: the RSOC path, where there is no article to read ────────
def test_fallback_leads_with_the_vertical():
    # RSOC search-arbitrage ads land on a search page, so there is nothing to scrape.
    # The vertical the pipeline already assigned is the strongest signal they carry
    # (98.5% of them have one), so it goes first and the copy only disambiguates.
    out = av.fallback_excerpt('Abandoned Houses', ('Cheap homes near you', 'See listings'))
    assert out.startswith('Topic hint: Abandoned Houses')
    assert 'Cheap homes near you' in out


def test_fallback_ignores_the_placeholder_verticals():
    # ads.vertical stores the literal string 'None' for 722 rows - not a NULL. Treating
    # it as a topic would classify those ads as being about "None".
    for junk in ('None', 'none', '', '   ', 'n/a', '-', 'unknown'):
        out = av.fallback_excerpt(junk, ('Cheap homes near you',))
        assert not out.startswith('Topic hint:')
        assert out == 'Cheap homes near you'


def test_fallback_caps_the_copy_so_the_vertical_still_dominates():
    out = av.fallback_excerpt('Tires', ('x' * 5000,))
    assert out.startswith('Topic hint: Tires')
    assert len(out) < av.FALLBACK_COPY_CHARS + 60


def test_fallback_strips_markdown_from_the_copy_too():
    out = av.fallback_excerpt('Tires', ('See [our deals](https://x.test/a)',))
    assert out == 'Topic hint: Tires . See our deals'


def test_fallback_with_a_vertical_and_no_copy_at_all():
    assert av.fallback_excerpt('24/7 Nurse', ()) == 'Topic hint: 24/7 Nurse'
    assert av.fallback_excerpt('24/7 Nurse', (None, '', '  ')) == 'Topic hint: 24/7 Nurse'


def test_fallback_with_nothing_usable_is_empty():
    # An empty excerpt means the ad is written as an empty family rather than guessed at.
    assert av.fallback_excerpt(None, ()) == ''
    assert av.fallback_excerpt('None', (None,)) == ''


# ── build_messages ────────────────────────────────────────────────────────────
def test_build_messages_returns_none_without_an_article_or_candidates():
    assert av.build_messages('', ['Tires']) is None
    assert av.build_messages('an article', []) is None


def test_build_messages_lists_every_candidate():
    msgs = av.build_messages('an article', ['Tires', 'Car Deals'])
    assert msgs[0]['role'] == 'system'
    assert '- Tires' in msgs[1]['content'] and '- Car Deals' in msgs[1]['content']
    assert 'an article' in msgs[1]['content']


# ── parse_family: the guard that keeps invented labels out of the DB ──────────
CANDIDATES = ['Car Deals', 'Used Cars', 'SUV Deals', 'Tires', 'Car Insurance']


def test_parse_family_keeps_the_models_order_and_exact_spelling():
    assert av.parse_family('Used Cars\nCar Deals', CANDIDATES) == ['Used Cars', 'Car Deals']


def test_parse_family_is_case_insensitive_but_writes_the_canonical_spelling():
    # The DB comparison is exact, so whatever the model's capitalisation, what we
    # store must be the vocabulary's own spelling.
    assert av.parse_family('used cars\nTIRES', CANDIDATES) == ['Used Cars', 'Tires']


def test_parse_family_strips_bullets_and_numbering():
    assert av.parse_family('1. Car Deals\n- Tires\n* SUV Deals', CANDIDATES) == ['Car Deals', 'Tires', 'SUV Deals']


def test_parse_family_does_not_eat_digits_that_belong_to_the_vertical():
    # "24/7 Nurse" is a real vertical (159 articles). A naive lstrip of digits and
    # punctuation turns it into "/7 Nurse", which then matches nothing, forever.
    digity = ['24/7 Nurse', '5G Internet']
    assert av.parse_family('24/7 Nurse\n5G Internet', digity) == digity
    assert av.parse_family('1. 24/7 Nurse', digity) == ['24/7 Nurse']


def test_parse_family_drops_anything_not_offered():
    # A hallucinated or paraphrased label would never match an article row, so it
    # must be discarded rather than trusted.
    assert av.parse_family('Automobiles\nCar Deals\nCars in general', CANDIDATES) == ['Car Deals']


def test_parse_family_handles_none_and_junk():
    assert av.parse_family('NONE', CANDIDATES) == []
    assert av.parse_family('', CANDIDATES) == []
    assert av.parse_family(None, CANDIDATES) == []
    assert av.parse_family('   \n\n  ', CANDIDATES) == []


def test_parse_family_deduplicates():
    assert av.parse_family('Tires\nTires\ntires', CANDIDATES) == ['Tires']


def test_parse_family_caps_at_max_family():
    many = [f'V{i}' for i in range(20)]
    assert len(av.parse_family('\n'.join(many), many)) == av.MAX_FAMILY


def test_shortlist_is_smaller_than_the_vocabulary_and_family_smaller_still():
    # The prompt economics the cost estimate rests on.
    assert av.MAX_FAMILY < av.SHORTLIST_SIZE
