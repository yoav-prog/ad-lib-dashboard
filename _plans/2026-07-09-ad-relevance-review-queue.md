# Ad relevance check + review queue

Date: 2026-07-09
Status: approved direction from Amit (Slack), implementing.

## Problem

The scraper queries the Facebook Ad Library with `search_type=keyword_unordered`,
which is a free-text search over ad copy. It returns any ad whose text loosely
matches the query, not ads that advertise the queried domain. Nothing in the
pipeline verifies where an ad actually leads, so junk enters the `ads` table
stamped with the tracked domain.

Evidence (production, 2026-07-09):
- motorcycle.com holds a Temu ad and a WhatsApp ad (Amit's screenshot).
- castofnotes.com run: "300 fetched, 298 old-enough, 16 new to process" -
  Apify delivered the full 300, but 282 were already stored from OTHER domains'
  keyword searches. The shared junk pool (Temu, scholarship-spam networks)
  dominates every domain's results, so per-domain counts are fiction.
- Dedup itself is correct and stays as-is: keyed purely on `ad_archive_id`
  (db.existing_ad_ids + upsert on conflict ad_archive_id).

## Goal (Amit's spec)

For every fetched ad, check whether its destination URL contains the tracked
domain. If it does, it enters the base as before. If it does not, it goes to a
separate REVIEW area where a human approves (enters the base) or rejects
(never enters, never comes back).

## Approach

### Relevance classifier (single source of truth)

One function in the scraper module (shared by the pipeline and the backfill):
an ad matches its domain when the HOST of any destination field matches the
domain exactly or as a subdomain (`go.castofnotes.com` matches
`castofnotes.com`). Fields checked: `snapshot.link_url`, every card's
`link_url`, and the display captions (FB captions usually carry the display
domain). Host-based matching on purpose: a plain substring check would
re-admit `temu.com/motorcycle.com-...` path junk.

Queries that are not domain-shaped (no dot, e.g. a keyword query) skip the
check entirely - relevance is only meaningful for domain queries.

### Review states

New `ads.review_status` column: `approved` (default) | `pending` | `rejected`.
- Scraper inserts matched ads as `approved`, mismatched as `pending`.
- Rejected rows are KEPT in the table: they stay in the dedup set so the next
  scrape never re-imports them. Deleting them would re-queue the same junk
  forever.
- Human decisions are permanent: `review_status` is excluded from the upsert's
  update set, so a re-sighting can never flip an approved/rejected ad back.

### Cost note

Pending (junk) ads skip the ScrapingBee article scrape - junk landing pages
are not worth a paid call. GPT enrichment (3 gpt-4.1-mini calls, fractions of
a cent) and media upload stay, so review cards have thumbnails (FB CDN links
expire) and approved ads are complete. Net cost goes DOWN vs today, where junk
got the full pipeline including ScrapingBee.

### Dashboard

- Feed (`getAds`) returns only `approved` rows: the junk disappears from every
  view and per-domain counts become honest immediately.
- New "Review" tab: pending ads with thumbnail, page, queried domain, actual
  destination, headline; approve / reject per row + bulk; badge with pending
  count. Admin-only actions, mirroring existing bulk actions.

### Backfill

`backfill_review_status.py` (same pattern as the other backfill_* scripts):
applies the same classifier to stored rows (splitting ' | '-joined multi-card
link_urls/captions) and flips mismatched `approved` rows to `pending`.
Idempotent; never touches `rejected` or already-`pending` rows.

## Rejected alternatives

- Substring "URL contains domain" (Amit's literal wording): re-admits junk
  whose path merely contains the domain. Host matching is the intent.
- Delete junk instead of a review queue: loses the dedup memory, so junk is
  re-fetched and re-processed every scrape. Also Amit explicitly wants a
  human look.
- Auto-reject with no queue: FB sometimes routes real arbitrage ads through
  intermediate hosts; a human catches those in review.
- Switch to keyword_exact_phrase at the source: worth an A/B later, but the
  post-filter is the guarantee either way; not in this change.

## Architecture

- Classifier lives in the scraper module (data layer), used by run_scrape and
  the backfill - one SSOT for "does this ad belong to this domain".
- The dashboard never re-implements the rule; it only reads review_status.
- Guard: unit test asserts review_status is NOT in db._UPDATE_COLUMNS, so a
  future refactor cannot silently let scrapes overwrite human decisions.

## Security

No new inputs from untrusted users. Review actions are admin-gated
(requireAdmin) like every other mutation; decision values are whitelisted to
('approved','rejected') server-side. No secrets touched.

## Observability

- Scraper logs per domain: fetched / old-enough / new, now split into matched
  vs sent-to-review counts.
- Review actions log via console.info('[review] ...') with ids + decision.

## Settings

No new settings. The matching rule is deliberately not configurable (one
correct definition); the review queue itself is the control surface. If a
per-domain "auto-approve everything" toggle is ever needed, it slots into the
domains table later.

## Testing

- tests/test_relevance.py: host match (exact, www, subdomain), path-only
  match rejected (Temu case), caption display-link match, card link match,
  keyword (non-domain) queries skip the check, ' | '-joined stored fields,
  empty/missing links -> pending.
- db invariants: review_status in AD_COLUMNS, not in _UPDATE_COLUMNS.
- Full pytest suite + web `npm test` green before done.

## Addendum (2026-07-09, after first production triage)

Shipped and backfilled: 6,081 rows checked, 592 moved to pending. The team
asked for bulk-triage tooling in the Review tab, so it gained a facet rail
(Searched Domain / Leads To / Page, with per-facet search above 6 options),
sort (newest, page, domain, leads-to), and select-all scoped to the filtered
slice - so "every ad leading to alibaba.com -> reject" is three clicks. The
filter logic lives in lib/ui.js (filterReviewAds) as a pure tested function.

## Deploy / rollout

1. Merge via PR into main (normal flow; no direct pushes).
2. Apply migration 0006 with `python apply_migration.py 0006_review_status.sql`
   (needs DATABASE_URL locally or run from CI env).
3. Run `python backfill_review_status.py` once - existing junk moves to the
   Review tab.
4. Rollback: revert the PR; the column is additive and harmless if unused.
