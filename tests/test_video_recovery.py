"""A re-scrape must never lose a video we already own.

The July 2026 incident: Facebook stopped serving video_hd_url for older video
ads, so a re-scrape saw only the preview image, stored video_hd_url = NULL, and
the Sheet export fell back to the poster - even though the mp4 had been sitting
in GCS since the original scrape. These tests pin the fix: process_ad_media
falls back to storage for a video ad's primary slot when Apify hands it no URL,
and backfill_video_urls can rebuild the link from a bucket listing. The
recovery tests fail on the pre-fix code, which only consulted storage when
Apify supplied a URL to upload.
"""

import backfill_video_urls


# ── Fakes ─────────────────────────────────────────────────────────────────────
class FakeBlob:
    def __init__(self, name):
        self.name = name
        self.public_url = f'https://storage.googleapis.com/test-bucket/{name}'

    def make_public(self):
        pass


class FakeBucket:
    """In-memory stand-in for a GCS bucket; records every list call."""

    def __init__(self, names=()):
        self.names = list(names)
        self.list_calls = []

    def list_blobs(self, prefix=''):
        self.list_calls.append(prefix)
        return [FakeBlob(n) for n in self.names if n.startswith(prefix)]


AD_ID = '935388992817979'
STORED_VID = f'facebook_ads/videos/{AD_ID}-260526-video-4442_vid1.mp4'
STORED_PREVIEW = f'facebook_ads/images/{AD_ID}-260526-video-5286_vidpreview1.jpg'


def video_ad(**snapshot_extra):
    snapshot = {'display_format': 'VIDEO', 'images': [], 'cards': [],
                'videos': [], 'extra_images': [], 'extra_videos': []}
    snapshot.update(snapshot_extra)
    return {'ad_archive_id': AD_ID, 'snapshot': snapshot}


# ── Scraper: process_ad_media recovery ────────────────────────────────────────
async def test_video_with_only_a_preview_url_recovers_the_stored_video(fb):
    """The observed failure: Apify returns the preview image but no video URL.
    The stored mp4 must be picked up instead of dropping the link."""
    bucket = FakeBucket([STORED_VID, STORED_PREVIEW])
    ad = video_ad(videos=[{'video_preview_image_url': 'https://fb.example/prev.jpg'}])

    media = await fb.process_ad_media(ad, bucket, {})

    assert media['video_hd'] == f'https://storage.googleapis.com/test-bucket/{STORED_VID}'
    assert media['video_preview'] == f'https://storage.googleapis.com/test-bucket/{STORED_PREVIEW}'


async def test_video_ad_with_no_video_items_at_all_recovers_both_slots(fb):
    """Harder variant: the snapshot's videos array is empty entirely."""
    bucket = FakeBucket([STORED_VID, STORED_PREVIEW])

    media = await fb.process_ad_media(video_ad(), bucket, {})

    assert media['video_hd'] == f'https://storage.googleapis.com/test-bucket/{STORED_VID}'
    assert media['video_preview'] == f'https://storage.googleapis.com/test-bucket/{STORED_PREVIEW}'


async def test_video_never_uploaded_stays_empty(fb):
    """No stored video to recover: the field stays empty rather than inventing one."""
    media = await fb.process_ad_media(video_ad(), FakeBucket(), {})

    assert media['video_hd'] == ''
    assert media['video_preview'] == ''


async def test_image_ads_pay_no_extra_storage_calls(fb):
    """Recovery is gated to video ads: an image ad with no media must not
    trigger any bucket listing."""
    bucket = FakeBucket()
    ad = {'ad_archive_id': AD_ID, 'snapshot': {'display_format': 'IMAGE'}}

    media = await fb.process_ad_media(ad, bucket, {})

    assert media['video_hd'] == ''
    assert bucket.list_calls == []


async def test_live_video_url_still_wins_over_recovery(fb, monkeypatch):
    """When Apify does serve a video URL, the normal check/upload path handles
    it and the recovery fallback must not fire a second listing for slot 1."""
    bucket = FakeBucket([STORED_VID, STORED_PREVIEW])
    ad = video_ad(videos=[{'video_hd_url': 'https://fb.example/live.mp4',
                           'video_preview_image_url': 'https://fb.example/prev.jpg'}])

    media = await fb.process_ad_media(ad, bucket, {})

    # The existing stored files satisfy the check, so nothing is re-uploaded
    # and each video slot is listed exactly once.
    assert media['video_hd'] == f'https://storage.googleapis.com/test-bucket/{STORED_VID}'
    assert len([p for p in bucket.list_calls if 'videos' in p]) == 1


# ── Backfill: rebuilding the link from a public listing ──────────────────────
def test_stored_media_url_picks_the_primary_video():
    items = [
        {'name': STORED_PREVIEW},
        {'name': STORED_VID},
    ]
    assert backfill_video_urls.stored_media_url(items, '_vid1.mp4') \
        == f'https://storage.googleapis.com/{backfill_video_urls.BUCKET}/{STORED_VID}'


def test_stored_media_url_handles_empty_and_missing():
    assert backfill_video_urls.stored_media_url([], '_vid1.mp4') is None
    assert backfill_video_urls.stored_media_url(None, '_vid1.mp4') is None
    assert backfill_video_urls.stored_media_url([{'name': STORED_PREVIEW}], '_vid1.mp4') is None
