# Prohibited-content filter (keep policy-violating competitor ads out of the feed)

Date: 2026-07-21
Branch: `prohibited-content-filter` (to be cut off `main`)
Requested by: Maya (via Yoav).

## Goal

Maya asked whether we can automatically keep competitor ads that fall into Google
Publisher Policy "Prohibited Content Topics" **out** of the feed. This is a
compliance filter: classify each scraped ad against the prohibited categories and
hide the ones that match, so the people using the Command Center never have to
scroll past adult, gambling, weapons, drugs, etc.

Confirmed with Yoav:
- She wants these ads **removed / suppressed**, not surfaced.

### The categories, in confidence tiers

The list Maya sent, sorted by how reliably a vision + copy model can call it. This
tiering drives the design (see "The one hard rule" below).

- **Tier A - high confidence, auto-hide:** Adult/sexual, Weapons/violence,
  Gambling/casino, Marijuana/Cannabis/Ketamine/Psilocybin, Egg Donation,
  Before-and-After.
- **Tier B - fuzzy, hide but keep recoverable:** Political/election, Hate speech,
  Dangerous products/services, "Any content violating Google Publisher Policies"
  (catch-all). The model will disagree with a human a real fraction of the time on
  these, so they must never be silently destroyed.
- **Out of scope (v1):** "Specific deals/offers which cannot be fulfilled." This is
  a fact about the advertiser, not about the creative or copy - it is not
  classifiable from the ad. Flagging this to Maya rather than pretending we can.

## The one hard rule: soft-filter, never hard-drop

We do **not** delete flagged ads or skip storing them. We classify, store the ad
**and** the category, and hide flagged rows from the default feed. Reason: the Tier
B categories misfire, and for a competitive-intelligence tool, silently throwing
away a real competitor ad on a bad model call is worse than showing one ad we
shouldn't. Every suppression stays auditable and reversible.

This mirrors the existing `review_status` design (`0006_review_status.sql`): junk is
kept, not deleted, so dedup never re-imports it and a human can always look.

## Architecture (fits the existing enrichment seam)

Layers are already clean; this respects them:
- **SSOT / domain logic:** a new dependency-free `content_flag.py` owns the prompt
  and the answer parsing, exactly like `brand.py` and `creative_language.py`. The
  scraper, the backfill, and the tests all import it, so live and backfill can never
  drift. This is the single source of truth for what "prohibited" means.
- **Enrichment call:** `fb.gpt_detect_prohibited(session, ad_copy, image_url)` in
  `facebookadscraperapify2026-v2.py`, built like `gpt_detect_brand` (reads BOTH copy
  and creative image, since a violation can live in either - a weapons photo, or
  gambling text). Returns `''` on failure so a hiccup never writes a wrong label.
- **Wiring:** add it to the existing `asyncio.gather` in `run_scrape.process_ad`
  ([run_scrape.py:357](../run_scrape.py#L357)) so it runs concurrently with brand +
  creative-language and adds no wall-clock latency. Thread the result through
  `build_ad_dict` into the new column.
- **Data access:** the `content_flag` column joins `AD_COLUMNS` in `db.py`. The feed
  query is the only place that enforces the hide, so the boundary is in one place.
- **Mechanical guard (rule 20):** a unit test asserts the feed query's WHERE clause
  excludes flagged rows, and a test asserts `AD_COLUMNS` and `build_ad_dict` agree on
  the new column - so a future edit that drops the filter or the column fails the
  build instead of silently leaking prohibited ads back into the feed.

## Data model

`content_flag text` on `ads`, nullable, with a CHECK constraint listing the allowed
category slugs plus `none` (mirrors `brand`'s enum-with-check so junk answers can't
land):

    none | adult | weapons | gambling | political | hate | dangerous |
    before_after | drugs | egg_donation | policy_other

Semantics, matching the `brand` / `creative_language` convention:
- `NULL`  - not classified yet (existing rows before backfill; a failed call).
- `none`  - classified clean.
- a slug  - classified into that prohibited category; hidden from the feed.

Partial index `ads_content_flag_idx on ads (content_flag) where content_flag is not
null` for the audit view. Migration `0010_content_flag.sql`.

Single slug (most-severe match wins), not a set - keeps the SSOT output a single
token like `brand`, keeps the column simple, and is enough to drive both the hide
and the audit view. Multi-label is a later refinement if Maya needs it.

## Feed filtering + audit view

- **Feed query** ([queries.js:78](../web/lib/queries.js#L78)): add
  `and (a.content_flag is null or a.content_flag = 'none')` to the existing
  `where a.review_status = 'approved'`. NULL still shows, so the existing feed is not
  blanked before the backfill runs; only real category hits are hidden. New ads are
  classified at scrape time, so they are filtered from first sight.
- **"Filtered" tab** (new, like the Review tab): reads
  `where content_flag is not null and content_flag <> 'none'`, grouped by category,
  so Maya can spot-check what got suppressed and catch a Tier B false positive. A
  per-row "not prohibited" override sets `content_flag = 'none'` and returns the ad
  to the feed (reuses the Review tab's action pattern in `ReviewView.jsx` /
  `actions.js`).

## Settings (rule 15)

- v1: a single obvious control - the Filtered tab is the surface; the filter is on by
  default.
- Proposed setting: per-category toggles ("hide gambling", "hide political", ...) so
  Maya can loosen the Tier B categories she finds too aggressive without turning the
  whole thing off. Grouped under a new "Content filter" settings section. Flagged as
  the recommended follow-up; not hardcoded away - the per-category slug in the column
  is exactly what a future toggle reads, so v1 does not paint us into a corner.
- Intentionally not exposed in v1: a per-category confidence threshold (over-engineered
  before we have real false-positive data from the Filtered tab).

## Alternatives considered

- **Reuse `review_status` (add a `blocked` value)** instead of a new column:
  rejected. Prohibited is a different axis from relevance - an ad can be
  relevance-approved yet prohibited, and `review_status` is a human-decision field set
  on insert only. Overloading it muddies both. A dedicated column keeps each concern
  clean and mirrors `brand`.
- **Hard-drop at ingest** (never store flagged ads): rejected - the whole "soft-filter"
  section above. Unrecoverable false positives on Tier B.
- **Fold into the brand vision call** (one call returns brand + policy): rejected for
  the same reason the creative-language plan kept it separate - it complicates the
  clean brand SSOT and its 3-token output; the saving is cents per scrape.
- **Multi-label (array of categories):** deferred. Single most-severe slug is enough
  to hide + audit; revisit if Maya needs to see every category an ad trips.

## Cost (rule 8)

Same model and shape as the brand / creative-language calls already in production
(gpt-4.1-mini vision, low-detail image, one call per new ad): about
$0.001-0.003/ad, cents per scrape on new ads only. One-time backfill over the
existing ~12,754 ads is roughly $10-40. These are the numbers from the
creative-language pass, same call profile. **To confirm before running the backfill:
current gpt-4.1-mini image pricing** (rule 8 - not from memory), since that is the
only real spend and it is a one-off we control the timing of.

## Security

Sends only the already-public creative image URL and the ad copy to the same OpenAI
endpoint already in use - no new secret, no new PII, no new attack surface. CHECK
constraint on the column so a compromised or buggy writer cannot store an arbitrary
value. The filter fails **safe-for-data** (a failed call -> NULL -> ad still shows and
stays in the queue for reclassification) rather than fail-hidden, which is the right
default for an intelligence tool where losing data is the worse failure.

## Observability (rule 14)

- `gpt_detect_prohibited` logs failures like its siblings (`[gpt prohibited] ...`).
- `run_scrape` prints the flag alongside brand/creative-language per ad, and a
  per-run tally of how many ads were filtered and into which categories, so a scrape
  that suddenly hides 80% of a competitor is visible immediately (a sign the prompt
  or the model regressed).
- `backfill_content_flag.py` prints per-batch progress and a final category
  histogram.

## Testing (rule 18)

- Python unit test for `normalize_content_flag` (the parsing SSOT): every valid slug,
  `none`, punctuation/casing noise, and junk -> `''` (never a wrong label).
- Python test that the feed-visibility rule hides every prohibited slug and shows
  `none`/`NULL` (guards the boundary - rule 20).
- Python test that `AD_COLUMNS` includes `content_flag` and `build_ad_dict` returns it
  (guards column/writer drift).
- Web `ui.test.mjs`: the Filtered view query targets flagged rows; the override action
  clears the flag.
- Full runs green before done: `pytest` + web `node --test` + `next build`.
- Out of scope for automated tests: the live vision classification accuracy (no seam;
  covered by the pure-function parsing tests + a manual backfill dry-run on a sample,
  and by the Filtered tab which is the human check by design).

## Deploy (rule 19)

- Cut `prohibited-content-filter` off `main`. Local branch only.
- **Nothing pushed, merged, or deployed without an explicit go-ahead**, and I will
  spell out exactly what I'm touching before any git action. Production tracks `main`
  via the normal PR flow; I will not touch it.
- Migration `0010_content_flag.sql` applied to the DB **before** the backfill.
- Backfill is a manual one-off we run deliberately (after confirming pricing).
- Additive/nullable column with a fail-safe filter, so reverting the app code leaves
  the data harmless and the feed intact.

## Open questions for Maya

1. Tier B (political / hate / dangerous / catch-all): hide by default like Tier A, or
   route to the Filtered tab for a human yes/no before hiding? (Recommendation: hide
   by default, Filtered tab as the safety net - matches "she wants them out.")
2. "Deals that cannot be fulfilled" - confirm it's out of scope, or does she have a
   narrower definition we could actually detect?
3. Does she want the per-category toggles in v1, or is on/all-on fine to start?
