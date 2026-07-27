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
insert into domains (query, country, active_status, max_ads, interval_days) values
  ('analogaudiohub.com', 'ALL', 'active', 100, 3),
  ('competitor2.com',    'US',  'active',  50, 7);
```

`interval_days` is how many days between scrapes (1..365, default 3). Set it, or
edit it per domain in the Control Room. Smaller numbers scrape more often and cost
more (Apify + ScrapingBee + OpenAI are billed per run). To pause a domain, flip its
Status to paused (the `enabled` flag); the runner only scrapes enabled domains.

---

## 5. Campaign metrics from the "Comp Test" sheet (dashboard)

Fresh Finds and Review show four columns joined live from the team's campaign
sheet (revenue prediction, clicks, RPC, top keywords). Only the sheet's
`facebook-rsoc` rows and only ads in the TONIC RSOC feed take part; rows and
ads are matched by landing-page URL with tracking parameters stripped.

One-time setup:
1. The dashboard reuses the export credentials (`GCS_CLIENT_EMAIL` /
   `GCS_PRIVATE_KEY` in the Vercel env). Nothing new to create.
2. Share the metrics spreadsheet with `GCS_CLIENT_EMAIL` as **Viewer**.
   Until then the columns show dashes and the server logs `[metrics] failed`.

The sheet id and tab default to the team's current sheet (`DB2` tab) in
`web/lib/metrics.js`; set `METRICS_SPREADSHEET_ID` / `METRICS_SHEET_TAB` in the
Vercel env if the data ever moves. The join re-reads the sheet at most every
10 minutes; the "⟳ METRICS" button in Fresh Finds forces an immediate re-read.

---

## 6. Dashboard accounts

Everyone gets their own account. There is no shared passcode.

**Environment variables.** Set these in the Vercel project (and in `.env.local`
for local work). Full descriptions are in `.env.example`.

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | 32+ random chars. Signs the emergency-access cookie; only needed alongside `BREAK_GLASS_PASSCODE`. |
| `APP_URL` | Stable public URL. Invite emails link here, so it must be the production domain, not a preview one. |
| `ALLOWED_EMAIL_DOMAIN` | Only this domain may sign in. Unset means nobody can, on purpose. |
| `ADMIN_EMAIL` | Where `/setup` sends the first invite. |
| `SMTP_*`, `EMAIL_FROM` | Google Workspace SMTP for invites and resets. `SMTP_PASS` is an App Password. |
| `BREAK_GLASS_PASSCODE` | Optional emergency access. Leave blank to disable. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional. Turns on "Continue with Google". Both unset means the button never appears. |

**First run.**

1. Apply `supabase/migrations/0009_users_and_sessions.sql`, then
   `supabase/migrations/0011_google_identity.sql`.
2. Deploy, then open `/setup` once. It emails a setup link to `ADMIN_EMAIL` and
   then closes permanently. It only ever mails that one address, so leaving it
   exposed is safe.
3. Open the link, pick a password, and you are signed in as the first admin.
4. Invite everyone else from `/admin`.

**Sign in with Google (optional).** Adds a "Continue with Google" button to
`/login` and to invite links, next to the password form. It costs nothing:
this uses Google's plain OAuth 2.0 endpoints, which are free and have no
per-user charge. It is not Cloud Identity Platform, which is the paid product
with a similar name.

1. In the [Google Cloud console](https://console.cloud.google.com/), pick the
   project (the one holding the existing service accounts is fine) and open
   **APIs & Services → OAuth consent screen**. Choose **Internal**. That limits
   sign-in to your own Workspace organisation and skips Google's verification
   review. External would work but puts the app in front of a review and a
   consent warning for no benefit here.
2. **Credentials → Create credentials → OAuth client ID → Web application.**
   Under *Authorized redirect URIs* add, exactly:
   - `https://your-dashboard.vercel.app/api/auth/google/callback` (must match
     `APP_URL`)
   - `http://localhost:3000/api/auth/google/callback` for local work
3. Put the client ID and secret into `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` in Vercel and in `.env.local`.
4. Apply `supabase/migrations/0011_google_identity.sql` if you have not already.

What it does and does not change:

- **Access is still invite-only.** Google proves who someone is; it does not
  decide whether they may sign in. An address nobody invited at `/admin` is
  refused, and no account is ever created automatically.
- **It finishes an invite.** Someone who has been invited can click Continue with
  Google instead of setting a password, and their account activates. Handy, and
  it means fewer passwords in the database.
- **Passwords still work.** Nothing about the email and password path changed, so
  a broken OAuth client never locks the team out.
- **Workspace accounts only.** The account must be managed by your Workspace
  organisation (the `hd` claim). A personal Google account that happens to hold a
  company address is refused.
- **One Google account per person.** The Google subject is recorded on first use.
  If an address is later reissued to a different person, their sign-in is refused
  as a conflict rather than inheriting the old account. An admin clears that with
  **UNLINK** on the `/admin` row, which also signs the account out.

If sign-in fails and the server log shows `redirect_uri_mismatch`, the URI in the
console does not match `APP_URL` byte for byte. That is almost always a trailing
slash or `http` against `https`.

**Roles and permissions.** A role sets the defaults and the `/admin` checkboxes
override individual permissions per person.

| | edit ads | manage domains | run scrapes | export | manage users |
|---|---|---|---|---|---|
| Admin | yes | yes | yes | yes | yes |
| Editor | yes | no | no | yes | no |
| Viewer | no | no | no | no | no |

Managing users is not a checkbox: it follows the Admin role, which is what stops
a non-admin from granting themselves everything.

**Removing someone.** *Disable* keeps the account and its history and signs them
out everywhere immediately. *Delete* removes the account for good; the audit log
of what they did survives. The last remaining admin cannot be disabled, deleted,
or demoted.

**If you get locked out.** Set `BREAK_GLASS_PASSCODE` and go to `/admin/rescue`.
It grants user management for 30 minutes and never reaches the ad data. Every
attempt is logged. Without that variable set, recovery means editing the
database by hand.

---

## 7. Deployment region (performance)

`web/vercel.json` pins functions to `bom1` (Mumbai, `ap-south-1`). This is not
cosmetic. The Supabase database is in `ap-south-1`, and Vercel functions default
to `iad1` (Washington DC), so every query was crossing the planet and back.

Measured from a client in Israel against the Mumbai database:

| | |
|---|---|
| Bare round trip (`select 1`) | ~220 ms |
| Queries per dashboard render | 9 |
| `getAds()` alone | ~4.0 s, ~13 MB |

Vercel's own guidance is that functions should run in the same region as the
database. Mumbai also happens to be closer to Israel than Virginia is, so this
helps both hops. JSON has no comments, hence this note: **if the database ever
moves region, change `vercel.json` to match.**

---

## 8. What is built vs. what is next

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
