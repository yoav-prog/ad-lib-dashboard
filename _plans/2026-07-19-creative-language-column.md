# Creative Language column (language of the text ON the creative)

Date: 2026-07-19
Branch: `creative-language` (off `main`)
Requested by: Maya (via Yoav).

## Goal

Maya's request #4 asked for the language of the *creative* (the text printed on the
image or shown in the video), not the ad's copy fields. We already ship a `language`
column, but it is detected from the ad's TEXT fields (body/caption/headline via
`ad_copy_text`), which is a different thing. This adds a second column,
`creative_language`, that reads the text visible on the creative itself.

Confirmed with Yoav:
- On-creative text (not copy).
- Both images and videos.

## Approach

A vision call over the creative still, mirroring the Brand pipeline (which already
sends the same image to gpt-4.1-mini):
- **Images:** the stored creative image (`original_image_urls[0]`). Full coverage.
- **Videos:** the stored poster frame (`video_preview_url`). On-screen text language
  is constant across a clip, so one frame usually nails it. Gap: a video whose poster
  has no text but later frames do returns empty. Frame-sampling / audio transcription
  is a deliberate follow-up, not in this pass (flagged, not hidden).

`creative_language.py` is the single source of truth for the prompt + answer parsing,
shared by the scraper, the backfill, and the tests (same pattern as `brand.py`). The
model returns a language NAME (English, Spanish, ...) so the existing `langCode`
badge works, or `none` when the creative has no readable text (stored as '').

Brand and creative-language run as two concurrent vision calls in `process_ad`
(`asyncio.gather`), so the extra call adds no latency. Kept separate from the brand
detector for reliability and a clean SSOT; the ongoing cost delta is cents/scrape.

## Data model
`creative_language text` (nullable, free text like the existing `language`; NULL =
not classified yet). Partial index for the facet. Migration `0009_creative_language.sql`.

## UI
- Ship `creative_language` in `FEED_COLUMNS` + the row mapper.
- A "Creative Lang" column in Fresh Finds (badge via `langCode`), next to the existing
  Language (copy) column so the two can be compared; both hideable via COLUMNS.
- A "Creative Language" filter facet.
- A column in the Sheet + CSV export.

## Alternatives considered
- **Combine with the brand vision call** (one call returns brand + creative language):
  cheaper per new ad, but complicates the clean brand SSOT and the simple 3-token brand
  output; the saving is cents/scrape. Kept separate.
- **Replace the copy `language` column**: rejected. The two answer different questions
  and the copy signal is free (no vision needed); keep both.
- **Full video frame-sampling / Whisper transcription now**: rejected for v1 on
  cost/complexity (ffmpeg dependency, downloading every video). Poster frame is a
  strong language signal; revisit only if posters prove text-empty often.

## Cost
gpt-4.1-mini vision, low-detail image, ~$0.001-0.003/ad. One-time backfill of the
~12,754 ads: roughly $10-40. Ongoing: cents per scrape (new ads only). Flagged.

## Security
Sends only the already-public creative image URL to the same OpenAI endpoint already
in use. No new secret, no PII beyond what the creative already shows. Free-text column,
so no enum constraint (matches the existing `language`).

## Observability
Detector logs failures like its siblings; `run_scrape` prints the creative language
alongside brand; `backfill_creative_language.py` prints per-batch progress + a final
language tally.

## Testing
- Python unit test for `normalize_language` (the parsing SSOT): names, 'none'/'no
  text', punctuation, junk -> ''.
- Web `ui.test.mjs`: the Creative Language export column carries `langCode`.
- Full runs: pytest + web `node --test` + `next build` green before done.
- Out of scope for automated tests: the live vision call (no seam; covered by the
  pure-function tests + the backfill dry-run).

## Deploy
Local branch only; no push/merge/deploy without explicit go-ahead. Migration applied
to the DB before the backfill; backfill is a manual one-off. Additive/nullable column,
so reverting the app code leaves the data harmless.
