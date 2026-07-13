// Server-only Google Sheets client. Authenticates as the project's existing Google
// service account (the same GCS_* credentials the scraper uses) via a hand-signed
// JWT bearer grant, so no extra npm dependency is pulled in. The account can only
// reach spreadsheets that have been shared with GCS_CLIENT_EMAIL (least privilege);
// it cannot see the rest of the user's Drive. Never import this from a client module.
import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// One access token is reused for its lifetime (~1h) so a burst of exports re-signs
// nothing. Refreshed a minute early to stay clear of the expiry edge.
let cachedToken = null; // { token: string, exp: number(ms) }

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The private key is stored with literal "\n" escapes (matching run_scrape.py). The
// replace is a no-op if it already has real newlines, so it is safe either way.
function serviceAccount() {
  const email = process.env.GCS_CLIENT_EMAIL;
  const key = process.env.GCS_PRIVATE_KEY;
  if (!email || !key) return null;
  return { email, key: key.replace(/\\n/g, '\n'), keyId: process.env.GCS_PRIVATE_KEY_ID || undefined };
}

export function sheetsConfigured() {
  return serviceAccount() !== null;
}

export function serviceAccountEmail() {
  return process.env.GCS_CLIENT_EMAIL || null;
}

async function getAccessToken(nowMs) {
  if (cachedToken && cachedToken.exp - 60_000 > nowMs) return cachedToken.token;
  const sa = serviceAccount();
  if (!sa) throw new Error('Google Sheets export is not configured (missing GCS_CLIENT_EMAIL / GCS_PRIVATE_KEY).');

  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify(sa.keyId ? { alg: 'RS256', typ: 'JWT', kid: sa.keyId } : { alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: sa.email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const signingInput = `${header}.${claims}`;
  let signature;
  try {
    signature = base64url(crypto.sign('RSA-SHA256', Buffer.from(signingInput), sa.key));
  } catch {
    throw new Error('Could not sign the request with the service-account key (check GCS_PRIVATE_KEY formatting).');
  }
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) {
    throw new Error('Google authentication failed. Check the service-account key and the server clock.');
  }
  const data = await res.json();
  cachedToken = { token: data.access_token, exp: nowMs + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

// Turn a failed Sheets response into a message a non-technical admin can act on.
async function apiFail(res, action) {
  let detail = '';
  try { detail = (await res.json())?.error?.message || ''; } catch { /* no body */ }
  if (res.status === 401 || res.status === 403) {
    const err = new Error('Access denied. Share the sheet with the service account as Editor, and make sure the Google Sheets API is enabled.');
    err.code = 'PERMISSION';
    throw err;
  }
  if (res.status === 404) {
    const err = new Error('No spreadsheet found with that ID. Double-check the ID or URL.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const err = new Error(`Google Sheets error while ${action} (${res.status})${detail ? `: ${detail}` : ''}.`);
  err.code = 'API';
  throw err;
}

// Quote a tab title for A1 notation. Always quoted (with internal quotes
// doubled): quoting is always legal, and an unquoted title that happens to look
// like a cell reference (e.g. "DB2" = column DB, row 2) would be read as a cell
// on the spreadsheet's first sheet instead of as a tab name.
export function a1Tab(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

async function authed(token, url, init = {}) {
  return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
}

async function batchUpdate(token, id, requests) {
  const res = await authed(token, `${SHEETS_API}/${encodeURIComponent(id)}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) await apiFail(res, 'updating the spreadsheet');
  return res.json();
}

// Sheet metadata we need up front: each tab's id/title/size and any banded ranges
// (so we can clear and re-apply banding). Doubles as the access/existence check.
async function getSheetMeta(token, id) {
  const fields = 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),bandedRanges(bandedRangeId))';
  const res = await authed(token, `${SHEETS_API}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`);
  if (!res.ok) await apiFail(res, 'opening the spreadsheet');
  const data = await res.json();
  return (data.sheets || []).map((s) => ({
    sheetId: s.properties?.sheetId,
    title: s.properties?.title,
    rowCount: s.properties?.gridProperties?.rowCount || 0,
    columnCount: s.properties?.gridProperties?.columnCount || 0,
    bandedRanges: s.bandedRanges || [],
  }));
}

async function addTab(token, id, title, columnCount) {
  const out = await batchUpdate(token, id, [{
    addSheet: { properties: { title, gridProperties: { columnCount: Math.max(26, columnCount) } } },
  }]);
  const props = out.replies?.[0]?.addSheet?.properties || {};
  return { sheetId: props.sheetId, title: props.title, rowCount: props.gridProperties?.rowCount || 1000, columnCount: props.gridProperties?.columnCount || 26, bandedRanges: [] };
}

// Every existing row of the tab (whole used range), for dedupe. Empty when blank.
async function readRows(token, id, tabName) {
  const range = encodeURIComponent(a1Tab(tabName));
  const res = await authed(token, `${SHEETS_API}/${encodeURIComponent(id)}/values/${range}?majorDimension=ROWS`);
  if (!res.ok) await apiFail(res, 'reading the tab');
  return (await res.json()).values || [];
}

// ── Cell + formatting builders ────────────────────────────────────────────────
const rng = (sheetId, r0, r1, c0, c1) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
const rgb = (r, g, b) => ({ red: r, green: g, blue: b });
const HEADER_BG = rgb(0.102, 0.110, 0.125); // dark charcoal, matches the command-center look
const HEADER_FG = rgb(1, 1, 1);
const BAND_A = rgb(1, 1, 1);
const BAND_B = rgb(0.953, 0.957, 0.965); // faint gray for alternating rows
const HEADER_H = 30;
const ROW_H = 96; // tall enough to show an image preview

// Only emit an image/link formula for a real http(s) URL; escape any quotes for the
// formula string literal. Anything else becomes a blank cell (never a stray formula).
function safeUrl(v) {
  const u = String(v || '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  return u.replace(/"/g, '""');
}

function cellData(cell) {
  if (cell.kind === 'image') {
    const u = safeUrl(cell.value);
    return { userEnteredValue: u ? { formulaValue: `=IMAGE("${u}",1)` } : { stringValue: '' } };
  }
  // 'link' holds the raw image URL as plain, copyable text (no HYPERLINK wrapper).
  if (cell.kind === 'link') {
    const u = String(cell.value || '').trim();
    return { userEnteredValue: { stringValue: /^https?:\/\//i.test(u) ? u : '' } };
  }
  return { userEnteredValue: { stringValue: String(cell.value ?? '') } };
}

// Re-apply the full look to the whole used range every export, so the sheet stays
// consistent as rows accumulate: frozen header + first column, styled header, per-
// column width/alignment/wrap, tall rows for previews, and refreshed row banding.
function formatRequests(sheetId, columns, totalRows, oldBandingIds) {
  const N = columns.length;
  const reqs = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } }, fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount' } },
    { repeatCell: { range: rng(sheetId, 0, 1, 0, N), cell: { userEnteredFormat: { backgroundColor: HEADER_BG, textFormat: { bold: true, foregroundColor: HEADER_FG }, horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: HEADER_H }, fields: 'pixelSize' } },
  ];
  if (totalRows > 1) {
    reqs.push({ updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: totalRows }, properties: { pixelSize: ROW_H }, fields: 'pixelSize' } });
  }
  columns.forEach((c, i) => {
    reqs.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: c.width }, fields: 'pixelSize' } });
    if (totalRows > 1) {
      reqs.push({ repeatCell: { range: rng(sheetId, 1, totalRows, i, i + 1), cell: { userEnteredFormat: { verticalAlignment: 'MIDDLE', horizontalAlignment: c.align, wrapStrategy: c.wrap ? 'WRAP' : 'CLIP' } }, fields: 'userEnteredFormat(verticalAlignment,horizontalAlignment,wrapStrategy)' } });
    }
  });
  for (const id of oldBandingIds) reqs.push({ deleteBanding: { bandedRangeId: id } });
  reqs.push({ addBanding: { bandedRange: { range: rng(sheetId, 0, totalRows, 0, N), rowProperties: { headerColor: HEADER_BG, firstBandColor: BAND_A, secondBandColor: BAND_B } } } });
  return reqs;
}

const headerData = (columns) => ({ values: columns.map((c) => ({ userEnteredValue: { stringValue: c.header } })) });
const dataRowData = (row) => ({ values: row.cells.map(cellData) });

// Read the whole used range of a tab as raw row arrays (header row included).
// The metrics loader (lib/metrics) uses this to pull the team's campaign-
// performance tab; same service-account auth and friendly errors as the export.
export async function readSheetTab({ spreadsheetId, tabName }, nowMs) {
  const token = await getAccessToken(nowMs);
  return readRows(token, spreadsheetId, tabName);
}

// Google recommends keeping a single Sheets request near 2 MB and times a request out
// after 180 s of processing, so a very large export is written as a sequence of
// requests rather than one. This many data rows per write keeps a normal-size export a
// single (atomic) request exactly as before, and splits only genuinely large ones.
const ROWS_PER_WRITE = 5000;

// Write `rowData` (header + data rows, already built) to the sheet in chunks, then run
// the `trailing` requests (formatting, leftover-row clears) once the data has landed.
// `makeReq(part, startRow)` builds the write request for one chunk. When everything
// fits a single chunk, the data and trailing requests ride in one batchUpdate, so a
// typical export stays one atomic write; only oversized exports split (trading that
// all-or-nothing guarantee for the ability to write an unbounded number of rows).
async function writeInChunks(token, spreadsheetId, rowData, makeReq, trailing) {
  const parts = [];
  for (let i = 0; i < rowData.length; i += ROWS_PER_WRITE) parts.push(rowData.slice(i, i + ROWS_PER_WRITE));
  if (parts.length <= 1) {
    await batchUpdate(token, spreadsheetId, [makeReq(parts[0] || [], 0), ...trailing]);
    return;
  }
  let start = 0;
  for (const part of parts) {
    await batchUpdate(token, spreadsheetId, [makeReq(part, start)]);
    start += part.length;
  }
  await batchUpdate(token, spreadsheetId, trailing);
}

// Write the selected columns for `rows` to the named sheet/tab and re-apply the full
// formatting; the tab is created if missing. `columns` and `rows` come from
// ui.buildSheetData. A large export is split into multiple Sheets requests (see
// writeInChunks). Two modes:
//   append  (default) - add rows, skipping any already present (matched by the Ad ID
//                       column when it is included); the header is written only when
//                       the tab is empty.
//   replace           - clear whatever is in the tab and write this export fresh.
export async function writeToSheet({ spreadsheetId, tabName, columns, rows, mode = 'append' }, nowMs) {
  const token = await getAccessToken(nowMs);
  const sheets = await getSheetMeta(token, spreadsheetId);
  let sheet = sheets.find((s) => s.title === tabName);
  let created = false;
  if (!sheet) { sheet = await addTab(token, spreadsheetId, tabName, columns.length); created = true; }

  const existing = created ? [] : await readRows(token, spreadsheetId, tabName);
  const oldRows = existing.length;
  const oldBandingIds = sheet.bandedRanges.map((b) => b.bandedRangeId);
  // Grow the grid before writing when needed. appendCells auto-expands rows, but
  // updateCells (replace) does not, so a Replace into a small tab must size it first.
  const ensureGrid = (cols, rowsNeeded, reqs) => {
    const gp = {};
    if (sheet.columnCount && sheet.columnCount < cols) gp.columnCount = cols;
    if (sheet.rowCount && rowsNeeded && sheet.rowCount < rowsNeeded) gp.rowCount = rowsNeeded;
    if (Object.keys(gp).length) {
      reqs.unshift({ updateSheetProperties: { properties: { sheetId: sheet.sheetId, gridProperties: gp }, fields: Object.keys(gp).map((k) => `gridProperties.${k}`).join(',') } });
    }
  };

  if (mode === 'replace') {
    // Overwrite from the top with header + every row and clear any leftover cells
    // (rows/columns the previous, larger export left behind).
    const allRows = [headerData(columns), ...rows.map(dataRowData)];
    const totalRows = allRows.length;
    const oldColMax = existing.reduce((m, r) => Math.max(m, r.length), 0);
    const clearRows = Math.max(oldRows, totalRows);
    const clearCols = Math.max(columns.length, oldColMax);
    // Size the grid once to fit both the new data and anything being cleared, since
    // updateCells (unlike appendCells) never auto-grows the sheet.
    const gridReqs = [];
    ensureGrid(clearCols, clearRows, gridReqs);
    if (gridReqs.length) await batchUpdate(token, spreadsheetId, gridReqs);
    // After the data lands: re-apply the look, then clear any trailing rows the old,
    // larger export left behind and reset their tall preview height.
    const trailing = [...formatRequests(sheet.sheetId, columns, totalRows, oldBandingIds)];
    if (oldRows > totalRows) {
      trailing.push(
        { updateCells: { range: rng(sheet.sheetId, totalRows, oldRows, 0, clearCols), fields: 'userEnteredValue' } },
        { updateDimensionProperties: { range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: totalRows, endIndex: oldRows }, properties: { pixelSize: 21 }, fields: 'pixelSize' } },
      );
    }
    await writeInChunks(token, spreadsheetId, allRows, (part, start) => (
      { updateCells: { range: rng(sheet.sheetId, start, start + part.length, 0, clearCols), rows: part, fields: 'userEnteredValue' } }
    ), trailing);
    return { mode: 'replace', appended: rows.length, cleared: oldRows > 0 ? oldRows - 1 : 0, created };
  }

  // append mode
  const hasHeader = oldRows > 0;
  // Dedupe by the Ad ID column when it is part of the export, matched by header name
  // so a reordered sheet still works. Without it, every row is appended.
  const adCol = columns.findIndex((c) => c.header === 'Ad ID');
  const seen = new Set();
  if (hasHeader && adCol >= 0) {
    const eCol = existing[0].indexOf('Ad ID');
    if (eCol >= 0) for (let i = 1; i < existing.length; i++) if (existing[i][eCol]) seen.add(String(existing[i][eCol]));
  }
  const fresh = adCol >= 0 ? rows.filter((r) => !seen.has(String(r.cells[adCol].value))) : rows;
  if (hasHeader && !fresh.length) return { mode: 'append', appended: 0, skipped: rows.length, created, wroteHeader: false };

  const dataRows = fresh.map(dataRowData);
  const toAppend = hasHeader ? dataRows : [headerData(columns), ...dataRows];
  const totalRows = oldRows + toAppend.length;
  // Grow columns once up front; appendCells auto-grows rows as it writes.
  const gridReqs = [];
  ensureGrid(columns.length, 0, gridReqs);
  if (gridReqs.length) await batchUpdate(token, spreadsheetId, gridReqs);
  await writeInChunks(token, spreadsheetId, toAppend, (part) => (
    { appendCells: { sheetId: sheet.sheetId, rows: part, fields: 'userEnteredValue' } }
  ), formatRequests(sheet.sheetId, columns, totalRows, oldBandingIds));
  return { mode: 'append', appended: fresh.length, skipped: rows.length - fresh.length, created, wroteHeader: !hasHeader };
}
