# Bug #311: high-revenue TONIC RSOC campaigns with no Facebook creative

Date: 2026-11-04
Branch: worktree-tonic-rsoc-missing-creatives
Reporter: Maya. Status: approved by Yoav, building.

## The report

"There are competitor campaigns with high revenue (over 1000) where no creative is pulled from
Facebook." Yoav suspected we already pull what we can. Checked against live data before deciding.

## What the data says (read-only probes, 2026-11-04)

The "campaigns" are the Comp Test sheet, tab DB2 (`campaign_metrics`, 5,382 facebook-rsoc
article URLs, $412.9k). An ad is tied to a campaign when its landing URL, normalized to
host + path, equals the sheet's `campaign_target_url` (`web/lib/metrics.js`).

68 campaigns are at $1,000+. 54 already show a creative. The other 14:

| Cause | Campaigns | Revenue | Kind |
|---|---|---|---|
| Ad is in AdIntel but links through a click tracker; the join reads `link_url` only | 5 | $11.6k | bug |
| Ad matched but hidden by the prohibited-content filter (Filtered view) | 3 | $4.5k | by design |
| Never pulled: domain returns its 300-ad cap every run, or is not tracked | 4 | $5.6k | config |
| We have a sibling copy of the article (`...-0ff969`), not the exact URL | 1 | $3.9k | not a match |
| mytips.com is OUR domain, found under the KO feed | 1 | $1.4k | not a competitor |

Across all 5,382 campaigns the tracker gap hides 371 campaigns / $45.9k.

A second cause feeds it. `_scrape_article_sync` stores `Spb-Resolved-Url or url`, so when
ScrapingBee fails on a tracker (e.g. trk.s2sengine.com answers 500) the tracker itself is saved
as the landing page: 699 TONIC RSOC rows. About 800 more Tonic-tracker rows have no landing at
all. Every Tonic tracker family seen (checkbeforesearch.com, qcviwxfqmc.com, trk.s2sengine.com,
quickresultsfinder.com) answers a plain GET with one 302/307 straight to the article, for free.

Client Kits (RSOC view, `ref_comp_rows`) has the opposite problem: the creative shown is the
newest ad on the same SITE. Of 7,253 facebook-rsoc rows showing one, only 4,293 have an ad for
that exact article, so ~2,960 show another article's creative, and it goes into the export.

## Goals

1. A campaign whose ad links through a click tracker gets its creative and revenue.
2. New tracker ads keep their real landing page even when ScrapingBee fails.
3. Existing Tonic tracker rows get their landing page back (free).
4. Client Kits only shows (and exports) a creative that belongs to that exact article.

## Approach (chosen)

- `web/lib/metrics.js`: `adUrlKeys(linkUrl, resolvedUrl)` returns the link destinations first,
  then the landing page. `attachSheetMetrics` and `resolveCampaignKey` both use it, so the
  in-memory join and the `campaign_url_key` the 30-minute sync stamps cannot disagree.
  `resolveCampaignKey` now takes the ad row (`{ feed, link_url, resolved_url }`).
- `web/lib/metrics-sync.js`: reads `resolved_url` too. No migration: the next cron run
  (every 30 min) re-stamps the keys.
- New `landing.py`: `resolve_landing(url)` walks Location headers by hand (GET, no redirects
  followed automatically, body never read, bounded timeouts). Empty result means unknown, never
  the input echoed back. Optional `stop_site` ends the walk the moment a hop points at the ad's
  own domain, so the backfill never touches the rate-limited competitor site.
- Scraper: when ScrapingBee fails (or raises), the landing comes from `resolve_landing` instead
  of echoing the tracker. While editing that call, give it a real client-side timeout
  (see memory: scrapingbee-timeout-trap). The scraper walks without `stop_site`, so on those
  failures only it sends one header-only GET to the article site.
- `backfill_resolved_url.py`: `--feed NAME`; also retries rows whose stored landing is the tracker
  itself (same host + path as the link; ScrapingBee re-encodes macros, so string equality caught
  only 75 of ~700); skips links already on the ad's own site (`own`, 3,118 Tonic rows that need
  nothing); tries the free walk first, ScrapingBee only when the free walk gets no answer.
  Predicto behaves as before: its 152 own-site rows with no landing are all bare `/asrsearch`
  (`dead`, classified first).
- Client Kits: `getMetaCreativesByHosts` becomes `getMetaCreativesByUrls`, an exact
  article match (SQL narrows candidates, `adUrlKeys` decides), newest ad with an image wins.
  Costs ~1.3s server time vs ~0.5s for the host query (measured under scrape load); the sister
  lookup now runs beside it instead of after it, which wins most of that back.

## Rejected

- Fuzzy matching of clone-suffixed URLs (`slug-0ff969` vs `slug`): 248 campaigns, $12k, but
  suffixes mark different article copies and often different campaigns; slugs like `2026-862560`
  vs `2026-077ae1` share nothing but a year. Would pin one campaign's revenue on another's ad.
- Dropping the TONIC RSOC feed gate: one $1k+ case, and it is our own domain.
- Keeping a whole-site creative as a fallback in Client Kits: wrong creative in a client export
  is worse than no creative.

## Not code (reported, not changed)

- Domain caps: most big Tonic domains return exactly 300 (knowrift: 100) every 3-day run, ranked
  by impressions. Approved ~$1 Apify test, 1,000 per site with the production actor + input:
  - inspireblaze.com has only 371 live ads. The "missing" $1,622 campaign is rank 2: we pull it
    every run, it was hidden by the tracker-echo bug (trk.s2sengine.com). 87 inspireblaze
    campaigns ($10.2k) were unmatched for that reason; only one ($9) sits past rank 300.
  - intuitionlink.com has 1,000+ live ads. A deeper pull adds 13 unmatched campaigns ($1.6k).
    The missing $1,377 Klarna campaign is not in the top 1,000: most likely no longer running.
  - Verdict: do not raise caps. The tracker fix is where the value is.
- Untracked: asklayers.com, flickermindset.com. Low value overall (122 campaigns, $3.9k).
- Prohibited-filtered ads are reviewable in the Filtered view, where a person can clear a flag.

## Incident during this work (fixed)

The investigation's read-only probes used `set session characteristics as transaction read only`
through the adintel transaction pooler. The setting stuck to one pooled backend, which then made
the first backfill's UPDATEs fail as read-only (and may have cost the 10:30 metrics sync). Reset
on every pooled backend the same day and verified; the scrape running at the time logged no
errors. Rule saved to memory (pooler-session-settings-leak): never SET SESSION through a pooler.

## Security

- No new secret, no new dependency, no schema change. Reads stay read-only; the sync and the
  backfill write only `campaign_url_key` / `resolved_url`.
- `resolve_landing` only issues GETs to URLs already stored as ad links, never reads bodies,
  caps hops (5) and time per hop, and never follows a non-http(s) Location.
- New SQL takes keys as a bound array (postgres.js), nothing interpolated.

## Testing

- Node: `adUrlKeys` / `attachSheetMetrics` / `resolveCampaignKey` with tracker links, link-wins
  precedence, tracker-echo landings that must not match.
- Python: `resolve_landing` against a fake session (chains, relative Location, stop_host, first
  hop dead, mid-chain dead, hop cap, non-http Location) and the scraper fallback.
- Live, read-only: re-count campaign matches with the new rule; Client Kits exact match counts.
- `next build`, both test suites, then post-deploy: confirm the cron re-stamped the keys.

## Deploy

Merge -> Vercel deploys the web part; the scraper picks up the Python part on its next run. Then
run `python backfill_resolved_url.py --feed "TONIC RSOC"` once. Rollback: revert the PR (no
schema change; resolved_url values written by the backfill are correct data either way).
