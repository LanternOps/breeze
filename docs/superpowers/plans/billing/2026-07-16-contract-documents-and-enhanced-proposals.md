# Contract Documents & Enhanced Proposals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Also load the `breeze-testing` skill before writing any test file** — it carries the Drizzle mock patterns and the required coverage checklist this plan assumes.

**Goal:** Reproduce a full narrative client proposal (branded cover, formatted rich-text sections, pricing tables, embedded legal contract, one-signature execution) in the Breeze quote builder, backed by a new versioned partner-wide contract template library whose executed documents file against billing contracts.

**Architecture:** Three workstreams. (1) Rich-text fidelity: a sanitized constrained HTML subset stored/served everywhere, a formatted-text pdfkit renderer, and a TipTap editor. (2) Contract template library: `contract_templates` (dual-ownership org XOR partner) + immutable `contract_template_versions` (authored HTML or uploaded PDF) + `contract_documents` (org-owned executed snapshots). (3) Proposal integration: a fifth `contract` quote block type rendered inline (portal/public/PDF), folded into the acceptance hash, snapshotted at accept in the same transaction, and linked to the billing contract that acceptance already creates.

**Tech Stack:** Hono + Drizzle + Postgres RLS (API), Zod v4 shared validators, pdfkit (+ new `pdf-lib` for merging uploaded PDFs), new `sanitize-html` (API), TipTap (`@tiptap/react`, web), Astro/React (web + portal), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/billing/2026-07-16-contract-documents-and-enhanced-proposals-design.md` (read it first — decisions and rationale live there).

## Global Constraints

- Node pinned at `.nvmrc` **22.20.0** — run `node -v` and match before running any tests (wrong Node produces false failures/hangs).
- Zod is **v4**: use `z.string().guid()` (not `.uuid()`), and never build `z.enum` from Drizzle `enumValues` (breaks schema mocks) — write literal string arrays.
- Migrations: hand-written SQL, `2026-07-16-<slug>.sql` naming, idempotent, **no inner `BEGIN;`/`COMMIT;`**, never use `drizzle-kit generate/push`. Verify with `pnpm db:check-drift` (needs `DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze`).
- Every new tenant table: RLS policies **in the same migration**; register in the rls-coverage allowlists and **every applicable cascade list in the same PR** (see Task 2 — this is the historically-missed step).
- Web mutation handlers wrap requests in `runAction` (`apps/web/src/lib/runAction.ts`).
- Every new `t('...')` key added to the **en** locale must be added to **es, fr, de** (and pt-BR where the namespace exists) in the same commit — locale-parity CI reds main otherwise.
- E2E selectors are `data-testid` only.
- Allowed rich-text subset (single source of truth for sanitizer, TipTap config, and PDF renderer): `p`, `br`, `strong`, `em`, `u`, `h3`, `h4`, `ul`, `ol`, `li`, `a[href]` (http/https only).
- New deps: `sanitize-html` + `@types/sanitize-html`, `pdf-lib` (apps/api); `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-underline`, `@tiptap/extension-link` (apps/web). No others.
- Commit after every task (at minimum); use `feat(quotes):` / `feat(contracts):` / `feat(web):` prefixes matching repo history.

## File Structure (net-new files)

```
apps/api/migrations/2026-07-16-contract-documents.sql
apps/api/src/db/schema/contractDocuments.ts          # 3 new tables + enums
apps/api/src/services/richTextSanitize.ts            # subset sanitizer (write + read boundaries)
apps/api/src/services/richTextPdf.ts                 # subset → pdfkit formatted rendering
apps/api/src/services/contractTemplateService.ts     # library CRUD/versions/publish
apps/api/src/services/contractTemplateRender.ts      # variables, substitution, system-context block loader
apps/api/src/services/contractDocumentService.ts     # accept-time snapshot + listing
apps/api/src/routes/contracts/templates.ts           # template/version routes
apps/api/src/routes/contracts/documents.ts           # executed-document list/download routes
apps/api/src/__tests__/integration/contractTemplatesPartnerRls.integration.test.ts
apps/api/src/__tests__/integration/quoteContractAccept.integration.test.ts
packages/shared/src/validators/contractTemplates.ts
apps/web/src/components/common/RichTextEditor.tsx    # TipTap wrapper (quotes + templates)
apps/web/src/components/contracts/TemplatesTab.tsx
apps/web/src/components/contracts/TemplateEditor.tsx
apps/web/src/lib/api/contractTemplates.ts
e2e-tests/tests/quote-contract-proposal.spec.ts
```

Existing files with load-bearing edits: `packages/shared/src/validators/quotes.ts`, `apps/api/src/db/schema/quotes.ts`, `apps/api/src/services/{quoteService,quoteLifecycle,quoteContentHash,quoteAcceptService,quotePdf}.ts`, `apps/api/src/routes/quotes/quotes.ts`, `apps/api/src/routes/portal/quotes.ts`, `apps/api/src/routes/quotesPublic.ts`, `apps/api/src/services/tenantCascade.ts`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, `apps/portal/src/components/portal/quoteBlocks.tsx`, `apps/web/src/components/billing/quotes/{QuoteEditor,QuoteDocument,quoteTypes}.tsx|ts`, `apps/web/src/components/contracts/{ContractWorkspace,ContractDetail}.tsx`.

---

## Phase 0 — Rich-text fidelity (independent, ship-first)

### Task 1: Rich-text sanitizer service

**Files:**
- Create: `apps/api/src/services/richTextSanitize.ts`
- Test: `apps/api/src/services/richTextSanitize.test.ts`
- Modify: `apps/api/package.json` (deps)

**Interfaces:**
- Produces: `sanitizeRichTextHtml(html: string): string` and `RICH_TEXT_ALLOWED_TAGS: readonly string[]` — used by Tasks 3, 8, 10, 14.

- [ ] **Step 1: Install deps**

```bash
cd apps/api && pnpm add sanitize-html && pnpm add -D @types/sanitize-html
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/src/services/richTextSanitize.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeRichTextHtml } from './richTextSanitize';

describe('sanitizeRichTextHtml', () => {
  it('preserves the allowed subset', () => {
    const input = '<h3>Terms</h3><p><strong>Bold</strong> and <em>italic</em> and <u>underline</u></p><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol><p>line<br>break</p>';
    expect(sanitizeRichTextHtml(input)).toBe(input.replace('<br>', '<br />'));
  });
  it('strips script/style/iframe and event handlers', () => {
    expect(sanitizeRichTextHtml('<p onclick="x()">hi</p><script>evil()</script><style>p{}</style><iframe src="x"></iframe>'))
      .toBe('<p>hi</p>');
  });
  it('strips javascript: hrefs but keeps https links with forced rel', () => {
    expect(sanitizeRichTextHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRichTextHtml('<a href="https://example.com">x</a>'))
      .toBe('<a href="https://example.com" rel="noopener noreferrer" target="_blank">x</a>');
  });
  it('downgrades disallowed headings/divs to their text content wrapped as-is', () => {
    expect(sanitizeRichTextHtml('<h1>big</h1><div>plain</div>')).toBe('big plain'.replace(' ', '')); // see impl: text preserved, tags dropped
  });
  it('strips inline styles and classes', () => {
    expect(sanitizeRichTextHtml('<p style="color:red" class="x">hi</p>')).toBe('<p>hi</p>');
  });
});
```

Note: the `downgrades` assertion above must match your implementation exactly — `sanitize-html` drops disallowed tags but keeps inner text (`bigplain`). Fix the expected literal when you write it; the behavior that matters is *text preserved, tag gone*.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/services/richTextSanitize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// apps/api/src/services/richTextSanitize.ts
// Single source of truth for the proposal/contract rich-text subset. The same
// list constrains the TipTap editor (apps/web RichTextEditor) and the PDF
// renderer (richTextPdf.ts) — change all three together or not at all.
import sanitizeHtml from 'sanitize-html';

export const RICH_TEXT_ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'u', 'h3', 'h4', 'ul', 'ol', 'li', 'a'] as const;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...RICH_TEXT_ALLOWED_TAGS],
  allowedAttributes: { a: ['href', 'rel', 'target'] },
  allowedSchemes: ['http', 'https'],
  // Force safe link behavior regardless of author input.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
  disallowedTagsMode: 'discard',
};

/** Sanitize author/tenant HTML down to the proposal rich-text subset.
 * Applied at WRITE (store only clean content) and again at READ serialization
 * (defense in depth + covers rows written before this module existed). */
export function sanitizeRichTextHtml(html: string): string {
  return sanitizeHtml(html ?? '', OPTIONS);
}
```

- [ ] **Step 5: Run tests, adjust expected literals to actual sanitize-html output where flagged, verify PASS**

Run: `cd apps/api && pnpm vitest run src/services/richTextSanitize.test.ts`
Expected: PASS (after fixing the one marked literal). Do NOT weaken the script/event-handler/javascript: assertions — those must pass exactly.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/richTextSanitize.* apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): rich-text subset sanitizer for proposals/contracts"
```

### Task 2: Formatted rich-text PDF renderer

**Files:**
- Create: `apps/api/src/services/richTextPdf.ts`
- Test: `apps/api/src/services/richTextPdf.test.ts`
- Modify: `apps/api/src/services/quotePdf.ts:535-541` (rich_text branch)

**Interfaces:**
- Consumes: sanitized subset HTML (Task 1 guarantees shape).
- Produces: `renderRichTextIntoPdf(doc: PDFKit.PDFDocument, html: string, opts: { x: number; width: number; startY: number; ensureRoom: (needed: number) => number }): number` — returns the new y cursor. Used by quotePdf (Task 2) and contract document rendering (Task 14).

Implementation notes (this is the fiddly task — read `quotePdf.ts` first for page-break conventions):
- Parse with a small hand-rolled tokenizer over the sanitized subset (input is machine-sanitized, so a regex/stack parser over the 11 known tags is safe and dependency-free). Build a block list: `{ kind: 'p' | 'h3' | 'h4' | 'li', ordinal?: number, indent: 0 | 1, runs: Array<{ text: string; bold: boolean; italic: boolean; underline: boolean; link?: string }> }`.
- Draw runs with pdfkit `continued: true` segments; font `Helvetica` / `Helvetica-Bold` / `Helvetica-Oblique` / `Helvetica-BoldOblique`; `underline: true` passes through pdfkit natively.
- `ul` items draw a `•` glyph at `x`, text at `x + 14`; `ol` items draw `${n}.`; nested lists beyond one level flatten to one level (subset allows nesting but proposal fidelity only needs one).
- h3 → 13pt bold, h4 → 11.5pt bold, paragraph 11pt, 8pt spacing after each block (matches existing quotePdf rhythm).
- Call `opts.ensureRoom(lineHeight)` before each block so page breaks reuse quotePdf's existing pagination helper (find it near the block loop — the same mechanism `line_items` uses).

- [ ] **Step 1: Write failing tests** — assert against the parsed intermediate representation (export the parser separately as `parseRichText(html)` so tests don't need PDF byte inspection):

```ts
// apps/api/src/services/richTextPdf.test.ts
import { describe, it, expect } from 'vitest';
import { parseRichText } from './richTextPdf';

describe('parseRichText', () => {
  it('splits paragraphs and inline formatting runs', () => {
    expect(parseRichText('<p>plain <strong>bold <em>bolditalic</em></strong> tail</p>')).toEqual([
      { kind: 'p', indent: 0, runs: [
        { text: 'plain ', bold: false, italic: false, underline: false },
        { text: 'bold ', bold: true, italic: false, underline: false },
        { text: 'bolditalic', bold: true, italic: true, underline: false },
        { text: ' tail', bold: false, italic: false, underline: false },
      ] },
    ]);
  });
  it('numbers ordered list items and bullets unordered ones', () => {
    const blocks = parseRichText('<ol><li>a</li><li>b</li></ol><ul><li>c</li></ul>');
    expect(blocks.map((b) => [b.kind, b.ordinal ?? null])).toEqual([['li', 1], ['li', 2], ['li', null]]);
  });
  it('renders h3/h4 as heading blocks and br as run breaks', () => {
    const blocks = parseRichText('<h3>Key Terms</h3><p>one<br>two</p>');
    expect(blocks[0]).toMatchObject({ kind: 'h3' });
    expect(blocks[1]!.runs.some((r) => r.text.includes('\n'))).toBe(true);
  });
  it('is resilient to empty/whitespace input', () => {
    expect(parseRichText('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**, then implement `parseRichText` + `renderRichTextIntoPdf` per the notes above.
- [ ] **Step 3: Wire into quotePdf** — replace the `rich_text` branch's `stripHtml` call (`apps/api/src/services/quotePdf.ts:535`) with `y = await renderRichTextIntoPdf(doc, html, { x: c.left, width: c.contentWidth, startY: y, ensureRoom })` (match the file's actual pagination helper; keep the existing `stripHtml` export if other call sites use it).
- [ ] **Step 4: Run the full quotePdf test file** — `pnpm vitest run src/services/richTextPdf.test.ts src/services/quotePdf.test.ts`. Existing quotePdf tests asserting plain-text rich_text output will need their fixtures updated to the new formatted expectations — update them; do not delete assertions.
- [ ] **Step 5: Commit** — `feat(api): formatted rich-text rendering in proposal PDFs`

### Task 3: Serve real (sanitized) HTML to portal, public, and web views

**Files:**
- Modify: `apps/api/src/services/quoteService.ts` (block create/update: sanitize on write), the block-serialization path used by `apps/api/src/routes/portal/quotes.ts` and `apps/api/src/routes/quotesPublic.ts` (sanitize on read), `apps/portal/src/components/portal/quoteBlocks.tsx` (render HTML instead of stripping), `apps/web/src/components/billing/quotes/QuoteDocument.tsx` (same).
- Tests: extend `apps/api/src/services/quoteService.test.ts`, `apps/portal` component tests if present, `QuoteDocument.test.tsx`.

**Interfaces:**
- Consumes: `sanitizeRichTextHtml` (Task 1).
- Produces: portal/public/web all render rich_text as formatted HTML; every rich_text `content.html` that leaves the API is sanitizer output.

- [ ] **Step 1 (TDD, API):** add quoteService tests — creating/updating a `rich_text` block with `<script>` stores sanitized HTML; the portal serialization applies `sanitizeRichTextHtml` to legacy rows (feed a mock row containing `<script>` and assert the serialized content is clean).
- [ ] **Step 2:** implement: in `quoteService.ts` block create/update, pass `content.html` through `sanitizeRichTextHtml` before insert/update. In the portal/public quote serializers, map rich_text blocks through the sanitizer. Grep first: `grep -n "rich_text" apps/api/src/routes/portal/quotes.ts apps/api/src/routes/quotesPublic.ts apps/api/src/routes/quotes/quotes.ts` to find every serialization point — cover all of them (parity rule: enumerate all sibling sites).
- [ ] **Step 3 (portal):** in `quoteBlocks.tsx`, replace the rich_text strip-to-text render with `<div className="quote-rich-text" dangerouslySetInnerHTML={{ __html: block.content.html }} />` and delete the now-dead comment block explaining why stripping was needed (the API now guarantees sanitized content; note that in a comment). Add minimal CSS for `ul/ol/h3/h4` inside `.quote-rich-text` (portal styles live next to `documentShell.tsx` — follow its pattern).
- [ ] **Step 4 (web):** same swap in `QuoteDocument.tsx`.
- [ ] **Step 5:** run `pnpm test --filter=@breeze/api` and `pnpm test --filter=@breeze/web`; fix fixture fallout (tests that asserted stripped text). Commit: `feat(quotes): render sanitized rich-text HTML in portal/public/web views`

### Task 4: TipTap rich-text editor in the quote builder

**Files:**
- Create: `apps/web/src/components/common/RichTextEditor.tsx`
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx` (both rich_text textareas: add-section at ~line 1305, inline block edit at ~line 1854), `apps/web/package.json`
- Test: `apps/web/src/components/common/RichTextEditor.test.tsx`

**Interfaces:**
- Produces: `<RichTextEditor value={html} onChange={(html) => …} ariaLabel={…} testId={…} />` — constrained to the allowed subset; reused by Task 16's TemplateEditor.

- [ ] **Step 1:** `cd apps/web && pnpm add @tiptap/react @tiptap/pm @tiptap/starter-kit @tiptap/extension-underline @tiptap/extension-link`
- [ ] **Step 2 (failing test):** render the component in jsdom, assert toolbar buttons exist by `data-testid` (`rte-bold`, `rte-italic`, `rte-underline`, `rte-h3`, `rte-h4`, `rte-bullet-list`, `rte-ordered-list`, `rte-link`), and that typing → `onChange` emits subset HTML. (TipTap works under jsdom; if `ClipboardEvent`/`DragEvent` polyfills are needed, add them in the test file, not setup — keep the blast radius local.)
- [ ] **Step 3:** implement. StarterKit configured with `heading: { levels: [3, 4] }`, disable everything not in the subset (`code`, `codeBlock`, `blockquote`, `strike`, `horizontalRule`); add Underline and Link (`openOnClick: false`, `protocols: ['http', 'https']`). Toolbar = small buttons using the workspace's existing button classes (copy from `QuoteEditor` toolbar idiom). Emit `editor.getHTML()` on update.
- [ ] **Step 4:** swap both QuoteEditor textareas for `<RichTextEditor>`; the add-section flow keeps its state variable (`richText`), just fed by onChange. Update the i18n placeholder keys usage; **add any new keys to en+es+fr+de**.
- [ ] **Step 5:** `pnpm test --filter=@breeze/web` — update the QuoteEditor tests that typed into the old textareas (drive `onChange` via the component or fireEvent on the contenteditable). Commit: `feat(web): TipTap rich-text editing for proposal sections`

---

## Phase 1 — Contract template library (backend)

### Task 5: Migration + Drizzle schema for the three tables (+ block enum + cover page column)

**Files:**
- Create: `apps/api/migrations/2026-07-16-contract-documents.sql`, `apps/api/src/db/schema/contractDocuments.ts`
- Modify: `apps/api/src/db/schema/quotes.ts` (enum + coverPage column), schema barrel (`apps/api/src/db/schema/index.ts` — confirm path by `grep -rn "from './contracts'" apps/api/src/db/schema/`)

**Interfaces:**
- Produces: Drizzle tables `contractTemplates`, `contractTemplateVersions`, `contractDocuments`; enums `contractTemplateStatusEnum('active'|'archived')`, `contractTemplateVersionStatusEnum('draft'|'published')`, `contractTemplateSourceTypeEnum('authored'|'uploaded')`; `quotes.coverPage` jsonb column; `'contract'` added to `quoteBlockTypeEnum`.

- [ ] **Step 1: Write the migration.** Full content:

```sql
-- Contract template library + executed contract documents (spec:
-- docs/superpowers/specs/billing/2026-07-16-contract-documents-and-enhanced-proposals-design.md).
--
-- contract_templates / contract_template_versions are PARTNER-WIDE-FIRST config
-- tables (epic #2135 shape): org_id XOR partner_id, one dual-axis RLS policy.
-- Versions denormalize the owner axes from their template (FK children get NO
-- RLS coverage for free); owner change is disallowed once versions exist, so
-- the denorm cannot drift. contract_documents is an org-owned transactional
-- record (executed instance for a specific client org — org_id NOT NULL is
-- deliberate, not an oversight).
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- Step 1: quote-side additions ------------------------------------------------
ALTER TYPE quote_block_type ADD VALUE IF NOT EXISTS 'contract';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS cover_page jsonb;

-- Step 2: enums ---------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE contract_template_status AS ENUM ('active', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE contract_template_version_status AS ENUM ('draft', 'published');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE contract_template_source_type AS ENUM ('authored', 'uploaded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Step 3: contract_templates --------------------------------------------------
CREATE TABLE IF NOT EXISTS contract_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  name varchar(255) NOT NULL,
  description text,
  status contract_template_status NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT contract_templates_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))
);
CREATE INDEX IF NOT EXISTS contract_templates_partner_id_idx ON contract_templates(partner_id);
CREATE INDEX IF NOT EXISTS contract_templates_org_id_idx ON contract_templates(org_id);

-- Step 4: contract_template_versions -------------------------------------------
CREATE TABLE IF NOT EXISTS contract_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES contract_templates(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  version_number integer NOT NULL,
  status contract_template_version_status NOT NULL DEFAULT 'draft',
  source_type contract_template_source_type NOT NULL,
  body_html text,
  file_data bytea,
  mime varchar(64),
  byte_size integer,
  sha256 char(64),
  declared_variables jsonb NOT NULL DEFAULT '[]',
  published_at timestamp,
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT contract_template_versions_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
  CONSTRAINT contract_template_versions_body_chk CHECK (
    (source_type = 'authored' AND body_html IS NOT NULL)
    OR (source_type = 'uploaded' AND file_data IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS contract_template_versions_template_version_uq
  ON contract_template_versions(template_id, version_number);
CREATE INDEX IF NOT EXISTS contract_template_versions_partner_id_idx ON contract_template_versions(partner_id);
CREATE INDEX IF NOT EXISTS contract_template_versions_org_id_idx ON contract_template_versions(org_id);

-- Step 5: contract_documents ---------------------------------------------------
CREATE TABLE IF NOT EXISTS contract_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  quote_acceptance_id uuid REFERENCES quote_acceptances(id) ON DELETE SET NULL,
  contract_id uuid REFERENCES contracts(id) ON DELETE SET NULL,
  template_id uuid NOT NULL REFERENCES contract_templates(id) ON DELETE RESTRICT,
  template_version_id uuid NOT NULL REFERENCES contract_template_versions(id) ON DELETE RESTRICT,
  rendered_html text,
  pdf_data bytea NOT NULL,
  mime varchar(64) NOT NULL DEFAULT 'application/pdf',
  byte_size integer NOT NULL,
  sha256 char(64) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_documents_org_idx ON contract_documents(org_id);
CREATE INDEX IF NOT EXISTS contract_documents_contract_idx ON contract_documents(contract_id);
CREATE INDEX IF NOT EXISTS contract_documents_quote_idx ON contract_documents(quote_id);

-- Step 6: RLS -------------------------------------------------------------------
ALTER TABLE contract_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_templates_isolation ON contract_templates;
CREATE POLICY contract_templates_isolation ON contract_templates
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

ALTER TABLE contract_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_template_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_template_versions_isolation ON contract_template_versions;
CREATE POLICY contract_template_versions_isolation ON contract_template_versions
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

ALTER TABLE contract_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_documents_isolation ON contract_documents;
CREATE POLICY contract_documents_isolation ON contract_documents
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
```

Before writing, `grep -n 'breeze_current_scope\|breeze_has_org_access' apps/api/migrations/2026-06-16-quotes.sql` and mirror the exact org-only policy idiom used there for `contract_documents` (the shape above matches the software-policies precedent; confirm the org-only convention matches quotes').

- [ ] **Step 2: Drizzle schema** — `apps/api/src/db/schema/contractDocuments.ts` mirroring the SQL exactly (import `bytea` from `./users`, `partners, organizations` from `./orgs`, `quotes, quoteAcceptances` from `./quotes`, `contracts` from `./contracts`, `users` from `./users`). Add `'contract'` to `quoteBlockTypeEnum` in `quotes.ts` and `coverPage: jsonb('cover_page')` to the `quotes` table. Export the new file from the schema barrel.
- [ ] **Step 3: Apply + drift check**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter @breeze/api dev:migrate 2>/dev/null || true  # use the repo's actual migrate entrypoint; autoMigrate runs on API boot in dev
pnpm db:check-drift
```
Expected: no drift. (If the migrate entrypoint differs, boot the dev API once — autoMigrate applies pending files.)

- [ ] **Step 4: Forge check as breeze_app** — `docker exec -it breeze-postgres psql -U breeze_app -d breeze`, set an org context for tenant A and `INSERT` a `contract_templates` row owned by partner B → expect `new row violates row-level security policy`.
- [ ] **Step 5: Commit** — `feat(contracts): contract template library + executed documents schema and RLS`

### Task 6: Cascade + RLS-coverage registration and partner-RLS integration suite

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, entries around lines 124-127), `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`DUAL_AXIS_TENANT_TABLES`, ~line 247)
- Create: `apps/api/src/__tests__/integration/contractTemplatesPartnerRls.integration.test.ts`

- [ ] **Step 1:** Insert into `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, verify FK direction): `'contract_documents'` after `'contract_billing_periods'`; `'contract_template_versions'` then `'contract_templates'` after `'contract_renewal_notices'`. Alphabetical order satisfies children-before-parents here (`contract_documents` < `contract_template_versions` < `contract_templates`, and documents precede `contracts`/`quotes`) — but confirm with the ordering test, don't trust this note.
- [ ] **Step 2:** Add `'contract_templates'` and `'contract_template_versions'` to `DUAL_AXIS_TENANT_TABLES` with a comment following the `configuration_policies` entry's format (what asserts the partner-axis branch, where the functional forge test lives).
- [ ] **Step 3:** Write `contractTemplatesPartnerRls.integration.test.ts` modeled on `configurationPoliciesPartnerRls.integration.test.ts` (copy its fixture bootstrap): cross-partner template forge → SQLSTATE 42501; both-axes/no-axes insert → 23514; org-scoped context cannot read partner-owned template; partner A cannot read partner B's templates; version rows enforce the same; `contract_documents` cross-org read/write blocked.
- [ ] **Step 4:** Run integration tests (real DB on :5433 — check `vitest.integration.config.ts` for env): `pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts src/__tests__/integration/contractTemplatesPartnerRls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts`
Expected: all PASS. tenantCascade failures = ordering/membership bug — fix the list, not the test.
- [ ] **Step 5:** Commit — `feat(contracts): register contract tables in cascade + RLS coverage contracts`

### Task 7: Shared validators

**Files:**
- Create: `packages/shared/src/validators/contractTemplates.ts` (+ export from the validators barrel — find it: `grep -rn "from './quotes'" packages/shared/src`)
- Modify: `packages/shared/src/validators/quotes.ts`
- Test: `packages/shared/src/validators/contractTemplates.test.ts`, extend `quotes` validator tests

**Interfaces (produces — later tasks import these exact names):**

```ts
// contractTemplates.ts
export const createContractTemplateSchema; // { name: string(1..255), description?: string(2000), ownerScope: 'organization'|'partner', orgId?: guid (required iff ownerScope='organization') }
export const updateContractTemplateSchema; // createContractTemplateSchema.partial().omit({ ownerScope: true, orgId: true })
export const createTemplateVersionSchema;  // { bodyHtml: string(1..200_000) } (authored; uploads go through multipart route)
export const contractVariableSchema;       // { name: /^[a-z][a-z0-9_.]{0,63}$/, kind: 'auto'|'manual', label?: string(100) }
export type ContractVariable;
export const AUTO_CONTRACT_VARIABLES: readonly string[]; // ['client.name','client.address','seller.name','quote.number','quote.title','totals.one_time','totals.monthly','totals.annual','totals.total','dates.effective','dates.expiry']
// quotes.ts additions
const contractContent = z.object({ templateId: z.string().guid(), templateVersionId: z.string().guid(), variableValues: z.record(z.string(), z.string().max(2000)).default({}), label: z.string().max(200).optional() });
// added to quoteBlockInputSchema discriminated union: { blockType: z.literal('contract'), content: contractContent }
export const coverPageSchema = z.object({ enabled: z.boolean(), title: z.string().max(200).optional(), coverImageId: z.string().guid().nullable().optional(), preparedForName: z.string().max(255).nullable().optional(), showPreparedBy: z.boolean().default(true) });
// updateQuoteSchema gains: coverPage: coverPageSchema.nullable().optional()
```

- [ ] **Step 1 (failing tests):** ownerScope='organization' without orgId → reject; ownerScope='partner' with orgId → reject; variable name regex (reject `{{X}}`-unfriendly names, uppercase, spaces); contract block content round-trips; coverPage accepts `{enabled:false}` and rejects >200-char titles; `quoteBlockTypeSchema` now includes `'contract'`.
- [ ] **Step 2:** implement (remember zod4 `.partial()` keeps `.default()`s — declare defaults only where a partial-update default is safe). Run `pnpm test --filter=@breeze/shared` → PASS.
- [ ] **Step 3:** Commit — `feat(shared): contract template + contract block + cover page validators`

### Task 8: contractTemplateService

**Files:**
- Create: `apps/api/src/services/contractTemplateService.ts`
- Test: `apps/api/src/services/contractTemplateService.test.ts` (Drizzle mocks per breeze-testing)

**Interfaces (produces):**

```ts
export class ContractTemplateServiceError extends Error { constructor(msg: string, public status: number, public code: string) }
export async function listTemplates(auth: AuthContext, opts?: { includeArchived?: boolean }): Promise<TemplateWithLatest[]>;
export async function createTemplate(auth: AuthContext, input: CreateContractTemplateInput): Promise<TemplateRow>;
export async function updateTemplate(auth: AuthContext, id: string, input: UpdateContractTemplateInput): Promise<TemplateRow>;
export async function archiveTemplate(auth: AuthContext, id: string): Promise<void>;
export async function createDraftVersion(auth: AuthContext, templateId: string, input: { bodyHtml: string }): Promise<VersionRow>;      // sanitizes bodyHtml (Task 1)
export async function createUploadedVersion(auth: AuthContext, templateId: string, file: { data: Buffer; mime: string }): Promise<VersionRow>; // validates %PDF- magic, 10MB cap
export async function publishVersion(auth: AuthContext, templateId: string, versionId: string): Promise<VersionRow>; // computes sha256 (body_html or file), scans {{vars}} → declared_variables (kind auto if in AUTO_CONTRACT_VARIABLES else manual), sets published_at; PUBLISHED VERSIONS ARE IMMUTABLE — updates to a published version throw 409 VERSION_IMMUTABLE
```

Behavioral rules (each gets a test): partner-wide create/update/archive requires `canManagePartnerWidePolicies(auth)` else `PartnerWideWriteDeniedError`; org-scoped create requires org in `auth` scope; version numbers allocate per template (max+1); editing = new draft version, never mutate published; archive blocks new attachments but existing pinned blocks keep rendering; delete is not exposed (archive only).

- [ ] **Step 1:** failing tests for each behavioral rule (mock db per breeze-testing patterns; assert SQL-level effects through the mock).
- [ ] **Step 2:** implement; run `pnpm --filter @breeze/api exec vitest run src/services/contractTemplateService.test.ts` → PASS.
- [ ] **Step 3:** Commit — `feat(contracts): contract template service (versions, publish, partner-wide gating)`

### Task 9: Template + version routes

**Files:**
- Create: `apps/api/src/routes/contracts/templates.ts`
- Modify: `apps/api/src/routes/contracts/index.ts` (mount at `/contract-templates` — check how `index.ts` mounts siblings and follow it)
- Test: `apps/api/src/routes/contracts/templates.test.ts`

Routes (all JSON unless noted): `GET /` list · `POST /` create · `GET /:id` detail with versions · `PATCH /:id` update · `POST /:id/archive` · `POST /:id/versions` new authored draft · `POST /:id/versions/upload` multipart PDF (10MB cap, `application/pdf` + `%PDF-` magic-byte check) · `POST /:id/versions/:versionId/publish` · `GET /:id/versions/:versionId` (authored: body; uploaded: metadata) · `GET /:id/versions/:versionId/file` (streams uploaded PDF, `Content-Type: application/pdf`).

- [ ] **Step 1:** failing route tests: 403 when org-scoped token creates partner-wide; 400 on ownerScope/orgId mismatch; 409 surfaced from VERSION_IMMUTABLE; upload rejects non-PDF; publish returns declared_variables scanned from body.
- [ ] **Step 2:** implement thin handlers delegating to the service; error mapping mirrors `contracts.ts` sibling file.
- [ ] **Step 3:** run file tests → PASS. Commit — `feat(contracts): contract template routes`

---

## Phase 2 — Proposal integration

### Task 10: contractTemplateRender service (variables + system-context loader)

**Files:**
- Create: `apps/api/src/services/contractTemplateRender.ts`
- Test: `apps/api/src/services/contractTemplateRender.test.ts`

**Interfaces (produces):**

```ts
export type ContractBlockRenderData = {
  blockId: string; templateId: string; templateVersionId: string;
  sourceType: 'authored' | 'uploaded';
  bodyHtml: string | null;          // authored only (sanitized at write; re-sanitized here)
  fileData: Buffer | null;          // uploaded only
  versionSha256: string;            // from the version row
  declaredVariables: ContractVariable[];
  templateName: string; versionNumber: number;
};
/** Resolve every contract block's pinned version content. MUST be called OUTSIDE
 * any org-scoped transaction: runs under withSystemDbAccessContext because
 * partner-owned template rows are invisible to org-scoped RLS contexts (portal!).
 * Version content is immutable, so read-before-transaction is safe. */
export async function loadContractBlockRenderData(blocks: Array<{ id: string; blockType: string; content: unknown }>): Promise<ContractBlockRenderData[]>;
export function resolveAutoVariables(quote: QuoteRow, opts?: { effectiveDate?: string }): Record<string, string>; // formats money via quote currency; dates.effective = opts.effectiveDate ?? today
export function substituteVariables(bodyHtml: string, values: Record<string, string>): { html: string; missing: string[] }; // HTML-escapes every value; missing = placeholders with no value
export function findUnresolvedVariables(data: ContractBlockRenderData, variableValues: Record<string, string>, autoValues: Record<string, string>): string[];
```

- [ ] **Step 1 (failing tests):** substitution escapes `<b>Acme & Co</b>` → `&lt;b&gt;Acme &amp; Co&lt;/b&gt;`; missing manual variable reported; auto variables resolve from a fixture quote (money formatted `$810.00`); loader wraps reads in `withSystemDbAccessContext` (assert via mocked db-context module — see worker-test memory pattern: mock the context module explicitly or CI reds while local greens).
- [ ] **Step 2:** implement; substitution operates on `{{name}}` tokens only (regex `/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g`), leaves unknown tokens in place *and* reports them.
- [ ] **Step 3:** run → PASS. Commit — `feat(contracts): contract block render data + variable substitution`

### Task 11: Quote service accepts contract blocks + cover page (and the repo-wide blockType sweep)

**Files:**
- Modify: `apps/api/src/services/quoteService.ts` (block create/update: validate template/version for `contract` blocks; `updateQuote`: persist `coverPage`; clone: carry coverPage + contract blocks), `apps/api/src/services/aiToolsQuotes.ts` (block-type enumeration parity)
- Test: extend `quoteService.test.ts`, `quoteService.clone.test.ts`

Validation on contract block create/update (service-level, before insert): version exists, belongs to template, `status='published'`, template not archived, and the template is visible to this quote's org/partner (org-owned template → same org; partner-owned → same partner as the quote). Reject otherwise with 422 `INVALID_CONTRACT_TEMPLATE`.

- [ ] **Step 1:** failing tests: contract block with draft version → 422; archived template → 422; cross-partner template → 422; clone carries the contract block content + coverPage verbatim; coverPage patch persists; coverPage `coverImageId` must reference a `quote_images` row on the same quote (mirror the line `imageId` ownership check).
- [ ] **Step 2:** implement. Then sweep: `grep -rn "line_items" --include='*.ts' --include='*.tsx' apps/api/src apps/web/src apps/portal/src packages/shared/src` and touch every enumeration/switch that must learn `'contract'` (known: `quoteService.ts`, `quotePdf.ts` (Task 14), `aiToolsQuotes.ts`, `quoteBlocks.tsx` (Task 13), `QuoteEditor/QuoteDocument/quoteTypes` (Task 16), shared validators (done)). List any additional hits in the commit message.
- [ ] **Step 3:** run API tests → PASS. Commit — `feat(quotes): contract blocks + cover page in quote service (with blockType parity sweep)`

### Task 12: Send-time gate + acceptance hash extension

**Files:**
- Modify: `apps/api/src/services/quoteLifecycle.ts` (send transition), `apps/api/src/services/quoteContentHash.ts`
- Test: extend both test files

Hash change (backwards-compatible — REQUIRED): add optional 4th parameter.

```ts
export type HashableContractPart = { blockId: string; templateVersionSha256: string; resolvedVariables: Record<string, string> };
export function computeQuoteSha256(quote, blocks, lines, contractParts?: HashableContractPart[]): string {
  // ...existing canonical build...
  // Only fold in when non-empty so every pre-contract acceptance hash stays verifiable:
  if (contractParts && contractParts.length > 0) {
    canonical.contracts = [...contractParts]
      .sort((a, b) => a.blockId.localeCompare(b.blockId))
      .map((p) => ({ blockId: p.blockId, versionSha: p.templateVersionSha256,
        vars: Object.fromEntries(Object.entries(p.resolvedVariables).sort(([a], [b]) => a.localeCompare(b))) }));
  }
}
```

Send gate in `quoteLifecycle.ts`: before transitioning draft→sent, if the quote has contract blocks, call `loadContractBlockRenderData` + `findUnresolvedVariables` per block; any unresolved → `QuoteServiceError('Contract variables unresolved: …', 422, 'CONTRACT_VARIABLES_UNRESOLVED')` carrying the variable names. (The lifecycle send path runs under the caller's org context — do the loader call **before** entering the transaction, same immutability argument as Task 10.)

- [ ] **Step 1:** failing tests: hash without contractParts is byte-identical to the pre-change implementation for a fixture (copy an existing expected hash from the current test file); hash changes when a variable value changes; send blocked with the missing-variable list; send passes when all manual variables filled.
- [ ] **Step 2:** implement; run both test files → PASS. Commit — `feat(quotes): send gate for unresolved contract variables + contract-aware acceptance hash`

### Task 13: Portal/public/web serialization + rendering of contract blocks

**Files:**
- Modify: `apps/api/src/routes/portal/quotes.ts`, `apps/api/src/routes/quotesPublic.ts`, `apps/api/src/routes/quotes/quotes.ts` (serialize contract blocks with rendered HTML), `apps/portal/src/components/portal/quoteBlocks.tsx` (render), `apps/web/src/components/billing/quotes/QuoteDocument.tsx` + `quoteTypes.ts`
- Test: route tests + component tests alongside each

Serialization contract (what the client sees for a `contract` block):

```ts
{ blockType: 'contract', content: {
    label?: string, templateName: string, versionNumber: number,
    sourceType: 'authored' | 'uploaded',
    renderedHtml: string | null,      // authored: substituted + sanitized; uploaded: null
    fileUrl: string | null            // uploaded: route that streams the PDF; authored: null
} }
```

- Portal/authed-web: `fileUrl` = existing-style authed asset path (`/portal/quotes/:id/contract-file/:blockId`, mirroring the `/images/:imageId` route). Public: token-gated equivalent under `/quotes/public`.
- The route handlers call `loadContractBlockRenderData` (system context) **before** their org-scoped serialization work, substitute auto+manual variables (auto uses today for `dates.effective` pre-acceptance), and never expose raw `{{tokens}}` (send gate guarantees resolution, but substitute defensively and log if `missing.length > 0` post-send).
- Portal/web render: authored → same `dangerouslySetInnerHTML` path as rich_text (content is sanitizer output), with template name + version footer (`data-testid="contract-block"`); uploaded → `<iframe src={fileUrl} title={templateName}>` with a download link.

- [ ] **Step 1:** failing route tests (portal + public): contract block serializes with renderedHtml containing substituted client name; `{{` never appears in the payload; uploaded version yields fileUrl and null renderedHtml; file route streams `application/pdf` and 404s cross-quote blockIds.
- [ ] **Step 2:** implement API side; **Step 3:** portal + web render cases; **Step 4:** run API + web test suites → PASS. Commit — `feat(quotes): inline contract rendering in portal, public link, and admin views`

### Task 14: PDF — cover page, contract blocks, uploaded-PDF merge

**Files:**
- Modify: `apps/api/src/services/quotePdf.ts` (cover page first; `contract` case in the block loop), `apps/api/src/routes/quotes/quotes.ts` + portal/public PDF routes (post-render merge step)
- Create: merge helper inside `quotePdf.ts` or `apps/api/src/services/pdfMerge.ts` (pdf-lib)
- Test: `quotePdf.test.ts` extensions + `pdfMerge.test.ts`

- Cover page: when `quote.coverPage?.enabled`, render page 1 before any blocks: branding logo (the renderer already receives `branding`), cover image (via `loadImage`, top ~55% of the page, full content width), title (24pt bold), then `Prepared for:` (coverPage.preparedForName ?? billToName + org address lines) and `Prepared by:` (sellerSnapshot name/company) side by side at the bottom (mirroring the reference PDF), then `doc.addPage()`.
- Authored contract block: heading (template name, unless `label` overrides) + `renderRichTextIntoPdf` (Task 2) over the substituted HTML — substituted content comes from the same pre-fetched render data the route already loaded (pass it into `renderQuotePdf` as a new injected input, keeping the renderer pure: `contractRenderData: Map<blockId, { html: string | null }>`).
- Uploaded contract block: the pdfkit pass draws a one-line marker (`<templateName> — attached below`), and the route post-processes: `pnpm add pdf-lib` (apps/api), `mergeUploadedContractPdfs(mainPdf: Buffer, uploads: Array<{ afterMarker: string; data: Buffer }>): Promise<Buffer>` — v1 appends uploaded PDFs' pages after the main document in block order (appending, not interleaving, keeps the merge trivial and matches "contract at the end" usage; note this limitation in a comment).
- [ ] **Step 1:** failing tests: renderQuotePdf with coverPage enabled produces a PDF whose page count grew by 1 (parse with pdf-lib in the test to count pages); contract block HTML renders (assert via the parse-IR path or page count); merge helper output page count = main + upload pages.
- [ ] **Step 2:** implement; **Step 3:** wire all three PDF routes (admin, portal, public) through the merge step; **Step 4:** run tests → PASS. Commit — `feat(quotes): proposal cover page + contract rendering in PDF (pdf-lib merge for uploads)`

### Task 15: Accept flow — executed snapshot + billing-contract linkage

**Files:**
- Create: `apps/api/src/services/contractDocumentService.ts`
- Modify: `apps/api/src/services/quoteAcceptService.ts`, its callers `apps/api/src/routes/portal/quotes.ts` + `apps/api/src/routes/quotesPublic.ts`
- Test: `contractDocumentService.test.ts`, extend `quoteAcceptService` tests
- Create: `apps/api/src/__tests__/integration/quoteContractAccept.integration.test.ts`

**Interfaces:**
- `AcceptQuoteParams` gains `contractRenderData?: ContractBlockRenderData[]` — **pre-fetched by the route handler outside the org-scoped transaction** (portal path; the public path already runs system-scoped but uses the same param for symmetry).
- `contractDocumentService.createExecutedDocuments(quote, acceptanceId, contractIds, renderData, blocks): Promise<string[]>` — for each contract block: substitute variables with `dates.effective` = accept date; authored → render PDF via a small pdfkit doc (branding header + `renderRichTextIntoPdf`); uploaded → PDF = stored file verbatim, rendered_html = null; insert `contract_documents` row with `contract_id = contractIds[0] ?? null` (deterministic: the first created billing contract; comment why), sha256 over the PDF bytes.

In `acceptQuote`: compute `contractParts` from renderData (`templateVersionSha256`, resolved variables) and pass to `computeQuoteSha256`; **after** the Phase-4 contract creation loop (so `contractIds` exists) and **before** the final select, call `createExecutedDocuments`. Same transaction — a thrown error rolls back the entire accept (this is the spec's atomicity requirement; do not catch).
Guard: if the quote has contract blocks but `contractRenderData` is missing/incomplete for any block, throw 500 `CONTRACT_RENDER_DATA_MISSING` — an accept must never silently skip its legal snapshot.

- [ ] **Step 1:** failing unit tests: acceptance with a contract block inserts a contract_documents row linked to acceptance + first contract; hash passed to the acceptance insert includes contractParts; missing renderData throws and nothing is inserted (assert via mock call ordering).
- [ ] **Step 2:** implement service + acceptQuote changes + both route callers (pre-fetch before `withDbAccessContext`/system context transaction).
- [ ] **Step 3 (integration, real Postgres):** `quoteContractAccept.integration.test.ts` — seed partner/org/template/published version/quote with contract block + recurring line; accept via the service under a real system context; assert in one test run: `quote_acceptances.quote_sha256` matches a recomputed hash including the contract part; `contract_documents` row exists with `contract_id` = the created billing contract, valid `%PDF-` magic bytes, sha256 matches `pdf_data`; a second concurrent accept 409s and leaves exactly one document row.
- [ ] **Step 4:** run unit + integration → PASS. Commit — `feat(quotes): executed contract document snapshot on acceptance, linked to billing contract`

---

## Phase 3 — Web UI

### Task 16: Contract Templates tab (library + editor)

**Files:**
- Create: `apps/web/src/components/contracts/TemplatesTab.tsx`, `apps/web/src/components/contracts/TemplateEditor.tsx`, `apps/web/src/lib/api/contractTemplates.ts`
- Modify: `apps/web/src/components/contracts/ContractWorkspace.tsx` (add tab)
- Test: `TemplatesTab.test.tsx`, `TemplateEditor.test.tsx`

- API client: typed wrappers for every Task-9 route (follow `apps/web/src/lib/api/contracts.ts` idiom).
- TemplatesTab: list with name/owner badge ("All orgs" for partner-owned — copy the badge from `PolicyForm.tsx`)/status/latest-version; create dialog with ownerScope selector (create-only) + org picker when org-scoped; archive action. `data-testid="contract-templates-tab"`, rows `data-testid="contract-template-row"`.
- TemplateEditor: `RichTextEditor` (Task 4) for the body, variable chips panel (insert `{{client.name}}` etc. at cursor; list manual variables detected live via the same `{{…}}` regex), version history sidebar (draft/published, publish button), upload-PDF version flow. Preview pane substitutes sample values.
- All mutations via `runAction`; new i18n keys → en+es+fr+de.
- [ ] **Steps:** failing component tests (list renders, create validates ownerScope/org pairing, publish calls API, archived template hides attach affordances) → implement → `pnpm test --filter=@breeze/web` PASS → commit `feat(web): contract template library UI`.

### Task 17: Quote editor — contract block + cover page panel

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx`, `QuoteDocument.tsx`, `quoteTypes.ts`, `apps/web/src/lib/api/quotes.ts`
- Test: `QuoteEditor.contractblock.test.tsx`, `QuoteEditor.coverpage.test.tsx` (new sibling files, matching the existing per-feature test-file pattern)

- Add `'contract'` to `AddableBlockType` + the add-section menu: template picker (fetches active templates), pinned-version display, auto/manual variable form (auto values shown read-only with their source; manual ones editable inputs → `variableValues`).
- Version-nudge: when a block's pinned version < template's latest published, show "Update to vN" button (explicit, never automatic).
- Cover page panel in the quote header area: enable toggle, title input, image pick/upload (reuse the existing quote image upload flow), prepared-for override, live summary. Persist via `updateQuote({ coverPage })`.
- Send-blocked UX: surface the 422 `CONTRACT_VARIABLES_UNRESOLVED` payload as inline errors on the block's variable form.
- [ ] **Steps:** failing tests (add contract block posts correct content; unresolved-variable 422 renders inline; cover page toggle persists) → implement → web tests PASS → commit `feat(web): contract block + cover page in quote editor`.

### Task 18: Executed documents surfaces

**Files:**
- Create: `apps/api/src/routes/contracts/documents.ts` (mount in contracts `index.ts`): `GET /contract-documents?contractId=…|unattached=true`, `GET /contract-documents/:id/pdf` (streams), `PATCH /contract-documents/:id` (`{ contractId }` link-later, org must match)
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx` (Documents section), `TemplatesTab.tsx` or workspace (Unattached documents view)
- Test: route tests + `ContractDetail.documents.test.tsx`

Documents section rows: template name + version, signer (join `quote_acceptances`), signed date, quote number link, Download PDF. `data-testid="contract-documents-section"`.
- [ ] **Steps:** failing route tests (list scoped by contract; unattached filter = `contract_id IS NULL`; PATCH rejects cross-org contract; stream sets `application/pdf`) → implement → API+web tests PASS → commit `feat(contracts): executed contract documents UI + routes`.

---

## Phase 4 — End-to-end

### Task 19: Playwright spec

**Files:**
- Create: `e2e-tests/tests/quote-contract-proposal.spec.ts` (+ page objects under `e2e-tests/pages/` if the flow needs them)

Flow (all `data-testid` selectors; seed via the worktree-stack seeded fixtures — see `e2e-tests/README.md`):
1. Admin: create partner-wide template → author body with `{{client.name}}` + a manual `{{governing_state}}` → publish.
2. Create quote → cover page on → rich_text section (formatted: bold + bullets via the TipTap toolbar) → pricing table → contract block → fill `governing_state` → send fails until filled (assert inline error) → send.
3. Public link: assert contract text renders inline with the substituted client name and formatting (a `<strong>` and `<li>` present inside `[data-testid="contract-block"]`).
4. Accept with typed name.
5. Admin: billing contract detail → Documents section shows the executed MSA v1 → download responds 200 `application/pdf`.
- [ ] **Steps:** write spec → run against the worktree stack (`worktree-stack` skill brings it up) → PASS → commit `test(e2e): full proposal-with-contract lifecycle`.

### Task 20: Full verification pass

- [ ] `node -v` matches 22.20.0.
- [ ] `pnpm test` (workspace-wide) green; `pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts` green (rls-coverage, tenantCascade, contractTemplatesPartnerRls, quoteContractAccept).
- [ ] `pnpm db:check-drift` clean.
- [ ] Manual smoke on the dev stack: build the Animal-Health-style proposal end-to-end (cover, narrative with bullets, two pricing tables, MSA block), send, accept via public link, download the executed PDF, verify formatting fidelity in the PDF.
- [ ] i18n parity: `grep` the locale files for every new key across en/es/fr/de.
- [ ] Use the `verify` skill before declaring done.

---

## Task dependency notes

- Tasks 1→2→3→4 are sequential (Phase 0). Phase 1 (5→6→7→8→9) is independent of Phase 0 except Task 8's sanitize-on-write (needs Task 1).
- Phase 2 needs both: Task 10 needs 5/7; 11 needs 7/8; 12 needs 10; 13 needs 10+3; 14 needs 2+10; 15 needs 10+12.
- Phase 3 needs Phase 2's routes; Task 16 needs Task 4's editor.
- If splitting across workers, Phase 0 and Phase 1 can run in parallel worktrees; everything else is serial enough to keep in one.
