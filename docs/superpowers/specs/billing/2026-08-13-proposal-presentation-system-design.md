# Proposal Presentation System — Design (Spec A)

**Date:** 2026-08-13
**Status:** Approved decisions baked in; advisor quorum ran (codex gpt-5.6-sol
xhigh, read-only, 2026-08-13) — its confirmed findings are incorporated
throughout (migration sequence, table validation caps, `{y, didBreak}` break
signaling, classic-as-legacy-bindings, send-time theme snapshot, Dockerfile
assets, invoices descoped, MCP tool contract). Awaiting Todd's spec review
**Depends on:** nothing (Spec B depends on this)
**Companion:** `2026-08-13-selectable-pricing-tiers-design.md` (Spec B, sketch)
**Origin:** `2026-08-13-proposal-presentation-handoff.md` — recreating a law-firm
client proposal PDF natively exposed the gaps this spec closes.
**Prior art (do not re-litigate):** `2026-06-23-quote-invoice-presentation-refresh.md`
— establishes one premium visual language, partner accent as the only brand
variable, spec-as-source-of-truth instead of shared components.

## Goal and acceptance target

A Breeze partner can produce a proposal that matches the quality of the reference
document (`~/Desktop/<client>-Managed-Security-Proposal.pdf`, 6 pages,
Barlow Condensed + DM Sans, US Letter) using only native blocks — no images of
tables. **Acceptance: Q-2026-0016 rebuilt with zero image-of-content blocks is
visually competitive with the reference PDF in all three renderers.**

## Decisions (made by Todd, 2026-08-13)

| # | Decision |
|---|---|
| 1 | Per-partner theming — OliveTech's look becomes a configured theme, not a hard-code |
| 2 | New primitives: **table** and **callout**. Pricing tiers → Spec B. **Two-column: deferred** (revisit trigger: a partner asks for side-by-side content the tiers block can't express) |
| 3 | Curated theme presets + existing accent. No per-element overrides, no font uploads |
| 4 | Table cells hold **inline runs only** — no nested lists/paragraphs. Extensible later by widening what a cell run may hold; that is additive, not a redesign |
| 5 | Ship **two themes**: `classic` = today's rendering exactly, per surface (see below — zero visual change on deploy) and `condensed` = the new designed theme (Barlow Condensed + DM Sans). A third theme later is a code+assets addition with no DB migration — cheap, but not literally "just data" |
| 6 | Page size: new column defaults `'letter'`, **existing partners backfilled to `'a4'`** in the same migration — no shipped document changes shape on deploy |

## Constraints discovered in code (verified 2026-08-13)

- **Every content primitive exists in five agreeing places:** the sanitizer gate
  (`apps/api/src/services/richTextSanitize.ts` for HTML;
  `packages/shared/src/validators/quotes.ts` Zod shapes for structured content) →
  `richTextPdf.ts` / `quotePdf.ts` → web `QuoteDocument.tsx` → portal
  `quoteBlocks.tsx`, plus the `QuoteEditor.tsx` authoring UI and tests for each.
- **Block union:** `packages/shared/src/validators/quotes.ts:19`
  `quoteBlockTypeSchema = z.enum(['heading','rich_text','image','line_items','contract'])`,
  content shapes at `:26-44`, discriminated union `:46-52`. The web mirrors this
  by hand in `apps/web/src/components/billing/quotes/quoteTypes.ts:22`, guarded by
  `quoteTypes.parity.test.ts:35-36`. The DB has a pg enum (`quote_blocks.block_type`,
  `apps/api/src/db/schema/quotes.ts:121`) — **a new block type needs an enum-value
  migration.**
- **Renderer dispatch is a flat `if/else` chain with no default branch** in all
  three renderers (`quotePdf.ts:844-920` and the two TSX files). Unknown block
  types render as *nothing, silently*.
- **Pagination:** `quotePdf.ts:241-248` `ensureSpace(doc, y, needed)` is the
  main page-break helper; `richTextPdf.ts` receives it as the `ensureRoom`
  callback (`RenderRichTextOpts`, `richTextPdf.ts:290-297`) and never invents
  its own pagination. It is *not* the only authority today — `renderLineTable`
  owns its own row-space/header-repeat logic (`quotePdf.ts:339-356`). New
  renderers follow the callback pattern (strengthened below); `renderLineTable`
  is left alone.
- **Fonts today:** PDF uses pdfkit built-in Helvetica only (no `registerFont`
  anywhere in `apps/api/src`). Web self-hosts Plus Jakarta Sans via `@fontsource`
  (`apps/web/src/styles/globals.css:15-22`). **Portal ships no webfont at all** —
  system-UI stack. So web and portal already render the same quote in different
  typefaces; this spec fixes that as a side effect.
- **CSP:** `font-src 'self'` already present in all three CSP definitions
  (`apps/web/src/middleware.ts:37`, `apps/portal/src/lib/csp.ts:49`,
  `apps/api/src/middleware/security.ts:196`). Self-hosted fonts need **no CSP
  change**. (The drift guards don't currently assert `font-src`; nothing to do.)
- **Branding resolution:** `apps/api/src/services/quoteBranding.ts` is the single
  source for partner name / logo / accent / footer / currency. Two constraints it
  documents at `:6-11`:
  1. It must only be called from **partner- or system-scoped** DB contexts —
     `partners` is a partner-axis RLS table and an org-scoped read silently
     returns zero rows (branding degrades to the `'Proposal'` fallback).
     Portal routes read `partners` themselves under `withSystemDbAccessContext`.
  2. `logoUrl` and `primaryColor` come from **`portal_branding`, which is
     org-scoped** (`org_id NOT NULL UNIQUE`, `apps/api/src/db/schema/portal.ts:14`)
     — i.e. today's proposal accent is the *customer's* portal brand, not the
     MSP's. See "Named gap" below.
- **`partners` is in none of the four tenant registration lists** (cascade,
  export policy, device lists) — new columns there carry no registration tax.
- **Reference fonts are OFL-licensed** (Barlow Condensed, DM Sans — SIL Open Font
  License, embedding permitted). No licensing obstacle.
- **`quoteContentHash`** (`quoteContentHash.ts:42`) hashes blocks at accept time.
  New block types flow through it naturally (it hashes content JSON); no schema
  change to the hash. Theme/page-size are **not** hash inputs and must stay out —
  they are presentation, and a partner switching theme must not invalidate
  outstanding acceptance links.

### Named gap (explicitly out of scope): MSP-brand logo/accent

The right long-term shape is a partner-owned document brand (logo + accent on
`partners`), with `portal_branding` reserved for the customer portal. This spec
does **not** build it: in practice the MSP configures each customer's
`portal_branding` anyway, so proposals already carry MSP-chosen colors, and the
reference PDF is reproducible without it. **Deferral trigger:** a partner
complains that proposals for different customers show different brands, or wants
a proposal logo distinct from the portal logo. When that lands, add
`document_logo_url` / `document_accent_color` to `partners` and change only
`resolveQuoteBranding`'s precedence — no renderer changes.

## Design

### 1. Theme storage and resolution

Two columns on `partners` (`apps/api/src/db/schema/orgs.ts`):

```
document_theme      varchar(32)  NOT NULL DEFAULT 'classic'   -- 'classic' | 'condensed'
document_page_size  varchar(8)   NOT NULL DEFAULT 'letter'    -- 'letter' | 'a4'
```

Plain varchars with app-layer validation (Zod enum), not pg enums — adding a
theme must be a data change, not a migration. Not `partners.settings` jsonb:
these are read on every PDF render and deserve typed columns with defaults; the
`timezone` column (`orgs.ts:32`) is the precedent for first-class over jsonb.

**Migration** (idempotent, per repo rules) — the naturally re-runnable sequence,
no column-absence guard needed:
1. `ADD COLUMN IF NOT EXISTS document_page_size varchar(8)` — nullable, **no default**
2. `UPDATE partners SET document_page_size = 'a4' WHERE document_page_size IS NULL`
3. `ALTER COLUMN ... SET DEFAULT 'letter'`, then `SET NOT NULL`

Re-application can never flip a partner who has since chosen Letter (step 2 only
touches NULLs, and none remain). `document_theme` needs no backfill: `'classic'`
*is* today's rendering. Partner-only ownership is a deliberate carve-out from the
partner-wide-first default (the theme is the MSP's identity, not per-customer
config) — this paragraph is the PR justification, same class as `backup_configs`.

**Settings plumbing (easy to miss):** the new fields must be added to
`partnerPublicColumns()` (`apps/api/src/routes/orgs.ts:337`) or the settings page
can't reload them; to `partnerBillingSettingsSchema`
(`packages/shared/src/validators/invoices.ts:86`); and to the explicit update +
return mappings in `updatePartnerBillingSettings`
(`apps/api/src/services/invoiceService.ts:449`).

**Resolution:** `resolveQuoteBranding` gains `theme: DocumentTheme` and
`pageSize: 'letter' | 'a4'`, read from the same `partners` query it already
makes (`quoteBranding.ts:47-51`) — zero extra queries. Unrecognized stored
values resolve to `classic` (forward compatibility). All renderers take theme
from `QuoteBranding` — no renderer reads `partners` directly.

**Theme does NOT automatically ride along.** `resolveQuoteBranding` must only
run partner/system-scoped (`quoteBranding.ts:6-11`), and several delivery paths
build branding **manually** rather than through it. Each needs an explicit
update (or a scope-safe shared resolver they all adopt):
- portal HTML/PDF — `apps/api/src/routes/portal/quotes.ts:56`
- public (unauthenticated) quote view — `apps/api/src/routes/quotesPublic.ts:62`
- send-time emailed PDF — `apps/api/src/services/quoteLifecycle.ts:315`

The implementation plan must enumerate every `renderQuotePdf` caller and every
HTML quote view and prove each receives theme + pageSize.

**Snapshot at send.** Sent-quote PDFs are not stored artifacts: send generates
an in-memory email attachment (`quoteLifecycle.ts:345`) and portal downloads
re-render on demand (`portal/quotes.ts:76`) — the schema's PDF reference/hash
columns have no production write path (`schema/quotes.ts:73`). So a partner
switching theme would silently restyle every already-sent quote the customer
re-opens. Fix: **freeze `theme` + `pageSize` onto the quote at send time**
(same pattern as the existing frozen `sellerSnapshot`); pre-send renders follow
the partner's live setting, sent quotes render from their snapshot. Persisting
whole PDFs stays out of scope.

**Settings UI:** theme + page-size selectors on the existing partner billing
settings page (where invoice footer/prefix live). Two dropdowns; live preview is
out of scope (the quote detail's PDF download is the preview).

**Invoices: OUT of scope.** `invoicePdf.ts` has the same A4/Helvetica
hard-codes, but its header contract promises HTML/PDF synchronization
(`invoicePdf.ts:1`) — theming only the PDF breaks it — and issued invoices read
live branding before persisting (`invoicePdf.ts:373,398`), so they'd need their
own snapshot-at-issue semantics. That's a separate small design, deferred;
quotes only for this spec.

### 2. Theme definition

A theme is a static TypeScript record — no DB storage of theme *contents*:

```ts
// apps/api/src/services/documentThemes.ts (+ mirrored minimal maps in web/portal)
type DocumentTheme = {
  id: 'classic' | 'condensed';
  fonts: {
    heading: { family: string; pdf: { regular: string; bold: string } }; // pdf: registered font name or built-in
    body:    { family: string; pdf: { regular: string; bold: string; italic: string; boldItalic: string } };
  };
  headingStyle: { transform?: 'uppercase'; letterSpacing?: number; weight: number };
  // classic: Helvetica built-ins, no transforms — byte-identical to today's output
};
```

**`classic` is defined as renderer-specific legacy bindings, not one shared
typography.** Today's three surfaces already disagree (PDF: Helvetica; web:
Plus Jakarta Sans; portal: system-UI stack, `documentShell.tsx:23` sets no
font) — one `classic` family cannot both preserve all three current appearances
and unify them. So `classic` per surface = exactly what that surface does today,
and **`condensed` is where cross-surface parity is established** (same families
in all three renderers). The `classic` PDF lookup must produce the current
output (regression target below); `classic` web/portal are no-ops.

The regression target for `classic` PDFs is **unchanged content-stream
operations plus a rasterized visual comparison** (`pdftoppm` + pixel diff on
fixtures) — not literal byte equality, which pdfkit metadata/object ordering
doesn't guarantee.

### 3. Fonts

- **API/PDF:** TTFs vendored at `apps/api/assets/fonts/` (Barlow Condensed
  SemiBold; DM Sans Regular/Medium/Bold/Italic/BoldItalic; OFL license files
  alongside). `doc.registerFont` at document start only when the resolved theme
  needs them (pdfkit subsets embedded fonts automatically). **Neither production
  Dockerfile currently copies `apps/api/assets`** (`apps/api/Dockerfile:78`,
  `docker/Dockerfile.api:56`) — both need an explicit `COPY` and the loader must
  resolve a stable runtime path (not `import.meta`-relative guesswork). Font
  registration fails loudly (thrown, not warned) so a missing asset is a boot/
  test failure, not a silent Helvetica fallback.
- **Web + portal:** woff2 via `@fontsource` packages (matching the existing
  Plus Jakarta Sans pattern in web). `@font-face` declarations are registered
  unconditionally with `font-display: swap`; browsers fetch a face only when a
  matched element uses it, so quotes resolving to `classic` download nothing.
  The document root carries `data-doc-theme="condensed|classic"` and theme CSS
  selects on it.
  Portal gains its first webfont; the quote document element gets an explicit
  `font-family` from the theme map so the surrounding portal chrome keeps the
  system stack.
- App UI chrome is untouched — themes style *documents*, not the app.

### 4. New block types: `table` and `callout`

Added to: shared Zod enum + content shapes + discriminated union
(`validators/quotes.ts`), DB pg enum (migration: `ALTER TYPE ... ADD VALUE IF NOT
EXISTS` — note pg cannot run this inside the same transaction as first use; keep
the enum migration file separate from any migration that inserts such rows), web
`quoteTypes.ts` + parity test, both sanitize functions, all three renderers,
editor.

```ts
// content shapes (Zod, packages/shared/src/validators/quotes.ts)
table: {
  columns: [{ label: string /* inline-HTML subset, max 200 chars */,
              align?: 'left'|'center'|'right',
              weight?: number /* int 1-10, default 1 */ }],   // 1-8 columns
  rows:    [{ cells: string[] /* inline-HTML subset, max 2000 chars each */ }], // 1-100 rows
  caption?: string /* max 300 */, zebra?: boolean, headerStyle?: 'accent' | 'plain',
}
callout: {
  variant: 'info' | 'accent' | 'warn', title?: string /* plain text, max 200 */,
  html: string /* existing 11-tag subset, max 50_000 (matches rich_text) */,
}
```

Validation rules (all enforced in the Zod shape, not at render time):
- **Exact shape: `cells.length === columns.length`** (`superRefine`) — no
  render-time padding/truncation, which would make displayed content diverge
  from persisted/hashed content.
- Every free-text field capped (limits above; rich_text's existing 50k cap is
  the precedent) — 8 columns × 100 rows of unbounded strings is otherwise a
  memory/PDF-layout DoS surface.
- `weight` is a bounded positive integer — no zero/negative/`Infinity`.

**Sanitization.** Structured block content bypasses `richTextSanitize` today
*by design* (`quoteService.ts:94-99` early-returns non-`rich_text`), so both new
types are added explicitly to `sanitizeBlockContentForWrite` **and**
`sanitizeQuoteBlocksForRead`:
- `callout.html` → the existing 11-tag sanitizer, unchanged.
- `table` cells and column labels → a new **inline-only sanitizer profile**
  (`strong, em, u, a, br` + the same href/rel/target rules) exported from
  `richTextSanitize.ts` beside the existing one. Cells are the enforcement point
  for the inline-only decision: block-level tags are stripped at write time
  (and, per the fix for #3520 if it lands first, rejected/warned rather than
  silently dropped).

Read-path hardening: `sanitizeQuoteBlocksForRead` currently only handles
`rich_text` and otherwise trusts stored JSONB (`quoteService.ts:80-90`). Extend
it to `safeParse` + canonicalize the new structured types on read, so a
legacy/direct-write row can't reach a renderer with an out-of-contract shape.
(Known pre-existing adjacent gap, out of scope here: acceptance hashes raw DB
blocks while customer routes display read-sanitized blocks — noted for Spec B.)

**Rendering — web + portal:** straightforward JSX per surface, matching the
existing spec-as-source-of-truth duplication (no shared components). Table =
semantic `<table>` with theme typography, zebra striping, accent header row.
Callout = tinted rounded rect (accent-derived tints), optional title, rich text
body. **Both TSX renderers and the PDF chain gain an explicit final `else`: an
unrecognized block type renders a visible "unsupported block" placeholder in
the staff web editor/preview, and renders nothing (current behavior) in
portal/PDF** — authors see the problem; customers never see debris.

**Rendering — PDF (the hard part).** New `tablePdf.ts` beside `richTextPdf.ts`,
same architectural contract:

- `parseTable(content)` → validated model; `measureTable(doc, model, width,
  theme)` → per-row heights. **Measurement must match drawing font-for-font:**
  measure each inline run at the font it will actually draw in (bold/italic
  switches included), not a flattened single-font approximation —
  `richTextPdf.ts:333` measures flattened text in one font while `:354` draws
  per-run fonts, a known drift source we must not import into tables, where a
  too-short row height visibly clips. `measureTable` is draw-free but touches
  pdfkit font state; it must save/restore the doc's font so it stays
  observably pure. Both functions unit-testable without producing PDF bytes.
- `renderTableIntoPdf` receives a caller-owned page-break closure like
  `renderRichTextIntoPdf` does (`richTextPdf.ts:290-297`), but the callback
  contract is **`ensureRoom(needed) → { y, didBreak }`** — the table must know
  a break happened to repeat its header row; inferring breaks from `doc.y`
  movement is too fragile for explicit-coordinate drawing. (Precedent: the
  existing `renderLineTable` already owns its own row-space/header-repeat logic
  at `quotePdf.ts:339-356` — so "one page-break authority" is aspiration, not
  current fact; new code follows the closure pattern, and `renderLineTable` is
  left as-is.) The rich_text call sites keep the number-returning closure;
  table/callout sites get the richer one.
- **Rows never split.** A single row taller than the usable page height (page
  height − margins − header row) degrades that row to stacked `label: value`
  **rich-text paragraphs rendered through `renderRichTextIntoPdf`**, which
  already paginates paragraph-by-paragraph — so the degraded form may span
  pages and can never itself clip. Never an infinite ensure-room loop; testable
  with a fixture row of absurd length.
- Cell inline marks reuse `richTextPdf`'s existing run parser (`parseRichText`
  restricted to inline runs) — **no second rich-text parser**.
- Column widths: relative `weight` over available width; minimum column width
  floor (~40pt); text wraps within cells.

Callout in PDF requires one new capability: a **`measureRichText` API** in
`richTextPdf.ts` (per-run-font heights, no drawing — does not exist today), so
the tinted background rect's exact height is known before drawing. Then:
`ensureRoom(total)`; a callout **does not split across pages** (degrade: if
taller than a full page, render as plain rich text without the tinted chrome —
rich-text flow paginates, same never-clip principle); tinted rounded rect +
`renderRichTextIntoPdf`.

**Editor:** two new entries in the add-block picker. Table editor = compact grid
UI (add/remove row/column, per-column align, zebra/header toggles) with
inline-mark editing per cell. **The existing `RichTextEditor` cannot be "configured
inline-only"** — it is block-oriented (headings/paragraphs/lists,
`apps/web/src/components/common/RichTextEditor.tsx:43,149`); cells need a small
separate inline-schema TipTap component (marks + link only, single paragraph,
Enter disabled). Callout = variant picker + title + existing rich-text editor. Follow the existing add-block
body pattern (`QuoteEditor.tsx:1155-1236`) and the one-concern-per-test-file
house style.

### 5. What this spec does NOT include

- **Two-column block** — deferred (trigger above, Decisions #2).
- **Selectable pricing tiers** — Spec B; carries the money/public-endpoint risk.
- **Per-quote theme override** — deferred; revisit if a partner asks to style
  one proposal differently.
- **MSP-brand logo/accent on `partners`** — named gap above.
- **Custom font uploads, per-element style overrides, additional themes** —
  decisions #3/#5.
- **h1/h2 or `<table>`/`<blockquote>` in the rich-text subset** — the table
  block replaces the need; the 11-tag subset is unchanged.

## Testing

- **Pure model tests:** `tablePdf.test.ts` — `parseTable`/`measureTable` with no
  PDF bytes, mirroring `richTextPdf.test.ts`'s AST-first structure.
- **PDF byte tests:** extend the `quotePdf.test.ts` pattern (pdf-lib + zlib
  content-stream inflation; hand-built valid PNG fixtures — heed its `:7-11`
  warning about fixtures that silently hit catch-branches). Assert: page size
  letter vs a4 per branding; `condensed` embeds Barlow/DM Sans (font dictionary)
  while `classic` output is regression-held via **unchanged content-stream
  operations + rasterized pixel comparison on fixtures** (not byte equality —
  pdfkit metadata/ordering isn't stable); table row/page counts across a page
  break; header-row repetition; the oversized-row degrade path; callout render +
  degrade.
- **Branding:** extend `quoteBranding.test.ts` — theme/pageSize resolution,
  unknown-value fallback to `classic`.
- **Sanitizer:** inline-profile tests beside the existing suite — block-level
  tags stripped from cells, XSS cases (href schemes, `javascript:` pre-filter)
  reused against the inline profile.
- **Web/portal:** `QuoteDocument` + `quoteBlocks` render tests for both new
  blocks; parity test updated (it fails the build until `quoteTypes.ts` is
  updated — good); editor tests per new-block precedent
  (`QuoteEditor.contractblock.test.tsx` is the closest model).
- **Regression:** the three filed bugs get regression tests where their fixes
  land (#3519 editor latch, #3520 sanitizer feedback, #3521 MCP array marker) —
  tracked on those issues, not gated on this spec.
- **Migration:** covered by `autoMigrate.test.ts` conventions; enum-value
  migration in its own file (same-day `-a-`/`-b-` infix if needed).

## Rollout / compatibility

- Ship order within one release: migration (columns + enum) → API renderers +
  branding → web/portal renderers + editor. Hosted droplets deploy all services
  together, so skew is minutes; **self-hosted installs can skew longer, and an
  old portal silently drops unknown block types (`quoteBlocks.tsx:296`)** —
  readers before writers, i.e. don't add the new blocks to the editor picker in
  a release before the portal renderer ships. In practice: one release carries
  everything; the release notes flag the block additions for self-hosters.
- Deploy day: **zero visual change** for every existing partner (`classic` +
  backfilled `a4`). OliveTech flips to `condensed` + `letter` manually as the
  pilot.
- Sent quotes are pinned by the send-time theme/pageSize snapshot (§1); the
  send-time emailed PDF (`quoteLifecycle.ts:345`) is inherently fixed.
- **MCP needs explicit work:** `manage_quotes` hard-codes its allowed block
  types and content description (`apps/api/src/services/aiToolsQuotes.ts:275`)
  — shared validators alone don't update the tool contract. Add table/callout
  there in the same PR as the validators.

## Risks

| Risk | Mitigation |
|---|---|
| Table pagination edge cases (the classic tarpit) | Draw-free measure functions matched font-for-font to drawing, `{ y, didBreak }` break signaling, rows-never-split + paginating degrade path, fixture-driven page-count tests |
| Measurement/drawing font drift → clipped rows | Measure each run at its actual draw font; regression fixtures with heavy bold/italic cells |
| `classic` output shifts → every partner's documents change | Content-stream + raster regression on current fixtures before any theme code lands |
| Sent quotes restyle when a partner changes theme | Theme/pageSize frozen onto the quote at send (sellerSnapshot pattern) |
| Backfill migration re-applied flips a partner's chosen page size | NULL-guarded backfill sequence (add nullable → fill NULLs → set default → NOT NULL) |
| Font assets missing from production images | Explicit `COPY apps/api/assets` in **both** Dockerfiles; `registerFont` throws on missing file |
| Cell sanitizer too permissive (XSS via table) / oversized content DoS | Inline profile shares the hardened href/scheme rules + XSS corpus; hard Zod length/shape caps |
| pg enum `ADD VALUE` transactional restriction | Enum migration isolated in its own file (each migration file is its own transaction — `autoMigrate.ts:611`) |
| Self-hosted version skew: old portal drops new blocks silently | Readers-before-writers rule; release notes call it out |
