# RSoC policy-risk column for Fresh Finds

Date: 2026-07-28
Branch: `rsoc-policy-column` (to be cut off `main`)
Requested by: Yoav.

## Goal

Every Fresh Finds row is a competitor ad we may turn into our own content article and
monetize via **Google RSoC** (Related Search on Content / AdSense for Search). Before we
invest in writing an article, we want a per-row signal telling us **how much policy care
that row's topic/angle will demand on RSoC**. A wrong "safe" call is expensive: Google
runs a 3-strike RAF (Restricted Access Features) enforcement system as of Aug 2025, and a
struck account loses the advanced features that make RSoC scale.

Aligned with Yoav (three choices):
1. The column scores **topic/angle risk**, inferred from ad copy + creative + landing domain.
2. Output is a **tier + one-line reason + policy-area label**.
3. Scope is **Google RSoC only** for v1.

## The one insight that reshaped the design (from the council)

**The ad is not the artifact that gets banned. The article is.** The column can only see
the competitor's ad; the strike lands on what *we* publish. Topic risk and execution risk
are different variables, and RSoC strikes fire mostly on execution (misleading claims,
search-term bridging, fabricated results). So this column predicts **one input** to the
real risk, not the risk itself.

Consequence, load-bearing for the whole design: **a "Green" here must never read as "safe
to publish."** It means "this topic carries no known RSoC restriction," not "you're clear."
If the UI blurs that, we manufacture exactly the false confidence we're paying to avoid,
which is worse than no column. The genuine ban-prevention is a **publish-time gate** that
scores the actual drafted article (Phase 2 below), not this pre-investment filter.

## What the signal is

A per-ad **"RSoC Fit"** verdict = `{ tier, policy_area, reason }`, computed from two axes:

1. **Vertical restriction** — does the topic fall in a Google **Publisher Restriction**
   vertical? These are *not banned* but receive restricted ad demand on RSoC (lower RPM,
   higher scrutiny). Exact list (verified against Google's page 2026-07-28):
   sexual content, shocking content, explosives, guns/gun parts, other weapons, tobacco,
   recreational drugs, alcohol sale/misuse, online gambling, prescription drugs,
   unapproved pharmaceuticals & supplements.
2. **Angle / claim risk** — does the ad's angle rely on misleading, exaggerated, or
   unreliable claims (miracle cures, guaranteed income, before/after weight-loss), shocking
   imagery, or clickbait framing? Maps to Google Publisher Policies **"Misrepresentative
   content"** (prohibited: misleading representation, unreliable/harmful health claims,
   deceptive practices, manipulated media) + AFS deceptive-implementation rules.

### Tiers (honest framing — the council's biggest correction)

- **Red — Restricted vertical / prohibited angle.** Topic sits in a Publisher Restriction
  vertical, OR the angle inherently violates (miracle health cure, guaranteed income,
  before/after weight-loss claims). Building risks strikes/throttling.
- **Yellow — Sensitive; needs a human look.** Adjacent to a restricted vertical, or an
  aggressive angle that *can* be written compliantly but has rules. Yellow = "review
  required", not "probably fine".
- **Green — No restricted signal detected.** Ordinary topic, no restricted vertical, no
  exaggerated angle. Explicitly NOT "safe to publish" — the article still needs the Phase 2
  check. Label reads as a topic-level "clear", never a go-light for the draft.

The reason line always shows (never collapses behind the color). The policy-area chip names
the axis (e.g. "Unapproved supplements", "Misleading health claim", "Online gambling").

### Deterministic hazard floor (highest-leverage cheap safety)

Before the LLM, a hard-coded **deny-list** (SSOT, unit-tested) forces the tier to Red/Yellow
regardless of what the model says, keyed on landing domain + copy keywords: crypto/forex
"get rich", payday/short-term loans, CBD/cannabis, "miracle cure"/"melts fat"/"reverse
diabetes", weapons/ammo, prescription drug names, adult terms, sensitive-event terms. The
model grades *on top of* this floor. Rationale: the catastrophic failure is a confident
false-Green on a truly hazardous vertical; an LLM waffles exactly there, a keyword match does
not. We optimize the tail, not the average call — asymmetric costs demand an asymmetric gate.

## Architecture (follows the existing per-axis SSOT pattern)

The codebase already has **one dependency-free SSOT module per enrichment axis**: `brand.py`,
`creative_language.py`, `content_flag.py`. The in-pattern move is a **new sibling module
`rsoc_policy.py`** that owns the rubric prompt, the deny-list, and the parse/normalize of the
structured answer. This reuses all plumbing (it is NOT a duplicated classifier):

- **SSOT / domain logic:** `rsoc_policy.py` — dependency-free (no keys, no network), like its
  siblings, so the live path, the backfill, and the tests import the same prompt + parser and
  can never drift.
- **Enrichment call:** a new `gpt_detect_rsoc_risk(session, ad_copy, image_url, domain)`
  coroutine in `facebookadscraperapify2026-v2.py`, built like `gpt_detect_prohibited`, added
  to the **existing `asyncio.gather`** in `run_scrape.process_ad` so it runs concurrently with
  brand + creative-language + content_flag and adds no wall-clock latency. Returns a
  fail-safe empty verdict on error (leaves the row unscored, never mislabels).
- **Data access:** new nullable columns on `ads` — `rsoc_tier` (CHECK in
  green/yellow/red), `rsoc_policy_area text`, `rsoc_reason text`. Join them into `AD_COLUMNS`
  and `build_ad_dict` in `db.py`, and into `FEED_COLUMNS` + `mapAd` in `web/lib/queries.js`.
  Migration `0011_rsoc_policy.sql`. Partial index on `rsoc_tier` for facet/sort.
- **Why a sibling, not folded into `content_flag.py`:** that file is a single-purpose SSOT
  (one token, the prohibited *hide* screen). This is a different axis with a different output
  shape (structured tier+reason) and a different purpose (graded, never hides). Folding them
  would break the clean single-responsibility its own docstring sets. Sibling = same pattern,
  shared plumbing, zero drift.

### Mechanical guard (rule 20)

- Python test: `AD_COLUMNS` and `build_ad_dict` agree on the three new columns (guards
  column/writer drift).
- Python test: the deny-list floor forces Red/Yellow on every hazard fixture (guards the
  safety floor from being silently weakened).
- Web test: the column reads `rsoc_tier`/`rsoc_reason`/`rsoc_policy_area` off the row and the
  Fresh Finds query selects them.

## UI (Fresh Finds column)

- New entry in `FRESH_COLS` (`web/components/Dashboard.jsx`): `{ key: 'rsoc', label: 'RSoC Fit', w: 132 }`,
  hideable via the existing COLUMNS picker, remembered per browser like every other column.
- Renderer in `web/lib/ui.js`: a colored chip (red/amber/green) with the policy-area label,
  and the one-line reason as the cell's title/tooltip + a subline. Sortable by tier; a facet
  in the filter rail to show only Red/Yellow.
- Honest copy: the header tooltip states this scores the **topic**, and that a Green row
  still needs a compliance check on the written article. A lazy user must not read the chip
  as a publish green-light (rule 10/16).

## Phase 2 (required fast-follow, not v1): publish-time article gate

The git history shows an existing "AI draft-article" feature. The real ban-prevention is a
second `rsoc_policy` check that scores the **drafted article text** (title + body) against
the same rubric before publish, and blocks/warns on Red. v1 (this column) is a pre-investment
filter that saves wasted writing effort; it is not a compliance guarantee. This is flagged
explicitly so we do not ship a false sense of safety. Recommend building it immediately after
v1 proves out.

## Validation before backfill (do this first)

Hand-label ~50 already-scraped ads (tier + policy area), run `rsoc_policy` over them, measure
agreement — especially the **false-Green rate on known-hazard rows**. Only run the ~13k
backfill after the eval looks sane. This is the single highest-value first step: it is cheap,
and it is the only thing that tells us whether the $10-40 backfill is buying truth or noise.

## Cost (rule 8) — real current numbers

- Model: **gpt-4.1-mini** (already wired for the other 3 enrichment calls), verified pricing
  2026-07-28: **$0.40 / 1M input, $1.60 / 1M output**. Per ad (low-detail image + short
  copy): ~$0.001-0.003. New ads only, at scrape time = cents/scrape.
- One-time backfill over ~13k ads: **~$10-40**. Batch API would halve it ($0.20/$0.80) but
  adds complexity for a one-off we control; not worth it.
- Model choice (rule 17, on merit not brand): mini is adequate for vertical bucketing; it is
  weak on the fuzzy misleading-claim call — but so is any model, because that judgment truly
  belongs to the article that doesn't exist yet, so we do not overspend here. Upgrade path:
  route only the Yellow/ambiguous band to a stronger reasoning model in Phase 2 if the eval
  shows errors cluster in the middle. The deny-list carries the catastrophic-tail safety
  regardless of model.

## Security (rule 13)

Sends only the already-public creative image URL + ad copy + domain to the same OpenAI
endpoint already in use — no new secret, no new PII, no new attack surface. CHECK constraint
on `rsoc_tier` so a buggy/compromised writer cannot store a junk tier. Fails safe-for-data:
a failed call leaves the row unscored (NULL), never mislabeled, and the deny-list still
applies. The deny-list is server-side only.

## Observability (rule 14)

- `gpt_detect_rsoc_risk` logs failures like its siblings: `[rsoc policy] ...`.
- `run_scrape` prints the tier alongside brand/lang/content_flag per ad, and a per-run tally
  of green/yellow/red counts, so a scrape that suddenly floods Red (prompt/model regression)
  is visible immediately.
- `backfill_rsoc_policy.py` prints per-batch progress and a final tier + policy-area histogram.
- Every deny-list floor hit logs which rule fired, so we can audit the deterministic gate.

## Settings (rule 15)

- v1: the column is on by default, hideable via the existing COLUMNS picker (no new settings
  surface needed — reuses the per-browser column prefs).
- Proposed follow-up (not v1): a "hide Red rows" quick-filter default and a per-user risk
  threshold (show only Green). Not hardcoded away — the tier column is exactly what such a
  toggle would read.

## Testing (rule 18)

- Python unit tests for `rsoc_policy` parsing SSOT: every tier, every policy-area slug,
  punctuation/casing noise, junk -> fail-safe empty (never a wrong tier).
- Python tests for the deny-list floor: each hazard fixture forces Red/Yellow; a clean
  fixture passes through to the LLM verdict.
- Python column-drift guard (AD_COLUMNS vs build_ad_dict).
- Web test: Fresh Finds query selects the new columns; the chip renders the tier/reason.
- Full suites green before done: `pytest` + web `node --test` + `next build`.
- Out of scope for automated tests: live classification accuracy (no seam) — covered by the
  50-ad manual eval above and the visible per-run tally.

## Deploy (rule 19)

- Cut `rsoc-policy-column` off `main`. Local branch only.
- **Nothing pushed, merged, or deployed without an explicit go-ahead**; exact touch list
  spelled out before any git action. Production tracks `main` via the normal PR flow; not
  touched.
- Migration `0011_rsoc_policy.sql` applied before the backfill.
- Backfill is a manual, flag-gated (`--backfill-rsoc`), idempotent/resumable one-off run
  after the eval + pricing confirmation.
- Additive nullable columns + a fail-safe classifier, so reverting the app code leaves the
  data harmless and Fresh Finds intact.

## Alternatives considered (rule 4)

- **Reuse `content_flag` as the column** (show the prohibited category): rejected — every
  visible Fresh Finds row already passed that screen, so it reads "none" on all of them.
  Wrong axis entirely.
- **Fold the new axis into `content_flag.py`** (one call, both outputs): rejected — different
  output shape and purpose; breaks the file's single-responsibility and its clean one-token
  contract. Sibling module keeps both clean with no plumbing cost.
- **Binary (safe/unsafe) instead of 3 tiers**: rejected — collapses the "needs a human look"
  middle where the real judgment lives; Yellow-as-review-action is more honest than a
  forced call.
- **Continuous 0-100 score**: deferred — the user chose tiers, and a number over-promises
  precision an LLM can't deliver on fuzzy policy. We can store a coarse confidence later
  without a schema change if sorting demands it.
- **Stronger model up front**: rejected for v1 — the ambiguous judgment belongs to the
  not-yet-written article; spend the model budget at the Phase 2 publish gate, not here.
- **LLM only, no deny-list**: rejected — leaves the catastrophic false-Green tail unguarded.

## Open questions

1. Confirm the **column header wording** — "RSoC Fit" vs "Policy Heat" vs "RSoC Risk". I lean
   "RSoC Fit" (neutral, doesn't imply a verdict on the article).
2. Do you want the **deny-list terms** reviewed by you before I hardcode them, or should I
   draft a first list from the Publisher Restrictions verticals and you edit it after?
3. Green-by-default filter: leave all rows visible in v1, or default Fresh Finds to hide Red?
   (I lean: show everything in v1, add the toggle as the follow-up.)
