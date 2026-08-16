# Client Kits: scope auto-assign to the ad's own country+language (fix Belgium→France mismatch)

Date: 2026-08-16
Status: implemented, PR open
Owner: web dashboard
Branch: client-kits-country-vertical-match (worktree: ../adintel-kit-country-vertical-match)

## Where this came from

Maya (WhatsApp, Hebrew) reported a bad Client Kit she exported for one competitor
(the "Tarzo" tab in her planning sheet): "some of the headlines don't match the
article", "the headline is Belgium and our link is France", "I don't know if the
problem is in our link or in the creatives it belongs to."

## What was actually wrong (verified, not guessed)

The Tarzo tab was produced by bulk auto-assign (`bulkAssignOurLinks` →
`planBulkAssignment`). The competitor was one Belgian French real-estate campaign
with 36 near-identical creatives (same body, 2 headlines, 36 different images → 36
distinct ad ids, so the creative-dedupe does not collapse them).

Reading the sheet directly:
- 36 BE ads, each given a distinct our-link, all French — but 21 of 36 (58%) were
  off-topic (lingerie, garden pools, seized cars, cremation, dental implants,
  cruises), 4 were explicitly about France, and 1 was even a Dutch link.

Root cause, two layers:
1. The candidate pool was one domain-wide fetch (`searchOurLinks`, newest 1000, no
   country/language filter). For a 63k-row domain the correct-country links may not
   even be in that window.
2. `planBulkAssignment` only hard-gated language. Country (+3) and vertical (+4/+2)
   were soft rank nudges. With global link uniqueness, the few relevant BE links got
   consumed by the first creatives and the rest were forced onto whatever
   same-language link was still free — France articles, then unrelated verticals.

The code comment claimed "ads with no eligible link come back unassigned rather than
forced a mismatch", but "eligible" only meant same-language, so a lingerie article
counted as eligible for a house ad.

## Supply check (the deciding fact)

Queried the read-only articles DB (counts only). For mytips.com: BE-FR = 519
articles, BE-NL = 1061 (BE-FR home/finance verticals alone ≈ 190). Supply dwarfs the
36 creatives, so "nothing empty" AND "correct country+language" are both achievable
with unique links — no reuse, no schema change.

## Approach (what shipped)

- `web/lib/ui.js` `planBulkAssignment`: country is now a hard gate alongside language
  (new `requireCountryMatch`, default true), but each gate only constrains on an
  attribute the ad actually has, so a country-less ad is not starved to nothing.
  Vertical stays a ranker (via `scoreLink`/`rankLinks`), so within the correct
  country+language the on-topic link wins but a thin vertical never forces an empty.
- `web/app/actions.js` new `assignLinksScoped` helper: groups the batch by
  (country, language), fetches a pool pre-filtered to that locale at the DB, and keeps
  links distinct across the whole batch via a shared `used` set. Both bulk paths
  (`bulkAssignOurLinks` for Meta, `bulkAssignToComp` for RSOC) use it. With
  `matchByAd` off it falls back to one un-scoped pool (legacy "any link" behavior).

Net effect: a be/fr ad is only ever offered be/fr links (never France, never Dutch);
a house ad prefers house articles; and because locale supply is ample nothing goes
blank in practice.

## The one honest tradeoff

Country/language are now hard. If a locale ever had fewer of our links than the
competitor's creatives, the surplus ads would come back unassigned rather than be
handed a wrong-country link. Verified supply (BE-FR 519 ≫ 36) means this does not
happen for the reported case; the alternative (reusing a link across ads) was
rejected because the feature's core invariant is never handing the same link to two
clients (unique(our_url)).

## Testing (rule 18)

`web/tests/client-kits.test.mjs` (node --test):
- Rewrote the old "top earner first pick when scarce" test — it asserted the buggy
  cross-country fallback (a US ad taking a DE link). It now pins the hard gate: the
  surplus US ad is left unassigned, never given the DE link.
- Added: a be/fr ad is kept on be/fr links (never fr/FR, never be/nl); vertical ranks
  the house link above a newer lingerie one within the locale; ample locale supply
  fills every ad distinctly (nothing empty).
- Updated the "strict off" test to relax both gates.
Full suite: 206 pass. `next build`: green.

Out of scope: driving the live articles DB in CI (read-only external DB, no seam) —
matched the existing plan's decision.

## Deploy (rule 19)

Branch `client-kits-country-vertical-match` (own worktree) → single PR into `main`.
Additive logic change only, no migration, no env change. Rollback = revert the PR.
Not touching `main`, the remote, or other branches until the PR is opened; never
merging by hand.

## Alternatives rejected

- Reuse a link across near-duplicate creatives to guarantee fill under starvation:
  breaks the global-uniqueness invariant and needs a schema change; unnecessary given
  verified supply.
- Make vertical a hard gate too: risks empties in thin verticals with no upside, since
  vertical already ranks first within the correct locale.
- Keep one domain-wide pool and only tighten the scorer: the pool can miss a locale's
  links entirely, so scoring alone cannot guarantee a correct-country pick.
