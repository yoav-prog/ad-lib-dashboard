# Fresh Finds → Google Sheet export

Date: 2026-07-08
Branch: fresh-finds-image-size-toggle (feature builds on Fresh Finds)

## Goal
From the Fresh Finds page, push the current on-screen view into a Google Sheet the
user names by Sheet ID (or URL) + tab name, in one click. Complements the existing
CSV download; does not replace it.

## Decisions (confirmed with the user)
- **Auth**: reuse the project's existing Google service account. The scraper already
  authenticates to Google with `GCS_CLIENT_EMAIL` / `GCS_PRIVATE_KEY` (and the
  original scraper already called the Sheets API with the `spreadsheets` scope). We
  sign a JWT bearer assertion with Node's built-in `crypto` and exchange it for an
  access token. No new npm dependency.
- **Write mode**: append new rows, skip ones already present (dedupe by the `Ad ID`
  column). Header row written only when the target tab is empty. The tab is created
  if it does not exist.
- **Rows**: the current filtered/searched/date-ranged view (same set the EXPORT CSV
  button uses). Client sends only the ad IDs; the server re-queries the DB so the
  payload is tiny and the exported data is server-authoritative.
- **Columns**: identical to the CSV (single source of truth = `EXPORT_COLUMNS`).

## Alternatives rejected
- **Apps Script webhook**: no Google creds in the app, writes any owned sheet without
  per-sheet sharing — but needs a one-time Apps Script deploy and a service account +
  Sheets scope already exist here, so this added setup for no benefit.
- **OAuth (user connects Google)**: token storage + refresh + consent screen. Overkill
  for a single-tenant internal tool.
- **Keep CSV + Sheets import / =IMPORTDATA**: zero build, but not the one-click push
  the user asked for.

## Architecture
- `web/lib/sheets.js` (new, server-only): `sheetsConfigured()`, and
  `appendRowsToSheet({spreadsheetId, tabName, header, rows}, nowMs)`. Handles JWT
  minting (cached ~1h in-module), tab creation via `batchUpdate.addSheet`, reading
  existing Ad IDs for dedupe, and `values.append` (RAW, INSERT_ROWS). Friendly errors
  for 401/403 (share/enable), 404 (bad ID).
- `web/lib/ui.js`: lift the CSV column list to module-level `EXPORT_COLUMNS`; keep
  `buildCsv` using it; add `buildSheetValues(rows, now)` → `{header, values}` and
  `parseSheetId(input)` (accepts a bare ID or a full Sheets URL).
- `web/lib/queries.js`: add `getAdsByIds(ids)` returning rows in the given id order.
- `web/app/actions.js`: add admin-only `exportToSheet({spreadsheetId, tabName, adIds})`.
- `web/app/page.js`: pass `exportSaEmail = process.env.GCS_CLIENT_EMAIL` (admin only).
- `web/components/Dashboard.jsx`: thread `exportSaEmail` to `FreshFinds`; add an
  `→ EXPORT TO SHEET` button beside EXPORT CSV (admin only) and a `SheetExportModal`
  matching the existing AI-draft modal style. Remembers last Sheet ID + tab in
  localStorage.

## Security (rule 13)
- Server action is `requireAdmin`-gated (viewers can't export).
- Private key stays server-side (Vercel env), never sent to the client; the SA email
  is a non-secret identifier and may be shown to the admin to guide sharing.
- Service account can only touch sheets explicitly shared with it (least privilege;
  it cannot read the user's Drive).
- Inputs validated: Sheet ID regex, tab name required, ad-id list capped.
- No secrets logged (private key already in the scraper's redaction set).

## Cost (rule 8)
Google Sheets API is free within per-minute quotas (300 writes/min per project). An
export is 2-3 API calls. No monetary cost at this volume. (Google has signaled
over-quota charges may arrive later in 2026 — irrelevant here.)

## User setup (one time)
1. Add `GCS_CLIENT_EMAIL` and `GCS_PRIVATE_KEY` to the Vercel project env (already
   GitHub Actions secrets; copy the same values).
2. In Google Cloud, enable the **Google Sheets API** on the service account's project.
3. Share each target sheet with the service account email (`GCS_CLIENT_EMAIL`) as Editor.

## QA checklist
- New tab created + header + rows on first export.
- Second export of the same view → 0 added, all skipped (dedupe).
- Partially overlapping view → only the new rows added.
- Bad ID / URL, unshared sheet, missing env → clear, specific errors.
- Viewer role cannot see or call the export.
- Tab names with spaces/punctuation quoted correctly in A1 notation.
- Long ad copy and commas/quotes/newlines land intact (RAW input).

## Open questions
- Confirm the exact `GCS_PRIVATE_KEY` is present/valid on Vercel before first use.
