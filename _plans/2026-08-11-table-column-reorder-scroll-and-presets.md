# Table column reorder, presets, and scroll controls

Date: 2026-08-11
Branch: `feat/table-column-reorder-scroll`
Worktree: `C:/Projects/adintel-table-columns-scroll` (off `origin/main` @ 6dcebb6)

## Goals

Two user-facing capabilities across the dashboard's tables:

1. **Scroll controls.** Horizontal (left/right) scroll affordances on both the top
   and bottom of every scrollable table, so the horizontal scrollbar is reachable
   without scrolling the whole page down. Plus on-hover "back to top" and
   "jump to bottom" arrows.
2. **Column organization.** Let users reorder columns by drag-and-drop (not just
   hide/show), save named presets, delete them, and set a default preset that
   loads automatically.

## Constraints / decisions (agreed with user)

- **Preset storage:** per account, in the database (syncs across devices), not
  localStorage. localStorage stays as a fast cache + migration source for the
  legacy `adintel.cols.*` visibility values.
- **Reorder rollout:** all four column-model tables at once (Fresh Finds, Review,
  Filtered, Rejected).
- **Scroll rollout:** every scrollable table, including the non-column-model ones
  (Control Room, Competitor, Trends, Admin).
- **DnD library:** `@dnd-kit/core` + `@dnd-kit/sortable` (chosen for keyboard/touch
  a11y and polish, over the codebase's existing native HTML5 DnD).
- **Delivery:** one worktree, one PR, phased commits (scroll / registry / presets).
- No new paid services. Postgres/Supabase already exist; dnd-kit is free OSS.

## Current architecture (as found)

- Next.js 15 (App Router) + React 19. No table library. Inline styles via `s()`
  (`web/lib/style.js`). Accent `A = #E8A33D`, mono font `MONO`.
- Tables are flexbox `div` layouts, NOT `<table>`. Each column is hand-coded twice
  (header row + body row) in fixed source order, widths baked per column.
- Four tables share the column model via `useColumnPrefs` + `ColumnPicker`
  (`web/components/ColumnPicker.jsx`) and `columnVisibility`/`columnPrefValue`
  (`web/lib/ui.js`). Visibility persists to localStorage as `{ h: [hidden keys] }`
  under `adintel.cols.{freshfinds,review,filtered,rejected}`.
  - Fresh Finds: `FreshFinds` in `web/components/Dashboard.jsx` (`FRESH_COLS`).
  - Review/Filtered/Rejected: their own `*View.jsx` (`REVIEW_COLS`, etc.).
- Horizontal scroll: each table body sits in `overflow-x:auto` with a computed
  `min-width: tableMinW`. Vertical scroll is the WINDOW (paging calls
  `window.scrollTo(0,0)`), not the container.
- Auth: `getCurrentUser()` (`web/lib/auth.js`) returns a uuid-keyed user from a
  DB-backed session cookie. Server actions live in `web/app/actions.js`
  (`'use server'`), use `getSql()` (`web/lib/db.js`), and gate on
  `getCurrentUser()` / `requireCapability()`.
- Migrations: `supabase/migrations/NNNN_*.sql`, plain SQL, `public.` schema,
  `create table if not exists`, uuid PKs `gen_random_uuid()`.

## Approach

### Phase 1 — Scroll controls (`web/components/TableScroll.jsx`)

Reusable wrapper around a table's horizontal scroll region:

- Two synced horizontal scrollbar strips driving one shared `scrollLeft`: one
  `position:sticky; top:0`, one `position:sticky; bottom:0`, so a horizontal bar is
  always on screen at both edges. Native container scrollbar hidden to avoid a third.
- Hover left/right chevron buttons on the bars, nudging `scrollLeft` by a page step.
- Floating hover control (bottom-right): "back to top" (`window.scrollTo({top:0})`)
  and "jump to bottom" (scroll to table end). Appears after the user scrolls.
- Widths measured with `ResizeObserver`; two-way scroll sync guarded by a flag to
  avoid feedback loops. The pure sync math is factored out and unit-tested.

Dropped into all four column-model tables and the four others.

### Phase 2 — Data-driven column registry (no behavior change)

For each of the four tables, convert `_COLS` into a registry of
`{ key, label, w, align?, header(ctx), render(ad, ctx) }`. Replace the long
`{cols.has('x') && <div>…}` sequences (header + body) with one `.map` over the
ordered, visible columns. Structural columns (checkbox, thumbnail, headline,
decision buttons, and Fresh Finds' feed-derived Slug/Query) stay pinned and are NOT
reorderable. This phase preserves current output exactly; existing tests plus new
registry tests guard it.

### Phase 3 — Reorder UI + per-account presets

- **Migration** `0014_column_presets.sql`:
  `column_presets(id uuid pk, user_id uuid fk users on delete cascade, table_key
  text, name text, layout jsonb, is_default bool, created_at, updated_at)`,
  unique `(user_id, table_key, lower(name))`, partial unique index enforcing one
  default per `(user_id, table_key)`.
  `layout = { order: [keys...], hidden: [keys...] }`.
- **Server actions** `web/app/preset-actions.js`: `listPresets`, `savePreset`,
  `renamePreset`, `deletePreset`, `setDefaultPreset`. All scoped to
  `getCurrentUser()` by `user_id`; validate `table_key` against a known set and keys
  against the server-side catalog; cap name length and presets-per-(user,table).
- **Hook** `useColumnLayout(tableKey, defs)` replacing `useColumnPrefs`: exposes
  `order`, `visible`, reorder/toggle handlers, and preset state. Loads the account
  default after mount (avoids hydration mismatch), migrates the legacy localStorage
  value once, and caches the active layout locally for instant paint.
- **Columns manager popover** (evolves `ColumnPicker`): dnd-kit sortable list with a
  drag handle + visibility checkbox + label per column, live table preview while
  dragging, and preset controls (switch active, save-as, set-default, delete, reset
  to catalog order).

## Alternatives considered and rejected

- **CSS `order` hack instead of the registry refactor.** Reorders flex children
  visually without restructuring JSX, but produces spacing artifacts (per-column
  left/right padding is inconsistent), leaves DOM/tab order wrong for a11y, and rots
  fast. Rejected for violating the clean-architecture bar (rule 2/20).
- **localStorage presets.** Simplest, matches the current visibility store, but a
  "save presets + default" feature that doesn't follow the account is a weaker
  product. User chose DB. Rejected.
- **Native HTML5 DnD.** Matches PipelineView and adds zero deps, but weaker
  touch/keyboard support. User chose dnd-kit for polish. Rejected.

## Security (rule 13)

- Preset queries are always filtered by the authenticated `user_id`; no client-
  supplied user id is ever trusted.
- `table_key` validated against `{freshfinds, review, filtered, rejected}`; unknown
  fails closed.
- Column keys in `layout` intersected with the server-side catalog for that table;
  unknown keys dropped. `order` de-duped; `hidden` must be a subset of the catalog.
- Caps: name length (<= 60), presets per (user, table) (<= 20), layout array sizes
  bounded by the catalog length. Prevents jsonb bloat / abuse.
- No PII or secrets stored or logged. Reads are any signed-in user; writes require a
  session (no elevated capability needed — presets are personal preference).

## Observability (rule 14)

Namespaced, value-carrying logs:
- `[columns layout]` — load/apply/migrate, with `{ tableKey, order, hidden }`.
- `[preset save|delete|default]` — with `{ tableKey, name, id }`.
- `[table scroll]` — mount/measure, with `{ scrollWidth, clientWidth }` at debug
  moments only (not per scroll frame).

## Settings (rule 15)

The preset system IS the settings surface for tables. The default preset is the key
persistent choice. Column order, visibility, and named presets are all user-
controlled per table. Nothing new is hardcoded that a user can't override.

## Testing (rule 18)

- `web/tests/` (`node --test`): registry integrity (every catalog key has a render
  fn; widths present), layout merge/validation (order+hidden reconcile against a
  changed catalog, legacy migration), server-side key/table validation helpers, and
  the pure scrollbar-sync math.
- Manual QA: DnD reorder + preview, save/switch/default/delete presets across all
  four tables, scroll bars top+bottom + arrows on all eight tables, hydration (no
  flash/mismatch), and the legacy-localStorage migration path.

## Deploy (rule 19)

- Work stays on `feat/table-column-reorder-scroll` in its own worktree. One PR into
  `main`. No direct pushes to `main`, no manual promotion.
- The migration is applied through the project's normal Supabase migration flow by
  the user; Claude does not run it against any database. The app degrades gracefully
  if the table is absent (presets simply unavailable; visibility/order still work
  from the local cache) so a deploy-before-migrate window is safe.

## Open questions

- Should the default preset also be applied server-side (zero flash) later, or is
  after-mount application acceptable for v1? (Plan: after-mount for v1.)
- Do we want a shared, org-wide "team default" preset in a later pass? Out of scope
  now.
