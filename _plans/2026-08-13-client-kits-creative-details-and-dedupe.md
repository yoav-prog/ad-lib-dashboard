# Client Kits: competitor creative details + unique-creative dedupe

Date: 2026-08-13
Branch: client-kits-creative-dedupe
Status: built this PR.

## Maya's feedback (from WhatsApp, on the Meta Ads source)

1. Select all / a part, not one by one - already covered by the shared SelectMenu caret
   (This page / First N / All matching); no code needed.
2. Add country, vertical, RPC to the competitor rows.
3. Show the competitor's description (body), not just the title - the creative is image +
   title + description.
4. UNIQUE: collapse creatives that appear several times and are byte-identical - dedupe
   "by identical creative only" (Yoav confirmed: not by country+vertical).

## What shipped

- **Meta view row**: now shows the competitor **description** (body_text) as a second line
  under the title (only when it differs), and a new **RPC** column beside Revenue. Country
  and vertical were already on the meta line.
- **Unique creatives toggle** (default ON) on the Meta view: collapses rows whose creative
  (image + title + body) is identical, keeping the highest-revenue instance (the list is
  revenue-sorted). Selection, assignment and export all operate on the collapsed set.
- **RSOC view**: a matching **Unique** toggle (default ON) that collapses identical
  competitor titles (RSOC rows have no image/body). It already showed vertical/geo/RPC.
- **Meta export**: added the **RPC** column (Body/Country/Vertical were already exported).
- Pure helpers `creativeKey(ad)` and `dedupeBy(rows, keyFn)` in lib/ui, unit-tested.

## Data limitation (flagged)

Image + title + description only exist for **Meta** ads. RSOC (`ref_comp_rows`) has only a
title, so its "unique" dedupes by title and it has no body/native image (the ~33% best-
effort thumbnail aside).

## Testing / deploy
- 203 unit tests green (creativeKey / dedupeBy / KIT-export-includes-RPC added); next build
  clean. No new env var, no migration. Additive; rollback = revert.
