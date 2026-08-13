-- ═════════════════════════════════════════════════════════════════════════════
-- 0015_link_assignments.sql
-- Client Kits: the record of which of OUR OWN article links has been assigned to a
-- competitor ad, so a client deliverable can carry the competitor's creative with
-- our link substituted for theirs.
--
-- Our article links live in a SEPARATE, read-only database (the articles DB), so we
-- cannot mark a link "used" over there. This table is the availability ledger on the
-- adintel side: a link is "available" exactly when its URL is absent here. Cross-DB,
-- so there is no foreign key to the articles DB; our_article_id / our_headline are
-- snapshots kept for display and provenance only.
--
-- Availability is GLOBAL, enforced by the UNIQUE constraint on our_url: a given link
-- is offered to at most one competitor ad, ever, so we never hand the same link to two
-- clients. Assigning a link to an ad first clears that ad's previous assignment (done
-- in the app, app/actions.js), which frees the old link back to available; the unique
-- constraint is the mechanical guarantee that nothing slips past that.
-- ═════════════════════════════════════════════════════════════════════════════

create table if not exists public.link_assignments (
    id             uuid        primary key default gen_random_uuid(),
    ad_archive_id  text        not null,
    our_url        text        not null,
    our_domain     text        not null,
    our_headline   text,
    our_article_id integer,
    assigned_by    text,
    assigned_at    timestamptz not null default now()
);

-- Global availability: one competitor ad per link, never two.
create unique index if not exists link_assignments_our_url_key
    on public.link_assignments (our_url);

-- The per-ad lookup the kit view and export do (assignments for a set of ads).
create index if not exists link_assignments_ad_idx
    on public.link_assignments (ad_archive_id);

-- Grouping/counting by our domain (how many of a domain's links are taken).
create index if not exists link_assignments_domain_idx
    on public.link_assignments (our_domain);
