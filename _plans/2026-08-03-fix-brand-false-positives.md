# Fix brand false positives in Fresh Finds

Date: 2026-08-03
Branch: fix-brand-false-positives (worktree, off origin/main)

## Problem

The Brand column in Fresh Finds mislabels ads as a brand when no actual brand is
present. Reported triggers: the literal word "brand" in the copy (in any
language), and generic nouns like "phones" and "police". These are examples of a
pattern, not an exhaustive list.

## Root cause

Brand classification has a single source of truth: the GPT vision call in
`brand.py` (`_SYSTEM_PROMPT` + `normalize_brand`), shared by the live scraper
(`facebookadscraperapify2026-v2.gpt_detect_brand`) and `backfill_brand.py`. There
is no keyword or denylist path anywhere in the repo.

The false positives come from the model (`gpt-4.1-mini`) over-firing because the
prompt is too loose:
- It points the model at "the ad copy (brand names)" and asks whether a brand is
  "present", so copy that literally contains the word "brand" gets echoed back as
  a positive.
- `brand : any other recognizable commercial brand is present` carries no
  exclusions, so generic product categories ("phones") and public institutions
  ("police") get read as brands.

`normalize_brand` is not the culprit - it only parses the model's own one-token
answer, and its existing tests pass. The fix is at the prompt level.

## Chosen approach (Option A)

Tighten `_SYSTEM_PROMPT` in `brand.py`:
- Define a brand precisely: a specific, NAMED company or product line (a proper
  noun you could name), from a logo/wordmark in the image or a brand name in copy.
- State the exclusions explicitly (GPT-4.1 follows instructions literally, per the
  OpenAI GPT-4.1 prompting guide, so undesired behavior must be spelled out):
  generic product categories / common nouns, governments and public institutions,
  and the mere presence of the word "brand" or an unnamed seller.
- Add a firm default rule: if you cannot name a specific brand or see a
  recognizable logo/wordmark, answer none; when unsure, answer none.
- Keep the one-token output contract (car_brand / brand / none) and the car-before-
  brand ordering intact, so `normalize_brand`, `max_tokens: 3`, and both call sites
  are unchanged.

### Alternatives rejected
- Option B - second confirmation pass or a larger model (gpt-4.1) for borderline
  cases. Adds cost and latency for every ad; the prompt is the cheaper lever and
  should be tried first.
- Option C - post-filter with a denylist of generic words. Brittle, cannot cover
  "any language", and fights the model instead of steering it. Rejected.

## SSOT / architecture

The prompt stays in `brand.py`, imported by the live path and the backfill, so
they can never drift. No new logic, no boundary changes.

## Testing

`tests/test_brand.py` (pytest). Add regression guards that fail on the old prompt
and pass on the new one:
- The system prompt names the reported false positives ("police", "phones") as
  non-brands and instructs a default of "none" when unsure.
- Existing `normalize_brand` and `build_brand_messages` tests stay green
  (behavior unchanged).

Offline limit (honest): a prompt change is not provable without hitting the paid
model. Real validation is `python backfill_brand.py --dry-run --limit N` against a
sample of known-bad ads after merge. Called out in the PR.

## Observability

No new runtime step. The scraper already logs prompt/model regressions for the
sibling detectors; brand tallies print per batch in the backfill.

## Deploy

One PR into `main`. No schema change. To relabel existing rows, run
`backfill_brand.py --all` (or scoped) after merge - operator-triggered, not part of
the deploy.

## Security

No new inputs, secrets, or surface. Copy is already truncated (`[:800]`) and the
image is sent at low detail. Unchanged.
