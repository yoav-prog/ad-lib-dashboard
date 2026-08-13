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
    where domain is not null and url like 'http%' and is_external = false
    group by domain
    order by total desc, domain asc
  `;
  const out = rows.map((r) => ({ domain: r.domain, total: r.total }));
  domainsCache.fill(out);
  console.info('[articles db] domains listed', { domains: out.length });
  return out;
}

// The networks our links are published on (Tonic, System1, Traffic Club, Inuvo, ...) with
// how many links each holds, most first. Drives the network filter in the assign panel so
// a Tonic client is only ever offered Tonic links. Held for ten minutes like the domains.
const networksCache = createTtlCache(10 * 60 * 1000);

export async function listOurNetworks() {
  const hit = networksCache.peek();
  if (hit) return hit.value;
  const sql = getArticlesSql();
  const rows = await sql`
    select network, count(*)::int as total
    from articles
    where network is not null and network <> '' and url like 'http%' and is_external = false
    group by network
    order by total desc, network asc
  `;
  const out = rows.map((r) => ({ network: r.network, total: r.total }));
  networksCache.fill(out);
  console.info('[articles db] networks listed', { networks: out.length });
  return out;
}

// Real, http(s) links on one of our domains, newest first, optionally narrowed by
// network / language / country / a free-text search, and excluding any URLs already handed
// out (the caller passes the assigned set for this domain so the array stays small). Capped
// so a panel never pulls the whole table. Returns plain rows the UI and the matcher read.
export async function searchOurLinks({ domain, network, language, country, search, excludeUrls, limit = 200 } = {}) {
  const dom = String(domain || '').trim();
  if (!dom) return [];
  const cap = Math.min(500, Math.max(1, Number(limit) || 200));
  const s = String(search || '').trim();
  const like = s ? `%${s}%` : null;
  const net = String(network || '').trim();
  const excluded = Array.isArray(excludeUrls) && excludeUrls.length ? excludeUrls.map(String) : null;
  const sql = getArticlesSql();
  const rows = await sql`
    select id, url, headline, domain, network, country, language, vertical, category, keyword, published_at
    from articles
    where domain = ${dom}
      and url like 'http%'
      and is_external = false
      ${net ? sql`and lower(network) = ${net.toLowerCase()}` : sql``}
      ${language ? sql`and lower(language) = ${String(language).toLowerCase()}` : sql``}
      ${country ? sql`and upper(country) = ${String(country).toUpperCase()}` : sql``}
      ${like ? sql`and (headline ilike ${like} or url ilike ${like} or keyword ilike ${like})` : sql``}
      ${excluded ? sql`and not (url = any(${excluded}))` : sql``}
    order by published_at desc nulls last, id desc
    limit ${cap}
  `;
  console.info('[articles db] links searched', {
    domain: dom, network: net || null, language: language || null, country: country || null, search: s || null,
    excluded: excluded ? excluded.length : 0, returned: rows.length,
  });
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    headline: r.headline,
    domain: r.domain,
    network: r.network,
    country: r.country,
    language: r.language,
    vertical: r.vertical,
    category: r.category,
    keyword: r.keyword,
    published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
  }));
}

// ── RSOC competitor rows (ref_comp_rows) ───────────────────────────────────────
// The competitor intelligence Maya's workflow actually uses: network / vertical / geo /
// adtitle / revenue / RPC / keywords. It shares the articles DB with our own links, so we
// exclude any competitor row that lives on one of OUR domains right in SQL (the sheet's
// "Exclude Aporia" step) - a row's host is pulled from its url and checked against the set
// of our article domains. Both facets and search apply the same exclusion so counts match.
// notOursSql builds that condition as a raw sql`` fragment (no user input), the same way
// lib/queries.js composes its conditional clauses. "Ours" is articles.is_external = false
// (our own ~46 domains); external=true rows are competitor domains and must NOT be treated
// as ours, so the exclusion set is is_external=false domains only.
const notOursSql = (sql) => sql`lower(regexp_replace(substring(url from '://([^/]+)'), '^www\\.', '')) not in (select distinct lower(domain) from articles where is_external = false and domain is not null)`;
const compFacetsCache = createTtlCache(10 * 60 * 1000);

export async function getCompFacets() {
  const hit = compFacetsCache.peek();
  if (hit) return hit.value;
  const sql = getArticlesSql();
  const notOurs = notOursSql(sql);
  const [networks, verticals, geos] = await Promise.all([
    sql`select network as v, count(*)::int as n from ref_comp_rows where url like 'http%' and ${notOurs} and network is not null group by network order by n desc`,
    sql`select vertical as v, count(*)::int as n from ref_comp_rows where url like 'http%' and ${notOurs} and vertical is not null group by vertical order by n desc limit 100`,
    sql`select geo as v, count(*)::int as n from ref_comp_rows where url like 'http%' and ${notOurs} and geo is not null group by geo order by n desc`,
  ]);
  const out = {
    networks: networks.map((r) => ({ value: r.v, total: r.n })),
    verticals: verticals.map((r) => ({ value: r.v, total: r.n })),
    geos: geos.map((r) => ({ value: r.v, total: r.n })),
  };
  compFacetsCache.fill(out);
  console.info('[articles db] comp facets', { networks: out.networks.length, verticals: out.verticals.length, geos: out.geos.length });
  return out;
}

// Competitor rows on real http(s) landings, our own domains excluded, filtered by
// competitor network / vertical / geo / free-text, highest revenue first, capped.
export async function searchCompRows({ network, vertical, geo, search, limit = 200 } = {}) {
  const cap = Math.min(500, Math.max(1, Number(limit) || 200));
  const s = String(search || '').trim();
  const like = s ? `%${s}%` : null;
  const sql = getArticlesSql();
  const notOurs = notOursSql(sql);
  const rows = await sql`
    select id, network, adtitle, url, revenue, clicks, rpc, top_keywords, vertical, geo
    from ref_comp_rows
    where url like 'http%'
      and ${notOurs}
      ${network ? sql`and lower(network) = ${String(network).toLowerCase()}` : sql``}
      ${vertical ? sql`and vertical = ${String(vertical)}` : sql``}
      ${geo ? sql`and upper(geo) = ${String(geo).toUpperCase()}` : sql``}
      ${like ? sql`and (adtitle ilike ${like} or top_keywords::text ilike ${like})` : sql``}
    order by revenue desc nulls last, id desc
    limit ${cap}
  `;
  console.info('[articles db] comp rows searched', {
    network: network || null, vertical: vertical || null, geo: geo || null, search: s || null, returned: rows.length,
  });
  return rows.map(mapCompRow);
}

function mapCompRow(r) {
  return {
    id: r.id,
    network: r.network,
    adtitle: r.adtitle,
    url: r.url,
    revenue: r.revenue != null ? Number(r.revenue) : null,
    clicks: r.clicks != null ? Number(r.clicks) : null,
    rpc: r.rpc != null ? Number(r.rpc) : null,
    top_keywords: Array.isArray(r.top_keywords) ? r.top_keywords.join(', ') : (r.top_keywords == null ? '' : String(r.top_keywords)),
    vertical: r.vertical,
    geo: r.geo,
  };
}

// Comp rows by id, server-authoritative, for bulk assign and export (so matching and the
// exported values never trust client-sent fields). Preserves the given id order.
export async function getCompRowsByIds(ids) {
  const clean = (Array.isArray(ids) ? ids : [])
    .map((x) => Math.trunc(Number(x)))
    .filter((n) => Number.isFinite(n));
  if (!clean.length) return [];
  const uniq = [...new Set(clean)];
  const sql = getArticlesSql();
  const rows = await sql`
    select id, network, adtitle, url, revenue, clicks, rpc, top_keywords, vertical, geo
    from ref_comp_rows where id = any(${uniq})
  `;
  const byId = new Map(rows.map((r) => [r.id, mapCompRow(r)]));
  return uniq.map((id) => byId.get(id)).filter(Boolean);
}
