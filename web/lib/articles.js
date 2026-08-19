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
import { normalizeUrlKey, matchOwned } from './owned.js';
import { ourQueryPlan, groupOurArticles, countOurArticles } from './ourmatch.js';

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
    // A bounded pool, deliberately small. This pooler runs in SESSION mode with a hard cap of
    // 40 clients and it belongs to the Mega Uploader app, not to us - we are a read-only guest
    // on someone else's production database. postgres.js otherwise opens up to 10 connections
    // per instance and every serverless instance gets its own client, so a busy feed could take
    // the whole cap and lock the owning app out of its own data. Five is ample for the handful
    // of reads any one request makes now that the page-scoped lookup is a single query.
    _sql = postgres(url, { prepare: false, ssl: 'require', max: 5 });
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
// network / vertical / geo accept a single value or an array (multi-select from the rail).
export async function searchCompRows({ network, vertical, geo, search, limit = 200 } = {}) {
  const cap = Math.min(500, Math.max(1, Number(limit) || 200));
  const s = String(search || '').trim();
  const like = s ? `%${s}%` : null;
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);
  const nets = arr(network).map((x) => x.toLowerCase());
  const verts = arr(vertical);
  const geos = arr(geo).map((x) => x.toUpperCase());
  const sql = getArticlesSql();
  const notOurs = notOursSql(sql);
  const rows = await sql`
    select id, network, adtitle, url, revenue, clicks, rpc, top_keywords, vertical, geo
    from ref_comp_rows
    where url like 'http%'
      and ${notOurs}
      ${nets.length ? sql`and lower(network) = any(${nets})` : sql``}
      ${verts.length ? sql`and vertical = any(${verts})` : sql``}
      ${geos.length ? sql`and upper(geo) = any(${geos})` : sql``}
      ${like ? sql`and (adtitle ilike ${like} or top_keywords::text ilike ${like})` : sql``}
    order by revenue desc nulls last, id desc
    limit ${cap}
  `;
  console.info('[articles db] comp rows searched', {
    networks: nets.length, verticals: verts.length, geos: geos.length, search: s || null, returned: rows.length,
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

// ── Sister family (article_lineage) ────────────────────────────────────────────
// article_lineage links a competitor/source `parent_url` to OUR child articles, grouped by
// `family_id` (which equals the articles' `sister_family_id`). So a competitor URL that we
// have cloned yields a family, and our articles in that family (is_external=false) are the
// exact sister versions we built from it - a far stronger match than topic/vertical guessing.

// Which of the given competitor URLs actually have a sister family (for badging rows).
export async function getSisterFamilyUrls(urls) {
  const clean = [...new Set((Array.isArray(urls) ? urls : []).map(String).filter(Boolean))].slice(0, 500);
  if (!clean.length) return [];
  const sql = getArticlesSql();
  const rows = await sql`select distinct parent_url from article_lineage where parent_url = any(${clean})`;
  return rows.map((r) => r.parent_url);
}

// Our sister articles for a set of competitor URLs, keyed by competitor URL. Only our own
// links (is_external=false), optionally narrowed to one network. Availability (already
// assigned) is filtered on the adintel side by the caller, since that ledger lives there.
export async function getSisterLinksForUrls(urls, network) {
  const clean = [...new Set((Array.isArray(urls) ? urls : []).map(String).filter(Boolean))].slice(0, 300);
  if (!clean.length) return {};
  const net = String(network || '').trim();
  const sql = getArticlesSql();
  const rows = await sql`
    select l.parent_url as competitor_url,
           a.id, a.url, a.headline, a.domain, a.network, a.country, a.language, a.vertical, a.published_at
    from article_lineage l
    join articles a on a.sister_family_id = l.family_id and a.is_external = false and a.url like 'http%'
    where l.parent_url = any(${clean})
      ${net ? sql`and lower(a.network) = ${net.toLowerCase()}` : sql``}
    order by a.published_at desc nulls last, a.id desc
    limit 3000
  `;
  const byUrl = {};
  for (const r of rows) {
    (byUrl[r.competitor_url] = byUrl[r.competitor_url] || []).push({
      id: r.id, url: r.url, headline: r.headline, domain: r.domain, network: r.network,
      country: r.country, language: r.language, vertical: r.vertical,
      published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
      sister: true,
    });
  }
  return byUrl;
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

// ── "We have our own version" (main feed lineage badge) ─────────────────────────
// Amit's ask: on the main competitor feed, flag each ad for which we have already produced our
// own article inspired by its landing URL. That is exactly the sister-family relation above -
// article_lineage.parent_url is the competitor/source URL, and the family's is_external=false
// articles are our own versions. The Client Kits tab (RSOC comp rows) matches parent_url
// exactly because a comp row's `url` is already a clean article URL. A Meta ad's landing is
// not: link_url can be " | "-joined and carry tracking query strings, and resolved_url may be
// an RSOC search page with no article at all. So this path normalizes both sides to host+path
// and matches on that. The pure URL-matching rules live in lib/owned.js (dependency-free, unit-
// tested); everything here reads only this database, so it stays inside the one enforced
// boundary. attachOwned takes already-fetched adintel rows as plain data.

// The index of competitor/source URLs we have our own version of: every article_lineage parent
// whose family actually contains one of OUR articles (is_external=false, real http link). Small
// (~1k rows), the same for every viewer, and only shifts when we clone something new, so it is
// held for ten minutes like the other article-DB lookups. Keyed by normalized parent_url;
// the first parent to claim a normalized key wins (they collide only on trivial dupes).
const ownedIndexCache = createTtlCache(10 * 60 * 1000);

export async function getOwnedParentIndex() {
  const hit = ownedIndexCache.peek();
  if (hit) return hit.value;
  const sql = getArticlesSql();
  const rows = await sql`
    select distinct l.parent_url, l.family_id
    from article_lineage l
    where l.parent_url like 'http%'
      and exists (
        select 1 from articles a
        where a.sister_family_id = l.family_id and a.is_external = false and a.url like 'http%'
      )
  `;
  const index = new Map();
  for (const r of rows) {
    const key = normalizeUrlKey(r.parent_url);
    if (key && !index.has(key)) index.set(key, { parent_url: r.parent_url, family_id: r.family_id });
  }
  ownedIndexCache.fill(index);
  console.info('[owned] index built', { parents: rows.length, keys: index.size });
  return index;
}

// Attach owned_parent_url / owned_family_id to each feed row (null when we have no own version).
// Best-effort: if the articles DB is not configured or the lookup fails, the feed is returned
// unchanged rather than broken - the badge is an enrichment, never a gate on showing ads.
export async function attachOwned(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  if (!articlesConfigured()) return rows;
  try {
    const index = await getOwnedParentIndex();
    const hits = matchOwned(rows, index);
    console.info('[owned] page matched', { rows: rows.length, owned: hits.size });
    return rows.map((r) => {
      const h = hits.get(r.ad_archive_id) || null;
      return { ...r, owned_parent_url: h?.parent_url ?? null, owned_family_id: h?.family_id ?? null };
    });
  } catch (e) {
    console.warn('[owned] enrichment skipped', String(e?.message || e));
    return rows;
  }
}

// ── "Our articles for this ad, on the domain you picked" ───────────────────────
// The feature the OURS badge above only half-delivered. Rather than requiring an exact URL
// clone (article_lineage, which covers 1,826 of ~30k ads), this asks the looser and far more
// useful question: on the domain the user chose, do we already have articles for the same
// COUNTRY, the same LANGUAGE and the same TOPIC as this ad's landing article?
//
// "Same topic" is `ads.article_verticals` - the vertical family derived from the ad's own
// article by backfill_article_verticals.py, drawn verbatim from the vocabulary of THIS
// database, so it can be compared with `articles.vertical` directly. The matching rules
// themselves live in lib/ourmatch.js (pure, unit-tested, no driver import); this file only
// turns them into SQL.
//
// What the user sees is always read live from here, never from the materialized
// `ads.our_article_domains`: that column exists solely so the feed's server-side filter can be
// expressed in adintel SQL, and a page must never show a count a stale backfill made up.

// Bounds on one lookup. Measured against the live database with a deliberately pessimistic
// 200-vertical locale on our biggest domain: 330 ms and ~190 KB at five rows per vertical.
// A feed page is 5-15 locales, run in parallel, so that is the wall-clock cost of the whole
// page. OUR_CHUNK keeps a whole-feed export behaving exactly like a page rather than asking
// for one enormous union that the vertical cap would then silently truncate.
const OUR_MAX_LOCALES = 25;
const OUR_MAX_VERTICALS = 300;
const OUR_PER_VERTICAL = 5;
const OUR_CHUNK = 250;

// Our articles on one domain for one locale, newest first, capped per vertical. Each row also
// carries `total`, its vertical's real count, so the UI can say "128" while only 8 crossed the
// wire. country/language are compared directly rather than through upper()/lower(): both
// columns are already stored normalized here (verified - zero rows deviate), so the plain
// comparison is both correct and able to use ix_articles_country / ix_articles_language.
// ONE query for the whole page, not one per locale.
//
// This used to fan out a query per locale through Promise.all - up to 25 at once. postgres.js
// opens a connection per concurrent query, and this database is a Supabase pooler in SESSION
// mode capped at 40 clients, SHARED with the Mega Uploader app that owns it. A single feed page
// could exhaust that pool on its own: every query then failed with EMAXCONNSESSION, both
// enrichments hit their catch, and the feed rendered with no articles at all - a dash on every
// row, indistinguishable from "we have nothing". It could also have starved the Uploader app,
// which is not ours to break.
//
// So the locale groups are OR-ed into one statement on one connection. The window functions
// partition by (country, language, vertical) rather than vertical alone, so each locale still
// gets its own newest-N and its own true total.
function ourArticlesQuery(sql, domain, plan) {
  const group = (p) => sql`(a.country = ${p.country} and a.language = ${p.language}
                            and a.vertical = any(${p.verticals.slice(0, OUR_MAX_VERTICALS)}))`;
  const locales = plan.map(group).reduce((acc, g) => sql`${acc} or ${g}`);
  // Only the fields the row chip and the detail panel actually render. network / category /
  // keyword are deliberately absent: nothing displays them here and they were about half the
  // bytes on a busy locale.
  return sql`
    select t.id, t.url, t.headline, t.domain, t.country, t.language, t.vertical,
           t.published_at, t.total
    from (
      select a.id, a.url, a.headline, a.domain, a.country, a.language, a.vertical, a.published_at,
             row_number() over (partition by a.country, a.language, a.vertical
                                order by a.published_at desc nulls last, a.id desc) as rn,
             count(*) over (partition by a.country, a.language, a.vertical)::int as total
      from articles a
      where a.domain = ${domain}
        and a.is_external = false
        and a.url like 'http%'
        and (${locales})
    ) t
    where t.rn <= ${OUR_PER_VERTICAL}
  `;
}

// Every article any row on this page could match, in one round trip per locale. Returns a flat
// array; grouping it back onto the ads is groupOurArticles' job (pure, so it is tested directly).
export async function getOurArticlesForAds(rows, domain) {
  const dom = String(domain || '').trim();
  if (!dom) return [];
  const plan = ourQueryPlan(rows).slice(0, OUR_MAX_LOCALES);
  if (!plan.length) return [];
  const sql = getArticlesSql();
  const out = (await ourArticlesQuery(sql, dom, plan)).map((r) => ({
    id: r.id, url: r.url, headline: r.headline, domain: r.domain,
    country: r.country, language: r.language, vertical: r.vertical, total: r.total,
    published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
  }));
  console.info('[our articles] fetched', { domain: dom, locales: plan.length, articles: out.length });
  return out;
}

// Hang `our_articles` (the newest few, for the row chip and the detail panel) and
// `our_articles_count` (the real total) on each feed row. Best-effort in exactly the way
// attachOwned is: no domain chosen, articles DB unconfigured, or a throwing lookup all return
// the rows untouched. This enriches the feed; it is never a gate on showing it.
export async function attachOurArticles(rows, domain, { perRow = 6 } = {}) {
  const dom = String(domain || '').trim();
  if (!Array.isArray(rows) || !rows.length || !dom) return rows;
  if (!articlesConfigured()) return rows;
  try {
    // Chunked so a 20k-row export asks the same size of question a 100-row page does. Without
    // this the per-locale vertical cap would quietly drop verticals on a big export and the
    // CSV would disagree with the table it was downloaded from.
    const byAd = new Map();
    for (let i = 0; i < rows.length; i += OUR_CHUNK) {
      const chunk = rows.slice(i, i + OUR_CHUNK);
      const articles = await getOurArticlesForAds(chunk, dom);
      for (const [id, hits] of groupOurArticles(chunk, articles)) byAd.set(id, hits);
    }
    console.info('[our articles] matched', { domain: dom, rows: rows.length, matched: byAd.size });
    return rows.map((r) => {
      const hits = byAd.get(r.ad_archive_id);
      if (!hits || !hits.length) return { ...r, our_articles: [], our_articles_count: 0 };
      return { ...r, our_articles: hits.slice(0, perRow), our_articles_count: countOurArticles(hits) };
    });
  } catch (e) {
    console.warn('[our articles] enrichment skipped', String(e?.message || e));
    return rows;
  }
}

// There is deliberately no isOurDomain() here any more. Checking a browser-supplied domain
// against the real list means querying this database, which lives in eu-west-1 while the app
// runs in bom1, and it sat serially in front of every feed page load. Nothing needed it to be
// authoritative: the value only ever reaches SQL as a bound parameter, and a domain we do not
// publish on matches no articles, which is the right answer for it. actions.withCleanDomain
// checks the hostname shape instead and lets the query decide. Do not reinstate it in a
// request path.
