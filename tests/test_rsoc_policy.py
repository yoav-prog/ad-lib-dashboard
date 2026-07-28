"""RSoC policy-risk classification (rsoc_policy.py) - the single source of truth shared by
the live scraper (gpt_detect_rsoc_risk) and the one-off backfill (backfill_rsoc_policy.py).

Two things must never break here:
  1. The deterministic deny-list FLOOR. A confident false-'green' on a hazardous vertical is
     the one failure that costs a real account, so the floor forcing red/yellow regardless of
     the model - and NOT false-firing on look-alike words ('ammo' inside 'ammonia') - is
     pinned by tests.
  2. The db wiring. rsoc_tier must ride in AD_COLUMNS (or it never persists) and must reach the
     row as NULL rather than '' when unclassified (or the column's check constraint rejects the
     row and takes the whole insert batch - and the run - down with it).
"""

import db
import rsoc_policy
import run_scrape


# ── parse_rsoc_answer maps a model line to (tier, area, reason) ────────────────
def test_a_well_formed_line_parses_into_its_three_fields():
    assert rsoc_policy.parse_rsoc_answer('red | supplements | pushes keto gummies hard') == (
        'red', 'supplements', 'pushes keto gummies hard')


def test_tier_casing_and_punctuation_are_tolerated():
    tier, area, _ = rsoc_policy.parse_rsoc_answer('  GREEN | none | ordinary consumer topic')
    assert (tier, area) == ('green', 'none')


def test_a_missing_area_or_reason_is_filled_not_rejected():
    # green with nothing else -> the clean slug and a stock reason.
    assert rsoc_policy.parse_rsoc_answer('green') == ('green', 'none', 'No restricted signal detected')
    # a non-green tier with no area falls back to 'other', never a wrong slug.
    tier, area, reason = rsoc_policy.parse_rsoc_answer('yellow')
    assert (tier, area) == ('yellow', 'other') and reason


def test_an_off_list_area_falls_back_to_other_for_a_graded_tier():
    tier, area, _ = rsoc_policy.parse_rsoc_answer('red | crypto_scam | shady coin')
    assert (tier, area) == ('red', 'other')


def test_a_tier_word_is_recovered_even_without_the_pipe_format():
    # A model that ignored the format but said the tier somewhere still classifies.
    tier, _, _ = rsoc_policy.parse_rsoc_answer('I think the topic is red overall.')
    assert tier == 'red'


def test_a_preamble_line_does_not_break_the_real_line():
    tier, area, _ = rsoc_policy.parse_rsoc_answer('Sure!\nred | financial | get-rich pitch')
    assert (tier, area) == ('red', 'financial')


def test_unusable_answers_return_none_never_a_wrong_tier():
    for raw in ('', None, '   ', '123', '???', 'purple', 'maybe'):
        assert rsoc_policy.parse_rsoc_answer(raw) is None


# ── hazard_floor: the deterministic deny-list ─────────────────────────────────
def test_a_get_rich_angle_is_forced_red():
    tier, area, _ = rsoc_policy.hazard_floor('Learn how to get rich from home', '')
    assert (tier, area) == ('red', 'financial')


def test_a_restricted_vertical_keyword_is_forced_red():
    tier, _, _ = rsoc_policy.hazard_floor('Buy Ozempic online, no prescription', '')
    assert tier == 'red'


def test_a_gambling_domain_fires_even_with_clean_copy():
    tier, area, _ = rsoc_policy.hazard_floor('play today', 'luckycasino.com')
    assert (tier, area) == ('red', 'gambling')


def test_a_tobacco_term_is_yellow_not_red():
    tier, area, _ = rsoc_policy.hazard_floor('our new vape flavours', 'shop.example.com')
    assert (tier, area) == ('yellow', 'tobacco')


def test_the_most_severe_matching_rule_wins():
    # 'wine deals' is yellow, 'get rich' is red -> red must win.
    tier, _, _ = rsoc_policy.hazard_floor('get rich then celebrate with wine deals', '')
    assert tier == 'red'


def test_a_clean_topic_has_no_floor():
    assert rsoc_policy.hazard_floor('best hiking boots for autumn trails', 'trailgear.com') is None


def test_whole_word_matching_does_not_fire_on_look_alikes():
    # The critical false-positive guard: 'ammo' must not match inside 'ammonia', nor 'bet'
    # inside 'better'. A substring match here would wrongly force a clean article to red.
    assert rsoc_policy.hazard_floor('an ammonia-based bathroom cleaner', '') is None
    assert rsoc_policy.hazard_floor('a better way to organise your desk', '') is None


def test_every_deny_list_rule_uses_a_valid_tier_and_area():
    # Guards the hand-edited deny-list: a typo'd tier or area would silently never fire (area)
    # or crash the severity compare (tier). Fail the build instead.
    for (tier, area, _reason, _kw) in rsoc_policy.HAZARD_RULES:
        assert tier in rsoc_policy.RSOC_TIERS
        assert area in rsoc_policy.POLICY_AREAS
    for (tier, area, _reason, _subs) in rsoc_policy.HAZARD_DOMAINS:
        assert tier in rsoc_policy.RSOC_TIERS
        assert area in rsoc_policy.POLICY_AREAS


# ── combine_verdict: the floor and the model merged ───────────────────────────
def test_the_floor_overrides_a_softer_model_verdict():
    # The whole point: a hard-coded red is never talked down to green by a waffling model.
    assert rsoc_policy.combine_verdict(('green', 'none', 'looks fine'),
                                       ('red', 'financial', 'get-rich')) == ('red', 'financial', 'get-rich')


def test_a_strictly_more_severe_model_verdict_wins_with_its_own_reason():
    assert rsoc_policy.combine_verdict(('red', 'health_claims', 'miracle cure'),
                                       ('yellow', 'tobacco', 'vape')) == ('red', 'health_claims', 'miracle cure')


def test_a_tie_keeps_the_deterministic_floor():
    assert rsoc_policy.combine_verdict(('yellow', 'other', 'model'),
                                       ('yellow', 'tobacco', 'vape')) == ('yellow', 'tobacco', 'vape')


def test_either_source_alone_is_returned():
    assert rsoc_policy.combine_verdict(('green', 'none', 'ok'), None) == ('green', 'none', 'ok')
    assert rsoc_policy.combine_verdict(None, ('red', 'weapons', 'ammo')) == ('red', 'weapons', 'ammo')


def test_neither_source_leaves_the_row_unscored():
    assert rsoc_policy.combine_verdict(None, None) == (None, None, None)


# ── build_rsoc_messages assembles the vision request ──────────────────────────
def test_messages_none_when_nothing_to_look_at():
    assert rsoc_policy.build_rsoc_messages('', '', 'example.com') is None
    assert rsoc_policy.build_rsoc_messages(None, None, None) is None


def test_messages_include_image_only_for_http_urls():
    with_img = rsoc_policy.build_rsoc_messages('some copy', 'https://cdn.example.com/a.jpg', 'x.com')
    assert any(p.get('type') == 'image_url' for p in with_img[1]['content'])
    text_only = rsoc_policy.build_rsoc_messages('some copy', 'data:image/png;base64,xxx', 'x.com')
    assert all(p.get('type') != 'image_url' for p in text_only[1]['content'])


def test_messages_carry_the_landing_domain_as_context():
    msgs = rsoc_policy.build_rsoc_messages('some copy', '', 'payday-loans.example')
    assert 'payday-loans.example' in msgs[1]['content'][0]['text']


# ── area label maps stay internally consistent ────────────────────────────────
def test_policy_areas_and_labels_agree():
    assert set(rsoc_policy.POLICY_AREAS) == set(rsoc_policy.POLICY_AREA_LABELS)


# ── db wiring: the three columns persist and are NULL-safe ─────────────────────
def _row(tier=None, area=None, reason=None):
    """The db row build_ad_dict makes for a bare ad - only the rsoc_* fields matter here."""
    return run_scrape.build_ad_dict(
        {'ad_archive_id': 'a-1', 'snapshot': {}}, dict(run_scrape._EMPTY_MEDIA),
        '', '', '', 1, '', 'example.com', '', '', '', '', '', '', 'approved',
        tier, area, reason,
    )


def test_the_rsoc_columns_are_persisted():
    for col in ('rsoc_tier', 'rsoc_policy_area', 'rsoc_reason'):
        assert col in db.AD_COLUMNS


def test_the_rsoc_grade_refreshes_on_rescrape_unlike_a_human_field():
    # Opposite of content_flag/review_status: the topic grade has no human override, so a later
    # scrape SHOULD re-derive it. It must therefore stay IN the update set.
    assert 'rsoc_tier' in db._UPDATE_COLUMNS


def test_an_ungraded_ad_writes_null_never_an_empty_string():
    # '' would violate the rsoc_tier check constraint and abort the whole insert batch.
    for tier in ('', None):
        assert _row(tier, '', '')['rsoc_tier'] is None


def test_a_real_grade_is_written_through_unchanged():
    row = _row('red', 'supplements', 'keto gummies angle')
    assert (row['rsoc_tier'], row['rsoc_policy_area'], row['rsoc_reason']) == (
        'red', 'supplements', 'keto gummies angle')
