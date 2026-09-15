# Proposal Presentation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-partner document themes (fonts + page size) and two new quote block primitives (table, callout) so a partner can reproduce the reference proposal PDF natively in all three renderers.

**Architecture:** Theme + page size live as two typed columns on `partners`, resolved through `resolveQuoteBranding` and frozen onto the quote at send. Blocks are structured JSON validated by shared Zod shapes; free-text fields pass a new inline-only sanitizer profile. PDF tables get a dedicated `tablePdf.ts` with draw-free measurement matched font-for-font to drawing and a caller-owned `{ y, didBreak }` page-break closure.

**Tech Stack:** Drizzle + hand-written SQL migrations, Zod 4, pdfkit, sanitize-html, TipTap (web editor), React (web + portal renderers), Vitest, pdf-lib + pdftoppm for PDF assertions.

**Spec:** `docs/superpowers/specs/billing/2026-08-13-proposal-presentation-system-design.md` — read it first; every requirement below traces to it.

## Global Constraints

- Migrations: idempotent, `YYYY-MM-DD-<slug>.sql` naming, same-day ordering via `-a-`/`-b-` infix, **no inner BEGIN/COMMIT**, never touch the closed `2026-08-06` block.
- pg enum `ADD VALUE` must live in its own migration file (each file = one transaction, `autoMigrate.ts:611`).
- Theme values: `'classic' | 'condensed'`; page sizes: `'letter' | 'a4'`. Unrecognized stored values resolve to `classic`/`a4` at read time.
- `classic` = today's rendering exactly, per surface. Regression target: unchanged content-stream ops + raster comparison, **not** byte equality.
- Invoices are OUT of scope. Two-column block is OUT of scope. Per-quote theme override is OUT of scope.
- Table cells/labels: inline HTML only (`strong, em, u, a, br`), caps per the Zod shapes in Task 2. `cells.length === columns.length` exactly.
- Rows never split across pages; degrade path renders through `renderRichTextIntoPdf` (which paginates) and may span pages.
- All new free-text block content passes through `sanitizeBlockContentForWrite` AND `sanitizeQuoteBlocksForRead`.
- No renderer reads `partners` directly; theme arrives via branding/snapshot.
- Run `pnpm db:check-drift` after any schema change. Test commands run from repo root unless noted.

## PR slicing

One plan file, **four sequential PRs into main** — never a stacked chain (stacked PRs based on sibling branches get NO CI on this repo). Each PR is independently shippable and classic-invisible until the last:

| PR | Tasks | Ships | Safe because |
|---|---|---|---|
| 1 | 1-5 | migrations + export-policy registration, Zod shapes, sanitizer, theme registry + fonts + Dockerfiles, branding + send snapshot | No renderer consumes themes yet; new block types not creatable from any UI |
| 2 | 6-9 | PDF: theme/page size, measureRichText, tablePdf, callout | Classic regression harness guards zero visual change; blocks still not authorable |
| 3 | 10-13 | web + portal renderers, document fonts/DTO, editor | Feature becomes visible/authorable — readers and writers land together |
| 4 | 14-15 | settings UI, MCP contract, export-policy registration, sweep | Partner-facing toggle last, after everything renders |

Merge each before branching the next. Task 16 (acceptance verification) runs after PR 4.

---

### Task 1: Migrations + Drizzle schema (partner theme columns, quote presentation snapshot, block enum values)

**Files:**
- Create: `apps/api/migrations/2026-08-14-a-partner-document-theme.sql`
- Create: `apps/api/migrations/2026-08-14-b-quote-block-types-table-callout.sql`
- Modify: `apps/api/src/db/schema/orgs.ts` (partners table, after `invoiceFooter`)
- Modify: `apps/api/src/db/schema/quotes.ts` (quotes table + `quoteBlockTypeEnum`)
- Test: existing `apps/api/src/db/autoMigrate.test.ts` (naming/ordering) + `pnpm db:check-drift`

**Interfaces:**
- Produces: `partners.documentTheme: varchar('document_theme', { length: 32 })`, `partners.documentPageSize: varchar('document_page_size', { length: 8 })`, `quotes.presentationSnapshot: jsonb('presentation_snapshot')` (shape `{ theme: string, pageSize: string }`, null until sent), pg enum `quote_block_type` gains `'table'`, `'callout'`.

- [ ] **Step 1: Write migration `2026-08-14-a-partner-document-theme.sql`**

```sql
-- Partner document presentation: theme + page size (Spec A §1).
-- NULL-guarded sequence so re-application can never flip a partner's choice:
-- add nullable/no-default -> fill NULLs -> set default -> NOT NULL.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS document_theme varchar(32);
UPDATE partners SET document_theme = 'classic' WHERE document_theme IS NULL;
ALTER TABLE partners ALTER COLUMN document_theme SET DEFAULT 'classic';
ALTER TABLE partners ALTER COLUMN document_theme SET NOT NULL;

ALTER TABLE partners ADD COLUMN IF NOT EXISTS document_page_size varchar(8);
-- Existing partners keep A4 (today's output); new partners default to Letter.
UPDATE partners SET document_page_size = 'a4' WHERE document_page_size IS NULL;
ALTER TABLE partners ALTER COLUMN document_page_size SET DEFAULT 'letter';
ALTER TABLE partners ALTER COLUMN document_page_size SET NOT NULL;

-- Frozen presentation at send time ({ theme, pageSize }); NULL until sent.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS presentation_snapshot jsonb;
```

- [ ] **Step 2: Write migration `2026-08-14-b-quote-block-types-table-callout.sql`**

```sql
-- New quote block primitives (Spec A §4). Own file: ALTER TYPE ... ADD VALUE
-- cannot run in the same transaction as first use of the value, and each
-- migration file is one transaction (autoMigrate.ts).
ALTER TYPE quote_block_type ADD VALUE IF NOT EXISTS 'table';
ALTER TYPE quote_block_type ADD VALUE IF NOT EXISTS 'callout';
```

- [ ] **Step 3: Update Drizzle schema.** In `apps/api/src/db/schema/orgs.ts`, partners table (near `invoiceFooter`, ~line 73):

```ts
// Document presentation (Spec A): curated theme preset + page size for
// quote PDFs/HTML. Partner-owned deliberately (MSP identity, not per-org
// config) — see the spec's carve-out justification.
documentTheme: varchar('document_theme', { length: 32 }).notNull().default('classic'),
documentPageSize: varchar('document_page_size', { length: 8 }).notNull().default('letter'),
```

In `apps/api/src/db/schema/quotes.ts`: add `'table', 'callout'` to the `quoteBlockTypeEnum` pgEnum values array, and on the quotes table add:

```ts
// Frozen { theme, pageSize } captured at send so sent quotes never restyle
// when the partner later changes theme (sellerSnapshot pattern).
presentationSnapshot: jsonb('presentation_snapshot'),
```

- [ ] **Step 4: Export-policy registration (MUST ship in this PR).** `quotes` is in `CORE_ORG_CASCADE_DELETE_ORDER`, so its new column must be classified in `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`) **in the same PR as the migration** — the export-policy integration suite fails on any unclassified column. `presentation_snapshot` is jsonb → bucket **`excludedOpen`** (open-container rule; contents are benign but the rule is mechanical). `partners` is in none of the four registration lists — its two columns need nothing. Run the two export-policy integration suites locally (they need a real DB; see `vitest.integration.config.ts`).

- [ ] **Step 5: Verify.** Run: `pnpm --filter @breeze/api test -- autoMigrate` → PASS (naming, ordering, reference resolution). Run `pnpm db:migrate && pnpm db:migrate` (twice — idempotency) then `pnpm db:check-drift` → no drift.

- [ ] **Step 6: Commit** — `feat(api): partner document theme/page-size columns + table/callout block enum`

---

### Task 2: Shared Zod shapes + web type mirror

**Files:**
- Modify: `packages/shared/src/validators/quotes.ts` (block enum :19, content shapes :26-44, union :46-52)
- Modify: `apps/web/src/components/billing/quotes/quoteTypes.ts:22` (`QuoteBlockType` members)
- Test: `packages/shared/src/validators/quotes.test.ts` (extend), `apps/web/src/components/billing/quotes/quoteTypes.parity.test.ts` (goes green once both sides updated)

**Interfaces:**
- Produces (exact — every later task uses these):

```ts
export type QuoteTableColumn = { label: string; align?: 'left'|'center'|'right'; weight?: number };
export type QuoteTableContent = { columns: QuoteTableColumn[]; rows: { cells: string[] }[]; caption?: string; zebra?: boolean; headerStyle?: 'accent'|'plain' };
export type QuoteCalloutContent = { variant: 'info'|'accent'|'warn'; title?: string; html: string };
```

- [ ] **Step 1: Write failing validator tests** in `packages/shared/src/validators/quotes.test.ts`:

```ts
describe('table block content', () => {
  const valid = { blockType: 'table', content: { columns: [{ label: 'Item' }, { label: 'Better', align: 'center', weight: 2 }], rows: [{ cells: ['<strong>EDR</strong>', 'Included'] }] } };
  it('accepts a valid table', () => { expect(quoteBlockInputSchema.safeParse(valid).success).toBe(true); });
  it('rejects cells.length !== columns.length', () => {
    const bad = structuredClone(valid); bad.content.rows[0].cells.push('extra');
    expect(quoteBlockInputSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects >8 columns, >100 rows, oversized cells, bad weight', () => {
    const cols9 = { ...valid, content: { ...valid.content, columns: Array.from({ length: 9 }, () => ({ label: 'c' })), rows: [] } };
    expect(quoteBlockInputSchema.safeParse(cols9).success).toBe(false);
    const bigCell = structuredClone(valid); bigCell.content.rows[0].cells[0] = 'x'.repeat(2001);
    expect(quoteBlockInputSchema.safeParse(bigCell).success).toBe(false);
    for (const weight of [0, -1, 1.5, Infinity, 11]) {
      const w = structuredClone(valid); w.content.columns[0] = { label: 'c', weight };
      expect(quoteBlockInputSchema.safeParse(w).success).toBe(false);
    }
  });
});
describe('callout block content', () => {
  it('accepts valid, rejects bad variant and oversized html', () => {
    expect(quoteBlockInputSchema.safeParse({ blockType: 'callout', content: { variant: 'accent', title: 'Why this matters', html: '<p>Because.</p>' } }).success).toBe(true);
    expect(quoteBlockInputSchema.safeParse({ blockType: 'callout', content: { variant: 'loud', html: '<p>x</p>' } }).success).toBe(false);
    expect(quoteBlockInputSchema.safeParse({ blockType: 'callout', content: { variant: 'info', html: 'x'.repeat(50_001) } }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @breeze/shared test -- quotes` → FAIL (unknown blockType).

- [ ] **Step 3: Implement** in `packages/shared/src/validators/quotes.ts`:

```ts
export const quoteBlockTypeSchema = z.enum(['heading', 'rich_text', 'image', 'line_items', 'contract', 'table', 'callout']);

// Table: structured JSON, never HTML-parsed. Inline-HTML strings (cells/labels)
// are sanitized server-side with the inline-only profile (richTextSanitize).
// Hard caps: 8 cols x 100 rows x 2000 chars — unbounded content is a
// memory/PDF-layout DoS surface (spec §4).
const tableColumn = z.object({
  label: z.string().max(200),
  align: z.enum(['left', 'center', 'right']).optional(),
  weight: z.number().int().min(1).max(10).optional(),
});
const tableContent = z.object({
  columns: z.array(tableColumn).min(1).max(8),
  rows: z.array(z.object({ cells: z.array(z.string().max(2000)) })).min(1).max(100),
  caption: z.string().max(300).optional(),
  zebra: z.boolean().optional(),
  headerStyle: z.enum(['accent', 'plain']).optional(),
}).superRefine((val, ctx) => {
  // Exact shape — no render-time padding/truncation, which would let displayed
  // content diverge from persisted/hashed content.
  val.rows.forEach((row, i) => {
    if (row.cells.length !== val.columns.length) {
      ctx.addIssue({ code: 'custom', path: ['rows', i, 'cells'], message: `row has ${row.cells.length} cells, expected ${val.columns.length}` });
    }
  });
});
const calloutContent = z.object({
  variant: z.enum(['info', 'accent', 'warn']),
  title: z.string().max(200).optional(),
  html: z.string().max(50_000), // same cap as rich_text
});
```

Add both to `quoteBlockInputSchema`'s discriminated union:

```ts
  z.object({ blockType: z.literal('table'), content: tableContent }),
  z.object({ blockType: z.literal('callout'), content: calloutContent }),
```

Export inferred types: `export type QuoteTableContent = z.infer<typeof tableContent>; export type QuoteCalloutContent = z.infer<typeof calloutContent>; export type QuoteTableColumn = z.infer<typeof tableColumn>;`

- [ ] **Step 4:** Add `table: true, callout: true` (matching the existing member-map shape) to `quoteTypes.ts:22`'s `QuoteBlockType` source. Run `pnpm --filter @breeze/shared test -- quotes` and `pnpm --filter @breeze/web test -- quoteTypes.parity` → PASS.

- [ ] **Step 5: Commit** — `feat(shared,web): table + callout quote block schemas`

---

### Task 3: Inline sanitizer profile + write/read canonicalization

**Files:**
- Modify: `apps/api/src/services/richTextSanitize.ts`
- Modify: `apps/api/src/services/quoteService.ts:80-99` (`sanitizeQuoteBlocksForRead`, `sanitizeBlockContentForWrite`)
- Test: `apps/api/src/services/richTextSanitize.test.ts` (extend), `apps/api/src/services/quoteService.test.ts` (extend or create sibling)

**Interfaces:**
- Produces: `export function sanitizeInlineRichText(html: string): string` — allowlist `strong, em, u, a, br`; same href scheme rules, `javascript:` pre-filter, forced `rel`/`target` as the block profile.
- `sanitizeBlockContentForWrite` / `sanitizeQuoteBlocksForRead` handle `'table'` (every `columns[].label`, `rows[].cells[]`, plain-text-strip `caption`) and `'callout'` (`html` via existing 11-tag profile, `title` plain text).

- [ ] **Step 1: Write failing tests:**

```ts
describe('sanitizeInlineRichText', () => {
  it('keeps inline marks, strips block tags', () => {
    expect(sanitizeInlineRichText('<strong>a</strong> <em>b</em><br><u>c</u>')).toBe('<strong>a</strong> <em>b</em><br /><u>c</u>');
    expect(sanitizeInlineRichText('<p>x</p><ul><li>y</li></ul><table><tr><td>z</td></tr></table>')).toBe('xyz');
  });
  it('applies the hardened link rules', () => {
    expect(sanitizeInlineRichText('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript');
    expect(sanitizeInlineRichText('<a href="https://a.b">x</a>')).toContain('rel="noopener noreferrer"');
  });
});
describe('structured block sanitization', () => {
  it('sanitizes every table cell and label on write', () => {
    const out = sanitizeBlockContentForWrite({ blockType: 'table', content: { columns: [{ label: '<p>Item</p>' }], rows: [{ cells: ['<script>x</script><strong>ok</strong>'] }] } });
    expect(out.columns[0].label).toBe('Item');
    expect(out.rows[0].cells[0]).toBe('<strong>ok</strong>');
  });
  it('sanitizes callout html with the block profile and drops out-of-contract shapes on read', () => {
    const rows = sanitizeQuoteBlocksForRead([{ blockType: 'table', content: { rows: 'garbage' } } as never]);
    expect(rows[0].content).toEqual({ columns: [], rows: [] }); // canonical empty, never raw garbage
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @breeze/api test -- richTextSanitize quoteService` → FAIL.

- [ ] **Step 3: Implement.** In `richTextSanitize.ts` add beside the existing profile:

```ts
/** Inline-only marks for table cells / column labels: no block-level structure
 *  by design (Spec A decision #4). Shares the hardened link rules above. */
export const INLINE_RICH_TEXT_ALLOWED_TAGS = ['strong', 'em', 'u', 'a', 'br'] as const;
export function sanitizeInlineRichText(html: string): string {
  return sanitizeHtml(stripJavascriptHrefs(html), {
    allowedTags: [...INLINE_RICH_TEXT_ALLOWED_TAGS],
    allowedAttributes: { a: ['href', 'rel', 'target'] },
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: false,
    transformTags: { a: enforceSafeAnchor }, // reuse the existing transform
    disallowedTagsMode: 'discard',
  });
}
```

(Reuse the file's existing `javascript:` pre-filter and anchor transform — extract them into shared helpers if they're currently inlined, keeping the existing exports' behavior identical; existing tests must stay green.)

In `quoteService.ts`, extend both functions. Write side (`sanitizeBlockContentForWrite`):

```ts
if (input.blockType === 'table') {
  const c = input.content as QuoteTableContent;
  return {
    ...c,
    columns: c.columns.map((col) => ({ ...col, label: sanitizeInlineRichText(col.label) })),
    rows: c.rows.map((r) => ({ cells: r.cells.map(sanitizeInlineRichText) })),
    caption: c.caption ? sanitizePlainText(c.caption) : c.caption,
  };
}
if (input.blockType === 'callout') {
  const c = input.content as QuoteCalloutContent;
  return { ...c, html: sanitizeRichText(c.html), title: c.title ? sanitizePlainText(c.title) : c.title };
}
```

(`sanitizePlainText` = strip ALL tags via the sanitizer with an empty allowlist; add it if the file lacks one.) Read side (`sanitizeQuoteBlocksForRead`): for `table`/`callout`, run the stored JSONB through the Task 2 Zod shape with `safeParse`; on success apply the same per-field sanitization as write; on failure substitute the canonical empty content (`{ columns: [], rows: [] }` / `{ variant: 'info', html: '' }`) so a legacy/direct-write row can never reach a renderer out-of-contract (spec §4 read-path hardening).

- [ ] **Step 4: Run** the same tests → PASS. Also run the full existing sanitizer suite → PASS (no behavior change to the 11-tag profile).

- [ ] **Step 5: Commit** — `feat(api): inline sanitizer profile + structured block write/read sanitization`

---

### Task 4: Theme definitions + font assets + Dockerfiles (API)

**Files:**
- Create: `apps/api/src/services/documentThemes.ts`
- Create: `apps/api/assets/fonts/` — vendor TTFs: `BarlowCondensed-SemiBold.ttf`, `DMSans-Regular.ttf`, `DMSans-Bold.ttf`, `DMSans-Italic.ttf`, `DMSans-BoldItalic.ttf` + `OFL-BarlowCondensed.txt`, `OFL-DMSans.txt` (download from Google Fonts; verify OFL headers present)
- Modify: `apps/api/Dockerfile` (~:78) and `docker/Dockerfile.api` (~:56) — add `COPY` for `apps/api/assets`
- Test: `apps/api/src/services/documentThemes.test.ts`

**Interfaces:**
- Produces:

```ts
export type DocumentThemeId = 'classic' | 'condensed';
export type DocumentPageSize = 'letter' | 'a4';
export interface PdfThemeFonts {
  heading: { regular: string; bold: string };                       // pdfkit font names
  body: { regular: string; bold: string; italic: string; boldItalic: string };
}
export function resolveThemeId(raw: string | null | undefined): DocumentThemeId; // unknown -> 'classic'
export function resolvePageSize(raw: string | null | undefined): DocumentPageSize; // unknown -> 'a4'
export function pdfPageSize(size: DocumentPageSize): 'LETTER' | 'A4';
/** Registers the theme's font files on `doc` (no-op for classic) and returns
 *  the font-name table to draw with. THROWS if a font file is missing —
 *  a silent Helvetica fallback would ship wrong documents (spec §3). */
export function registerThemeFonts(doc: PDFKit.PDFDocument, theme: DocumentThemeId): PdfThemeFonts;
```

- [ ] **Step 1: Write failing tests:**

```ts
describe('documentThemes', () => {
  it('resolves unknown values to safe defaults', () => {
    expect(resolveThemeId('brutalist')).toBe('classic');
    expect(resolveThemeId(null)).toBe('classic');
    expect(resolvePageSize('tabloid')).toBe('a4');
    expect(pdfPageSize('letter')).toBe('LETTER');
  });
  it('classic returns pdfkit built-ins without touching doc', () => {
    const doc = { registerFont: vi.fn() } as unknown as PDFKit.PDFDocument;
    const fonts = registerThemeFonts(doc, 'classic');
    expect(fonts.body).toEqual({ regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique' });
    expect(doc.registerFont).not.toHaveBeenCalled();
  });
  it('condensed registers real font files on a real document', () => {
    const doc = new PDFDocument({ size: 'A4' });
    const fonts = registerThemeFonts(doc, 'condensed');
    expect(fonts.heading.regular).toBe('Doc-Heading');
    doc.font('Doc-Heading'); // throws if registration failed
    doc.end();
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement.** Font path resolution must survive tsc output layout AND Docker: resolve from a `FONT_DIR` computed as `path.resolve(process.cwd(), 'assets/fonts')` with a fallback to `path.resolve(__dirname, '../../assets/fonts')`; export `FONT_DIR` for the test to assert existence. `registerThemeFonts('condensed')` calls `doc.registerFont('Doc-Heading', <BarlowCondensed-SemiBold.ttf>)`, `'Doc-Body'`, `'Doc-Body-Bold'`, `'Doc-Body-Italic'`, `'Doc-Body-BoldItalic'` and returns those names; wrap `fs.accessSync` per file and throw `new Error(\`document theme font missing: ${file}\`)`.

- [ ] **Step 4:** Dockerfiles: in BOTH runner stages add (adjusting to each file's actual WORKDIR/copy conventions — read the surrounding lines first):

```dockerfile
COPY --from=build /app/apps/api/assets ./assets
```

Verify with `docker build -f apps/api/Dockerfile . -t breeze-api-fontcheck` and `docker run --rm breeze-api-fontcheck ls assets/fonts` listing the five TTFs.

- [ ] **Step 5: Run tests** → PASS. **Commit** — `feat(api): document theme registry + vendored OFL fonts + image assets`

---

### Task 5: Branding resolution + send-time snapshot + manual branding paths

**Files:**
- Modify: `apps/api/src/services/quoteBranding.ts`
- Modify: `apps/api/src/routes/portal/quotes.ts:56` (manual branding build), `apps/api/src/routes/quotesPublic.ts:62`, `apps/api/src/services/quoteLifecycle.ts:315` (send-time branding) and the send path (~:345-360) to stamp the snapshot
- Test: `apps/api/src/services/quoteBranding.test.ts` (extend); `apps/api/src/services/quoteLifecycle.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveThemeId`, `resolvePageSize` (Task 4).
- Produces: `QuoteBranding` gains `theme: DocumentThemeId; pageSize: DocumentPageSize;`. `QuoteBrandingSource` gains `presentationSnapshot: unknown;`. Resolution precedence (all paths): **quote.presentationSnapshot (if non-null) → partner columns → defaults**.

- [ ] **Step 1: Write failing tests** in `quoteBranding.test.ts` (follow the file's existing partner/brand mock pattern):

```ts
it('resolves theme/pageSize from partner columns for drafts', async () => {
  // partner row mocked with documentTheme: 'condensed', documentPageSize: 'letter'
  const b = await resolveQuoteBranding({ ...baseQuote, presentationSnapshot: null });
  expect(b.theme).toBe('condensed'); expect(b.pageSize).toBe('letter');
});
it('prefers the frozen snapshot for sent quotes', async () => {
  const b = await resolveQuoteBranding({ ...baseQuote, presentationSnapshot: { theme: 'classic', pageSize: 'a4' } });
  expect(b.theme).toBe('classic'); expect(b.pageSize).toBe('a4'); // even though partner says condensed/letter
});
it('falls back safely on unknown values', async () => {
  const b = await resolveQuoteBranding({ ...baseQuote, presentationSnapshot: { theme: 'x', pageSize: 'y' } });
  expect(b.theme).toBe('classic'); expect(b.pageSize).toBe('a4');
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `resolveQuoteBranding`:

```ts
const snap = quote.presentationSnapshot as { theme?: string; pageSize?: string } | null;
// ...in the returned object:
theme: resolveThemeId(snap?.theme ?? partner?.documentTheme),
pageSize: resolvePageSize(snap?.pageSize ?? partner?.documentPageSize),
```

Both route callers (`routes/quotes/quotes.ts:99,248`, `routes/invoices/invoices.ts:64`) pass the quote row's `presentationSnapshot` (invoices route: pass `null` — invoices are out of scope and must keep classic/a4 behavior; their `resolveQuoteBranding` call simply ignores the new fields).

- [ ] **Step 4: Manual branding paths.** Each of the three sites builds branding by hand under its own DB scope. At each, read the partner's two columns in the query it already makes (or add them to its select) and apply the same snapshot-first precedence with `resolveThemeId`/`resolvePageSize`. Read each site before editing; they must end up passing `theme` + `pageSize` into the same branding object they already hand to `renderQuotePdf`/HTML views:
  - `routes/portal/quotes.ts:56` (system-context partner read — portal HTML + PDF)
  - `routes/quotesPublic.ts:62` (public quote view)
  - `services/quoteLifecycle.ts:315` (send-time emailed PDF)

- [ ] **Step 5: Snapshot at send.** In `quoteLifecycle.ts`'s send transition (where `sellerSnapshot` is frozen / status flips to `sent`), stamp once — never overwrite an existing snapshot (re-send keeps the original presentation):

```ts
presentationSnapshot: existing.presentationSnapshot ?? { theme: resolveThemeId(partner.documentTheme), pageSize: resolvePageSize(partner.documentPageSize) },
```

Test: sending a quote persists the snapshot; re-sending does not change it; the send-time PDF render receives the snapshot values.

- [ ] **Step 6: Run** `pnpm --filter @breeze/api test -- quoteBranding quoteLifecycle` → PASS. **Commit** — `feat(api): theme/pageSize through branding + frozen at send`

---

### Task 6: classic-regression harness, then quotePdf theme + page size

**Files:**
- Modify: `apps/api/src/services/quotePdf.ts` (`:772` doc construction; `QuotePdfBranding` type at ~`:135`; heading/header draw calls)
- Modify: `apps/api/src/services/richTextPdf.ts` (`fontFor` :283, `RenderRichTextOpts`)
- Test: `apps/api/src/services/quotePdf.classicRegression.test.ts` (create), extend `quotePdf.test.ts`

**Interfaces:**
- Consumes: `registerThemeFonts`, `pdfPageSize`, branding `theme`/`pageSize` (Tasks 4-5).
- Produces: `QuotePdfBranding` gains `theme?: DocumentThemeId; pageSize?: DocumentPageSize` (optional, default classic/a4 so existing tests compile). `RenderRichTextOpts` gains optional `fonts?: PdfThemeFonts['body']` (default Helvetica set — `fontFor` consults it). Heading font + eyebrow/wordmark use `fonts.heading` when themed.

- [ ] **Step 1: Build the regression harness FIRST (before any renderer change).** In `quotePdf.classicRegression.test.ts`: render the existing test fixtures (reuse `quotePdf.test.ts`'s fixture builders) with **no theme fields set**, then (a) extract content streams via pdf-lib + zlib (the `quotePdf.test.ts:1-5` pattern) and snapshot their text-run operators, (b) if `pdftoppm` is on PATH, rasterize page 1 at 72dpi and compare against a checked-in PNG baseline pixel-by-pixel with a small tolerance (skip raster half with a logged warning if `pdftoppm` is absent, so CI without poppler still runs the operator half). Generate the baselines from **unmodified main** and commit them.

- [ ] **Step 2: Run** → PASS (baseline == current output, trivially). Commit the harness + baselines — `test(api): classic PDF regression baselines`.

- [ ] **Step 3: Thread theme through the renderer.** In `renderQuotePdf`:

```ts
const themeId = branding.theme ?? 'classic';
const fonts = registerThemeFonts(doc, themeId);           // after doc construction
const doc = new PDFDocument({ size: pdfPageSize(branding.pageSize ?? 'a4'), margin: 50, bufferPages: true });
```

Replace hard-coded `'Helvetica-Bold'`/`'Helvetica'` in the header/wordmark/heading/cover/footer draw calls with `fonts.heading.bold` / `fonts.body.regular` etc. **Mechanical rule: for classic these resolve to the exact same strings, so the regression harness must stay green.** Pass `fonts.body` into `renderRichTextIntoPdf` via the new opts field; in `richTextPdf.ts` change `fontFor` to close over the provided set:

```ts
function fontFor(fonts: BodyFonts, bold: boolean, italic: boolean): string {
  if (bold && italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (italic) return fonts.italic;
  return fonts.regular;
}
```

(default `fonts` = the Helvetica set; all existing call sites unchanged).

- [ ] **Step 4: New assertions** in `quotePdf.test.ts`: branding `{ pageSize: 'letter' }` produces LETTER MediaBox (612×792); `{ theme: 'condensed' }` embeds font programs whose BaseFont names include `BarlowCondensed` and `DMSans` (pdf-lib font dictionary walk); no theme fields → identical behavior to before (regression suite).

- [ ] **Step 5: Run** `pnpm --filter @breeze/api test -- quotePdf richTextPdf` → PASS including the classic regression. **Commit** — `feat(api): themed fonts + page size in quote PDF renderer`

---

### Task 7: `measureRichText` API (richTextPdf)

**Files:**
- Modify: `apps/api/src/services/richTextPdf.ts`
- Test: `apps/api/src/services/richTextPdf.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
/** Height the given sanitized inline/block HTML would occupy at `width`,
 *  measured PER-RUN at the font each run will actually draw in (bold/italic
 *  switches included) — no drawing, doc font state saved/restored. */
export function measureRichText(doc: PDFKit.PDFDocument, html: string, width: number, fonts?: BodyFonts): number;
/** Same per-run measurement for a single inline-runs string (table cells). */
export function measureInlineRuns(doc: PDFKit.PDFDocument, html: string, width: number, fontSize: number, fonts?: BodyFonts): number;
```

- [ ] **Step 1: Failing tests:** a bold-heavy string measures taller-or-equal vs the flattened single-font measurement at a narrow width (bold glyphs are wider → more wrapped lines); measuring twice returns identical values; doc's current font/size restored after the call (`doc._font.name` unchanged — or assert via drawing the same text before/after and comparing `doc.y` deltas).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement:** walk `parseRichText` blocks; for each block, lay runs out with pdfkit's `widthOfString` per run at that run's font (greedy line-fill at `width`), count lines × line-height (use `doc.currentLineHeight()` at the block's font size), sum block heights + spacing — mirroring exactly what the draw loop at `:355-370` does, minus drawing. Save `doc._font`/`doc._fontSize` at entry, restore at exit.

- [ ] **Step 4: Run** → PASS. **Commit** — `feat(api): per-run-font rich text measurement`

---

### Task 8: `tablePdf.ts` — pure parse + measure

**Files:**
- Create: `apps/api/src/services/tablePdf.ts`
- Test: `apps/api/src/services/tablePdf.test.ts`

**Interfaces:**
- Consumes: `QuoteTableContent` (Task 2), `measureInlineRuns` (Task 7), `PdfThemeFonts` (Task 4).
- Produces:

```ts
export interface TableModel { columns: { label: string; align: 'left'|'center'|'right'; width: number }[]; rows: { cells: string[]; height: number }[]; headerHeight: number; caption?: string; zebra: boolean; headerStyle: 'accent'|'plain'; }
export function parseTable(content: unknown, availableWidth: number): TableModel | null; // null on out-of-contract content
export function measureTable(doc: PDFKit.PDFDocument, model: TableModel, fonts: PdfThemeFonts): TableModel; // fills header/row heights, font state restored
export const MIN_COLUMN_WIDTH = 40;
export interface EnsureRoomRich { (needed: number): { y: number; didBreak: boolean }; }
export function renderTableIntoPdf(doc: PDFKit.PDFDocument, model: TableModel, opts: { x: number; startY: number; accent: string; fonts: PdfThemeFonts; ensureRoom: EnsureRoomRich }): number; // returns new y  (implemented Task 9)
```

- [ ] **Step 1: Failing tests for `parseTable`:** valid content → widths distributed by weight over `availableWidth` with the 40pt floor (weights [1,3] at width 400 → [100, 300]; floor kicks in for 8 skinny columns); out-of-contract input → `null`; missing align defaults `'left'`, zebra defaults `false`.

- [ ] **Step 2:** Failing tests for `measureTable` (real `PDFDocument`, no drawing): row height = max cell height + 2×cell padding (define `CELL_PADDING = 6` exported); a long wrapping cell makes its row taller than its siblings; a bold-heavy cell measures at bold font (reuse Task 7's comparison trick); doc font state restored.

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** (`parseTable` = Zod safeParse via Task 2 shape + width math, pure; `measureTable` = `measureInlineRuns` per cell at body font size 10). **Step 5: Run** → PASS. **Commit** — `feat(api): table PDF parse + measure`

---

### Task 9: `renderTableIntoPdf` + callout render + quotePdf dispatch

**Files:**
- Modify: `apps/api/src/services/tablePdf.ts` (render half)
- Modify: `apps/api/src/services/quotePdf.ts` (block walk `:843+`: `table` + `callout` branches; the richer ensureRoom closure)
- Test: `apps/api/src/services/tablePdf.test.ts` + `quotePdf.test.ts` (extend)

**Interfaces:**
- Consumes: everything above. In `quotePdf.ts`'s block walk add (mirroring the rich_text closure comment at `:854-862`):

```ts
} else if (b.blockType === 'table') {
  const model = parseTable(b.content, c.contentWidth);
  if (model) {
    const ensureRoomRich: EnsureRoomRich = (needed) => {
      const before = doc.y;
      y = ensureSpace(doc, doc.y, needed);
      return { y, didBreak: doc.y !== before };
    };
    measureTable(doc, model, fonts);
    y = renderTableIntoPdf(doc, model, { x: c.left, startY: y, accent: primary, fonts, ensureRoom: ensureRoomRich });
  }
} else if (b.blockType === 'callout') {
  y = renderCalloutIntoPdf(doc, b.content, { x: c.left, width: c.contentWidth, startY: y, accent: primary, fonts, ensureRoom: ensureRoomRich });
}
```

- [ ] **Step 1: Failing render tests** (pdf-lib page/content assertions, `quotePdf.test.ts` style):
  - 30 tall rows on A4 → >1 page; the header row's label text appears in EVERY page's content stream that contains table rows (header repetition).
  - Row taller than a full usable page → degrade: output contains the `label: value` stacked-paragraph form (assert the cell text present, no table row rect ops for it) and never throws / never loops (test completes).
  - Callout: tinted rect ops present, body text present; callout taller than a page → plain rich text, no rect.
  - Zebra on → alternating fill ops; headerStyle `'accent'` → accent-colored header fill.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `renderTableIntoPdf`:**

```
draw = for each row (header first):
  { y, didBreak } = ensureRoom(rowHeight)
  if didBreak and row is not the header: redraw header row at y, y += headerHeight
  if rowHeight > usablePageHeight(doc) - headerHeight:   // degrade BEFORE drawing
    for each cell: renderRichTextIntoPdf(doc, `<strong>${columns[i].label}:</strong> ${cell}`, { ..., ensureRoom: numberAdapter })
    continue
  draw row background (zebra/header fill), then each cell's inline runs per-run-font
  y += rowHeight
```

`renderCalloutIntoPdf` (put it in `tablePdf.ts` or a small `calloutPdf.ts` — implementer's choice, one file): `h = measureRichText(...) + titleHeight + 2*pad`; if `h` > usable page height → `renderRichTextIntoPdf` plain (paginates itself); else `ensureRoom(h)`, draw rounded rect (`doc.roundedRect(x, y, width, h, 6)`) filled with the variant tint (`info` = neutral gray tint, `accent` = 10% accent, `warn` = amber tint — derive: accent at 0.08 alpha over white; hex math helper), 3pt left accent bar, then title (bold) + `renderRichTextIntoPdf` inside padding.

- [ ] **Step 4: Run** `pnpm --filter @breeze/api test -- tablePdf quotePdf` → PASS incl. classic regression (untouched fixtures contain no new blocks). **Commit** — `feat(api): table + callout PDF rendering`

---

### Task 10: Web renderer (QuoteDocument) + unknown-block placeholder

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteDocument.tsx` (`DocBlock` :222)
- Test: `apps/web/src/components/billing/quotes/QuoteDocument.test.tsx` (extend)

**Interfaces:**
- Consumes: `QuoteTableContent`/`QuoteCalloutContent` shapes (server-sanitized; safe for `dangerouslySetInnerHTML` per the file's existing rich_text precedent comment at :229-233).

- [ ] **Step 1: Failing RTL tests:** table renders `<table>` with column labels, cell inline HTML (`<strong>` survives), zebra class toggling, caption; callout renders variant-tinted container + title + html; **unknown blockType renders a visible "unsupported block" placeholder with `data-testid="unsupported-block"`** (staff-facing; spec §4).

- [ ] **Step 2: Run** `pnpm --filter @breeze/web test -- QuoteDocument` → FAIL. **Step 3: Implement** in `DocBlock`, following the component's existing style (Tailwind, `data-testid`, i18n via `t('quotes.document...')` — add keys to the billing namespace; remember the i18n literal-key gate):

```tsx
if (block.blockType === 'table') {
  const content = block.content as Partial<QuoteTableContent> | undefined;
  if (!content?.columns?.length || !content?.rows?.length) return null;
  return (
    <div className="overflow-x-auto" data-testid="quote-table-block">
      <table className="w-full border-collapse text-sm">
        <thead><tr className={content.headerStyle === 'plain' ? 'border-b-2' : 'border-b-2 bg-primary/10'}>
          {content.columns.map((col, i) => (
            <th key={i} style={{ textAlign: col.align ?? 'left' }} className="px-3 py-2 font-semibold text-foreground"
                dangerouslySetInnerHTML={{ __html: col.label }} />
          ))}
        </tr></thead>
        <tbody>
          {content.rows.map((row, ri) => (
            <tr key={ri} className={content.zebra && ri % 2 === 1 ? 'bg-muted/30' : undefined}>
              {row.cells.map((cell, ci) => (
                <td key={ci} style={{ textAlign: content.columns?.[ci]?.align ?? 'left' }} className="px-3 py-2 align-top text-foreground/90"
                    dangerouslySetInnerHTML={{ __html: cell }} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {content.caption && <p className="mt-1 text-xs text-muted-foreground">{content.caption}</p>}
    </div>
  );
}
if (block.blockType === 'callout') {
  const content = block.content as Partial<QuoteCalloutContent> | undefined;
  if (!content?.html?.trim()) return null;
  const tone = content.variant === 'warn' ? 'border-amber-500/40 bg-amber-500/10' : content.variant === 'accent' ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/40';
  return (
    <div className={`rounded-lg border-l-4 p-4 ${tone}`} data-testid="quote-callout-block">
      {content.title && <p className="mb-1 text-sm font-semibold text-foreground">{content.title}</p>}
      <div className="quote-rich-text prose prose-sm max-w-prose dark:prose-invert" dangerouslySetInnerHTML={{ __html: content.html }} />
    </div>
  );
}
// FINAL fallback (replaces the implicit null): staff-visible placeholder.
return (
  <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-testid="unsupported-block">
    {t('quotes.document.unsupportedBlock')}
  </div>
);
```

- [ ] **Step 4: Run** → PASS (fix any existing tests that relied on unknown → null). **Commit** — `feat(web): table + callout quote blocks + unsupported placeholder`

---

### Task 11: Portal renderer (quoteBlocks)

**Files:**
- Modify: `apps/portal/src/components/portal/quoteBlocks.tsx` (before the `return null` at :296)
- Test: `apps/portal/src/components/portal/quoteBlocks.test.tsx` (extend)

**Interfaces:** same content shapes; **unknown blocks keep returning `null` here** (customers never see debris — spec §4).

- [ ] **Step 1: Failing tests** mirroring Task 10's table/callout assertions (portal file has no i18n — literal strings, matching its existing style; add `data-testid="quote-table-block"` / `"quote-callout-block"`).
- [ ] **Step 2: Run** `pnpm --filter @breeze/portal test -- quoteBlocks` → FAIL. **Step 3: Implement** — same JSX as Task 10 minus i18n/prose-invert, keyed `key={block.id}`, inserted as `if (block.blockType === 'table') {...}` / `'callout'` branches above the final `return null` (which stays).
- [ ] **Step 4: Run** → PASS. **Commit** — `feat(portal): table + callout quote blocks`

---

### Task 12: Web + portal document fonts (`condensed` theme CSS)

**Files:**
- Modify: `apps/web/package.json` + `apps/portal/package.json` — add `@fontsource/barlow-condensed`, `@fontsource/dm-sans`
- Modify: `apps/web/src/styles/globals.css`, `apps/portal/src/styles/globals.css`
- Modify: `QuoteDocument.tsx` (web) and `documentShell.tsx` (portal, :23) — stamp `data-doc-theme` from the quote payload's branding/theme field
- Modify: the API responses feeding both views must include the resolved `theme` (extend the quote-detail DTO + `publicQuoteDto.ts` with `presentation: { theme, pageSize }` — wire from Task 5's branding)
- Test: extend `QuoteDocument.test.tsx` / portal `PublicQuoteView.test.tsx` — `data-doc-theme="condensed"` present when the DTO says so; absent/classic otherwise

- [ ] **Step 1:** Add the DTO field (API): `presentation: { theme: branding.theme, pageSize: branding.pageSize }` in the staff quote-detail response and `publicQuoteDto.ts`; type it in `packages/shared/src/types/publicQuote.ts`.
- [ ] **Step 2:** CSS in both apps' globals (mind web's `@theme inline` self-reference warning at `globals.css:81-87` — these are plain vars, NOT `@theme` tokens):

```css
@import '@fontsource/barlow-condensed/600.css';
@import '@fontsource/dm-sans/400.css';
@import '@fontsource/dm-sans/500.css';
@import '@fontsource/dm-sans/700.css';

[data-doc-theme='condensed'] { font-family: 'DM Sans', var(--font-sans, system-ui), sans-serif; }
[data-doc-theme='condensed'] :is(h1, h2, h3, h4, th) { font-family: 'Barlow Condensed', 'DM Sans', sans-serif; letter-spacing: 0.01em; }
```

(Declared unconditionally; browsers fetch a face only when a matched element uses it, so classic documents download nothing. `font-src 'self'` already allows self-hosted woff2 in web, portal, and API CSP — no CSP edits.)
- [ ] **Step 3:** Stamp `data-doc-theme={presentation?.theme ?? 'classic'}` on the web document root container in `QuoteDocument.tsx` and the portal `documentShell.tsx` wrapper.
- [ ] **Step 4:** Run web + portal test suites → PASS. Visual check via the running stack (worktree-stack) on a condensed-theme quote. **Commit** — `feat(web,portal): condensed document theme fonts`

---

### Task 13: Editor — inline cell editor + table & callout authoring

**Files:**
- Create: `apps/web/src/components/common/InlineRichTextEditor.tsx` (small TipTap: marks bold/italic/underline/link only, single paragraph, Enter disabled — the existing `RichTextEditor.tsx:43,149` is block-oriented and cannot be configured inline-only)
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx` — add-block picker entries (`:62-66` picker, `:1155+` submit bodies, `:866-876` label dispatch), table editor UI, callout editor UI
- Test: `apps/web/src/components/common/InlineRichTextEditor.test.tsx`, `apps/web/src/components/billing/quotes/QuoteEditor.tableblock.test.tsx`, `QuoteEditor.calloutblock.test.tsx` (house style: one concern per file; `QuoteEditor.contractblock.test.tsx` is the closest model)

**Interfaces:**
- Consumes: `addBlock(quoteId, { blockType: 'table', content })` / `updateBlock` (existing API client fns), Task 2 content types.
- Produces: `<InlineRichTextEditor value={html} onChange={(html) => ...} />` — emits inline-subset HTML.

- [ ] **Step 1: InlineRichTextEditor** failing tests: typing emits `onChange` with inline HTML; Enter does not create a paragraph; bold toggle wraps `<strong>`; pasted block HTML is flattened to inline. Implement with TipTap `Document/Text/Paragraph` minimal schema + `Bold/Italic/Underline/Link` marks, `handleKeyDown` swallowing Enter, `editorProps.transformPastedHTML` stripping to the inline subset.
- [ ] **Step 2: Table editor** failing tests (RTL): picker shows "Table"; creating one POSTs `blockType: 'table'` with columns/rows from the grid UI; add/remove row + column buttons; per-column align select; zebra + header-style toggles; cell count always matches column count (adding a column pads every row with `''` — the client keeps the Task 2 invariant); submit disabled while a request is in flight and re-enabled after (regression for the #3519 class — assert via a rejected `addBlock` mock that the button unlatches and an error surfaces).
- [ ] **Step 3:** Implement table editor inside `QuoteEditor.tsx` following the contract-block body pattern; state as `QuoteTableContent`; each cell renders an `InlineRichTextEditor`. Callout editor: variant select (`info/accent/warn`), title input, existing `RichTextEditor` for body html. All submits through `runAction` inside `runScoped('add-block', ...)` exactly like the image path (`:1140-1169`).
- [ ] **Step 4:** Run `pnpm --filter @breeze/web test -- InlineRichTextEditor QuoteEditor.tableblock QuoteEditor.calloutblock` → PASS. **Commit** — `feat(web): table + callout block authoring`

---

### Task 14: Partner settings — API plumbing + web UI

**Files:**
- Modify: `apps/api/src/routes/orgs.ts:337` (`partnerPublicColumns()` — add both columns)
- Modify: `packages/shared/src/validators/invoices.ts:86` (`partnerBillingSettingsSchema` — add `documentTheme: z.enum(['classic','condensed']).optional()`, `documentPageSize: z.enum(['letter','a4']).optional()`)
- Modify: `apps/api/src/services/invoiceService.ts:449` (`updatePartnerBillingSettings` — update + return mappings)
- Modify: the web partner billing settings page (where invoice footer/prefix live — locate via `grep -rn invoiceNumberPrefix apps/web/src`) — two labeled selects: "Document theme" (Classic / Condensed) and "Page size" (Letter / A4)
- Test: extend the existing partner-billing-settings route/service tests + a web settings render/save test

- [ ] **Step 1:** Failing API test: PATCH partner billing settings with `{ documentTheme: 'condensed', documentPageSize: 'letter' }` persists and returns both; invalid value → 400. **Step 2:** Implement the three API touchpoints. **Step 3:** Failing web test: selects render current values, saving PATCHes through `runAction`. **Step 4:** Implement UI following the page's existing field pattern. **Step 5:** All green → **Commit** — `feat(api,web): partner document theme settings`

---

### Task 15: MCP tool contract + final sweep

**Files:**
- Modify: `apps/api/src/services/aiToolsQuotes.ts:275` — add `table`/`callout` to the hard-coded allowed block types + content description in `manage_quotes`
- Test: existing aiTools schema tests (extend if a block-type list assertion exists)

- [ ] **Step 1:** Update the tool's block-type enum + description text (describe the two content shapes compactly, mirroring how existing types are described). Run the aiTools test file for quotes → PASS.
- [ ] **Step 2: Repo-wide sweep (spec step 7 discipline):** `grep -rn "blockType" apps/ packages/ --include="*.ts" --include="*.tsx" -l` and check every file that switches/dispatches on block types now handles or deliberately ignores `table`/`callout` (known list: the three renderers ✓, editor ✓, `quoteContentHash` (hashes content JSON generically — no change, verify), `contractTemplateRender`/PDF snapshot paths, any block-type switch in portal `QuoteDetailView`). Record the sweep result in the PR description.
- [ ] **Step 3: Full gates:** `pnpm --filter @breeze/api test && pnpm --filter @breeze/web test && pnpm --filter @breeze/portal test && pnpm --filter @breeze/shared test`, `pnpm db:check-drift`, `pnpm lint`. Export-policy registration for `quotes.presentation_snapshot` already shipped with Task 1 (verify it's present); no other tenancy surface was touched.
- [ ] **Step 4: Commit** — `feat(api): MCP quote tool block types`

---

### Task 16: Acceptance verification (manual, not merged code)

- [ ] Bring up the worktree stack (`worktree-stack` skill). Set the seeded partner to `condensed` + `letter` via the new settings UI.
- [ ] Rebuild the reference proposal's four image-workaround elements as native blocks on a draft quote (capability table → `table`; the two comparison tables → `table`; plan-cards page → rich_text + callout for now — tiers are Spec B): verify staff preview, portal view, and downloaded PDF (Letter, Barlow/DM Sans, repeated table headers across a page break).
- [ ] Verify a `classic` partner's existing quote renders pixel-identical (raster harness + eyeball).
- [ ] Send a themed quote, flip the partner back to `classic`, confirm the sent quote still renders condensed (snapshot held).

---

## Self-Review (done at write time)

- **Spec coverage:** storage/migration → T1; settings plumbing → T14; theme defs/fonts/Dockerfiles → T4; branding + manual paths + send snapshot → T5; Zod + parity → T2; sanitizer write/read → T3; pagination contract/measure/render/degrade → T7-T9; classic regression → T6; web/portal renderers + placeholder policy → T10-T11; web/portal fonts + DTO → T12; editor incl. inline TipTap → T13; MCP → T15; export-policy column registration → T15; acceptance target → T16. Deferred items (two-column, invoices, per-quote override, MSP-brand accent) have no tasks — correct.
- **Type consistency:** `PdfThemeFonts`/`BodyFonts`, `EnsureRoomRich`, `QuoteTableContent` names match across T4/T6/T7/T8/T9; `resolveThemeId`/`resolvePageSize` used in T5/T6/T12.
- **Placeholder scan:** none — every step carries code or an exact command.
