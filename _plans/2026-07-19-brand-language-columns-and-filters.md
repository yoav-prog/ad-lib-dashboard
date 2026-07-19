# Brand + Language columns, feed-scoped domain filter, pre-export filtering

Date: 2026-07-19
Branch: `competitor-brand-lang-filters` (off `feed-pagination`)
Requested by: Maya (via Yoav), four asks against the competitor ad-intel system.

## Goals

Four requests from the competitor dashboard's daily user:

1. **Brand column** — classify each creative as **No brand / Brand / Car brand**. Car
   brands get their own bucket because they are a "lite" compliance category. Detect
   from **both** the creative image (logo/wordmark) and the ad copy (brand name).
2. **Feed-scoped domain filter** — selecting a Feed narrows the Domain facet to that
   feed's domains, instead of always listing every domain.
3. **Pre-export filtering** — make it obvious that exports already honor the active
   filters, and label the export controls with the count going out.
4. **Language column** — surface the already-detected `language` as its own visible
   Fresh Finds column (detection already exists end to end).

## What already exists (verified in code)

- `language` is detected during scraping (`gpt_detect_language`), stored on `ads`,
  shipped to the browser (`FEED_COLUMNS`), already a filter facet, and already a
  Sheet/CSV export column. Only a dedicated on-screen column is missing → request #4
  is a UI-only change.
- CSV export (`buildCsv(filtered, …)`) and Sheet export (`filtered.map(id)`) already
  send exactly the filtered view → request #3 is discoverability + labeling, not new
  capability.
- Domain facet is built from `uniq('domain')` unconditionally → request #2 is a
  contained change to that one facet's option/count source.
- No `brand` field anywhere → request #1 is the only real build (schema + a vision
  enrichment step + backfill + UI).

## Approach

### Data model
New nullable `brand text` on `ads`, constrained to `('none','brand','car_brand')`
(NULL = not yet classified). Filter index. Migration `0008_brand.sql`.

### Detection (request #1)
`gpt_detect_brand(session, ad_copy, image_url)` in the scraper module, mirroring the
three existing `gpt_detect_*` helpers but as a **vision** call: it sends the creative
image (low detail, for cost) plus the ad copy and asks for exactly one of
`car_brand / brand / none`. A pure `normalize_brand(raw)` function is the single
source of truth for parsing the model's answer; the scraper, the backfill, and the
unit test all import it (no drift).

- Live path: `run_scrape.process_ad` runs it after media upload, using the permanent
  GCS image URL — the same source the backfill uses, so live and backfill agree.
- Backfill: `backfill_brand.py` over the ~12,754 existing rows, `--only-missing`,
  `--dry-run`, `--limit`, mirroring `backfill_language.py`.

### UI
- Ship `brand` in `FEED_COLUMNS` + the row mapper.
- Fresh Finds: a **Brand** column (badge: gray none / amber brand / blue car) and a
  **Language** column; a **Brand** filter facet.
- Feed-scoped Domain facet (#2): the Domain option list + counts derive from the
  ads matching the currently selected feed(s).
- Export polish (#3): show the count on the CSV / Sheet buttons and echo the active
  filters in the export modal header.
- Manual override (#1): a Brand segmented control in the Detail workflow panel
  (mirrors Pipeline Status). `brand` added to the `AD_FIELDS` server whitelist.
- `brand` added to `SHEET_COLUMNS` so it rides along in Sheet + CSV exports.

## Alternatives considered

- **Text-only brand detection** (cheaper, no vision): rejected — Maya asked for
  "both," and logo-only creatives with no brand name in copy would be missed.
- **A different vision provider (Gemini Flash / Claude Haiku)** per model-neutrality:
  at a sub-$50 total spend the per-token savings are noise, and OpenAI is already
  fully wired (key, async session, semaphore, three sibling detectors). Adding a
  provider would cost more in integration than it saves. Chosen on cost+fit, not
  incumbency.
- **`brand` as a free-text label**: rejected — a fixed 3-value enum is filterable,
  sortable, and matches Maya's exact spec.

## Cost

`gpt-4.1-mini` at $0.40/1M input, $1.60/1M output; images billed as input tokens,
sent at low detail. ~$0.001–0.003 per ad. One-time backfill of ~12,754 ads: roughly
$10–40 (about half via the Batch API). Ongoing: cents per scrape (dedup means only
new ads are enriched). Negligible; flagged and approved.

## Security

- New enum is constrained at the DB (`check`), so a bad value cannot land.
- The manual override goes through the existing admin-gated server action and the
  `AD_FIELDS` whitelist applied via parameterized `sql(set)` — no new injection
  surface, no new endpoint.
- The vision call sends only the already-public creative image URL + ad copy to the
  same OpenAI endpoint already in use. No new secret, no PII beyond what ad copy
  already contains.

## Observability

- `gpt_detect_brand` logs failures like its siblings; `run_scrape` prints the brand
  value alongside `lang/country/vertical`.
- `backfill_brand.py` prints per-row changes and a final summary (mirrors
  `backfill_language.py`).
- Frontend: brand override reuses the existing `[columns]`/workflow console logging
  pattern; no silent state changes.

## Testing

- Python unit test for `normalize_brand` (the parsing SSOT): car/brand/none variants,
  punctuation, junk → `''`. Fails on the old code path (function absent).
- Web `ui.test.mjs`: `brandLabel` mapping + `buildCsv`/`SHEET_COLUMNS` include brand.
- Full runs: `pytest` and `node --test` (web) green before done.
- Out of scope for automated tests: the live vision API call and the Sheets network
  write (no seam; covered by the pure-function tests + manual smoke).

## Settings

Brand is exposed three ways the user controls: a hideable Fresh Finds column (COLUMNS
picker), a filter facet, and a per-ad manual override. Detection detail level is
hardcoded to "low" for cost; if accuracy needs it, that becomes a future setting.
Language column is likewise hideable via the COLUMNS picker.

## Deploy

Local feature branch only. No push/merge without explicit go-ahead. The migration
must be applied to Supabase before the backfill runs; the backfill is a manual
one-off, not part of CI. Rollback: the column is additive and nullable, so reverting
the app code leaves the data harmless.

## Open questions

- Detection "detail" level (low vs high) — starting low for cost; revisit if Maya
  reports misses on logo-only creatives.
