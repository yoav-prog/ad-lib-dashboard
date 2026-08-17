// Mechanical boundary guard (see _plans/2026-08-17-competitor-owned-lineage-panel.md and the
// header of lib/articles.js): the separate "articles"/Mega-Uploader database must be reachable
// through lib/articles.js ONLY. This test walks the app and lib source and fails the build if
// any other module reads process.env.ARTICLES_DATABASE_URL (the only way to connect to it), so
// the read-only, single-boundary contract cannot rot on a later fast edit. Naming the variable
// in help text is fine - only the env access is forbidden. Dependency-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const ALLOWED = join('lib', 'articles.js');
const SCAN_DIRS = ['lib', 'app', 'components'];
const SKIP = new Set(['node_modules', '.next', 'tests']);
const FORBIDDEN = 'process.env.ARTICLES_DATABASE_URL';

function collect(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.(js|jsx|mjs)$/.test(name)) out.push(full);
  }
}

const files = [];
for (const d of SCAN_DIRS) collect(join(webRoot, d), files);

test('only lib/articles.js reads process.env.ARTICLES_DATABASE_URL', () => {
  const offenders = files.filter((f) => {
    const rel = relative(webRoot, f);
    if (rel === ALLOWED) return false;
    return readFileSync(f, 'utf8').includes(FORBIDDEN);
  }).map((f) => relative(webRoot, f));
  assert.deepEqual(offenders, [], `${FORBIDDEN} must be read only in ${ALLOWED}, not: ${offenders.join(', ')}`);
});

test('the guard actually sees files (scan is not empty)', () => {
  assert.ok(files.length > 5, `expected to scan several source files, got ${files.length}`);
});
