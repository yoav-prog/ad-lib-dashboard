# Per-row manual run in Control Room

## Context

Today the only way to trigger a scrape from Control Room is **RUN NOW**, which marks
*every* active row due and runs them all ([actions.js `triggerScrape`](../web/app/actions.js)).
The scheduled GitHub runner (`scrape.yml`, hourly) then scrapes **all due rows** via
[`run_scrape.py`](../run_scrape.py)'s no-argument due-sweep. There is no way to run a
single competitor, or a chosen handful, on demand.

The user wants to pick **which rows** to run — one row or a selected subset — in **true
isolation**: only the picked rows scrape, each with its own Max Ads / Country / Feed,
advancing only their schedules, never sweeping up other rows.

Why isolation needs real plumbing (not a one-liner): the runner's no-arg mode scrapes
*all due rows*, and `domains.next_run_at` **defaults to `now()`**
(supabase/migrations/0001_initial_schema.sql:51) so freshly-added rows are immediately
due. A naive "mark this row due + dispatch" would also scrape every other currently-due
row — exactly what the user said they don't want. So the runner itself must learn a
targeted mode.

Outcome: a checkbox multi-select on the Tracked Domains table (mirroring the existing
Fresh Finds bulk pattern) plus a **RUN SELECTED** action that dispatches the scraper for
exactly those rows. RUN NOW (all active) stays unchanged.

## Answer to the side question (for the record)

There is no "daily cron." The runner fires **hourly**; each row's **cadence** (DAILY/…)
decides how often it's actually scraped. The runner only ever touches rows in this table
that are **enabled AND cadence≠paused AND due**. Anything paused or absent is never scraped.

## Approach

A targeted run passes the selected domain UUIDs through a GitHub `workflow_dispatch`
input to the runner, which loads exactly those rows and scrapes only them. Falls back to
marking-those-rows-due if no dispatch token is configured or the input isn't live on main yet.

Selecting a single row and running it *is* the "single row" path — no separate per-row
instant button, deliberately: each run costs money (Apify residential proxy + OpenAI +
ScrapingBee), so a two-step select→run guards against accidental costly scrapes. This also
matches the existing Fresh Finds bulk-select interaction.

## Changes

**1. `.github/workflows/scrape.yml`** — declare the input and pass it to the run step:
```yaml
  workflow_dispatch:
    inputs:
      domain_ids:
        description: 'Comma-separated domain UUIDs to run (blank = every due domain)'
        required: false
        default: ''
```
and in the `Run due scrapes` step `env:` add `DOMAIN_IDS: ${{ github.event.inputs.domain_ids }}`.
For `schedule` triggers the input is empty, so the due-sweep is unchanged.

**2. `db.py`** — new helper beside `get_due_domains` (db.py:255-265):
```python
def get_domains_by_ids(conn, ids):
    """Specific domains by id — used by targeted manual runs. Unlike get_due_domains
    this ignores enabled / cadence / next_run_at: an explicit request runs the row
    regardless (so you can one-off a paused competitor)."""
    if not ids: return []
    with conn.cursor() as cur:
        cur.execute('select * from domains where id = any(%s)', (list(ids),))
        return cur.fetchall()
```

**3. `run_scrape.py`** — add a targeted mode alongside the existing `--query` and due-sweep:
- `import uuid`; add `--domain-ids` arg.
- `_target_domain_ids(args)`: read `args.domain_ids` or env `DOMAIN_IDS`, split on comma,
  validate each with `uuid.UUID(...)` (drop invalid), return the clean list.
- In `run` (run_scrape.py:360): compute `target_ids` once; extend the cheap-exit guard to
  `if not args.query and not target_ids:` (targeted rows may not be "due").
- In the `else` (non-`--query`) branch, choose the row set once, then reuse the **existing**
  per-domain scrape+`bump_domain_schedule` loop unchanged:
  ```python
  rows = db.get_domains_by_ids(conn, target_ids) if target_ids else db.get_due_domains(conn)
  print(f'{len(rows)} selected domain(s) to run' if target_ids else f'{len(rows)} domain(s) due')
  ```
  Empty `rows` (all ids deleted) → finishes as a clean 0/0 run.

**4. `web/app/actions.js`** — new `runDomains(ids)` after `triggerScrape`, following its shape:
- `requireAdmin()`; sanitize `ids` to unique UUID-shaped strings, cap ~50.
- Dispatch `scrape.yml` on `ref:'main'` with `inputs:{ domain_ids: clean.join(',') }`.
- Fallback (no token/repo, or non-ok dispatch such as a 422 before main declares the input):
  `update domains set next_run_at = now(), enabled = true where id = any(${clean})` and
  `revalidatePath('/')`. Return `{ ok, dispatched, count, reason }` so the UI can report honestly.

**5. `web/components/Dashboard.jsx`** — import `runDomains`; add `onRunDomains` mirroring
`onRunNow` (Dashboard.jsx:112-117) (set `dispatchedAtRef`/`pending` on dispatch, then
`poll()`); pass `onRunDomains` to `<ControlRoom>` (Dashboard.jsx:302).

**6. `web/components/ControlRoom.jsx`** — mirror the Fresh Finds bulk pattern
(Dashboard.jsx:580-601):
- Accept `onRunDomains`; local `sel` Set of domain ids with `toggleSel` / clear.
- Add a leading 34px checkbox cell to the table header (select-all over `shownDomains`) and
  to each row; guarded by `canEdit`.
- A bulk bar above the table, shown when `sel.size > 0`: `N selected` · **► RUN N SELECTED**
  (calls `onRunDomains([...sel])`, then clears) · est. `up to X ads` (sum of selected
  `max_ads`) · Clear. Reports the dispatched/fallback outcome inline.
- Update the footer hint to mention selecting rows to run a subset; keep RUN NOW = all active.

## Cost / security notes

- No new paid service. This only lets you trigger the **existing** pipeline for a subset;
  cost per run is bounded by each row's Max Ads, same as today. Running a subset is
  cheaper than "run all," so this can only reduce spend.
- `runDomains` is `requireAdmin`-gated like every other action. IDs are validated to UUID
  shape both in the server action and in Python, and only ever reach SQL through psycopg's
  parameterized `= any(%s)` — no injection surface. Existing log redaction is untouched.

## Deployment note (must do, or isolation silently degrades)

The dispatch always targets `ref:'main'` (actions.js:158), and GitHub validates `inputs`
against the workflow **on main**. So:
1. Merge this branch to **main** so `scrape.yml` (with the input), `run_scrape.py`, and
   `db.py` are what CI runs.
2. Redeploy the web app so `actions.js` + components ship.

Until the input exists on main, `runDomains` still works but falls back to mark-due (not
isolated). After merge, true single/subset isolation is live.

## Verification

- **Runner, targeted:** `python run_scrape.py --domain-ids "<real-uuid>" --no-media --retries 1`
  → logs `1 selected domain(s) to run`, scrapes only that row, bumps only its `next_run_at`.
  Confirm a **paused** row still runs this way.
- **Runner, unchanged:** `python run_scrape.py` with nothing due → `nothing due; exiting`.
- **Web:** `npm run dev` in `web/` → Control Room → select one row → RUN → verify dispatch
  (or fallback message). Select several → RUN. Verify select-all / clear, and that a viewer
  (read-only) sees no checkboxes.
- **CI (after merge):** trigger from the UI; confirm the Actions run logs `N selected
  domain(s) to run` and only those rows scrape.
- Full QA pass per house rules: golden path (1 row, many rows), edge cases (deleted id,
  invalid id, no token fallback, run while another run is active → claim lock exits quietly),
  viewer read-only, and that RUN NOW still runs all active.
