// Pure URL-matching logic for the "we have our own version" feed badge. No database or driver
// imports live here on purpose, so the match rules can be unit-tested with Node's built-in
// runner and no dependencies (like lib/ui.js). The database side - building the owned-parent
// index and attaching the flags - stays in lib/articles.js, the single articles-DB boundary.

// host (lowercased, no leading www.) + path (no trailing slash), dropping scheme, query and
// fragment. Returns null for anything unparseable. Case is preserved on the path on purpose -
// article slugs are case-sensitive and both sides run through this same function, so a match is
// apples-to-apples.
export function normalizeUrlKey(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return host + path;
}

// A single ad may carry several candidate landing URLs: link_url is sometimes a " | "-joined
// list, and resolved_url is the followed destination. Any one of them matching an owned parent
// makes the ad owned. Order: resolved_url first (the true destination), then each link_url.
export function ownedCandidateUrls(row) {
  const out = [];
  if (row && row.resolved_url) out.push(row.resolved_url);
  for (const part of String((row && row.link_url) || '').split(' | ')) {
    const p = part.trim();
    if (p) out.push(p);
  }
  return out;
}

// Given feed rows and the owned-parent index (Map normKey -> { parent_url, family_id }), return
// a Map ad_archive_id -> { parent_url, family_id } for the rows that match. Pure, so it is
// unit-tested directly.
export function matchOwned(rows, index) {
  const hits = new Map();
  if (!index || !index.size || !Array.isArray(rows)) return hits;
  for (const r of rows) {
    for (const cand of ownedCandidateUrls(r)) {
      const key = normalizeUrlKey(cand);
      if (key && index.has(key)) { hits.set(r.ad_archive_id, index.get(key)); break; }
    }
  }
  return hits;
}
