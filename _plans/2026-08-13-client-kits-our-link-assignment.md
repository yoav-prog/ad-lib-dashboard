# Client Kits: assign our own article links to competitor ads, export client-safe

Date: 2026-08-13
Status: in progress
Owner: web dashboard
Branch: client-link-kits (worktree: ../adintel-client-link-kits)

## Where this came from

Maya asked (WhatsApp, Hebrew) for a way to hand a client a competitor's winning
ads without exposing the competitor's own landing pages. Her words: the client
needs "on one side the article and on the other side the competitor's creative
as it appeared" but "without the competitors'" real link — "there's everything
except our link, so we can pick a domain and see if there are available links."

Decoded: for a chosen competitor, show the competitor's creative and substitute
one of OUR OWN article links (picked from a domain we choose, from links that
are still available) in place of the competitor's link. The output is a client
deliverable (a Google Sheet) that carries the creative + our link, never the
competitor's URL.

## Goal

A new "Client Kits" tab that lets a user:
1. Pick a competitor (tracked domain) and see its winning ads (creatives + metrics).
2. For each ad, assign one of our own article links — pick a domain, see the
   available links on it (auto-suggested by the ad's language/country/vertical),
   choose one. Manual pick and auto-suggest both supported.
3. Export the finished kit to a Google Sheet: competitor creative + our link,
   with the competitor's own link/slug/query columns deliberately dropped.

## Data sources (confirmed with the user)

- Competitor ads: the existing adintel Supabase DB (`ads` table).
- Our article links: an EXISTING separate Supabase DB, READ ONLY. Table
  `public.articles` (~258k rows): `id, url, headline, domain, country, language,
  network, vertical, category, keyword, published_at`. "Our domains" are the
  distinct `domain` values (mytips.com, visionaryecho.com, ...). Reached via a
  new `ARTICLES_DATABASE_URL` env var (never committed; see Security).

## Key design decision: where "available" lives

The articles DB is read-only, so we cannot mark a link "used" there. The
assignment state (which of our links has been handed out) lives in the adintel
DB, in a new `link_assignments` table. "Available" = an article URL that is not
present in `link_assignments`. Availability is GLOBAL (a link is offered to at
most one competitor ad, ever), enforced by a UNIQUE constraint on the URL, so we
never hand the same link to two clients. Reassigning an ad frees its old link.

Cross-DB, so there is no SQL join: candidate links are read from the articles DB,
the assigned-URL set is read from adintel, and the overlap is filtered out in JS
(candidates over-fetched, then trimmed to the display cap).

## Architecture (layers + the boundary that stays enforced)

- Data access, competitor side: `web/lib/queries.js` (adintel DB via `getSql`).
- Data access, our-links side: NEW `web/lib/articles.js` — the ONLY module that
  touches the articles DB, SELECT-only, via a second postgres client
  (`getArticlesSql`). No other module imports the articles client. This is the
  enforced boundary: article-DB access cannot leak into UI or actions except
  through these named read functions.
- Assignment state: adintel DB. Reads in `queries.js`
  (`getAssignmentsByAdIds`, `getAssignedUrls`), writes in server actions.
- Presentation/format SSOT: `web/lib/ui.js` — `buildSheetData` generalized to take
  a column catalog; `KIT_COLUMNS` added there so the kit export and (future) kit
  CSV never drift, exactly like `SHEET_COLUMNS`.
- Server actions: `web/app/actions.js` — every mutation re-gated server-side.
- UI: NEW `web/components/ClientKitsView.jsx`, lazy-loaded like Competitors.

At 100x load the hot paths are: distinct-domain list (cached, TTL), per-domain
link search (capped + indexed by domain), assignment reads (indexed by
ad_archive_id). None ship the 258k-row table to the browser.

## Approach

### DB (adintel) — migration `0015_link_assignments.sql`
```
link_assignments(
  id           uuid pk default gen_random_uuid(),
  ad_archive_id text not null,        -- competitor ad
  our_url       text not null,        -- our chosen article link
  our_domain    text not null,        -- denormalized, for display/grouping
  our_headline  text,                 -- snapshot of the article headline
  our_article_id integer,             -- articles DB id (no cross-DB FK)
  assigned_by   text,                 -- user email
  assigned_at   timestamptz not null default now()
)
unique(our_url)                        -- global availability
index(ad_archive_id)                   -- per-ad lookup
```
One link per ad in practice: assign replaces any prior assignment for that ad
(freeing the old link). `unique(our_url)` is the mechanical guarantee.

### Articles DB — `web/lib/articles.js` (read-only)
- `getArticlesSql()`: second `postgres()` client on `ARTICLES_DATABASE_URL`,
  `{ prepare: false, ssl: 'require' }` (Supabase pooler), created lazily.
- `articlesConfigured()`: env present?
- `listOurDomains()`: `select domain, count(*) ... group by domain order by count desc`,
  TTL-cached (10 min). Returns `[{ domain, total }]`.
- `searchOurLinks({ domain, language, country, vertical, search, excludeUrls, limit })`:
  candidate links on a domain, optional filters, capped; returns
  `{ id, url, headline, domain, country, language, vertical, category, keyword, published_at }`.

### Matching (auto-suggest) — pure, tested
`scoreLink(ad, link)` in ui.js (pure): +language match, +country match,
+vertical/category overlap (normalized token contains). Higher = better. The
view uses it to rank the available list and to auto-pick the top link per ad.
Deterministic, no network — unit-tested against fixtures.

### Server actions — `web/app/actions.js`
- `loadOurDomains()` — read, signed-in.
- `searchOurLinks(params)` — read, signed-in; excludes already-assigned URLs.
- `loadKitAssignments(adIds)` — read, signed-in.
- `assignOurLink({ adId, url, domain, headline, articleId })` — `export_data`;
  deletes any prior assignment for the ad, inserts, maps `unique` violation to a
  friendly "already taken" reason.
- `unassignOurLink({ adId })` — `export_data`.
- `exportKitToSheet({ spreadsheetId, tabName, adIds, columnKeys, mode })` —
  `export_data`; re-reads ads server-side, joins their assignments, builds rows
  from `KIT_COLUMNS`, writes via existing `writeToSheet`.

### UI — `web/components/ClientKitsView.jsx`
Competitor picker (from loaded ads' domains) → winning-ad list (creative +
metrics, sorted by revenue then days). Each row shows its Our-Link cell
(assigned link or an ASSIGN button). Assign opens a panel: our-domain dropdown
(default = best guess), search box, and the available-link list auto-suggested
by the ad. "Auto-suggest all" fills every unassigned row with its top match.
"Export kit" opens the existing sheet-export modal shape, writing the kit.

## Settings (rule 15)
No new user setting needed at v1: the domain/link choices are per-assignment,
not global preferences. Column choice for the kit export reuses the existing
column-picker pattern (KIT_COLUMN_META). Noted-not-built: a saved "preferred
our-domain per vertical" default — deferred until Maya asks.

## Security (rule 13)
- `ARTICLES_DATABASE_URL` is a secret: env only, `.env` is gitignored, placeholder
  in `.env.example`. Never logged. The user pasted the live credential in chat —
  flagged for rotation. RECOMMENDED: provision a read-only Postgres role for this
  URL so least-privilege is enforced at the DB, not just by our SELECT-only module.
- Articles DB access is SELECT-only and isolated in `lib/articles.js`.
- Every mutation re-gated with `requireCapability('export_data')`; reads require a
  signed-in session, matching the existing feed actions.
- Inputs validated: sheet id regex (reused), ad-id list deduped/capped, domain and
  url length-capped, url must be http(s). Sheet writes stay formula-injection-safe
  via the existing `safeUrl`/`cellData` path.
- The kit export omits the competitor's link/slug/query columns by construction, so
  a client deliverable cannot leak competitor URLs.

## Observability (rule 14)
Namespaced logs at each step: `[kit domains]`, `[kit search]`,
`[kit assign]`, `[kit unassign]`, `[kit export]`, `[articles db]` — logging the
counts/ids/domain/filter actually used (never URLs' full content or credentials).

## Testing (rule 18)
Unit (node --test, existing runner):
- `scoreLink` ranking: language/country/vertical weighting, ties, empties.
- availability filter: assigned URLs removed from candidates.
- `KIT_COLUMNS` build via generalized `buildSheetData`: competitor link/slug/query
  absent; our_domain/our_link/our_headline present and populated from the join.
- `buildSheetData` still builds `SHEET_COLUMNS` unchanged (regression).
Integration/manual (login-gated, needs prod creds — walked in review + on the
Vercel preview): pick competitor, assign/reassign/unassign, auto-suggest all,
availability hides taken links, export lands with no competitor URL.
Out of scope: driving the live articles DB in CI (read-only external DB, no seam).

## Deploy (rule 19)
Branch `client-link-kits` (own worktree) → single PR into `main`. CI (node tests +
next build) must be green. Merge triggers the normal Vercel deploy. Before the
feature works in production the user must add `ARTICLES_DATABASE_URL` to the Vercel
project env and run migration `0015` on the adintel DB. Rollback: revert the PR;
the new tab and table are additive and touch no existing flow. Not touching `main`,
the remote, or other branches until the PR is opened; never merging by hand.

## Alternatives rejected
- Store availability in the articles DB: it is read-only (user constraint), and it
  is shared by other tools — we must not write there.
- Cross-DB SQL join for availability: different databases; not possible. JS filter
  over a capped candidate set is simple and fast enough.
- Extend the Fresh Finds sheet export instead of a new view: the user chose a new
  in-app view; the kit also needs per-ad assignment state the feed export has no
  place for.
- Per-kit (not global) availability: risks handing the same link to two clients,
  which is the exact thing Maya wants to avoid.

## Open questions (non-blocking; sensible defaults chosen)
- Is `published_at` the right freshness signal for ranking our links? (Assumed yes.)
- Should a link ever be reusable across clients? (Assumed no — global availability.)
- Vertical taxonomies differ between the two DBs; auto-suggest leans on
  language+country first, vertical as a soft token match. Refine if Maya finds the
  suggestions weak.
