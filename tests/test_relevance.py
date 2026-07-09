"""The ad ↔ domain relevance rule: keyword searches drag in ads that merely
mention a domain, so only ads whose DESTINATION (link_url, card links, or the
display caption) points at the tracked domain may enter the base as approved.
Matching is host-based - the Temu case (domain appearing only in the URL path)
must NOT match. The same rule serves raw Apify ads and stored ' | '-joined rows.
"""


def ad(link_url=None, caption=None, cards=None):
    snap = {}
    if link_url is not None:
        snap['link_url'] = link_url
    if caption is not None:
        snap['caption'] = caption
    if cards is not None:
        snap['cards'] = cards
    return {'snapshot': snap}


# ── host matching ─────────────────────────────────────────────────────────────
def test_exact_host_matches(fb):
    assert fb.ad_matches_domain(ad(link_url='https://castofnotes.com/article'), 'castofnotes.com')


def test_www_and_case_are_ignored(fb):
    assert fb.ad_matches_domain(ad(link_url='HTTPS://WWW.CastOfNotes.COM/x'), 'castofnotes.com')
    assert fb.ad_matches_domain(ad(link_url='https://castofnotes.com/'), 'www.CASTOFNOTES.com')


def test_subdomain_matches(fb):
    assert fb.ad_matches_domain(ad(link_url='https://go.castofnotes.com/offer'), 'castofnotes.com')


def test_domain_in_path_only_does_not_match(fb):
    # The Temu case: 'motorcycle.com' in the path of a temu.com URL is junk.
    assert not fb.ad_matches_domain(
        ad(link_url='https://www.temu.com/motorcycle.com-storage-box.html'), 'motorcycle.com')


def test_suffix_of_another_host_does_not_match(fb):
    # notmotorcycle.com is a different site, not a subdomain of motorcycle.com.
    assert not fb.ad_matches_domain(ad(link_url='https://notmotorcycle.com/x'), 'motorcycle.com')


def test_unrelated_destination_does_not_match(fb):
    assert not fb.ad_matches_domain(ad(link_url='https://api.whatsapp.com/send'), 'motorcycle.com')


# ── which fields count as a destination ──────────────────────────────────────
def test_display_caption_matches(fb):
    # FB captions carry the display domain, often as bare text with a path.
    assert fb.ad_matches_domain(ad(link_url='https://track.example.net/c', caption='CASTOFNOTES.COM/notes'), 'castofnotes.com')


def test_card_link_matches(fb):
    assert fb.ad_matches_domain(
        ad(cards=[{'link_url': 'https://elsewhere.com/a'}, {'link_url': 'https://castofnotes.com/b'}]),
        'castofnotes.com')


def test_no_links_at_all_does_not_match(fb):
    assert not fb.ad_matches_domain(ad(), 'castofnotes.com')
    assert not fb.ad_matches_domain(ad(link_url='', caption='Learn more!'), 'castofnotes.com')


def test_joined_stored_fields_match_any_part(fb):
    # backfill builds synthetic snapshots from DB rows where multi-card values
    # are ' | '-joined into one string.
    joined = 'https://elsewhere.com/a | https://castofnotes.com/b'
    assert fb.ad_matches_domain(ad(link_url=joined), 'castofnotes.com')


# ── keyword (non-domain) queries skip the check ───────────────────────────────
def test_keyword_query_always_matches(fb):
    assert fb.ad_matches_domain(ad(link_url='https://anything.com/x'), 'life insurance')
    assert fb.ad_matches_domain(ad(), 'weightloss')


def test_query_pasted_as_url_still_normalizes(fb):
    assert fb.ad_matches_domain(ad(link_url='https://castofnotes.com/x'), 'https://www.castofnotes.com/some/page')


def test_malformed_values_never_crash(fb):
    weird = {'snapshot': {'link_url': {'text': 'https://castofnotes.com/x'},
                          'cards': [None, 'nope', {'caption': None}]}}
    assert fb.ad_matches_domain(weird, 'castofnotes.com')
    assert fb.normalize_domain(None) == ''
    assert fb.normalize_domain('   ') == ''
