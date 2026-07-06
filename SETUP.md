# Setup - Ad Intelligence Pipeline (Phase 1 foundation)

This covers the backend foundation: the database, the data-access layer, and the
scraper's secret handling. The dashboard (Next.js) and the scheduled runner come
next, once the database is live.

---

## 0. Security first - do this before anything else

The Apify, ScrapingBee, and OpenAI keys were hardcoded in the scraper, so treat
them as compromised.

1. **Revoke and reissue all three:**
   - Apify: Account → Integrations → API tokens → revoke, create new.
   - ScrapingBee: Dashboard → API key → reset.
   - OpenAI: Platform → API keys → revoke, create new.
2. Keep the two Google service-account JSON files out of git. They are already
   covered by `.gitignore`.

The scraper no longer contains any secrets. It reads them from the environment
and fails loudly if one is missing.

---

## 1. Create the Supabase project

1. Go to supabase.com, create a project (Pro plan recommended so the project
   never pauses; Free is fine while developing).
2. Save the database password you set.
3. Get the connection string: Project Settings → Database → Connection string →
   **Transaction** (this is the pooler on port **6543**, which is what CI and the
   scraper use). It looks like:
   ```
   postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```

---

## 2. Run the migration

Open Supabase → SQL Editor → New query, paste the contents of
[`supabase/migrations/0001_initial_schema.sql`](supabase/migrations/0001_initial_schema.sql),
and run it. This creates the `runs`, `domains`, and `ads` tables, their indexes,
and the RLS policies.

(If you prefer the Supabase CLI: `supabase db push`.)

---

## 3. Configure secrets locally

```bash
python -m venv .venv
# Windows:  .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env      # then fill in real values
```

Fill in `.env`:
- `DATABASE_URL` - the transaction-pooler string from step 1.
- `APIFY_API_TOKEN`, `SCRAPINGBEE_API_KEY`, `OPENAI_API_KEY` - the **reissued** keys.
- `SERVICE_ACCOUNT_FILE_SHEETS` / `SERVICE_ACCOUNT_FILE_STORAGE` - paths to the
  two Google JSON key files on your machine.

Verify the database layer connects:
```bash
python -c "import db; \
  from dotenv import load_dotenv; load_dotenv(); \
  import os; print('DATABASE_URL set:', bool(os.environ.get('DATABASE_URL')))"
```
(For loading `.env` automatically you can `pip install python-dotenv`; in CI the
variables come from GitHub Actions secrets instead.)

---

## 4. Seed the management config (domains)

The scraper will read what to pull from the `domains` table (this replaces the
old `WA` Google Sheet). Add rows in the SQL editor, for example:

```sql
insert into domains (query, country, active_status, max_ads, cadence) values
  ('analogaudiohub.com', 'ALL', 'active', 100, 'daily'),
  ('competitor2.com',    'US',  'active',  50, 'weekly');
```

`cadence` is one of `hourly`, `daily`, `weekly`, `paused`. Default to `daily`;
`hourly` multiplies scrape spend (Apify + ScrapingBee + OpenAI) roughly 24x.

---

## 5. What is built vs. what is next

**Built now (this foundation):**
- `supabase/migrations/0001_initial_schema.sql` - schema, indexes, RLS, run lock.
- `db.py` - Postgres data layer: run lock (`claim_run`), completion/failure,
  due-domain lookup, schedule advance, and the dedup `upsert_ads`.
- Scraper secrets moved to environment variables (fail-closed).
- `requirements.txt`, `.env.example`, `.gitignore`.

**Next (needs the live database above to test end to end):**
1. Wire the scraper's output to `db.upsert_ads` instead of Google Sheets, read
   config from `domains`, and record each run via `claim_run` / `finish_run`.
2. Backfill the existing `DB` Google Sheet history into `ads`.
3. Add the GitHub Actions workflow (hourly, self-checks `db.any_domain_due`).
4. Build the Next.js dashboard on Vercel (fresh-finds feed first).

See the full plan in
[`_plans/2026-07-06-competitor-ad-intelligence-dashboard.md`](_plans/2026-07-06-competitor-ad-intelligence-dashboard.md).
