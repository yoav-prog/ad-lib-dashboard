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

// Quote a tab title for A1 notation. Bare word-titles pass through; anything with a
// space or punctuation is single-quoted with internal quotes doubled.
function a1Tab(title) {
  const t = String(title);
  return /^[A-Za-z0-9_]+$/.test(t) ? t : `'${t.replace(/'/g, "''")}'`;
}

async function authed(token, url, init = {}) {
  return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
}

// Ensure the named tab exists; create it if missing. Returns true if it was created.
async function ensureTab(token, id, tabName) {
  const res = await authed(token, `${SHEETS_API}/${encodeURIComponent(id)}?fields=sheets.properties.title`);
  if (!res.ok) await apiFail(res, 'opening the spreadsheet');
  const meta = await res.json();
  const titles = (meta.sheets || []).map((s) => s.properties?.title);
  if (titles.includes(tabName)) return false;

  const add = await authed(token, `${SHEETS_API}/${encodeURIComponent(id)}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
  });
  if (!add.ok) await apiFail(add, `creating the tab "${tabName}"`);
  return true;
}

// Every existing row of the tab (whole used range). Empty array if the tab is blank.
async function readRows(token, id, tabName) {
  const range = encodeURIComponent(a1Tab(tabName));
  const res = await authed(token, `${SHEETS_API}/${encodeURIComponent(id)}/values/${range}?majorDimension=ROWS`);
  if (!res.ok) await apiFail(res, 'reading the tab');
  return (await res.json()).values || [];
}

async function appendRows(token, id, tabName, values) {
  const range = encodeURIComponent(`${a1Tab(tabName)}!A1`);
  const res = await authed(
    token,
    `${SHEETS_API}/${encodeURIComponent(id)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ majorDimension: 'ROWS', values }) },
  );
  if (!res.ok) await apiFail(res, 'appending rows');
  return res.json();
}

// Append `rows` (2D string array) under `header` to the given sheet/tab, skipping any
// row whose Ad ID already appears in the tab. Writes the header only when the tab is
// empty. Creates the tab if it does not exist. Returns a summary of what happened.
export async function appendRowsToSheet({ spreadsheetId, tabName, header, rows }, nowMs) {
  const token = await getAccessToken(nowMs);
  const created = await ensureTab(token, spreadsheetId, tabName);
  const existing = created ? [] : await readRows(token, spreadsheetId, tabName);
  const hasHeader = existing.length > 0;

  // Dedupe by the Ad ID column, matched by header name so a reordered sheet still works.
  const adCol = header.indexOf('Ad ID');
  const seen = new Set();
  if (hasHeader && adCol >= 0) {
    const existingAdCol = existing[0].indexOf('Ad ID');
    if (existingAdCol >= 0) {
      for (let i = 1; i < existing.length; i++) {
        const v = existing[i][existingAdCol];
        if (v) seen.add(String(v));
      }
    }
  }
  const fresh = adCol >= 0 ? rows.filter((r) => !seen.has(String(r[adCol]))) : rows;

  const toWrite = hasHeader ? fresh : [header, ...fresh];
  if (!toWrite.length) return { appended: 0, skipped: rows.length, created, wroteHeader: false };

  await appendRows(token, spreadsheetId, tabName, toWrite);
  return { appended: fresh.length, skipped: rows.length - fresh.length, created, wroteHeader: !hasHeader };
}
