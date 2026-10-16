---
spec: docs/superpowers/specs/billing/2026-10-15-standalone-agreement-signing-spec.md
feature_plan: docs/superpowers/plans/billing/2026-10-15-standalone-agreement-signing.md
---
# Standalone Agreement Signing — W1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared writer for signed agreements (`freezeSignedAgreement`), an evidence snapshot on `contract_documents` back-filled for legacy rows, the `agreement_requests` tables with every tenancy registration, and the **Record signed agreement** flow (service, multipart route, web dialog) — shipped as three PRs (W1a → W1b → W1c).

**Architecture:** W1a refactors the quote accept path's document freeze behind a golden-vector gate and adds a production hash-verification script, with zero schema change. W1b lands the migration, Drizzle schema, cascade/merge/export registrations and the request-aware freeze. W1c adds the on-behalf `record-signed` endpoint and dialog on top. Every quote-path test on `main` keeps its expectations.

**Tech Stack:** Hono, Drizzle (queries), hand-written SQL migrations, PostgreSQL RLS as `breeze_app`, pdfkit, Vitest (unit under `apps/api/vitest.config.ts`; integration under `vitest.integration.config.ts`; RLS coverage under `vitest.config.rls-coverage.ts`), React + Vitest/jsdom (web).

**Spec:** `docs/superpowers/specs/billing/2026-10-15-standalone-agreement-signing-spec.md`. File:line refs below are against `origin/main` @ `509242e9f8` (identical to the spec's `ec95c2f236` for every file named here).

## Global Constraints

Copied from the feature plan; every task inherits them.

- Vocabulary: "Agreement template", "Signed agreement", "Contract", "Agreement request"; never "contract document" in UI; "electronically accepted by", never "signed by".
- Tenancy: `agreement_requests`, `agreement_request_recipients` are Shape 1 (`org_id NOT NULL`, four per-command `breeze_has_org_access(org_id)` policies, template `apps/api/migrations/2026-07-16-contract-documents.sql:143-157`). Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`; `SET NULL` composite FKs name their column list. No `signed_agreement_id` back-reference; no `CASCADE_ORDER_SET_NULL_EDGE_BREAKS` entry.
- Migration: `apps/api/migrations/2026-12-29-100000-agreement-requests.sql` (newest on `origin/main` at plan time: `2026-12-28-130000-pam-reconciliation-reset-capability.sql`; **re-run** `git ls-tree --name-only origin/main apps/api/migrations/ | sed 's#.*/##' | grep -E '^[0-9]{4}-.*\.sql$' | node -e 'const n=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean);console.log(n.sort((a,b)=>a.localeCompare(b)).pop())'` before committing and rename to sort after whatever it prints). Idempotent; no inner `BEGIN;`/`COMMIT;`; `SELECT set_config('breeze.scope', 'system', true);` first; RLS in the same file; then `pnpm db:migrate && pnpm db:check-drift`.
- Registrations: `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts:505-523`), `orgMergeRegistry.ts` repoint list (`apps/api/src/services/orgMergeRegistry.ts:872` neighbourhood), `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts:340`, `:727-734`). No device/ticket lists, no `OBJECT_PRECLEAR_TABLES`.
- Export buckets: `excludedSensitive` = `accept_token_jti`, `accept_token_issued_at`, `accept_token_expires_at`, `accept_token_kid`, `public_response_jti`; `excludedOpen` = `variable_values`, `client_address_snapshot`, `seller_snapshot`, `pdf_data`; `reviewedIncluded` = `content_sha256`, `content_hash_version`; everything else `included`.
- CI: integration/contract suites run only under **Integration Tests** (8 shards). A stacked PR gets no CI → `gh workflow run CI --ref <branch>`. Scoped runs: `cd apps/api && npx vitest run <path>`; never `pnpm --filter <pkg> test -- --run <path>`. RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. Integration suites need `pnpm test-stack up` (tear down with `pnpm test-stack down` when done).
- Hash compatibility is an input property: the quote-context variable map, accepted-date pin, persisted locale (NULL → `'en'`) and v1/v2 canonical forms are unchanged by the extraction.
- `findUnresolvedVariables` tests key presence: the request auto map **omits** `quote.number`, `quote.title`, `totals.one_time`, `totals.monthly`, `totals.annual`, `totals.total`, `dates.expiry`.
- Web mutations through `runAction`; no `runActionAllowlist.ts` additions; new `en` keys in all 8 `apps/web/src/locales/*/billing.json`; `data-testid` prefix `agreements-`.
- W1 gates `record-signed` on `agreements:write` (PR body states it; W2 moves it to `agreements:send`).

## Review Focus

Each line names the input, the expected behaviour, and the task that pins it with a test.

1. **PNG externally-signed copy downloaded via `/contract-documents/:id/pdf`** must arrive as `signed-agreement-<id>.png`, `Content-Disposition: attachment` — Task 14.
2. **`signedAt` later than now + 5 min on record-signed** → 400 `SIGNED_AT_IN_FUTURE`, nothing inserted — Task 12 (schema) + Task 13 (service).
3. **Template declaring `{{totals.monthly}}` recorded as a request** → 422 `AGREEMENT_VARIABLES_UNRESOLVED` naming `totals.monthly`, no `agreement_requests` or `contract_documents` row — Task 9 (map omits key) + Task 13.
4. **`contractId` belonging to another org on record-signed** → 404 `CONTRACT_NOT_FOUND` from the service's pre-check; the composite FK (23503) is the backstop proven in Task 7 — Task 13.
5. **Legacy `contract_documents` row whose `quote_acceptance_id` is already NULL** stays `source_kind='quote'` with NULL evidence after the back-fill; the list row renders "accepted via quote — acceptance evidence unavailable" instead of a blank signer — Task 6 (back-fill test) + Task 8 (list projection) + Task 16 (row copy).

## Model routing

- **Top-tier (Fable/Opus in-session, Sonnet/Opus review):** Tasks 1, 3, 4, 5 (W1a contract + golden gate); 6, 7, 10 (W1b SQL review, RLS/CHECK tests, request-aware freeze); 13, 15 (W1c service + route auth).
- **Cheap-implementable (Laguna / Codex `medium` / Haiku with the file list; verified by tsc + the named tests):** Tasks 2 (script), 8 (list projection), 9 (request map), 11 (`computeAgreementSha256`), 12 (validator), 14 (filename), 16, 17 (dialog, locale keys), 18 (integration seed/asserts from the stated contract).

---

# W1a — Extraction, zero schema

Branch `feature/8865-standalone-agreement-signing/wave-<W1 sub-issue#>` off `main`. PR title `feat(agreements): shared signed-agreement freeze path + acceptance-hash verify script (#8865 W1a)`.

### Task 1: Golden characterization vectors for the acceptance hash (gate for every later task)

This task deliberately inverts red-first: it is a **characterization** test recorded on unrefactored `main`. Record first, commit, then every refactor must keep it green. The real-row check is Task 2's script.

**Files:**
- Create: `apps/api/src/services/quoteAcceptanceHash.golden.test.ts`

**Interfaces:**
- Consumes: `buildContractHashParts(blocks, renderData, quote, effectiveDate, renderLocale)` (`apps/api/src/services/contractDocumentService.ts:117-132`), `computeQuoteSha256(quote, blocks, lines, parts, version)` (`apps/api/src/services/quoteContentHash.ts:50`), `resolveAutoVariables(quote, opts)` (`apps/api/src/services/contractTemplateRender.ts:289`).
- Produces: five pinned hex constants + one pinned variable map that Tasks 3–5 and W1b Task 10 must preserve.

- [ ] **Step 1: Write the test with placeholder expectations**

Mock only `../db` (the `contractTemplateRender.test.ts:8-12` idiom — the resolver is pure and must run for real):

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
import { buildContractHashParts } from './contractDocumentService';
import { computeQuoteSha256 } from './quoteContentHash';
import { resolveAutoVariables } from './contractTemplateRender';
import type { ContractBlockRenderData, QuoteRow } from './contractTemplateRender';

// A FULL quotes row. Define a local fixtureQuote() by copying the one at
// contractTemplateRender.test.ts:46-110 (test files do not export it) and override the
// fields below. Fixed ids, fixed money, fixed dates — nothing from Date.now().
const quote = fixtureQuote({
  id: '11111111-1111-4111-8111-111111111111', orgId: 'org-1', partnerId: 'p-1',
  currencyCode: 'EUR', documentLocale: 'fr-FR', billToName: 'Société Exemple',
  billToAddress: { line1: '1 rue A', city: 'Paris', postalCode: '75001', country: 'FR' },
  sellerSnapshot: { name: 'MSP SARL' }, quoteNumber: 'Q-2026-0042', title: 'BAA',
  subtotal: '1234.50', taxTotal: '0.00', total: '1234.50',
  oneTimeTotal: '234.50', monthlyRecurringTotal: '1000.00', annualRecurringTotal: '0.00',
  expiryDate: '2026-11-30', acceptedAt: new Date('2026-10-01T10:00:00.000Z'),
});
const block = { id: 'blk-1', blockType: 'contract', sortOrder: 0,
  content: { templateId: 't-1', templateVersionId: 'v-1', variableValues: { 'client.name': 'Override Co', 'custom.po': 'PO-7' } } };
const line = { id: 'ln-1', description: 'Managed services', quantity: '10', unitPrice: '100.00', lineTotal: '1000.00',
  recurrence: 'monthly', taxable: true, customerVisible: true, sortOrder: 0,
  contractLineType: 'per_device', deviceRoles: ['workstation', 'server'], deviceGroupName: null, siteName: null,
  includedQuantity: null, overageMode: null, overageUnitPrice: null };
const renderData: ContractBlockRenderData[] = [{
  blockId: 'blk-1', templateId: 't-1', templateVersionId: 'v-1', sourceType: 'authored',
  bodyHtml: '<p>{{client.name}} {{totals.monthly}} {{dates.effective}} {{custom.po}}</p>', fileData: null,
  versionSha256: 'b'.repeat(64), declaredVariables: [], templateName: 'BAA', versionNumber: 3 }];
const EFFECTIVE = '2026-10-01';

const hash = (locale: string, version: 1 | 2) =>
  computeQuoteSha256(quote as any, [block] as any, [line] as any,
    buildContractHashParts([block], renderData, quote, EFFECTIVE, locale), version);

describe('acceptance hash golden vectors (characterization — recorded on main before the freeze extraction)', () => {
  it('v2 fr-FR', () => expect(hash('fr-FR', 2)).toBe('REPLACE_ME'));
  it('v1 fr-FR', () => expect(hash('fr-FR', 1)).toBe('REPLACE_ME'));
  it("v2 'en' (explicit)", () => expect(hash('en', 2)).toBe('REPLACE_ME'));
  it("v1 legacy NULL render_locale → 'en'", () => expect(hash('en', 1)).toBe(hash('en', 1)) /* pinned below */);
  it('v2 with no contract parts (pre-contract acceptance)', () =>
    expect(computeQuoteSha256(quote as any, [block] as any, [line] as any, [], 2)).toBe('REPLACE_ME'));
  it('quote-context HTML map is key- and value-stable', () => {
    expect(resolveAutoVariables(quote, { effectiveDate: EFFECTIVE, renderLocale: 'fr-FR' })).toEqual({ /* REPLACE_ME */ });
  });
  it('pdf map differs from the HTML map only in money formatting', () => {
    const html = resolveAutoVariables(quote, { effectiveDate: EFFECTIVE, renderLocale: 'fr-FR' });
    const pdf = resolveAutoVariables(quote, { effectiveDate: EFFECTIVE, renderLocale: 'fr-FR', pdf: true });
    expect(Object.keys(pdf).sort()).toEqual(Object.keys(html).sort());
    expect(pdf['client.name']).toBe(html['client.name']);
    expect(pdf['totals.monthly']).not.toBe(html['totals.monthly']); // U+202F → NBSP
  });
});
```

- [ ] **Step 2: Run it to harvest the real values**

Run: `cd apps/api && npx vitest run src/services/quoteAcceptanceHash.golden.test.ts`
Expected: FAIL on every `REPLACE_ME`; the diff output prints the actual 64-hex strings and the actual map.

- [ ] **Step 3: Pin the harvested values**

Paste each actual hex and the full map (11 keys: `client.name` = `'Société Exemple'` — the manual override is applied by `buildContractHashParts`, not by the resolver — `client.address`, `seller.name`, `quote.number`, `quote.title`, `totals.one_time`, `totals.monthly`, `totals.annual`, `totals.total`, `dates.effective`, `dates.expiry`). Replace the self-comparing v1-NULL case with the v1 `'en'` hex. Add a comment on top: `// DO NOT regenerate. These were recorded at origin/main 509242e9f8 before freezeSignedAgreement existed.`

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/quoteAcceptanceHash.golden.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quoteAcceptanceHash.golden.test.ts
git commit -m "test(quotes): pin acceptance-hash golden vectors before the freeze extraction (#8865 W1a)"
```

### Task 2: Production acceptance-hash verification script (spec §8 rollout gate)

`verifyQuoteAcceptanceHash` (`apps/api/src/services/quoteAcceptanceVerify.ts:46`) has no production caller on `main`. This makes the post-deploy check runnable inside the image.

**Files:**
- Create: `apps/api/scripts/verify-acceptance-hashes.lib.ts`, `apps/api/scripts/verify-acceptance-hashes.lib.test.ts`, `apps/api/scripts/verify-acceptance-hashes.ts`
- Modify: `apps/api/tsup.config.ts:10-20` (add entry), `apps/api/package.json` scripts (add `acceptances:verify-hashes` + `:prod`)

**Interfaces:**
- Produces:
  ```ts
  // verify-acceptance-hashes.lib.ts
  export type ParsedVerifyArgs = { limit: number; orgId?: string; partnerId?: string; since?: string };
  export function parseVerifyArgs(argv: string[]): ParsedVerifyArgs;   // defaults limit=50; --limit N (1..5000); --org-id/--partner-id uuid; --since ISO date
  export type VerifyOutcome = { acceptanceId: string; quoteId: string; hashVersion: 1 | 2; renderLocale: string; matches: boolean; error?: string };
  export function summarize(outcomes: VerifyOutcome[]): { checked: number; matches: number; mismatches: number; errors: number; exitCode: 0 | 1 | 2 };
  // exitCode: 0 all match; 1 ≥1 mismatch; 2 no mismatches but ≥1 error (acceptance/quote gone, unsupported version)
  ```
- Consumes: `verifyQuoteAcceptanceHash(acceptanceId)` under `runOutsideDbContext(() => withSystemDbAccessContext(...))` (same wrapping as `documentLocaleBackfill.integration.test.ts:140`).

- [ ] **Step 1: Write the failing lib test**

```ts
import { describe, it, expect } from 'vitest';
import { parseVerifyArgs, summarize } from './verify-acceptance-hashes.lib';

describe('parseVerifyArgs', () => {
  it('defaults limit to 50', () => expect(parseVerifyArgs([]).limit).toBe(50));
  it('reads --limit and clamps to 5000', () => expect(parseVerifyArgs(['--limit', '9999']).limit).toBe(5000));
  it('rejects a non-uuid --org-id', () => expect(() => parseVerifyArgs(['--org-id', 'nope'])).toThrow(/org-id/));
});
describe('summarize', () => {
  it('exit 1 on any mismatch', () =>
    expect(summarize([{ acceptanceId: 'a', quoteId: 'q', hashVersion: 2, renderLocale: 'en', matches: false }]).exitCode).toBe(1));
  it('exit 2 on errors without mismatches', () =>
    expect(summarize([{ acceptanceId: 'a', quoteId: 'q', hashVersion: 2, renderLocale: 'en', matches: true, error: 'Quote not found' }]).exitCode).toBe(2));
  it('exit 0 when everything matches', () =>
    expect(summarize([{ acceptanceId: 'a', quoteId: 'q', hashVersion: 1, renderLocale: 'en', matches: true }]).exitCode).toBe(0));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run scripts/verify-acceptance-hashes.lib.test.ts`
Expected: FAIL — `Cannot find module './verify-acceptance-hashes.lib'`.

- [ ] **Step 3: Implement the lib + the script**

`verify-acceptance-hashes.lib.ts`: pure argv parsing (UUID regex from `link-evidence-reports.lib.ts:8`) and `summarize`. `verify-acceptance-hashes.ts` (header comment in the `scripts/upgrade-preflight.ts:1-22` style, usage lines `pnpm --filter @breeze/api acceptances:verify-hashes --limit 100` and `docker exec breeze-api node dist/scripts/verify-acceptance-hashes.cjs --limit 100`): select the newest `limit` `quote_acceptances.id` (filter by `org_id` / `quotes.partner_id` / `signed_at >= since`) under `withSystemDbAccessContext`, call `verifyQuoteAcceptanceHash` per id inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`, catch per-row errors into `error`, print one line per mismatch/error (ids only, never signer names), print the summary JSON, `closeDb()`, exit with `summary.exitCode`. tsup entry: `'scripts/verify-acceptance-hashes': 'scripts/verify-acceptance-hashes.ts'`. package.json: `"acceptances:verify-hashes": "tsx scripts/verify-acceptance-hashes.ts"`, `"acceptances:verify-hashes:prod": "node dist/scripts/verify-acceptance-hashes.cjs"`.

- [ ] **Step 4: Run tests + build**

Run: `cd apps/api && npx vitest run scripts/verify-acceptance-hashes.lib.test.ts && pnpm build && ls dist/scripts/verify-acceptance-hashes.cjs`
Expected: PASS (6 tests); the `.cjs` exists.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/verify-acceptance-hashes.lib.ts apps/api/scripts/verify-acceptance-hashes.lib.test.ts apps/api/scripts/verify-acceptance-hashes.ts apps/api/tsup.config.ts apps/api/package.json
git commit -m "feat(quotes): verify-acceptance-hashes operator script (#8865 W1a)"
```

### Task 3: `AgreementRenderContext` and the context-based resolver

**Files:**
- Modify: `apps/api/src/services/contractTemplateRender.ts:279-326` (resolver), `:516`, `:589` (callers)
- Modify: `apps/api/src/services/contractDocumentService.ts:73-81` (`resolvedValuesForBlock`)
- Modify: `apps/api/src/services/quoteLifecycle.ts:456` (caller)
- Test: `apps/api/src/services/contractTemplateRender.test.ts:138-215` (existing `resolveAutoVariables` block; add a new `describe`)

**Interfaces:**
- Produces:
  ```ts
  // contractTemplateRender.ts
  export interface AgreementRenderContext {
    clientName: string;
    clientAddress: BillToAddress | null;
    sellerName: string;
    currencyCode: string;
    renderLocale: string;                 // already resolved by the factory — no precedence logic in the resolver
    effectiveDate: string | Date;
    quote?: {
      number: string | null; title: string | null; expiryDate: string | null;
      totals: { oneTime: string; monthly: string; annual: string; total: string };
    };
  }
  export function renderContextFromQuote(
    quote: QuoteRow,
    opts?: { effectiveDate?: string | Date; locale?: string | null; renderLocale?: string | null },
  ): AgreementRenderContext;             // renderLocale = opts.renderLocale ?? quote.documentLocale ?? opts.locale ?? 'en' (contractTemplateRender.ts:308 precedence, verbatim); effectiveDate = opts.effectiveDate ?? new Date()
  export function resolveAutoVariables(ctx: AgreementRenderContext, opts?: { pdf?: boolean }): Record<string, string>;
  /** Back-compat wrapper for quote callers — identical output to the pre-W1 function. */
  export function resolveQuoteAutoVariables(
    quote: QuoteRow,
    opts?: { effectiveDate?: string | Date; locale?: string | null; pdf?: boolean; renderLocale?: string | null },
  ): Record<string, string>;
  ```
- Rule: when `ctx.quote` is `undefined`, the returned map has exactly the four keys `client.name`, `client.address`, `seller.name`, `dates.effective` — the seven quote-only keys are **absent**, not `''`.

- [ ] **Step 1: Write the failing tests** (append to `contractTemplateRender.test.ts`)

```ts
describe('renderContextFromQuote + resolveAutoVariables(ctx)', () => {
  it('quote context map equals resolveQuoteAutoVariables (back-compat wrapper) key for key', () => {
    const q = fixtureQuote({ currencyCode: 'EUR', documentLocale: 'de-DE' });
    const viaCtx = resolveAutoVariables(renderContextFromQuote(q, { effectiveDate: '2026-09-15' }));
    expect(viaCtx).toEqual(resolveQuoteAutoVariables(q, { effectiveDate: '2026-09-15' }));
    expect(Object.keys(viaCtx)).toHaveLength(11);
  });
  it('renderLocale precedence is unchanged: renderLocale > documentLocale > locale > en', () => {
    const q = fixtureQuote({ currencyCode: 'EUR', documentLocale: 'de-DE' });
    expect(renderContextFromQuote(q, { renderLocale: 'fr-FR', locale: 'en' }).renderLocale).toBe('fr-FR');
    expect(renderContextFromQuote(q, { locale: 'en' }).renderLocale).toBe('de-DE');
    expect(renderContextFromQuote(fixtureQuote({ documentLocale: null }), { locale: 'fr-CA' }).renderLocale).toBe('fr-CA');
    expect(renderContextFromQuote(fixtureQuote({ documentLocale: null })).renderLocale).toBe('en');
  });
  it('a context without a quote OMITS the quote-only keys (findUnresolvedVariables is key-presence)', () => {
    const map = resolveAutoVariables({
      clientName: 'Acme', clientAddress: null, sellerName: 'MSP', currencyCode: 'USD', renderLocale: 'en', effectiveDate: '2026-10-01',
    });
    expect(Object.keys(map).sort()).toEqual(['client.address', 'client.name', 'dates.effective', 'seller.name']);
    expect(map).not.toHaveProperty('totals.monthly');
    expect(map).not.toHaveProperty('dates.expiry');
  });
  it('pdf: true routes money through formatMoneyForPdf for a quote context only', () => {
    const q = fixtureQuote({ currencyCode: 'EUR', documentLocale: 'fr-FR', total: '1000.00' });
    const pdf = resolveAutoVariables(renderContextFromQuote(q), { pdf: true });
    expect(pdf['totals.total']).not.toContain(' ');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractTemplateRender.test.ts`
Expected: FAIL — `renderContextFromQuote is not a function` / `resolveQuoteAutoVariables` missing.

- [ ] **Step 3: Implement**

In `contractTemplateRender.ts`: add the interface and `renderContextFromQuote` (reads exactly the fields the old function read: `billToName ?? ''`, `billToAddress`, `sellerSnapshot.name ?? ''`, `currencyCode ?? 'USD'`, totals, `quoteNumber`, `title`, `expiryDate`). Rewrite `resolveAutoVariables(ctx, opts)` to build the base four keys then `...(ctx.quote ? { 'quote.number', 'quote.title', 'totals.*', 'dates.expiry' } : {})` using `formatMoney`/`formatMoneyForPdf` with `ctx.currencyCode`, `ctx.renderLocale`, and `formatDate(ctx.effectiveDate)` / `formatDate(ctx.quote.expiryDate)`. Add `resolveQuoteAutoVariables` = `resolveAutoVariables(renderContextFromQuote(quote, opts), { pdf: opts?.pdf })`. Update the three internal callers (`:516`, `:589`, `quoteLifecycle.ts:456`) and `contractDocumentService.ts:80` to `resolveQuoteAutoVariables` (same arguments). Keep the doc comments' locale explanation on `renderContextFromQuote`.

- [ ] **Step 4: Run the gate**

Run: `cd apps/api && npx vitest run src/services/contractTemplateRender.test.ts src/services/quoteAcceptanceHash.golden.test.ts src/services/contractDocumentService.test.ts src/services/quoteLifecycle.test.ts`
Expected: all PASS; golden vectors unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractTemplateRender.ts apps/api/src/services/contractTemplateRender.test.ts apps/api/src/services/contractDocumentService.ts apps/api/src/services/quoteLifecycle.ts
git commit -m "refactor(agreements): AgreementRenderContext + context-based resolveAutoVariables (#8865 W1a)"
```

### Task 4: `assertTemplateVersionUsable` extracted from `quoteService`

**Files:**
- Modify: `apps/api/src/services/contractTemplateService.ts:94-122` (codes), append the new function
- Modify: `apps/api/src/services/quoteService.ts:1581-1608`
- Test: `apps/api/src/services/contractTemplateService.test.ts` (new `describe`), existing `quoteService.test.ts:292`, `quoteService.clone.test.ts:336` unchanged

**Interfaces:**
- Produces:
  ```ts
  // contractTemplateService.ts — add to ContractTemplateServiceErrorCode: 'VERSION_NOT_PUBLISHED' | 'TEMPLATE_NOT_VISIBLE'
  export interface TemplateVersionRef { templateId: string; templateVersionId: string }
  export async function assertTemplateVersionUsable(
    ref: TemplateVersionRef,
    target: { orgId: string; partnerId: string },
    dbc: Pick<typeof db, 'select'> = db,
  ): Promise<void>;
  // throws ContractTemplateServiceError(…, 422, 'VERSION_NOT_PUBLISHED')  — version missing, belongs to another template, or not 'published'
  //        ContractTemplateServiceError(…, 422, 'TEMPLATE_ARCHIVED')      — template missing or archived
  //        ContractTemplateServiceError(…, 422, 'TEMPLATE_NOT_VISIBLE')   — org-owned by another org, or partner-wide under another partner
  ```
- `quoteService.assertContractBlockValid(content, quote, dbc)` keeps its signature; body = `try { await assertTemplateVersionUsable(content, quote, dbc) } catch (e) { if (e instanceof ContractTemplateServiceError) throw new QuoteServiceError(e.message, 422, 'INVALID_CONTRACT_TEMPLATE'); throw e }`.

- [ ] **Step 1: Write the failing tests** in `contractTemplateService.test.ts` (use that file's existing `../db` mock idiom; queue one row for the version select and one for the template select)

```ts
describe('assertTemplateVersionUsable', () => {
  const ref = { templateId: 't1', templateVersionId: 'v1' };
  it('rejects an unpublished version (422 VERSION_NOT_PUBLISHED)', async () => {
    queueSelect([{ templateId: 't1', status: 'draft' }]);
    await expect(assertTemplateVersionUsable(ref, { orgId: 'o1', partnerId: 'p1' }))
      .rejects.toMatchObject({ status: 422, code: 'VERSION_NOT_PUBLISHED' });
  });
  it('rejects a version of a different template', async () => {
    queueSelect([{ templateId: 'OTHER', status: 'published' }]);
    await expect(assertTemplateVersionUsable(ref, { orgId: 'o1', partnerId: 'p1' })).rejects.toMatchObject({ code: 'VERSION_NOT_PUBLISHED' });
  });
  it('rejects an archived template (422 TEMPLATE_ARCHIVED)', async () => {
    queueSelect([{ templateId: 't1', status: 'published' }]); queueSelect([{ status: 'archived', orgId: null, partnerId: 'p1' }]);
    await expect(assertTemplateVersionUsable(ref, { orgId: 'o1', partnerId: 'p1' })).rejects.toMatchObject({ code: 'TEMPLATE_ARCHIVED' });
  });
  it("rejects another partner's partner-wide template (422 TEMPLATE_NOT_VISIBLE)", async () => {
    queueSelect([{ templateId: 't1', status: 'published' }]); queueSelect([{ status: 'active', orgId: null, partnerId: 'p2' }]);
    await expect(assertTemplateVersionUsable(ref, { orgId: 'o1', partnerId: 'p1' })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_VISIBLE' });
  });
  it("rejects another org's org-owned template", async () => {
    queueSelect([{ templateId: 't1', status: 'published' }]); queueSelect([{ status: 'active', orgId: 'o2', partnerId: null }]);
    await expect(assertTemplateVersionUsable(ref, { orgId: 'o1', partnerId: 'p1' })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_VISIBLE' });
  });
  it('accepts a published version of an active partner-wide template under the same partner', async () => {
    queueSelect([{ templateId: 't1', status: 'published' }]); queueSelect([{ status: 'active', orgId: null, partnerId: 'p1' }]);
    await expect(assertTemplateVersionUsable(ref, { orgId: 'o1', partnerId: 'p1' })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractTemplateService.test.ts`
Expected: FAIL — `assertTemplateVersionUsable` is not exported.

- [ ] **Step 3: Implement** — move the body of `quoteService.ts:1581-1608` verbatim (two selects, same visibility rule) into `contractTemplateService.ts`, throwing the three codes above; replace `quoteService.assertContractBlockValid`'s body with the wrapper. `contractTemplateService.ts` must **not** import `quoteTypes` (keep it a leaf).

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/services/contractTemplateService.test.ts src/services/quoteService.test.ts src/services/quoteService.clone.test.ts` — Expected: PASS, no expectation changes in the quote files.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractTemplateService.ts apps/api/src/services/contractTemplateService.test.ts apps/api/src/services/quoteService.ts
git commit -m "refactor(agreements): extract assertTemplateVersionUsable from quoteService (#8865 W1a)"
```

### Task 5: `freezeSignedAgreement` (quote source) and `createExecutedDocuments` delegation

**Files:**
- Modify: `apps/api/src/services/contractDocumentService.ts:134-292`
- Test: `apps/api/src/services/contractDocumentService.test.ts:103-233` (existing `createExecutedDocuments` block stays; add a `freezeSignedAgreement` block)

**Interfaces:**
- Produces:
  ```ts
  export interface SignedAgreementRender {
    sourceType: 'authored' | 'uploaded'; bodyHtml: string | null; fileData: Buffer | null;
    templateName: string; versionSha256: string;
  }
  export interface FreezeSignedAgreementInput {
    source: { kind: 'quote'; quoteId: string; quoteAcceptanceId: string };   // W1b adds | { kind: 'request'; agreementRequestId: string }
    orgId: string; contractId: string | null; templateId: string; templateVersionId: string;
    render: SignedAgreementRender;
    ctx: AgreementRenderContext;
    manualValues: Record<string, string>;
    /** Quote path only: a raw {{token}} after substitution is logged + blanked (today's :246-260 behaviour). Request paths pass false and the freeze throws instead (W1b). */
    allowUnresolvedFallback: boolean;
  }
  export async function freezeSignedAgreement(input: FreezeSignedAgreementInput): Promise<{ id: string; sha256: string }>;
  ```
- Invariant (keep in the file header): runs **inside the caller's transaction** on the bare `db`; a throw rolls the caller back; the HTML-form map fills `rendered_html` and the hash, the `pdf: true` map fills the pdfkit text.
- `createExecutedDocuments(quote, acceptanceId, contractIds, renderData, blocks, effectiveDate, renderLocale)` keeps its signature and return type; it now builds `ctx = renderContextFromQuote(quote, { effectiveDate, renderLocale })` once and calls `freezeSignedAgreement` per block. `renderAuthoredContractPdf(templateName, html, ctx)` reads `ctx.sellerName`, `ctx.clientName`, `ctx.effectiveDate` (the only three fields it read from the quote, `:167-171`).

- [ ] **Step 1: Write the failing tests**

```ts
describe('contractDocumentService.freezeSignedAgreement (quote source)', () => {
  beforeEach(() => { insertedValues.length = 0; vi.clearAllMocks(); });
  const ctx = { clientName: 'Acme Co', clientAddress: null, sellerName: 'MSP LLC', currencyCode: 'USD', renderLocale: 'en', effectiveDate: EFFECTIVE,
    quote: { number: 'Q-1', title: 'Proposal', expiryDate: '2026-08-01', totals: { oneTime: '100.00', monthly: '10.00', annual: '0.00', total: '110.00' } } };
  it('inserts one row with quote linkage, rendered_html from the HTML map and sha256 over the pdf', async () => {
    const out = await freezeSignedAgreement({
      source: { kind: 'quote', quoteId: 'q1', quoteAcceptanceId: 'acc1' }, orgId: 'org1', contractId: 'contractA',
      templateId: 't1', templateVersionId: 'v1',
      render: { sourceType: 'authored', bodyHtml: '<p>{{client.name}} {{totals.monthly}}</p>', fileData: null, templateName: 'MSA', versionSha256: 'a'.repeat(64) },
      ctx, manualValues: {}, allowUnresolvedFallback: true,
    });
    const row = insertedValues[0]!;
    expect(out).toEqual({ id: 'doc-1', sha256: row.sha256 });
    expect(row).toMatchObject({ orgId: 'org1', quoteId: 'q1', quoteAcceptanceId: 'acc1', contractId: 'contractA', templateId: 't1', templateVersionId: 'v1' });
    expect(row.renderedHtml).toContain('Acme Co');
    expect(row.renderedHtml).toContain('$10.00');
  });
  it('manual values win over auto values', async () => { /* manualValues: { 'client.name': 'Override' } → renderedHtml contains 'Override' */ });
  it('uploaded render stores fileData verbatim with rendered_html null', async () => { /* sourceType: 'uploaded', fileData: Buffer.from('%PDF-1.4 x') */ });
  it('throws CONTRACT_RENDER_DATA_MISSING (500) for an uploaded render with no bytes', async () => { /* fileData: null → rejects QuoteServiceError code */ });
  it('createExecutedDocuments produces byte-identical rows to a direct freezeSignedAgreement call', async () => {
    await createExecutedDocuments(makeQuote(), 'acc1', ['contractA'], [authoredRenderData()], [authoredBlock], EFFECTIVE, 'en');
    const viaLoop = { ...insertedValues[0]! }; insertedValues.length = 0;
    await freezeSignedAgreement({ source: { kind: 'quote', quoteId: 'q1', quoteAcceptanceId: 'acc1' }, orgId: 'org1', contractId: 'contractA',
      templateId: 't1', templateVersionId: 'v1', render: { sourceType: 'authored', bodyHtml: authoredRenderData().bodyHtml, fileData: null, templateName: 'Master Services Agreement', versionSha256: 'a'.repeat(64) },
      ctx: renderContextFromQuote(makeQuote(), { effectiveDate: EFFECTIVE, renderLocale: 'en' }), manualValues: {}, allowUnresolvedFallback: true });
    expect(insertedValues[0]!.renderedHtml).toBe(viaLoop.renderedHtml);
    // pdfkit stamps CreationDate; compare everything but the /CreationDate line.
    const strip = (b: Buffer) => b.toString('latin1').replace(/\/CreationDate \(D:[^)]*\)/, '');
    expect(strip(insertedValues[0]!.pdfData as Buffer)).toBe(strip(viaLoop.pdfData as Buffer));
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && npx vitest run src/services/contractDocumentService.test.ts` — Expected: FAIL, `freezeSignedAgreement` not exported.

- [ ] **Step 3: Implement** — lift the per-block body of `createExecutedDocuments` (`:219-289`) into `freezeSignedAgreement`; `resolvedValuesForBlock` becomes `{ ...resolveAutoVariables(ctx, { pdf }), ...manualValues }`; the unresolved branch (`:246-260`) runs only when `allowUnresolvedFallback` is true, otherwise `throw new QuoteServiceError('Agreement variables unresolved: ' + missing.join(', '), 422, 'AGREEMENT_VARIABLES_UNRESOLVED')` (add the code to `QuoteServiceErrorCode` in `quoteTypes.ts`). Insert `source.kind === 'quote' ? { quoteId, quoteAcceptanceId } : {}` — only the quote branch exists in W1a. `createExecutedDocuments` loops blocks → `freezeSignedAgreement`, returns the ids.

- [ ] **Step 4: Run the full gate**

Run: `cd apps/api && npx vitest run src/services/contractDocumentService.test.ts src/services/quoteAcceptService.test.ts src/services/quoteAcceptanceVerify.test.ts src/services/quoteAcceptanceHash.golden.test.ts src/services/contractTemplateRender.test.ts && pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json`
Expected: all PASS; tsc clean (12 GB heap: `NODE_OPTIONS=--max-old-space-size=12288`; check the exit code, never pipe to `tail`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractDocumentService.ts apps/api/src/services/contractDocumentService.test.ts apps/api/src/services/quoteTypes.ts
git commit -m "refactor(agreements): freezeSignedAgreement shared writer; quote accept delegates to it (#8865 W1a)"
```

**W1a wrap-up:** `pnpm test-stack up`, run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/quoteAccept.integration.test.ts src/__tests__/integration/quoteAcceptOnBehalf.integration.test.ts src/__tests__/integration/multiCurrencyWave6QuoteAcceptance.integration.test.ts src/__tests__/integration/documentLocaleBackfill.integration.test.ts`, then `pnpm test-stack down`. Open the PR (body: hash-compat statement, the script, "no schema change"). **After merge + deploy:** run `docker exec breeze-api node dist/scripts/verify-acceptance-hashes.cjs --limit 100` on EU and US; paste the summary on #8865.

---

# W1b — Migration, schema, registrations, request-aware freeze

Base `main` once W1a merges (otherwise stack on W1a and `gh workflow run CI --ref <branch>`). PR title `feat(agreements): agreement_requests tables + contract_documents evidence snapshot (#8865 W1b)`.

### Task 6: Migration + Drizzle schema + back-fill test

**Files:**
- Create: `apps/api/migrations/2026-12-29-100000-agreement-requests.sql`
- Modify: `apps/api/src/db/schema/contractDocuments.ts` (add `agreementRequests`, `agreementRequestRecipients` above `contractDocuments`; extend `contractDocuments`)
- Create: `apps/api/src/__tests__/integration/contractDocumentsEvidenceBackfill.integration.test.ts`

**Interfaces:**
- Produces Drizzle exports `agreementRequests`, `agreementRequestRecipients` (`schema/index.ts:160` already re-exports the file), types `AgreementRequestRow = typeof agreementRequests.$inferSelect`.
- The SQL (cheap-implementable from this spec; top-tier reviews CHECK/FK direction):

```sql
-- Agreement requests + signer-evidence snapshot on contract_documents
-- (spec docs/superpowers/specs/billing/2026-10-15-standalone-agreement-signing-spec.md §4).
-- Idempotent; no inner BEGIN/COMMIT. System scope FIRST: the back-fill below
-- UPDATEs contract_documents, which is FORCE RLS (issue #4518).
SELECT set_config('breeze.scope', 'system', true);

-- 1. agreement_requests (Shape 1, org_id NOT NULL — per-org transactional record like contract_documents)
CREATE TABLE IF NOT EXISTS agreement_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  status text NOT NULL DEFAULT 'draft',
  template_id uuid NOT NULL REFERENCES contract_templates(id) ON DELETE RESTRICT,
  template_version_id uuid NOT NULL REFERENCES contract_template_versions(id) ON DELETE RESTRICT,
  contract_id uuid,
  public_link_revoked_at timestamptz,
  label text,
  cover_message text,
  variable_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_name_snapshot varchar(255),
  client_address_snapshot jsonb,
  seller_snapshot jsonb,
  document_locale varchar(16),
  render_locale varchar(16),
  effective_date date,
  expires_at timestamptz NOT NULL,
  sent_at timestamptz, first_viewed_at timestamptz, signed_at timestamptz,
  declined_at timestamptz, voided_at timestamptz, expired_at timestamptz,
  decline_reason text, void_reason text,
  accept_token_jti varchar(128), accept_token_issued_at timestamptz, accept_token_expires_at timestamptz, accept_token_kid varchar(64),
  public_response_jti varchar(128), public_response_consumed_at timestamptz, public_response_outcome varchar(16),
  reminder_count integer NOT NULL DEFAULT 0, last_reminded_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  voided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreement_requests_status_chk CHECK (status IN ('draft','sent','viewed','signed','declined','voided','expired')),
  CONSTRAINT agreement_requests_outcome_chk CHECK (public_response_outcome IS NULL OR public_response_outcome IN ('accepted','declined'))
);
CREATE UNIQUE INDEX IF NOT EXISTS agreement_requests_id_org_uq ON agreement_requests (id, org_id);
DO $$ BEGIN
  ALTER TABLE agreement_requests ADD CONSTRAINT agreement_requests_contract_org_fk
    FOREIGN KEY (contract_id, org_id) REFERENCES contracts(id, org_id)
    ON DELETE SET NULL (contract_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS agreement_requests_org_idx ON agreement_requests (org_id);
CREATE INDEX IF NOT EXISTS agreement_requests_org_status_idx ON agreement_requests (org_id, status);
CREATE INDEX IF NOT EXISTS agreement_requests_contract_idx ON agreement_requests (contract_id);
CREATE INDEX IF NOT EXISTS agreement_requests_open_expiry_idx ON agreement_requests (expires_at) WHERE status IN ('sent','viewed');

-- 2. agreement_request_recipients (mirrors quote_recipients, 2026-07-20-portal-quote-recipients.sql)
CREATE TABLE IF NOT EXISTS agreement_request_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  email varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreement_request_recipients_email_normalized_chk CHECK (email = lower(btrim(email)))
);
DO $$ BEGIN
  ALTER TABLE agreement_request_recipients ADD CONSTRAINT agreement_request_recipients_request_org_fk
    FOREIGN KEY (request_id, org_id) REFERENCES agreement_requests(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS agreement_request_recipients_request_email_uq ON agreement_request_recipients (request_id, email);
CREATE INDEX IF NOT EXISTS agreement_request_recipients_org_idx ON agreement_request_recipients (org_id);

-- 3. RLS: four per-command policies per table, exactly 2026-07-16-contract-documents.sql:143-157
--    (repeat the ENABLE/FORCE + DROP POLICY IF EXISTS + CREATE POLICY block for BOTH tables).

-- 4. contract_documents: source discriminator + request link + evidence snapshot
ALTER TABLE contract_documents
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'quote',
  ADD COLUMN IF NOT EXISTS agreement_request_id uuid,
  ADD COLUMN IF NOT EXISTS signer_name varchar(255),
  ADD COLUMN IF NOT EXISTS signer_email varchar(255),
  ADD COLUMN IF NOT EXISTS signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS signer_ip varchar(64),
  ADD COLUMN IF NOT EXISTS signer_user_agent text,
  ADD COLUMN IF NOT EXISTS acceptance_origin text,
  ADD COLUMN IF NOT EXISTS acceptance_method varchar(32),
  ADD COLUMN IF NOT EXISTS acceptance_reference text,
  ADD COLUMN IF NOT EXISTS recorded_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS content_sha256 char(64),
  ADD COLUMN IF NOT EXISTS content_hash_version smallint,
  ADD COLUMN IF NOT EXISTS acceptance_render_locale varchar(16);
DO $$ BEGIN
  ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_agreement_request_fk
    FOREIGN KEY (agreement_request_id) REFERENCES agreement_requests(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_recorded_by_fk
    FOREIGN KEY (recorded_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS contract_documents_agreement_request_uq
  ON contract_documents (agreement_request_id) WHERE agreement_request_id IS NOT NULL;
ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_source_kind_chk;
ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_source_kind_chk CHECK (source_kind IN ('quote','request'));
ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_origin_chk;
ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_origin_chk
  CHECK (acceptance_origin IS NULL OR acceptance_origin IN ('customer','on_behalf'));
-- NOT a strict XOR on the two FKs: both are ON DELETE SET NULL, so after the source
-- row is deleted both are NULL — a strict XOR would raise 23514 DURING the parent
-- delete (the recorder_chk trap, 2026-10-27-100000-quote-acceptances-on-behalf.sql:68-77).
ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_one_source_chk;
ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_one_source_chk CHECK (
  NOT (quote_id IS NOT NULL AND agreement_request_id IS NOT NULL)
  AND (source_kind <> 'quote' OR agreement_request_id IS NULL)
  AND (source_kind <> 'request' OR (quote_id IS NULL AND quote_acceptance_id IS NULL))
);

-- 5. Back-fill the evidence snapshot from quote_acceptances (rows whose acceptance still resolves).
DO $$
DECLARE n integer;
BEGIN
  UPDATE contract_documents cd
     SET signer_name = qa.signer_name,
         signer_email = qa.signer_email,
         signed_at = qa.signed_at AT TIME ZONE 'UTC',
         signer_ip = qa.ip_address,
         signer_user_agent = qa.user_agent,
         acceptance_origin = qa.origin,
         acceptance_method = qa.method,
         acceptance_reference = qa.reference,
         recorded_by_user_id = qa.recorded_by_user_id,
         content_sha256 = qa.quote_sha256,
         content_hash_version = qa.hash_version,
         acceptance_render_locale = qa.render_locale
    FROM quote_acceptances qa
   WHERE cd.quote_acceptance_id = qa.id
     AND cd.signed_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled signer evidence onto % contract_documents rows', n; END IF;
END $$;
```

Drizzle: mirror every column (timestamps `{ withTimezone: true }` on the new tables and the new `contract_documents` columns; `foreignKey({...}).onDelete('set null')` for the composite contract FK; `foreignKey` with `onDelete('cascade')` for recipients; `uniqueIndex`/`index` names exactly as the SQL). `check-drift` compares columns/indexes, not deferrability.

- [ ] **Step 1: Write the failing back-fill integration test**

```ts
// contractDocumentsEvidenceBackfill.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';
import { replayMigration } from './replayMigration';
const runDb = it.runIf(!!process.env.DATABASE_URL);

// Seeds: template + published version; quote + acceptance (origin on_behalf, method 'email',
// reference 'PO 1', render_locale 'fr-FR', hash_version 2); contract_documents row A linked to
// the acceptance with NULL evidence; row B with quote_acceptance_id NULL (quote deleted long ago).
describe('contract_documents evidence back-fill (2026-12-29-100000)', () => {
  runDb('copies the acceptance evidence onto linked rows and leaves orphaned rows untouched', async () => {
    const { rowA, rowB } = await seed();
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE contract_documents SET signed_at = NULL, signer_name = NULL WHERE id IN (${rowA}::uuid, ${rowB}::uuid)`));
    await replayMigration('2026-12-29-100000-agreement-requests.sql');
    const [a] = rows(await withSystemDbAccessContext(() => db.execute(sql`SELECT * FROM contract_documents WHERE id = ${rowA}::uuid`)));
    expect(a).toMatchObject({ source_kind: 'quote', signer_name: 'Jane Doe', acceptance_origin: 'on_behalf', acceptance_method: 'email', acceptance_reference: 'PO 1', content_hash_version: 2, acceptance_render_locale: 'fr-FR' });
    expect(a.content_sha256).toHaveLength(64);
    const [b] = rows(await withSystemDbAccessContext(() => db.execute(sql`SELECT * FROM contract_documents WHERE id = ${rowB}::uuid`)));
    expect(b).toMatchObject({ source_kind: 'quote', signer_name: null, signed_at: null, agreement_request_id: null });
  });
  runDb('is idempotent: a second replay changes nothing', async () => { /* replay twice, compare rows */ });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractDocumentsEvidenceBackfill.integration.test.ts`
Expected: FAIL — `ENOENT` reading the migration file.

- [ ] **Step 3: Write the migration + Drizzle schema**, then `pnpm --filter @breeze/api db:migrate && pnpm --filter @breeze/api db:check-drift` (clean).

- [ ] **Step 4: Run the gate**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractDocumentsEvidenceBackfill.integration.test.ts && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts`, then from the repo root `git add apps/api/migrations/2026-12-29-100000-agreement-requests.sql && ./scripts/check-migration-naming.sh --staged`
Expected: all PASS (the naming guard is also the pre-commit hook; the pre-push hook re-runs it `--against-ref origin/main`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-12-29-100000-agreement-requests.sql apps/api/src/db/schema/contractDocuments.ts apps/api/src/__tests__/integration/contractDocumentsEvidenceBackfill.integration.test.ts
git commit -m "feat(db): agreement_requests tables + contract_documents evidence snapshot with back-fill (#8865 W1b)"
```

### Task 7: Registrations + contract suites + RLS/CHECK integration tests

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts:505-523` — insert `'agreement_request_recipients', 'agreement_requests',` in `localeCompare` position (both sort after `'agent_…'` entries and before `'ai_…'`; verify with `node -e "console.log(['agreement_requests','agreement_request_recipients','agent_versions','ai_agents'].sort((a,b)=>a.localeCompare(b)))"` — expected order `agent_versions, agreement_request_recipients, agreement_requests, ai_agents`).
- Modify: `apps/api/src/services/orgMergeRegistry.ts` repoint list — same two names, alphabetical, with a one-line comment: composite FKs are DEFERRABLE so parent/child `org_id` move in separate statements; no org-scoped unique key except `(request_id, email)` which cannot collide across orgs.
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` — add two `tablePolicy("org_id", …)` entries (alphabetical) and extend the `contract_documents` entry at `:340` with the buckets from Global Constraints.
- Create: `apps/api/src/__tests__/integration/agreementRequestsRls.integration.test.ts`, `apps/api/src/__tests__/integration/contractDocumentsSourceCheck.integration.test.ts`

- [ ] **Step 1: Run the contract suites to see them red** (schema exists from Task 6, lists not yet edited)

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts`
Expected: FAIL — "every org_id-columned public table is in getOrgCascadeDeleteOrder()" names both tables; export policy reports unclassified columns on `contract_documents` and the two new tables.

- [ ] **Step 2: Write the two new integration tests** (idiom: `serviceDeliverablesRls.integration.test.ts:19-58` — `seedTwoOrgs`, `orgContext`, `sqlstate`)

```ts
// agreementRequestsRls.integration.test.ts
describe('agreement_requests / agreement_request_recipients RLS (shape 1)', () => {
  runDb('cross-tenant forge insert as the app role is refused (42501)', async () => {
    const { orgA, orgB, ctxA } = await seedTwoOrgs(); const tv = await seedPublishedTemplate(orgA.partnerId);
    expect(await sqlstate(() => withDbAccessContext(ctxA, () => db.execute(sql`
      INSERT INTO agreement_requests (org_id, template_id, template_version_id, expires_at)
      VALUES (${orgB.id}::uuid, ${tv.templateId}::uuid, ${tv.versionId}::uuid, now() + interval '30 days')`)))).toBe('42501');
  });
  runDb('an org context reads only its own requests and recipients', async () => { /* insert one per org under system; SELECT under ctxA → 1 row each table */ });
  runDb("filing against another org's contract is refused by the composite FK (23503)", async () => {
    /* contract under orgB; insert request for orgA with contract_id = that contract, under system scope → 23503 */
  });
  runDb('deleting a contract nulls only contract_id on its requests', async () => { /* DELETE FROM contracts → request row survives with contract_id NULL, org_id intact */ });
  runDb('org merge repoints a request + its recipients + its signed agreement without 23503', async () => {
    /* SET CONSTRAINTS ALL DEFERRED; UPDATE agreement_requests SET org_id = survivor; UPDATE agreement_request_recipients SET org_id = survivor; UPDATE contract_documents …; COMMIT ok */
  });
});

// contractDocumentsSourceCheck.integration.test.ts
describe('contract_documents one-source CHECK + FK direction', () => {
  runDb('both source FKs set → 23514', async () => { /* insert with quote_id AND agreement_request_id */ });
  runDb("source_kind='request' with a quote_id → 23514", async () => {});
  runDb("deleting the quote leaves a quote-sourced row with its evidence and source_kind='quote'", async () => {});
  runDb('deleting a draft request nulls agreement_request_id on its signed agreement (SET NULL), row survives', async () => {});
  runDb('topologicalCascadeOrder() includes both tables and places recipients before requests before contract_documents', async () => {
    const order = await topologicalCascadeOrder();
    expect(order.indexOf('agreement_request_recipients')).toBeLessThan(order.indexOf('agreement_requests'));
    expect(order.indexOf('agreement_requests')).toBeLessThan(order.indexOf('contract_documents'));
  });
  runDb('cascadeDeleteOrg erases an org holding a signed request, its recipients and its signed agreement', async () => {});
});
```

- [ ] **Step 3: Edit the three registries**, then run everything:

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts src/__tests__/integration/agreementRequestsRls.integration.test.ts src/__tests__/integration/contractDocumentsSourceCheck.integration.test.ts src/__tests__/integration/tenantCascadeErasureBreadth.integration.test.ts && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage && npx vitest run src/services/orgMerge.test.ts src/extensions/tenancyRegistry.test.ts`
Expected: all PASS. (`orgMerge.test.ts` must additionally be green in the **full** `pnpm --filter @breeze/api test --run` before the PR.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/agreementRequestsRls.integration.test.ts apps/api/src/__tests__/integration/contractDocumentsSourceCheck.integration.test.ts
git commit -m "feat(tenancy): register agreement_requests tables in cascade/merge/export contracts (#8865 W1b)"
```

### Task 8: `listContractDocuments` reads the snapshot; API + web row types

**Files:**
- Modify: `apps/api/src/services/contractDocumentService.ts:331-398`
- Modify: `apps/api/src/routes/contracts/documents.test.ts:54-69` (LIST_ROW), `apps/web/src/lib/api/contractDocuments.ts:17-32`
- Test: `apps/api/src/services/contractDocumentService.test.ts:371-425`

**Interfaces:**
- `ContractDocumentListRow` gains: `sourceKind: 'quote' | 'request'; agreementRequestId: string | null; mime: string; signerEmail: string | null; acceptanceOrigin: 'customer' | 'on_behalf' | null; acceptanceMethod: string | null; acceptanceReference: string | null; evidenceAvailable: boolean` (`signedAt !== null`). `signerName`/`signedAt` now come from `contractDocuments.signerName/signedAt`; the `quoteAcceptances` left join is removed; the `quotes` join stays for `quoteNumber`.

- [ ] **Step 1: Write the failing test** — in the "predicates" describe: `it('projects signer fields from contract_documents, not quote_acceptances', ...)` asserting the compiled SQL (that block uses `PgDialect`) contains `"contract_documents"."signer_name"` and does not contain `quote_acceptances`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/contractDocumentService.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the projection; update `LIST_ROW` and the web type; the web `SignedAgreementsPage` renders `signerName ?? t('agreements.signedPage.evidenceUnavailable')` (key added in Task 17).
- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/services/contractDocumentService.test.ts src/routes/contracts/documents.test.ts && cd ../web && npx vitest run src/components/agreements/SignedAgreementsPage.test.tsx src/lib/api/contractDocuments.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(agreements): signed-agreement list reads the evidence snapshot (#8865 W1b)"`

### Task 9: `renderContextFromRequest`

**Files:**
- Modify: `apps/api/src/services/contractTemplateRender.ts` (next to `renderContextFromQuote`)
- Test: `apps/api/src/services/contractTemplateRender.test.ts`

**Interfaces:**
```ts
export function renderContextFromRequest(
  request: Pick<AgreementRequestRow, 'clientNameSnapshot' | 'clientAddressSnapshot' | 'sellerSnapshot' | 'renderLocale' | 'documentLocale' | 'effectiveDate'>,
  opts: { effectiveDate: string | Date; currencyCode: string },
): AgreementRenderContext;   // no `quote` member; renderLocale = request.renderLocale ?? request.documentLocale ?? 'en'; clientName = clientNameSnapshot ?? ''
```

- [ ] **Step 1: Failing test** — `it('renderContextFromRequest yields a 4-key map with quote-only keys absent', …)` and `it('renderContextFromRequest prefers render_locale over document_locale', …)`.
- [ ] **Step 2: Run** → FAIL (not exported). **Step 3:** implement. **Step 4:** run `src/services/contractTemplateRender.test.ts` → PASS. **Step 5:** commit `feat(agreements): renderContextFromRequest (#8865 W1b)`.

### Task 10: Request-aware `freezeSignedAgreement` + evidence on the quote path

**Files:**
- Modify: `apps/api/src/services/contractDocumentService.ts` (`FreezeSignedAgreementInput`, insert values), `apps/api/src/services/quoteAcceptService.ts:681-689`
- Test: `apps/api/src/services/contractDocumentService.test.ts`, `apps/api/src/services/quoteAcceptService.test.ts:593-624`

**Interfaces:**
```ts
export interface SignedAgreementEvidence {
  signerName: string; signerEmail: string | null; signedAt: Date;
  signerIp: string | null; signerUserAgent: string | null;
  acceptanceOrigin: 'customer' | 'on_behalf'; acceptanceMethod: string; acceptanceReference: string | null;
  recordedByUserId: string | null;
  contentSha256: string; contentHashVersion: number;   // quote family: quote_acceptances.quote_sha256 / hash_version; request family: computeAgreementSha256 / 1
  acceptanceRenderLocale: string;
}
export interface FreezeSignedAgreementInput {
  source: { kind: 'quote'; quoteId: string; quoteAcceptanceId: string } | { kind: 'request'; agreementRequestId: string };
  orgId: string; contractId: string | null; templateId: string; templateVersionId: string;
  render: SignedAgreementRender; ctx: AgreementRenderContext; manualValues: Record<string, string>;
  evidence: SignedAgreementEvidence;
  externalBytes?: { data: Buffer; mime: 'application/pdf' | 'image/png' | 'image/jpeg' };   // skips rendering; rendered_html NULL; mime stored
  allowUnresolvedFallback: boolean;
}
// createExecutedDocuments gains an 8th positional param `evidence: SignedAgreementEvidence` (quoteAcceptService.test.ts:620 asserts argument index 6 = renderLocale; index 7 is new).
```
Insert values: `sourceKind: source.kind`, `quoteId`/`quoteAcceptanceId` (quote) or `agreementRequestId` (request), `mime: externalBytes?.mime ?? 'application/pdf'`, every evidence column.

- [ ] **Step 1: Failing tests** — `it("source.kind='request' inserts agreement_request_id, no quote columns, source_kind 'request'")`, `it('externalBytes are stored verbatim with the sniffed mime and rendered_html null')`, `it('evidence columns are written for both sources')`, `it('allowUnresolvedFallback=false throws AGREEMENT_VARIABLES_UNRESOLVED and inserts nothing')`; in `quoteAcceptService.test.ts` extend the snapshot test: `expect(snapshotArgs[7]).toMatchObject({ acceptanceOrigin: 'customer', acceptanceMethod: 'typed-signature', contentHashVersion: 2, acceptanceRenderLocale: 'en' })` and `expect(snapshotArgs[7].contentSha256).toBe(acceptanceValues.quoteSha256)`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/contractDocumentService.test.ts src/services/quoteAcceptService.test.ts` → FAIL.
- [ ] **Step 3: Implement** — build the evidence object in `acceptQuote` right after the acceptance insert (`:424-446` has every field: `captured.*`, `params.ipAddress`, `params.userAgent`, `origin`, `captured.method`, `reference`, `recordedByUserId`, `quoteSha256`, `2`, `renderLocale`, `now`), pass as the 8th arg.
- [ ] **Step 4: Run the gate** — the two files above plus `src/services/quoteAcceptanceHash.golden.test.ts`, `src/services/quoteAcceptanceVerify.test.ts`; then integration `quoteAccept.integration.test.ts` + `quoteAcceptOnBehalf.integration.test.ts` (assert in the on-behalf suite that the new `contract_documents` row carries `acceptance_origin='on_behalf'` — add that expectation) → PASS.
- [ ] **Step 5: Commit** `feat(agreements): request-aware freezeSignedAgreement; quote accepts write the evidence snapshot (#8865 W1b)`

### Task 11: `computeAgreementSha256`

**Files:** Create `apps/api/src/services/agreementContentHash.ts`, `apps/api/src/services/agreementContentHash.test.ts`.

**Interfaces:**
```ts
export type AgreementHashVersion = 1;
export type AgreementHashInput =
  | { kind: 'rendered'; versionSha: string; vars: Record<string, string>; renderLocale: string; effectiveDate: string }
  | { kind: 'external'; versionSha: string; bytesSha256: string; mime: string };
export function computeAgreementSha256(input: AgreementHashInput, version: AgreementHashVersion = 1): string;
// canonical = { version: 1, kind, versionSha, ...(rendered: { vars: sorted-key object, renderLocale, effectiveDate }) | (external: { bytesSha256, mime }) }
// sha256(JSON.stringify(canonical)) — same canonicalisation family as quoteContentHash.ts:113-121.
```

- [ ] **Step 1: Failing tests** — determinism (same input twice), key-order independence of `vars`, rendered vs external differ for the same `versionSha`, external binds bytes (`bytesSha256` change → different hash), `effectiveDate` change → different hash, a pinned hex for one fixed input (recorded on first run, same comment as Task 1).
- [ ] **Step 2: Run** → FAIL (module missing). **Step 3:** implement (~25 lines). **Step 4:** `cd apps/api && npx vitest run src/services/agreementContentHash.test.ts` → PASS. **Step 5:** commit `feat(agreements): computeAgreementSha256 (#8865 W1b)`.

**W1b wrap-up:** full `pnpm --filter @breeze/api test --run` (for `orgMerge.test.ts`), the contract suites from Task 7, `pnpm db:check-drift`, `pnpm test-stack down`. PR body: the registration table (grep lines), export classification per column, "no `CASCADE_ORDER_SET_NULL_EDGE_BREAKS` entry", back-fill row-count warning.

---

# W1c — Record signed elsewhere

Base `main` once W1b merges (else stack + `gh workflow run CI --ref`). PR title `feat(agreements): record an agreement signed elsewhere (#8865 W1c)`. PR body states: gated on `agreements:write` until W2 ships `agreements:send`.

### Task 12: Shared validator

**Files:** Create `packages/shared/src/validators/agreementRequests.ts`, `packages/shared/src/validators/agreementRequests.test.ts`; modify `packages/shared/src/validators/index.ts` (export).

**Interfaces:**
```ts
import { QUOTE_ACCEPT_ON_BEHALF_METHODS } from './quotes';
export const AGREEMENT_SIGNED_AT_SKEW_MS = 5 * 60 * 1000;
export const recordSignedAgreementSchema = z.object({
  orgId: z.string().guid(),
  templateVersionId: z.string().guid(),
  contractId: z.string().guid().optional().nullable(),
  label: z.string().trim().max(255).optional().nullable(),
  variableValues: z.record(z.string(), z.string().max(2000)).default({}),
  signerName: z.string().trim().min(1).max(255),
  signerEmail: z.string().trim().email().max(255).optional().nullable(),
  signedAt: z.coerce.date(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional().nullable(),  // quotes.ts:19 keeps its isoDate private; redeclare
  method: z.enum(QUOTE_ACCEPT_ON_BEHALF_METHODS),
  reference: z.string().trim().min(1).max(500),
});
export type RecordSignedAgreementInput = z.infer<typeof recordSignedAgreementSchema>;
/** Multipart carries scalars as strings; this is the pre-parse shape the route feeds in. */
export function recordSignedAgreementFromForm(fields: Record<string, unknown>): unknown; // JSON.parse(variableValues) when it is a string, else {}
```
The future-`signedAt` rule lives in the service (Task 13) because it needs `now`; the schema only coerces.

- [ ] **Step 1: Failing tests** — accepts a full body; `reference` blank → fails; `method: 'telepathy'` → fails; `variableValues` default `{}`; `recordSignedAgreementFromForm({ variableValues: '{"a":"b"}' })` → object.
- [ ] **Step 2:** `cd packages/shared && npx vitest run src/validators/agreementRequests.test.ts` → FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(shared): recordSignedAgreementSchema (#8865 W1c)`.

### Task 13: `recordSignedAgreement` service

**Files:**
- Create: `apps/api/src/services/agreementRequestService.ts`, `apps/api/src/services/agreementRequestService.test.ts`, `apps/api/src/services/agreementRecordedOnBehalfAudit.ts` (+ `.test.ts`)
- Modify: `apps/api/src/services/contractTemplateRender.ts` (add `loadTemplateVersionRenderData`)

**Interfaces:**
```ts
// contractTemplateRender.ts
export type TemplateVersionRenderData = Omit<ContractBlockRenderData, 'blockId'>;
/** System-scoped read of ONE pinned published version (same contract as loadContractBlockRenderData: runOutsideDbContext + withSystemDbAccessContext). */
export async function loadTemplateVersionRenderData(templateVersionId: string, opts?: { includeFileData?: boolean }): Promise<TemplateVersionRenderData>;

// agreementRequestService.ts
export type AgreementRequestServiceErrorCode =
  | 'REQUEST_NOT_FOUND' | 'ORG_DENIED' | 'CONTRACT_NOT_FOUND' | 'AGREEMENT_VARIABLES_UNRESOLVED'
  | 'INVALID_SIGNER_NAME' | 'SIGNED_AT_IN_FUTURE' | 'EMPTY_FILE' | 'FILE_TOO_LARGE' | 'UNSUPPORTED_FILE_TYPE'
  | 'AGREEMENT_ALREADY_SIGNED' | 'INVALID_STATE';
export class AgreementRequestServiceError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 500, public code: AgreementRequestServiceErrorCode);
}
export interface RecordSignedAgreementParams {
  input: RecordSignedAgreementInput;                      // validated (Task 12)
  partnerId: string;                                      // auth.partnerId
  actorUserId: string | null;
  actorIp: string | null; actorUserAgent: string | null;  // stored as signer_ip / signer_user_agent — the TECH's, as quoteAcceptService.ts:431-436
  file: { buffer: Buffer; filename: string } | null;
  now: Date;
}
export interface RecordSignedAgreementResult { request: AgreementRequestRow; signedAgreementId: string; contentSha256: string }
/** MUST be called inside runOutsideDbContext(() => withSystemDbAccessContext(...)) — same wrapping as the on-behalf quote accept (routes/quotes/lifecycle.ts:151). Org access + template visibility are the CALLER's checks (route, Task 15) in the request's own context; this function re-asserts the template guard inside the tx. */
export async function recordSignedAgreement(params: RecordSignedAgreementParams): Promise<RecordSignedAgreementResult>;
```
Pipeline, in order, all inside the tx: (1) `signedAt > now + AGREEMENT_SIGNED_AT_SKEW_MS` → 400 `SIGNED_AT_IN_FUTURE`; (2) blank `signerName` → 400 (same guard as `quoteAcceptService.ts:400-404`); (3) `assertTemplateVersionUsable({ templateId: renderData.templateId, templateVersionId }, { orgId, partnerId })` — let the `ContractTemplateServiceError` propagate unchanged; the route's error mapper (Task 15) turns it into its own 422 status/code; (4) `contractId` → select `contracts.id, orgId`; missing or `orgId !== input.orgId` → 404 `CONTRACT_NOT_FOUND`; (5) file branch: `sniffEvidenceMime` null → 415, `> QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES` → 413, empty → 400; (6) org + partner snapshot: `organizations.name/billing address` via `buildBillToAddress`, `partners` via `buildSellerSnapshot`, `renderLocale = resolvePartnerDocumentLocale(partner)`; (7) `ctx = renderContextFromRequest(snapshot, { effectiveDate: input.effectiveDate ?? signedAt date-only UTC, currencyCode: partner default })`; (8) `findUnresolvedVariables(renderData, input.variableValues, resolveAutoVariables(ctx))` non-empty → 422 `AGREEMENT_VARIABLES_UNRESOLVED` with message `Agreement variables unresolved: a, b` (same marker shape as `AcceptOnBehalfDialog.tsx:34` so the dialog can parse it); (9) insert `agreement_requests` with `status='signed'`, `signed_at`, snapshots, `variable_values`, `created_by`, `expires_at = signedAt` (a signed request has no live link), `label`; (10) `contentSha256 = computeAgreementSha256(file ? { kind:'external', versionSha, bytesSha256, mime } : { kind:'rendered', versionSha, vars: { ...auto, ...manual }, renderLocale, effectiveDate })`; (11) `freezeSignedAgreement({ source: { kind:'request', agreementRequestId }, …, evidence: { acceptanceOrigin:'on_behalf', acceptanceMethod: input.method, acceptanceReference: input.reference, recordedByUserId: actorUserId, contentSha256, contentHashVersion: 1, acceptanceRenderLocale: renderLocale, signedAt, … }, externalBytes: file ? { data, mime } : undefined, allowUnresolvedFallback: false })`; (12) return.

`agreementRecordedOnBehalfAudit.ts`: `recordedOnBehalfAuditEvent({ requestId, orgId, signedAgreementId, method, reference, signerName, signerEmail, templateVersionId, external: boolean })` → `RouteAuditInput` with `action: 'billing.agreement.recorded_on_behalf'`, `resourceType: 'agreement_request'`, pattern `quoteAcceptOnBehalfAudit.ts:21-53`.

- [ ] **Step 1: Failing tests** (`../db` chain mock as `contractDocumentService.test.ts:17-37`; mock `./contractTemplateRender` `loadTemplateVersionRenderData`; spy `./contractDocumentService` `freezeSignedAgreement` via `importActual` spread as `quoteAcceptService.test.ts:25-27`; mock `./contractTemplateService` `assertTemplateVersionUsable`):
  - `signedAt` 10 minutes ahead → rejects `{ status: 400, code: 'SIGNED_AT_IN_FUTURE' }`, `db.insert` never called
  - template guard rejection propagates (`ContractTemplateServiceError` instance)
  - contract from another org → `{ status: 404, code: 'CONTRACT_NOT_FOUND' }`, no insert
  - template declaring `totals.monthly` (declaredVariables `[{ name:'totals.monthly', kind:'auto' }]`) → `{ status: 422, code: 'AGREEMENT_VARIABLES_UNRESOLVED' }`, message contains `totals.monthly`, no insert
  - happy rendered path: `agreement_requests` insert values `{ status:'signed', orgId, templateVersionId, clientNameSnapshot:'Acme', renderLocale:'en' }`; `freezeSignedAgreement` called with `source.kind='request'`, `allowUnresolvedFallback: false`, `evidence.acceptanceOrigin='on_behalf'`, `evidence.contentHashVersion=1`
  - external PNG path: `freezeSignedAgreement` receives `externalBytes.mime='image/png'`; `contentSha256` equals `computeAgreementSha256({ kind:'external', versionSha, bytesSha256: sha256(bytes), mime:'image/png' })`
  - non-image/pdf bytes → 415; 11 MB buffer → 413
  - audit payload test: action string, `reference` verbatim, `external` flag
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/agreementRequestService.test.ts src/services/agreementRecordedOnBehalfAudit.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** per the pipeline (service ≤ 300 lines; put the snapshot loader in a private helper).
- [ ] **Step 4: Run** the two files + `src/services/contractTemplateRender.test.ts` (add a `loadTemplateVersionRenderData` test: system-context wrapper called, `VERSION_NOT_FOUND` for an unpublished id) → PASS.
- [ ] **Step 5: Commit** `feat(agreements): recordSignedAgreement service + audit payload (#8865 W1c)`

### Task 14: MIME-correct filename on the signed-agreement download

**Files:** Modify `apps/api/src/routes/contracts/documents.ts:69-96`; test `apps/api/src/routes/contracts/documents.test.ts`.

**Interfaces:** filename = `signed-agreement-${id}.${ext}` where `ext` = `pdf | png | jpg` from `doc.mime` (`application/pdf`, `image/png`, `image/jpeg`); header = `contentDispositionFor(doc.mime, filename).replace(/^inline;/, 'attachment;')` (`routes/quotes/acceptanceEvidence.ts:95-97` precedent); `X-Content-Type-Options: nosniff`. `auditSensitiveRead` `format` stays `'pdf'` in W1 (W2 adds `pdf-certified | original`). Web `SignedAgreementsPage.tsx:28-30` `usePdfDownload` filename follows `doc.mime` the same way.

- [ ] **Step 1: Failing tests** — `getContractDocumentPdf` mocked to `{ mime: 'image/png', … }` → `Content-Disposition` matches `/^attachment; filename="signed-agreement-.*\.png"/`, `Content-Type: image/png`; `application/pdf` → `.pdf`.
- [ ] **Step 2:** run `src/routes/contracts/documents.test.ts` → FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `fix(agreements): name signed-agreement downloads by stored MIME (#8865 W1c)`.

### Task 15: `POST /contracts/agreement-requests/record-signed` route

**Files:**
- Create: `apps/api/src/routes/contracts/agreementRequests.ts`, `apps/api/src/routes/contracts/agreementRequests.test.ts`
- Modify: `apps/api/src/routes/contracts/index.ts:19` (mount `/agreement-requests` right after `/contract-documents`)

**Interfaces:**
```ts
export const agreementRequestRoutes = new Hono();
// scopes = requireScope('partner','organization','system'); writePerm = requirePermission(PERMISSIONS.AGREEMENTS_WRITE.resource, PERMISSIONS.AGREEMENTS_WRITE.action)
// POST /record-signed — multipart (bodyLimit QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES + 64 KiB, 413 on overflow):
//   parseBody({ all: true }) → recordSignedAgreementFromForm → recordSignedAgreementSchema.safeParse → 400 VALIDATION_ERROR on failure
//   auth.canAccessOrg(input.orgId) else 404 { code: 'ORG_NOT_FOUND' } (never 403 — do not reveal the org exists)
//   file part optional; when present must be a File
//   res = await runOutsideDbContext(() => withSystemDbAccessContext(() => recordSignedAgreement({ input, partnerId: auth.partnerId, actorUserId: auth.user?.id ?? null, actorIp: resolveClientIp(c), actorUserAgent: c.req.header('user-agent') ?? null, file, now: new Date() })))
//   writeRouteAudit(c, recordedOnBehalfAuditEvent({...}))
//   → 201 { data: { request: serializeRequest(res.request), signedAgreementId, contentSha256 } }   (serializeRequest strips accept_token_* / public_response_* columns)
// error mapper: AgreementRequestServiceError → its status/code; ContractTemplateServiceError → its status/code; QuoteServiceError (from freeze) → status/code; else rethrow
```
`resolveClientIp(c)` = `getTrustedClientIpOrUndefined(c)?.slice(0, 64) ?? null` from `services/clientIp` — exactly what the on-behalf quote accept passes (`routes/quotes/lifecycle.ts:22,157-158`).

- [ ] **Step 1: Failing route tests** (mock idiom `documents.test.ts:7-43`; mock `../../services/agreementRequestService` with `importOriginal` spread; mock `../../db` wrappers as passthrough):
  - JSON body instead of multipart → 400 `INVALID_MULTIPART`
  - `reference` missing → 400 `VALIDATION_ERROR`
  - `orgId` outside `accessibleOrgIds` → 404 `ORG_NOT_FOUND`, service not called
  - happy multipart with `file` → 201, service called with `file.buffer` of the right length, audit written with `method`+`reference`
  - service throws `AgreementRequestServiceError(…, 422, 'AGREEMENT_VARIABLES_UNRESOLVED')` → 422 with that code
  - a non-`File` `file` field → 400
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/contracts/agreementRequests.test.ts` → FAIL. **Step 3:** implement + mount. **Step 4:** run it + `src/routes/contracts/documents.test.ts` → PASS. **Step 5:** commit `feat(api): POST /contracts/agreement-requests/record-signed (#8865 W1c)`.

### Task 16: Web — API client + `RecordSignedAgreementDialog`

**Files:**
- Create: `apps/web/src/lib/api/agreementRequests.ts`, `apps/web/src/lib/api/agreementRequests.test.ts`, `apps/web/src/components/agreements/RecordSignedAgreementDialog.tsx`, `apps/web/src/components/agreements/RecordSignedAgreementDialog.test.tsx`
- Modify: `apps/web/src/components/agreements/SignedAgreementsPage.tsx:183-208` (header button, `agreements:write` via `usePermissions().can('agreements','write')`, reload on success), `apps/web/src/components/contracts/ContractWorkspace.tsx:159-167` (button beside the pill, pre-fills org + contract), `apps/web/src/components/organizations/record/OrgBillingTab.tsx:85` (nothing — the embed inherits the page button with `lockedOrgId`)

**Interfaces:**
```ts
// lib/api/agreementRequests.ts
export interface RecordSignedAgreementForm {
  orgId: string; templateVersionId: string; contractId?: string | null; label?: string | null;
  variableValues: Record<string, string>; signerName: string; signerEmail?: string | null;
  signedAt: string; effectiveDate?: string | null; method: QuoteAcceptOnBehalfMethod; reference: string; file?: File | null;
}
export function recordSignedAgreement(form: RecordSignedAgreementForm): Promise<Response>; // FormData, variableValues JSON-stringified, POST /contracts/agreement-requests/record-signed (fetchWithAuth sets no JSON content-type for FormData — lib/api/quotes.ts:454-466)
export const AGREEMENT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const AGREEMENT_UPLOAD_ALLOWED_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];

// RecordSignedAgreementDialog.tsx
interface Props { open: boolean; onClose: () => void; lockedOrgId?: string; lockedContractId?: string; onRecorded: (signedAgreementId: string) => void }
```
Dialog fields (spec §3.4): organization (locked when pre-filled; else the org picker used by `SignedAgreementsPage`'s link dialog), agreement template → published version (`listContractTemplates()` + `latestVersion` with `status==='published'`), optional contract (`listContracts({ orgId })`), method (`QUOTE_ACCEPT_ON_BEHALF_METHODS` tuple), reference (required), signer name (required), signer email, signed date (default today; max today), optional file (PDF/PNG/JPEG ≤ 10 MB, client-side type/size hint), manual variable inputs for every `declaredVariables` entry of kind `manual` (fetched via `getTemplateVersion`). Submit through `runAction`; on 422 `AGREEMENT_VARIABLES_UNRESOLVED` show the names parsed with the `AcceptOnBehalfDialog.tsx:33-38` parser (copy it; do not import across billing/agreements). Test ids: `agreements-record-dialog`, `agreements-record-template`, `agreements-record-method`, `agreements-record-reference`, `agreements-record-signer-name`, `agreements-record-signed-at`, `agreements-record-file`, `agreements-record-submit`, `agreements-record-open` (the trigger buttons).

- [ ] **Step 1: Failing tests** — api test: `recordSignedAgreement` posts `FormData` to the right path with `variableValues` stringified and the file appended. Dialog test (mock the three api modules as `SignedAgreementsPage.test.tsx:4-25`): submit disabled until reference + signer + template are set; chooses `signed_document` when a file is attached; success calls `onRecorded('sa-1')`; a 422 with `Agreement variables unresolved: custom.po` renders `custom.po` as a required field. Page test: button rendered only when `can('agreements','write')`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/lib/api/agreementRequests.test.ts src/components/agreements/RecordSignedAgreementDialog.test.tsx src/components/agreements/SignedAgreementsPage.test.tsx` → FAIL.
- [ ] **Step 3: Implement** (dialog ≤ 400 lines; the variable-input sub-form may be its own file `RecordSignedAgreementVariables.tsx`).
- [ ] **Step 4:** run the three files + `src/lib/__tests__/no-silent-mutations.test.ts` → PASS.
- [ ] **Step 5:** commit `feat(web): Record signed agreement dialog at the three entry points (#8865 W1c)`.

### Task 17: Locale keys (8 files) + honest row copy

**Files:** `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`; `apps/web/src/components/agreements/SignedAgreementsPage.tsx` rows.

Keys under `agreements.recordSigned.*` (title `Record signed agreement`, fields, `consequence` line "This files a signed agreement for {{org}}. It cannot be deleted afterwards.", `unresolved` "Provide a value for: {{names}}"), `agreements.signedPage.recordSigned` (button), `agreements.signedPage.evidenceUnavailable` ("Accepted via quote — acceptance evidence unavailable"), `agreements.signedPage.source.quote` ("via quote {{number}}"), `agreements.signedPage.source.recorded` ("recorded by MSP — {{method}}"), `agreements.signedPage.fileType.image` ("scanned copy"). Non-`en` files get translated values (not the English copy) — follow `TERMINOLOGY.md`.

- [ ] **Step 1:** run `cd apps/web && npx vitest run src/lib/i18n` → the locale-parity test FAILS listing the missing keys per locale.
- [ ] **Step 2:** add the keys to all 8 files; wire the row copy (`sourceKind`, `acceptanceOrigin`, `mime.startsWith('image/')`).
- [ ] **Step 3:** run `cd apps/web && npx vitest run src/lib/i18n src/components/agreements src/locales` → PASS.
- [ ] **Step 4:** commit `feat(web): agreements record-signed locale keys ×8 + honest signed-agreement rows (#8865 W1c)`.

### Task 18: Integration test — real DB end to end

**Files:** Create `apps/api/src/__tests__/integration/agreementRequestRecordSigned.integration.test.ts`.

Seed (`createPartner`, `createOrganization`, `createUser`, a published authored template with `declaredVariables: [{ name:'custom.po', kind:'manual' }]` and a published uploaded template) then call `recordSignedAgreement` under `runOutsideDbContext(() => withSystemDbAccessContext(...))` (as `quoteAcceptOnBehalf.integration.test.ts:49-70` calls `acceptQuote`):

- [ ] `it('rendered: creates a signed request and a request-sourced signed agreement with evidence')` — `agreement_requests.status='signed'`, `contract_documents.source_kind='request'`, `agreement_request_id` set, `quote_id` NULL, `acceptance_origin='on_behalf'`, `acceptance_method='email'`, `content_hash_version=1`, `rendered_html` contains the `custom.po` value, `sha256` = sha256(pdf_data).
- [ ] `it('external PNG: stores the bytes verbatim with mime image/png and binds them in content_sha256')`.
- [ ] `it('contract from another org → CONTRACT_NOT_FOUND, no rows written')`.
- [ ] `it('unresolved manual variable → AGREEMENT_VARIABLES_UNRESOLVED, no rows written')`.
- [ ] `it('the signed agreement lists under GET /contracts/contract-documents for the org with signerName from the snapshot')` — call `listContractDocuments` with an org `AuthContext`.
- [ ] Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/agreementRequestRecordSigned.integration.test.ts` → PASS. Commit `test(agreements): record-signed integration coverage (#8865 W1c)`.

**W1c wrap-up:** `pnpm --filter @breeze/api test --run`, `pnpm --filter @breeze/web test --run`, `pnpm --filter @breeze/shared test --run`, tsc on api + web (12 GB heap, check exit code), the Task 7 contract suites once more, `pnpm test-stack down`. PR body: permission note (`agreements:write` until W2), the three entry points, screenshot of the dialog, "E2E lands with W2's `agreement-standalone-signing.spec.ts`".

---

## Self-review (run before handing off)

1. **Spec coverage for W1** (spec §8 W1 row): migration ✔ Task 6; registrations ✔ Task 7; `freezeSignedAgreement` + quote delegation ✔ Tasks 5, 10; `AgreementRenderContext` ✔ Tasks 3, 9; `computeAgreementSha256` ✔ Task 11; `assertTemplateVersionUsable` ✔ Task 4; verifier golden fixtures ✔ Task 1 (+ Task 2 for real rows); `record-signed` endpoint ✔ Tasks 12–15, 18; web dialog ✔ Tasks 16–17; MIME-correct download (spec §3.4) ✔ Task 14; `listContractDocuments` from snapshot (spec §4.2) ✔ Task 8.
2. **Placeholders:** none — every step has the code, command or expected failure; the `REPLACE_ME` tokens in Task 1 are the harvest mechanism and are removed in its Step 3.
3. **Type consistency:** `FreezeSignedAgreementInput` grows between Task 5 (W1a) and Task 10 (W1b) by adding fields only; `createExecutedDocuments` keeps positions 0–6 and adds position 7; `AgreementRenderContext.renderLocale` is a resolved string everywhere; `SignedAgreementEvidence.contentHashVersion` is `2` on the quote path and `1` on the request path.
4. **Review Focus:** each of the five lines names its owning task above.
