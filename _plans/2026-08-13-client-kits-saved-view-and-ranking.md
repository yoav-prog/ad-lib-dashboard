# Client Kits: My Assignments view, better ranking, gitignore hygiene

Date: 2026-08-13
Branch: client-kits-saved-view
Status: built this PR.

## Asks (from the user)

1. gitignore the local working files sitting in the repo root.
2. A consolidated place to see everything I've assigned (the recurring "where do I see my
   choices later" gap).
3. Improve the sister-link ranking.

## What shipped

### 1. gitignore
`*.xlsx` (60 MB local working spreadsheets) and `outbrain-uploaderrr.py` (a local standalone
script) added to `.gitignore`. Both were untracked; this just keeps them out.

### 2. "My Assignments" (a third source in the Client Kits toggle)
A consolidated view of EVERY assignment across both sources, newest first, independent of
which competitor/filter you were on when you assigned it:
- `loadAllAssignments()` reads `link_assignments` and enriches each row with its competitor
  subject - Meta ads via `getAdsByIds` (headline + creative thumbnail), RSOC rows via
  `getCompRowsByIds` (title + network/vertical/geo). A since-deleted subject still shows the
  saved link, marked.
- The view lists subject, source badge, our link + headline, who/when; filter box; **REMOVE**
  (frees the link) and **DOWNLOAD CSV** of the whole list - a portable record of what was
  chosen. Read-only for viewers.

### 3. Ranking (scoreLink)
- Vertical is now **graded**: exact vertical/category match = 4, loose token overlap = 2
  (was a flat 2), so "Dental Implants" prefers a Dental Implants article over "Dental Care".
- A **+1 topic tiebreak**: a shared meaningful word (>=4 chars) between the competitor's
  headline and our article's headline/keyword, to break ties toward on-topic links.
- Language (5) and country (3) unchanged. Pure and unit-tested.

## Security / Observability / Testing / Deploy
- No new secret / env var / migration. `loadAllAssignments` is read-only, signed-in, capped
  at 2000. Removes reuse the existing `export_data`-gated unassign actions.
- Logs: `[kit saved] loaded {total, meta, rsoc}`.
- Tests: 200 green (ranking cases added/updated). `next build` clean. `link_assignments`
  read verified live (empty in prod today, query runs).
- Additive; rollback = revert.

## Not done (deeper, deferred)
True sister-family matching (via `sister_family_id` / `article_lineage`) - the current
ranking is topic/vertical/language/country based. Prefer-the-sister could be a later pass.
