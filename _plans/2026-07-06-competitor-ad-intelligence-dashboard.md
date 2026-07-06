# Competitor Ad Intelligence Dashboard - Architecture Plan

- **Date:** 2026-07-06
- **Status:** Approved architecture. Build order confirmed 2026-07-06: **Phase 1 (intelligence feed) first, content pipeline in Phase 2.** Still pending answers on open questions 13.1, 13.4, 13.5, 13.6.
- **Author:** Claude + Yoav
- **Related asset:** `facebookadscraperapify2026-v2.py` (existing working scraper)

---

## 1. Goal and context

We have a working Python scraper that pulls competitors' Facebook and Instagram ads from the
Meta Ad Library (via an Apify actor), scrapes each ad's landing page (ScrapingBee), enriches
each ad with GPT (language, target country, vertical), downloads the creative images and videos
into a Google Cloud Storage bucket, and currently writes rows into Google Sheets.

We are replacing the Google Sheet with a real web dashboard. The purpose of the tool is
competitive intelligence: see what competitors are advertising, spot topics worth writing our
own articles about, and take inspiration from their creative.

The dashboard is not the hard part. The scraper already works. The value and the risk both live
in: reliable ingestion, clean dedup, an honest "what's new" signal, and not over-building a
workflow nobody maintains.

## 2. Users and scope

- **Users:** a small internal marketing team. Not public. Behind login.
- **In scope (eventually):** fresh-finds feed, per-competitor (domain) feed, creative detail
  view, a content pipeline (ad to article with owner and status), and a management zone to
  configure how many ads to pull per domain and how often the scraper runs.
- **Out of scope:** public access, multi-tenant/customer-facing features, real-time streaming.

## 3. Requirements

### Functional
- Ingest ads keyed on `ad_archive_id`. Never import the same ad twice (dedup + upsert).
- Landing view: "fresh finds" - ads first seen since the last completed scrape.
- Per-domain / per-competitor feed.
- Creative detail: media, ad copy, scraped landing article, metadata, workflow controls.
- Management zone: per-domain pull count, country, active-status, and a cadence
  (hourly / daily / weekly) configurable from the UI.
- Content pipeline (phased): owner, status (idea / drafting / published), linked article URL.

### Non-functional
- Security first: auth, least privilege, no secrets in code, RLS at the DB.
- Reliability: partial or failed scrapes must not surface broken data; failures must be visible.
- Cost control: cadence must not silently multiply scraping spend.
- Aesthetic: dark "command center" chrome, but the creative media must stay large and vivid.

## 4. Chosen architecture

```
                 ┌─────────────────────────────┐
                 │  GitHub Actions (scheduler)  │
                 │  hourly cron, self-checks    │
                 │  next_run_at from the DB     │
                 └──────────────┬──────────────┘
                                │ runs when due, takes a run-lock
                                ▼
   ┌────────────────────────────────────────────────┐
   │  Python scraper (existing, adapted)            │
   │  Apify → ScrapingBee → GPT → media to GCS       │
   │  upsert rows into Supabase on ad_archive_id     │
   └───────────────┬───────────────┬─────────────────┘
                   │               │
        media (jpg/mp4)         rows + metadata
                   ▼               ▼
        ┌──────────────┐   ┌──────────────────────┐
        │  GCS bucket  │   │  Supabase (Postgres) │
        │  (permanent  │   │  Auth + RLS + tables │
        │   URLs)      │   └──────────┬───────────┘
        └──────────────┘              │
                                      ▼
                        ┌──────────────────────────┐
                        │  Next.js on Vercel        │
                        │  reads/writes Supabase    │
                        │  dashboard UI + mgmt zone │
                        └──────────────────────────┘
```

- **Database: Supabase (Postgres + Auth + Row Level Security).** Single source of truth. Chosen
  because it gives us database, authentication, and authorization in one product instead of
  wiring those together ourselves. Postgres also keeps the door open for `pgvector` semantic
  search later (Phase 3) without switching engines.
- **Media: keep the existing GCS bucket.** The scraper already downloads competitor creative and
  re-hosts it on GCS, so the DB stores permanent GCS URLs, not expiring Facebook CDN links. No
  reason to migrate this; it already solves the asset-persistence problem.
- **Scraper runner: GitHub Actions on a fixed hourly cron.** The workflow's first step reads the
  schedule from the DB and exits early if a run isn't due. The UI cadence dropdown just writes a
  value the workflow interprets. No always-on server, no dispatch glue, $0. A `runs` table
  provides the lock (no overlapping runs) and the integrity boundary (only completed runs are
  visible).
- **Dashboard: Next.js (App Router) on Vercel**, reading and writing Supabase from server
  components and route handlers.

## 5. Data model (initial)

```
ads
  ad_archive_id      text  PRIMARY KEY         -- dedup key
  page_id, page_name text
  caption, cta_text, body_text, cta_type, display_format, ...  (scraper columns)
  original_image_url, video_hd_url, ... (GCS URLs)
  article_title, article_content   text        -- scraped landing page
  rank, feed, domain, language, country, vertical
  days_running       int  GENERATED / derived from start_date
  first_seen_at      timestamptz               -- set once, on first insert
  last_seen_at       timestamptz               -- updated every run that sees it
  run_id             uuid  REFERENCES runs      -- the run that first captured it
  -- workflow (Phase 2):
  status             text  DEFAULT 'idea'       -- idea | drafting | published
  owner_id           uuid  REFERENCES users
  linked_article_url text
  is_saved           boolean DEFAULT false
  tags               text[]
  notes              text

runs
  id            uuid PRIMARY KEY
  status        text          -- running | completed | failed
  started_at, finished_at  timestamptz
  ads_found, ads_new, errors int
  -- a partial unique index on status='running' enforces "one run at a time"

domains  (the management-zone config)
  id            uuid PRIMARY KEY
  query         text          -- the search term / domain
  country       text
  active_status text
  max_ads       int
  cadence       text          -- hourly | daily | weekly
  next_run_at   timestamptz
  last_run_at   timestamptz
```

- Dedup = `INSERT ... ON CONFLICT (ad_archive_id) DO UPDATE SET last_seen_at = now(), ...`.
  `first_seen_at` is only set on insert, which is what makes "fresh finds" honest.
- "Fresh" is defined globally by `first_seen_at` against the last completed run boundary. A
  per-user "seen"/"saved" layer can sit on top later if wanted (open question 13.3).

## 6. Scheduling model

- One GitHub Actions workflow, `schedule: cron` hourly (the finest cadence requested).
- Step 1 queries `domains` for anything where `next_run_at <= now()`. If none, exit in seconds.
- If due, take the run-lock (insert a `runs` row with status `running`; the partial unique index
  makes a second concurrent run fail fast), run the scraper for the due domains, then set
  `next_run_at` forward based on each domain's cadence and close the run.
- Hourly checks are ~720 job-starts/month; the quick "nothing due" exits stay comfortably within
  the GitHub Actions free minutes for private repos (2,000 on Free, 3,000 on Pro).
- Upgrade path if sub-hourly cadence or stricter reliability is ever needed: move the runner to a
  small Railway ($5/mo) or Render cron ($1/mo) worker with the same self-check logic. No schema
  change required.

## 7. Cost analysis (verified 2026-07-06)

### New fixed infrastructure
| Item | Plan | Cost | Note |
|---|---|---|---|
| Supabase | Pro | $25/mo | Free tier pauses after 1 week idle; Pro avoids that. Dev can use Free. |
| Vercel | Pro | ~$20/mo per member | Hobby is non-commercial only; an internal business tool needs Pro. |
| GitHub Actions | Free tier | $0 | Hourly self-checks fit the free minutes. |
| GCS | existing | a few $/mo | Already in use; storage + egress of creatives. |
| **New fixed total** | | **~$45/mo** | Excludes existing scrape spend below. |

### Variable spend - the real cost driver (already incurred today)
Apify + ScrapingBee + OpenAI are billed **per run**, scaling with domains x ads x cadence. This
is the cost bomb the council flagged: an "hourly" cadence is roughly 24x a "daily" one. Mitigation
built into the design: cap cadence, **default to daily**, show an estimated per-run cost in the
management zone, and record actual counts in the `runs` table so spend is visible. Exact per-unit
rates for the Apify actor, ScrapingBee plan, and gpt-4.1-mini should be pulled from the current
account/dashboards before enabling anything faster than daily.

## 8. Security and safety

- **Immediate:** revoke and reissue the Apify token, ScrapingBee key, and OpenAI key currently
  hardcoded in the script. They are exposed; rotation into a store is not enough while the old
  keys still work. Same for the two GCP service-account JSON files - keep them out of any repo.
- **Secrets:** GitHub Actions Secrets for the runner, Vercel environment variables for the app,
  Supabase Vault / env for DB creds. Nothing in source, nothing in git history.
- **Auth + authorization:** Supabase Auth for login (email allowlist for the team). Row Level
  Security on every table; the app uses the anon key client-side and the service role key only in
  trusted server code.
- **Least privilege:** a dedicated DB role for the scraper limited to insert/update on `ads` and
  `runs`. GCS service account scoped to the one bucket.
- **Input validation:** validate management-zone inputs (max_ads bounds, cadence enum) so a bad
  config can't trigger runaway spend.
- **Legal / ToS:** scraping the Meta Ad Library via a third-party actor carries terms-of-service
  exposure. Acceptable for internal research, but noted here as a known risk, not an oversight.
- **Fail safe:** a failed or partial run stays invisible to the feed (integrity boundary in the
  `runs` table); the app never shows half-enriched ads as "fresh."

## 9. Alternatives considered and rejected

- **Neon (serverless Postgres).** Leaner and integrates tightly with Vercel, but ships only a
  bare database. We'd build auth and authorization ourselves. Rejected because Supabase folds
  those in and the storage difference is irrelevant at our data size.
- **GCP Cloud SQL.** Keeps everything in one cloud (we already use GCS + service accounts), but
  means managing a VPC, a connection pooler, and more ops than a small team wants. Rejected on
  operational overhead.
- **Run the scraper on Vercel.** Vercel functions now allow up to 800s (Pro) or 1800s (beta), and
  bill active CPU so I/O waiting is nearly free. Still rejected: the full multi-domain run with
  Apify paging and retry sleeps exceeds the 30-minute ceiling, and long jobs cut against Vercel's
  grain. GitHub Actions has no such wall-clock limit and is free.
- **A dedicated always-on scheduler service (Railway/Render) for v1.** More moving parts than the
  self-check GitHub Actions pattern needs. Kept as a documented upgrade path, not the starting
  point.
- **Keep Google Sheets as the backend.** Rejected up front: read quotas, latency, concurrent-write
  races, no real querying, and the current script wipes the `Data` tab every run.

## 10. Phased delivery

### Phase 1 - Intelligence feed (the trusted core, ship first)
1. Provision Supabase; create `ads`, `runs`, `domains` tables + RLS + team auth.
2. Adapt the scraper: write to Supabase (upsert on `ad_archive_id`) instead of Sheets; set
   `first_seen_at` / `last_seen_at`; wrap each domain in try/except and log to `runs`. Backfill
   the existing `DB` sheet history into `ads`.
3. Wrap the scraper in a GitHub Actions workflow with the self-check + run-lock; move all keys to
   GitHub Secrets in the same change.
4. Next.js app: fresh-finds landing, per-domain feed, creative detail view, save/star, dark
   command-center theme with large creative tiles. Login. "Last successful run" indicator.
5. Management zone (read + basic config): domains, per-domain `max_ads`, cadence (capped, daily
   default).

### Phase 2 - Content pipeline (build once the feed is used and trusted)
- Owner, status (idea / drafting / published), linked article URL, tags, notes; a kanban board.
- Kept deliberately lightweight; the council warned that unused status fields make the board lie.

### Phase 3 - Intelligence upside (optional, high-leverage)
- **Ad longevity ranking:** surface long-running ads as "proven winners" (nearly free from
  existing data).
- **Theme clustering / trends** from an extra GPT pass (offer / hook / angle) - "3 competitors
  pushing free-trial messaging this week."
- **Alerts** (Slack / email) on new ads from named competitors - turns a dashboard people forget
  into a push system.
- **"Draft this" AI article** pre-filled from the landing page + creative.
- **`pgvector` semantic search** across the full historical ad archive.

## 11. Design direction

Dark "command center" (chosen). Reconciling the one tension the council raised - a terminal look
can fight image/video-heavy content - the resolution is: dark, precise, monospace-numeric chrome
around **large, vivid creative tiles**. The data reads like a trading desk; the creative pops
against it. The detailed design brief already exists (handed off separately for the high-fidelity
prototype).

## 12. Council-flagged risks to design around

1. Overlapping runs corrupting upserts → `runs` table lock (partial unique index on `running`).
2. Partial-run garbage in "fresh finds" → only surface ads from completed runs.
3. "Fresh" is undefined without timestamps → `first_seen_at` + last-completed-run boundary.
4. Cadence as a cost multiplier → cap + daily default + per-run cost estimate + logged counts.
5. Exposed keys → revoke and reissue, not rotate.
6. Losing history → backfill the existing sheet.
7. Workflow rot → phase the pipeline; validate adoption before expanding it.

## 13. Open questions

1. **Vercel plan:** confirm we go Pro (needed for a commercial/internal tool). One member or more?
2. **Default and max cadence:** propose default daily, hard cap at hourly. Agree?
3. **"Fresh" semantics:** global (everyone sees the same "new since last run") or per-user
   (each person has their own seen/unseen)? Recommend global for v1, per-user "saved" on top.
4. **Backfill:** how far back does the existing `DB` sheet go, and do we import all of it?
5. **Team size / who logs in:** how many users, and is an email allowlist enough for auth?
6. **Repo + git:** this folder is not yet a git repo. Confirm we init one (and that the scraper's
   keys are already revoked before the first commit).
```
