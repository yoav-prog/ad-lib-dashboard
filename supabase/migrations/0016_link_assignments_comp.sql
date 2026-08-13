-- ═════════════════════════════════════════════════════════════════════════════
-- 0016_link_assignments_comp.sql
-- Client Kits gains a second competitor source: RSOC competitor rows (the articles
-- DB's ref_comp_rows), alongside the original Meta Ad Library ads. An assignment can
-- now hang off EITHER a Meta ad (ad_archive_id) OR an RSOC comp row (comp_row_id),
-- tagged by `source`. Global link availability is unchanged and still enforced by the
-- existing unique index on our_url, so a link handed to a Meta ad can never also go to
-- an RSOC row, and vice versa.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.link_assignments
  alter column ad_archive_id drop not null,
  add column if not exists comp_row_id integer,
  add column if not exists source text not null default 'meta';

-- Exactly one subject per assignment: a Meta ad XOR an RSOC comp row. Added via a
-- guarded block so re-running the migration is harmless (Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS). Existing rows (ad_archive_id set, comp_row_id null)
-- satisfy it, so validation passes without a backfill.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'link_assignments_one_subject'
  ) then
    alter table public.link_assignments
      add constraint link_assignments_one_subject
      check ((ad_archive_id is not null) <> (comp_row_id is not null));
  end if;
end $$;

-- The per-comp-row lookup the RSOC kit view and export do.
create index if not exists link_assignments_comp_idx
  on public.link_assignments (comp_row_id);
