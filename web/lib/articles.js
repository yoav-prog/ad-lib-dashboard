// Server-only, READ-ONLY access to the separate "articles" database — the catalog
// of OUR OWN published advertorial links (table public.articles, ~258k rows). It is a
// different Supabase project from the adintel app DB, reached via ARTICLES_DATABASE_URL.
//
// This module is the single, enforced boundary to that database: it issues SELECTs and
// nothing else, and no other module opens a client to it. Keeping every article-DB read
// here means the read-only contract (we must never write to a DB other tools depend on)
// is a property of one small file, not a rule scattered across the app. Ideally the URL
// points at a read-only Postgres role so least-privilege is enforced at the DB too.
import postgres from 'postgres';
import { createTtlCache } from './ttl-cache.js';

// One shared client, created lazily. The Supabase pooler needs prepared statements off
// and SSL, same as lib/db.js. The URL may arrive in SQLAlchemy form
// (postgresql+asyncpg://…) since that is how the credential is stored elsewhere; strip
// any +driver so the Node driver accepts it.
let _sql;

export function articlesConfigured() {
  return Boolean(process.env.ARTICLES_DATABASE_URL);
}

export function getArticlesSql() {
  if (!_sql) {
    const raw = process.env.ARTICLES_DATABASE_URL;
    if (!raw) throw new Error('ARTICLES_DATABASE_URL is not set (see ../.env.example)');
    const url = raw.replace(/^postgresql\+\w+:\/\//, 'postgresql://').replace(/^postgres\+\w+:\/\//, 'postgres://');
    _sql = postgres(url, { prepare: false, ssl: 'require' });
  }
  return _sql;
}

// The distinct domains we publish on, with how many links each holds, most first.
// Same for every viewer and mildly expensive (a group-by over 258k rows), so it is
// held for ten minutes rather than recomputed on each panel open.
const domainsCache = createTtlCache(10 * 60 * 1000);

export async function listOurDomains() {
  const hit = domainsCache.peek();
  if (hit) return hit.value;
  const sql = getArticlesSql();
  const rows = await sql`
    select domain, count(*)::int as total
    from articles
    where domain is not null and url like 'http%'
    group by domain
    order by total desc, domain asc
  `;
  const out = rows.map((r) => ({ domain: r.domain, total: r.total }));
  domainsCache.fill(out);
  console.info('[articles db] domains listed', { domains: out.length });
  return out;
}

// Real, http(s) links on one of our domains, newest first, optionally narrowed by
// language / country / a free-text search, and excluding any URLs already handed out
// (the caller passes the assigned set for this domain so the array stays small). Capped
// so a panel never pulls the whole table. Returns plain rows the UI and the matcher read.
export async function searchOurLinks({ domain, language, country, search, excludeUrls, limit = 200 } = {}) {
  const dom = String(domain || '').trim();
  if (!dom) return [];
  const cap = Math.min(500, Math.max(1, Number(limit) || 200));
  const s = String(search || '').trim();
  const like = s ? `%${s}%` : null;
  const excluded = Array.isArray(excludeUrls) && excludeUrls.length ? excludeUrls.map(String) : null;
  const sql = getArticlesSql();
  const rows = await sql`
    select id, url, headline, domain, country, language, vertical, category, keyword, published_at
    from articles
    where domain = ${dom}
      and url like 'http%'
      ${language ? sql`and lower(language) = ${String(language).toLowerCase()}` : sql``}
      ${country ? sql`and upper(country) = ${String(country).toUpperCase()}` : sql``}
      ${like ? sql`and (headline ilike ${like} or url ilike ${like} or keyword ilike ${like})` : sql``}
      ${excluded ? sql`and not (url = any(${excluded}))` : sql``}
    order by published_at desc nulls last, id desc
    limit ${cap}
  `;
  console.info('[articles db] links searched', {
    domain: dom, language: language || null, country: country || null, search: s || null,
    excluded: excluded ? excluded.length : 0, returned: rows.length,
  });
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    headline: r.headline,
    domain: r.domain,
    country: r.country,
    language: r.language,
    vertical: r.vertical,
    category: r.category,
    keyword: r.keyword,
    published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
  }));
}
