-- The scraper follows an ad's link_url through any redirects when it scrapes the
-- landing page (ScrapingBee returns the final URL in the Spb-Resolved-Url header).
-- Store it: the Predicto feed's searched phrase lives in the post-redirect URL's
-- ?search= param, which the raw tracker link (e.g. wildflares.com/teleport) hides.
alter table public.ads add column if not exists resolved_url text;
