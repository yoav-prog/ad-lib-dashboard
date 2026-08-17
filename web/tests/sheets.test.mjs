// Unit tests for the pure helpers and the retry loop in lib/sheets.js.
//
// a1Tab pins the fix for tab names that look like cell references: unquoted, "DB2" is
// read by the Sheets API as column DB row 2 on the first sheet ("Range exceeds grid
// limits"), not as a tab name. Quoting is always legal, so a1Tab always quotes.
//
// sendWithRetry / isTransientStatus / describeApiError pin the fix for exports dying on
// "Google Sheets error while opening the spreadsheet (503): The service is currently
// unavailable." Google documents 429 and 5xx as retry-with-backoff conditions; we retry
// them instead of throwing the export away on the first bad answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { a1Tab, backoffDelayMs, describeApiError, isTransientStatus, sendWithRetry, writeToSheet } from '../lib/sheets.js';

const noSleep = async () => {};
const res = (status) => ({ status, ok: status >= 200 && status < 300 });

test('a1Tab quotes a tab name that looks like a cell reference', () => {
  assert.equal(a1Tab('DB2'), "'DB2'");
  assert.equal(a1Tab('A1'), "'A1'");
});

test('a1Tab quotes plain and multi-word titles alike', () => {
  assert.equal(a1Tab('KWSDB'), "'KWSDB'");
  assert.equal(a1Tab('Fresh Finds'), "'Fresh Finds'");
});

test('a1Tab doubles internal single quotes', () => {
  assert.equal(a1Tab("Bob's tab"), "'Bob''s tab'");
});

// ── isTransientStatus ─────────────────────────────────────────────────────────

test('isTransientStatus covers the statuses Google says to back off on', () => {
  for (const s of [408, 429, 500, 502, 503, 504]) assert.equal(isTransientStatus(s), true, `${s} should retry`);
});

test('isTransientStatus leaves real failures alone', () => {
  for (const s of [200, 201, 400, 401, 403, 404, 409]) assert.equal(isTransientStatus(s), false, `${s} should not retry`);
});

// ── backoffDelayMs ────────────────────────────────────────────────────────────

test('backoffDelayMs doubles per attempt and stops at the cap', () => {
  const noJitter = () => 0;
  assert.equal(backoffDelayMs(1, noJitter), 400);
  assert.equal(backoffDelayMs(2, noJitter), 800);
  assert.equal(backoffDelayMs(3, noJitter), 1600);
  assert.equal(backoffDelayMs(4, noJitter), 2000); // capped
  assert.equal(backoffDelayMs(9, noJitter), 2000);
});

test('backoffDelayMs adds bounded jitter', () => {
  assert.equal(backoffDelayMs(1, () => 0.999), 400 + 249);
  for (let a = 1; a <= 5; a++) {
    const d = backoffDelayMs(a);
    assert.ok(d >= 400 && d < 2000 + 250, `attempt ${a} delay ${d} out of range`);
  }
});

test('the whole retry budget stays inside a few seconds', () => {
  const worst = [1, 2, 3].reduce((sum, a) => sum + backoffDelayMs(a, () => 0.999), 0);
  assert.ok(worst < 4000, `retry budget ${worst}ms is too slow for a server action`);
});

// ── sendWithRetry ─────────────────────────────────────────────────────────────

test('sendWithRetry returns a good answer without retrying', async () => {
  let calls = 0;
  const out = await sendWithRetry(async () => { calls++; return res(200); }, 'testing', noSleep);
  assert.equal(out.status, 200);
  assert.equal(calls, 1);
});

test('sendWithRetry rides out a 503 and returns the answer that works', async () => {
  const statuses = [503, 503, 200];
  let calls = 0;
  const out = await sendWithRetry(async () => res(statuses[calls++]), 'opening the spreadsheet', noSleep);
  assert.equal(out.status, 200);
  assert.equal(calls, 3);
});

test('sendWithRetry gives up after four attempts and hands back the last answer', async () => {
  let calls = 0;
  const out = await sendWithRetry(async () => { calls++; return res(503); }, 'opening the spreadsheet', noSleep);
  assert.equal(out.status, 503);
  assert.equal(calls, 4);
});

test('sendWithRetry does not retry a failure that will not fix itself', async () => {
  let calls = 0;
  const out = await sendWithRetry(async () => { calls++; return res(404); }, 'opening the spreadsheet', noSleep);
  assert.equal(out.status, 404);
  assert.equal(calls, 1);
});

test('sendWithRetry retries a thrown network fault', async () => {
  let calls = 0;
  const out = await sendWithRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('socket hang up');
    return res(200);
  }, 'reading the tab', noSleep);
  assert.equal(out.status, 200);
  assert.equal(calls, 3);
});

test('sendWithRetry throws a readable error when it can never reach Google', async () => {
  const boom = new Error('ECONNRESET');
  let calls = 0;
  await assert.rejects(
    () => sendWithRetry(async () => { calls++; throw boom; }, 'reading the tab', noSleep),
    (e) => {
      assert.equal(e.code, 'NETWORK');
      assert.match(e.message, /Could not reach Google Sheets while reading the tab/);
      assert.equal(e.cause, boom);
      return true;
    },
  );
  assert.equal(calls, 4);
});

test('sendWithRetry prefers a real status over an earlier network fault', async () => {
  let calls = 0;
  const out = await sendWithRetry(async () => {
    calls++;
    if (calls < 4) throw new Error('socket hang up');
    return res(503);
  }, 'updating the spreadsheet', noSleep);
  assert.equal(out.status, 503);
});

// ── describeApiError ──────────────────────────────────────────────────────────

test('describeApiError tells an admin to wait when Google is the one failing', () => {
  for (const s of [500, 502, 503, 504]) {
    const { code, message } = describeApiError(s, '', 'opening the spreadsheet');
    assert.equal(code, 'UNAVAILABLE');
    assert.match(message, new RegExp(`\\(${s}\\)`));
    assert.match(message, /export again/);
  }
});

test('describeApiError calls a 429 what it is', () => {
  const { code, message } = describeApiError(429, '', 'updating the spreadsheet');
  assert.equal(code, 'RATE_LIMIT');
  assert.match(message, /rate-limiting/);
});

test('describeApiError keeps the actionable sharing and id messages', () => {
  for (const s of [401, 403]) {
    const { code, message } = describeApiError(s, '', 'opening the spreadsheet');
    assert.equal(code, 'PERMISSION');
    assert.match(message, /Share the sheet with the service account as Editor/);
  }
  const notFound = describeApiError(404, '', 'opening the spreadsheet');
  assert.equal(notFound.code, 'NOT_FOUND');
  assert.match(notFound.message, /No spreadsheet found with that ID/);
});

test('describeApiError passes through the detail on a genuine API complaint', () => {
  const { code, message } = describeApiError(400, 'Range exceeds grid limits', 'updating the spreadsheet');
  assert.equal(code, 'API');
  assert.equal(message, 'Google Sheets error while updating the spreadsheet (400): Range exceeds grid limits.');
});

test('describeApiError copes with a failure that carries no detail', () => {
  assert.equal(describeApiError(400, '', 'reading the tab').message, 'Google Sheets error while reading the tab (400).');
});

// ── writeToSheet against a stubbed Google ─────────────────────────────────────
// The append path writes positionally with updateCells instead of appendCells so a
// retried request cannot land the same block of rows twice. These drive the real
// function with fetch stubbed out and assert on the requests it emits.

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GCS_CLIENT_EMAIL = 'exporter@example.iam.gserviceaccount.com';
process.env.GCS_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });

const COLUMNS = [
  { header: 'Ad ID', width: 120, align: 'LEFT', wrap: false },
  { header: 'Page', width: 160, align: 'LEFT', wrap: false },
];
const adRow = (id, page) => ({ cells: [{ value: id }, { value: page }] });

// Stand in for the three endpoints writeToSheet touches. `plan.values` is what the tab
// already holds; `plan.failMeta` makes the metadata read answer with that status once
// before succeeding. Returns the captured batchUpdate request bodies.
function stubGoogle(plan = {}) {
  const sent = [];
  let metaFails = plan.failMeta ? plan.failMetaTimes || 1 : 0;
  const json = (body) => ({ status: 200, ok: true, json: async () => body });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: `t${sent.length}`, expires_in: 3600 });
    if (u.includes(':batchUpdate')) { sent.push(JSON.parse(init.body).requests); return json({ replies: [{}] }); }
    if (u.includes('/values/')) return json({ values: plan.values || [] });
    if (metaFails > 0) { metaFails--; return { status: plan.failMeta, ok: false, json: async () => ({ error: { message: 'The service is currently unavailable.' } }) }; }
    return json({ sheets: [{ properties: { sheetId: 7, title: 'Fresh Finds', gridProperties: { rowCount: plan.rowCount ?? 1000, columnCount: 26 } }, bandedRanges: [] }] });
  };
  return sent;
}

const realFetch = globalThis.fetch;
const flatten = (sent) => sent.flat();
const find = (sent, kind) => flatten(sent).filter((r) => r[kind]).map((r) => r[kind]);

test('append writes at the first free row and never uses appendCells', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const sent = stubGoogle({ values: [['Ad ID', 'Page'], ['1', 'Money PPL'], ['2', 'Wellness Guide']] });
  const out = await writeToSheet(
    { spreadsheetId: 'sheet-id', tabName: 'Fresh Finds', columns: COLUMNS, rows: [adRow('2', 'Wellness Guide'), adRow('3', 'Home Addict')] },
    Date.now(),
  );
  assert.deepEqual({ appended: out.appended, skipped: out.skipped, created: out.created }, { appended: 1, skipped: 1, created: false });
  assert.equal(find(sent, 'appendCells').length, 0);
  const writes = find(sent, 'updateCells').filter((r) => r.rows);
  assert.equal(writes.length, 1);
  // Three rows already in the tab, so the one fresh row lands on row index 3.
  assert.deepEqual(writes[0].range, { sheetId: 7, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 2 });
  assert.equal(writes[0].rows[0].values[0].userEnteredValue.stringValue, '3');
});

test('append into an empty tab writes the header at row 0', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const sent = stubGoogle({ values: [] });
  const out = await writeToSheet(
    { spreadsheetId: 'sheet-id', tabName: 'Fresh Finds', columns: COLUMNS, rows: [adRow('1', 'Money PPL')] },
    Date.now(),
  );
  assert.equal(out.wroteHeader, true);
  const writes = find(sent, 'updateCells').filter((r) => r.rows);
  assert.deepEqual(writes[0].range, { sheetId: 7, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 });
  assert.equal(writes[0].rows[0].values[0].userEnteredValue.stringValue, 'Ad ID');
});

test('append grows the grid first, since a positional write cannot expand it', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const sent = stubGoogle({ values: [['Ad ID', 'Page'], ['1', 'Money PPL']], rowCount: 3 });
  await writeToSheet(
    { spreadsheetId: 'sheet-id', tabName: 'Fresh Finds', columns: COLUMNS, rows: [adRow('2', 'A'), adRow('3', 'B'), adRow('4', 'C')] },
    Date.now(),
  );
  const grown = find(sent, 'updateSheetProperties').find((r) => r.properties?.gridProperties?.rowCount);
  assert.equal(grown.properties.gridProperties.rowCount, 5); // 2 existing + 3 new
  // The grid request must be sent before the data lands, or the write falls off the sheet.
  assert.ok(sent.findIndex((reqs) => reqs.some((r) => r.updateSheetProperties?.properties?.gridProperties?.rowCount))
    <= sent.findIndex((reqs) => reqs.some((r) => r.updateCells?.rows)));
});

test('an export survives a 503 on the metadata read', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const sent = stubGoogle({ values: [], failMeta: 503 });
  const out = await writeToSheet(
    { spreadsheetId: 'sheet-id', tabName: 'Fresh Finds', columns: COLUMNS, rows: [adRow('1', 'Money PPL')] },
    Date.now(),
  );
  assert.equal(out.appended, 1);
  assert.equal(find(sent, 'updateCells').filter((r) => r.rows).length, 1);
});

test('an export gives up with the wait-and-retry message when Google stays down', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubGoogle({ values: [], failMeta: 503, failMetaTimes: 99 });
  await assert.rejects(
    () => writeToSheet({ spreadsheetId: 'sheet-id', tabName: 'Fresh Finds', columns: COLUMNS, rows: [adRow('1', 'Money PPL')] }, Date.now()),
    (e) => {
      assert.equal(e.code, 'UNAVAILABLE');
      assert.match(e.message, /temporarily unavailable \(503\)/);
      return true;
    },
  );
});
