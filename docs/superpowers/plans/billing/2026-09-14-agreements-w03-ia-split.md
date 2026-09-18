---
tracking_issue: LanternOps/breeze#5822
---
# Agreements W03: IA split — `/agreements` area, reciprocal links, org record section, docs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agreement templates and signed agreements their own first-class area at `/agreements`, remove the Templates/Documents tabs from `/contracts`, and wire the three reciprocal links the spec calls for (contract → template pill, template → usage counts, org record → that org's signed agreements) — so the three objects spec §1 shows conflated ("Contract" the recurring biller, "Agreement template" the legal doc, "Signed agreement" the executed instance) finally have distinct homes and visible relationships.

**Architecture:** No new tables, no migration, **no route renames**. The API gains exactly two read surfaces on the existing contracts router: a `?linked=` filter on `GET /contracts/contract-documents` and a `GET /contracts/contract-templates/:id/usage` counter. The web side is a *move*, not a rewrite: `TemplatesTab.tsx` becomes `components/agreements/TemplatesPage.tsx` (row click navigates instead of setting local state, so a template is finally linkable), `DocumentsTab.tsx` becomes `components/agreements/SignedAgreementsPage.tsx` — parameterised by `lockedOrgId`, `lockedContractId` and `defaultUnlinkedOnly` so the org record *and* the contract detail both embed the one list instead of keeping a second table, the same embed idiom `OrgBillingTab.tsx` already uses for `ContractsList`. A thin `AgreementsShell` supplies the two-tab header as real `<a>` links plus the spec §3 relationship sentence. `ContractsTabs.tsx` loses two of its four tabs and, in the default state, its tab bar.

**Tech Stack:** Hono + Zod (route-local validators), Drizzle (`sql` count aggregates over `quote_blocks.content` jsonb), Vitest with mocked services (API routes) and Testing Library (web), Astro pages as thin `client:load` island hosts, react-i18next across 8 locales, Playwright + a page object for e2e, Starlight for docs.

**Spec:** `docs/superpowers/specs/billing/2026-09-14-agreements-vocabulary-and-ia-design.md` (approved by Todd 2026-09-14). **§6 is normative for this wave**; §2 is the vocabulary contract.

## Scope decisions that override a literal reading of spec §6

The advisor quorum revised four points after the spec was approved. Where §6 and this section disagree, **this section wins** — and the reasons are recorded so a reviewer does not "fix" them back.

1. **API paths are NOT renamed.** Spec §5/§6 imagined `/agreement-templates` and `/signed-agreements` mounts. They are not being added. `apps/web/src/lib/api/contractTemplates.ts:16` stays `BASE = '/contracts/contract-templates'` and `contractDocuments.ts:12` stays `BASE = '/contracts/contract-documents'`. Both new endpoints live under those existing mounts (`apps/api/src/routes/contracts/index.ts:16-17`). The e2e regexes at `e2e-tests/tests/quote-contract-proposal.spec.ts:76` (`/\/contracts\/contract-templates$/`) and `:332` (`/\/contracts\/contract-documents\/[^/]+\/pdf$/`) are therefore **unchanged** — Task 10 touches navigation testids only. The vocabulary rename is a UI/docs concern (spec §2 D4/D5 already exempts DB and service names); URLs join it later or never.
2. **The Signed agreements page defaults to `linked=all`.** §6 said the "Unlinked only" chip defaults **on**; it defaults **off**. A page called "Signed agreements" that opens showing only the orphans is the same lie the old Documents tab told (spec §1: *"The 'Documents' tab only lists orphans"*) — the point of the split is that this page is the inventory. The chip is still there, still persists as `#unlinked=1`, still defaults on nothing. The org-record and contract-detail embeds likewise show everything in their scope.
3. **The API default for an omitted `?linked` stays `unlinked`.** That preserves the existing `DocumentsTab` caller's behaviour verbatim while the web moves over. Consequence the implementer must not skip: **the web client now has to send `linked=all` explicitly** — a missing param is not "everything".
4. **`ContractDocumentsSection` is replaced by the shared list.** Contract detail renders `<SignedAgreementsPage lockedContractId={contract.id} />` rather than maintaining its own table. **Checked first, as instructed:** the per-contract endpoint already exists — `documents.ts:26-29` accepts `contractId`, `contractDocumentService.ts:357-358` applies it, and `ContractDocumentsSection.tsx:54` already calls `listContractDocuments({ contractId })`. So this needs **no API change at all**; `lockedContractId` just forwards into the query the shared page already builds. That is the simpler option and the one taken.

**Depends on W01 and W02.** This plan assumes:
- **W01** renamed the §3 copy keys in `apps/web/src/locales/*/billing.json`. In particular `contracts.templatesTab.description` now reads *"Your MSA and standard terms. Add one to a quote and the customer signs it with the proposal; the signed copy is filed against the contract that quote creates."* — Task 4 reuses that exact key for the shell's page description rather than duplicating the sentence.
- **W02** added `AGREEMENTS_READ` / `AGREEMENTS_WRITE` to `packages/shared/src/constants/permissions.ts` and switched the route guards at `apps/api/src/routes/contracts/templates.ts:35-36` and `documents.ts:22-23` to them. **Per decision 1 above, W02's path-alias half is dropped** — if the branch you are on already renamed the web `BASE` constants or added the `/agreement-templates` mount, revert that before starting; if it only did the permission work, you are where this plan expects.

If `get_feature_status` shows either wave still open, **stop** — do not implement around them.

## Global Constraints

- **No schema change, no migration, no new table, no new route mount.** Nothing in §6 needs one; if a step seems to, the step is wrong.
- **Tenancy: the new queries inherit the request's context.** Both new API surfaces are ordinary handlers on `contractTemplateRoutes` / `contractDocumentRoutes`, which run under the request's `withDbAccessContext` transaction — the same ambient context `listContractDocuments` (`apps/api/src/services/contractDocumentService.ts:351`) and `listTemplates` (`contractTemplateService.ts:230`) already rely on. **Do not** wrap either new service function in `withSystemDbAccessContext` / `runOutsideDbContext` (CLAUDE.md: that double-holds a pooled connection under the request's own transaction and bypasses RLS — #1105/#2417). The usage counter re-uses `getTemplateOr404` + this file's existing read assertion so a template the caller cannot see 404s before any counting happens, and every aggregate carries `auth.orgCondition(...)` on its own org column.
- **Both new endpoints are guarded by `AGREEMENTS_READ`** — reuse the module-level `readPerm` constants W02 switched (`templates.ts:35`, `documents.ts:22`). Never inline a second `requirePermission`.
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`). Reads stay raw `fetchWithAuth` + explicit 401 handling, matching the components being moved.
- **Hash for transient UI state, never query params** (CLAUDE.md). The "Unlinked only" chip persists as `#unlinked=1` via `useHashState` (`apps/web/src/lib/useHashState.ts:47`); the two agreement *tabs* are real routes, not hash state.
- **i18n:** every new key needs a real translation in all 8 catalogs (`en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`). `localeParity.test.ts` fails on a missing key or an interpolation-token mismatch; `translationCoverage.test.ts` fails on an exact-English duplicate past the per-namespace cap. Verified current caps: `billing.json` — pt-BR 60 (`translationCoverage.test.ts:58`), es-419 46 (`:178`), fr-FR 59 (`:298`), fr-CA 59 (`:433`), de-DE 45 (`:574`), it-IT 37 (`:693`), tr-TR 22 (`:782`); `common.json` — pt-BR 103 (`:67`), es-419 88 (`:190`), fr-FR 106 (`:310`), fr-CA 108 (`:445`), de-DE 107 (`:590`), it-IT 107 (`:703`), tr-TR 49 (`:783`); `pages.json` — pt-BR 11 (`:94`), es-419 12 (`:215`), fr-FR 12 (`:340`), fr-CA 12 (`:475`), de-DE 14 (`:620`), it-IT 10 (`:720`), tr-TR 3 (`:802`). **Do not raise any baseline in this wave** — every string added here is translatable prose, so a raised cap means a lazy translation.
- **Testids:** new ones take the `agreements-` prefix per spec §6. Existing `contract-template-*` / `contract-document-*` testids inside the moved components are **kept** so the moved unit tests stay mostly intact and the e2e diff stays small; only navigation testids change.
- **File-size guideline: keep every new file under 500 lines.** `DocumentsTab.tsx` is 301 lines today; `SignedAgreementsPage.tsx` adds the filter chip, a Contract column, the row subtitle and three locking props (~+90). If it crosses ~450, extract the link dialog (`DocumentsTab.tsx:234-298`) into `components/agreements/LinkSignedAgreementDialog.tsx` **before** adding anything else.
- Run one test file as `cd apps/web && npx vitest run <path>` / `cd apps/api && npx vitest run <path>`. **Never** `pnpm --filter <pkg> test -- --run <path>` (CLAUDE.md:294 — the `--` is forwarded literally and vitest runs the whole suite in watch mode).
- Branch `feature/5822-agreements-ia/wave-5825`; PR body contains `Closes #5825`.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/src/routes/contracts/documents.ts` | `?linked=all\|linked\|unlinked` + `?orgId=` on `GET /` |
| `apps/api/src/services/contractDocumentService.ts` | `listContractDocuments` honours `linked` / `orgId` |
| `apps/api/src/routes/contracts/documents.test.ts` | filter forwarding + back-compat tests |
| `apps/api/src/routes/contracts/templates.ts` | `GET /:id/usage` |
| `apps/api/src/services/contractTemplateService.ts` | `getTemplateUsage` |
| `apps/api/src/routes/contracts/templates.test.ts` | usage route tests |
| `apps/web/src/lib/api/contractDocuments.ts` (+ new `.test.ts`) | `linked` / `orgId` list params (BASE unchanged) |
| `apps/web/src/lib/api/contractTemplates.ts` | `getTemplateUsage(id)` (BASE unchanged) |
| `apps/web/src/components/agreements/AgreementsShell.tsx` (+ `.test.tsx`) | two-tab header + page description |
| `apps/web/src/components/agreements/TemplatesPage.tsx` (+ `.test.tsx`) | moved `TemplatesTab`, row click navigates |
| `apps/web/src/components/agreements/SignedAgreementsPage.tsx` (+ `.test.tsx`) | moved `DocumentsTab`, locking props + chip |
| `apps/web/src/components/agreements/AgreementTemplateEditor.tsx` (+ 2 tests) | moved `TemplateEditor` + back link + usage line |
| `apps/web/src/pages/agreements/templates/index.astro`, `templates/[id].astro`, `signed/index.astro` | thin island hosts |
| `apps/web/src/components/contracts/ContractsTabs.tsx` (+ tests) | two tabs removed, legacy-hash redirect |
| `apps/web/src/components/contracts/ContractsList.tsx` | currency-mismatch banner |
| `apps/web/src/components/contracts/ContractWorkspace.tsx` (+ `.agreement.test.tsx`) | "Under {{template}} v{{n}}" pill |
| `apps/web/src/components/contracts/ContractDetail.tsx` | renders the shared list with `lockedContractId` |
| `apps/web/src/components/contracts/ContractDocumentsSection.tsx` | **deleted** (replaced by the shared list) |
| `apps/web/src/components/layout/Sidebar.tsx` (+ nav/rbac tests) | Agreements nav item + path alias |
| `apps/web/src/components/organizations/record/OrgBillingTab.tsx` (+ test) | Agreements `<details>` section |
| `apps/web/src/locales/*/billing.json`, `common.json`, `pages.json` | new keys ×8 |
| `e2e-tests/pages/AgreementsPage.ts` (new), `e2e-tests/tests/quote-contract-proposal.spec.ts` | sidebar navigation to `/agreements/templates` |
| `apps/docs/src/content/docs/features/agreements.mdx` (new), `contracts.mdx`, `quotes.mdx`, `astro.config.mjs` | docs split |

---

## Spec §6 → task map (self-review)

| Spec §6 bullet | Task | Note |
|---|---|---|
| Sidebar → Billing gains `Agreements  /agreements/templates  agreements:read  partnerScopeOnly` | T7 | |
| `nav.agreements` = "Agreements" in `common.json` ×8, real pt-BR | T7 | |
| `templates/index.astro` → shell → templates list, row click → `/agreements/templates/:id` (replaces `TemplatesTab.tsx:39` `selectedId`) | T5 | |
| `templates/[id].astro` → editor, Back → `/agreements/templates`, `id === 'new'` opens create dialog | T5 | |
| `signed/index.astro` → all `contract_documents`, columns Template · Organization · Signer · Signed · Quote · Contract, "Unlinked only" chip, link action | T5 | chip defaults **off** (decision 2) |
| `GET /signed-agreements?linked=…` | T1 | path stays `/contracts/contract-documents` (decision 1) |
| `AgreementsShell` = two real links + §3 relationship sentence | T4 | |
| `/contracts` drops Templates + Documents tabs; currency mismatches becomes a banner/chip; no tab bar in default state | T6 | |
| `#tab=templates` / `#tab=documents` redirect client-side | T6 | |
| `ContractWorkspace` header pill "Under {{template}} v{{n}}" from the existing documents query | T8 | |
| `TemplateEditor` "Used on {{quotes}} quotes · {{signed}} signed agreements"; archive confirm shows the counts | T2 (API), T3 (client), T5 (UI) | |
| Org record `<details>` "Agreements" reusing the signed list with `lockedOrgId`, gated on `agreements:read` | T9 | filter off (decision 2) |
| Testids `agreements-shell`, `agreements-tab-templates`, `agreements-tab-signed`, `signed-agreements-tab`, `signed-agreements-unlinked-filter`, `agreement-template-editor`, `agreement-template-usage`, `contract-under-agreement-pill`, `org-billing-section-agreements` | T4, T5, T8, T9 | |
| e2e spec navigates via the sidebar to `/agreements/templates` | T10 | API regexes untouched (decision 1) |
| Docs: new `agreements.mdx`, registered in `astro.config.mjs:109`, `contracts.mdx` cross-link + rewritten Permissions, `quotes.mdx` retarget | T11 | |
| *(added)* Contract detail reuses the shared list instead of `ContractDocumentsSection` | T8 | decision 4 |
| *(added)* Row subtitle "Accepted with quote … by … on …" | T5 | decision 4 |

---

### Task 1: API — `GET /contracts/contract-documents?linked=all|linked|unlinked`

**Files:**
- Modify: `apps/api/src/routes/contracts/documents.ts` (`listQuery` at `:26-29`, handler at `:51-59`)
- Modify: `apps/api/src/services/contractDocumentService.ts` (`listContractDocuments` at `:351-354`, filter block at `:355-362`)
- Test: `apps/api/src/routes/contracts/documents.test.ts` (append inside `describe('contract document routes')`; `BASE = '/contract-documents'` at `:49`, `ORG_ID` at `:52`)

**Interfaces:**
- Produces: `export type SignedAgreementLinkFilter = 'all' | 'linked' | 'unlinked';` and
  ```ts
  export async function listContractDocuments(
    auth: AuthContext,
    opts?: { contractId?: string; orgId?: string; unattached?: boolean; linked?: SignedAgreementLinkFilter },
  ): Promise<ContractDocumentListRow[]>;
  ```
- Consumes: `auth.orgCondition` (`apps/api/src/middleware/auth.ts:141`), `optionalQueryBoolean` (`@breeze/shared`, already imported at `documents.ts:3`).

**Where the validator lives — checked, and the answer is "not in `packages/shared`".** `packages/shared/src/validators/contracts.ts:393` holds `listContractsQuerySchema` (the `/contracts` list has two consumers), but the contract-document and contract-template list queries have **never** lived there: `documents.ts:26-29` and `templates.ts:39` both declare `listQuery` inline with `z.object({...})`, and there is no second consumer for this one. **Keep it inline in `documents.ts`** — exporting it from `@breeze/shared` would add a cross-package symbol with exactly one importer.

**Filter semantics (decision 3: omitted `linked` means `unlinked`).**

| Request | Rows |
|---|---|
| `?contractId=…` | that contract's — `contractId` still wins over `linked` |
| `?linked=unlinked` | `contract_id IS NULL` |
| `?linked=linked` | `contract_id IS NOT NULL` |
| `?linked=all` | everything the caller can read |
| `?unattached=true` (legacy spelling) | `contract_id IS NULL` |
| nothing | `contract_id IS NULL` — **unchanged for the current caller**, and the reason the web must now send `linked=all` explicitly |
| `?orgId=…` | narrows *within* what the caller may already read; applied **on top of** `orgCondition`, never instead of it |

- [ ] **Step 1: Write the failing route tests**

Append to `apps/api/src/routes/contracts/documents.test.ts`, inside the existing `describe`:

```ts
  it.each([['all'], ['linked'], ['unlinked']])('GET /?linked=%s forwards the filter to the service', async (linked) => {
    (svc.listContractDocuments as any).mockResolvedValue([LIST_ROW]);
    const res = await app().request(`${BASE}?linked=${linked}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(svc.listContractDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ linked }),
    );
  });

  it('GET /?linked=bogus is a 400 and never reaches the service', async () => {
    const res = await app().request(`${BASE}?linked=bogus`, { method: 'GET' });
    expect(res.status).toBe(400);
    expect(svc.listContractDocuments).not.toHaveBeenCalled();
  });

  // Back-compat pin (decision 3): an omitted `linked` still means "unlinked",
  // so the pre-Agreements DocumentsTab caller behaves identically. The
  // Agreements page opts INTO the full inventory with linked=all.
  it('GET / with no linked param defaults to unlinked', async () => {
    (svc.listContractDocuments as any).mockResolvedValue([LIST_ROW]);
    await app().request(BASE, { method: 'GET' });
    expect(svc.listContractDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ linked: 'unlinked' }),
    );
  });

  it('GET /?orgId=… scopes the list to one organization (org-record embed)', async () => {
    (svc.listContractDocuments as any).mockResolvedValue([LIST_ROW]);
    await app().request(`${BASE}?orgId=${ORG_ID}&linked=all`, { method: 'GET' });
    expect(svc.listContractDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG_ID, linked: 'all' }),
    );
  });
```

Before writing these, `ls apps/api/src/services/contractDocumentService.test.ts`. If it exists, add two predicate tests there (`linked: 'linked'` emits `IS NOT NULL`; `orgId` is ANDed with, not substituted for, `orgCondition`). If it does not, the route tests above plus the Step 6 live check are the coverage — do **not** stand up a new mocked-Drizzle suite for two `where` branches.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/contracts/documents.test.ts`
Expected: FAIL — `zValidator` strips the unknown `linked`/`orgId` keys so every `objectContaining` assertion misses, and `?linked=bogus` answers 200 instead of 400.

- [ ] **Step 3: Implement the route**

Replace `listQuery` (`documents.ts:26-29`):

```ts
// `linked` is the Agreements-area filter (spec §6). It DEFAULTS to 'unlinked' so
// the pre-Agreements caller (which sent `unattached=true`, or nothing) keeps its
// exact behaviour; the Signed agreements page opts into the full inventory by
// sending linked=all. `unattached` is the legacy spelling of linked=unlinked and
// stays accepted until no client sends it.
const listQuery = z.object({
  contractId: z.string().guid().optional(),
  orgId: z.string().guid().optional(),
  unattached: optionalQueryBoolean,
  linked: z.enum(['all', 'linked', 'unlinked']).default('unlinked'),
});
```

and the handler body (`:53-54`):

```ts
    const { contractId, orgId, unattached, linked } = c.req.valid('query');
    const docs = await listContractDocuments(authFrom(c), { contractId, orgId, unattached, linked });
```

- [ ] **Step 4: Implement the service predicate**

In `apps/api/src/services/contractDocumentService.ts`, widen the signature (`:351-354`) and replace the filter block (`:355-362`):

```ts
export async function listContractDocuments(
  auth: AuthContext,
  opts: { contractId?: string; orgId?: string; unattached?: boolean; linked?: SignedAgreementLinkFilter } = {},
): Promise<ContractDocumentListRow[]> {
  const conditions: SQL[] = [];
  const accessCond = auth.orgCondition(contractDocuments.orgId);
  if (accessCond) conditions.push(accessCond);
  // orgId NARROWS within what the caller may already read — ANDed on top of
  // orgCondition, never in place of it, so it can only ever subtract rows.
  if (opts.orgId) conditions.push(eq(contractDocuments.orgId, opts.orgId));
  if (opts.contractId) {
    conditions.push(eq(contractDocuments.contractId, opts.contractId));
  } else {
    // Explicit `linked` wins; `unattached` is its legacy spelling; the service's
    // own default matches the route's so a direct service caller behaves the same.
    const linked = opts.linked ?? (opts.unattached === false ? 'all' : 'unlinked');
    if (linked === 'unlinked') conditions.push(isNull(contractDocuments.contractId));
    else if (linked === 'linked') conditions.push(isNotNull(contractDocuments.contractId));
  }
  // …unchanged select / joins / orderBy…
```

Add `isNotNull` to the `drizzle-orm` import (`:23`), and export the type next to `ContractDocumentListRow` (`:328`):

```ts
/** Spec §6: the Signed agreements list's link-state filter. */
export type SignedAgreementLinkFilter = 'all' | 'linked' | 'unlinked';
```

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && npx vitest run src/routes/contracts/documents.test.ts && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: PASS, with the four pre-existing `GET /` tests (`documents.test.ts:73-105`) still green; no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/contracts/documents.ts apps/api/src/routes/contracts/documents.test.ts apps/api/src/services/contractDocumentService.ts
git commit -m "feat(billing): signed-agreement list gains linked/unlinked and org filters (W03)"
```

---

### Task 2: API — `GET /contracts/contract-templates/:id/usage`

**Files:**
- Modify: `apps/api/src/services/contractTemplateService.ts` (append after `archiveTemplate`, which ends at `:365`)
- Modify: `apps/api/src/routes/contracts/templates.ts` (new route after the `GET /:id` handler that starts at `:97`)
- Test: `apps/api/src/routes/contracts/templates.test.ts` (`BASE = '/contract-templates'` at `:54`, `TEMPLATE_ID` at `:55`; add `getTemplateUsage: vi.fn()` to the service mock at `:7-21`)

**Interfaces:**
- Produces:
  ```ts
  export interface TemplateUsage { quoteCount: number; signedCount: number }
  export async function getTemplateUsage(auth: AuthContext, templateId: string): Promise<TemplateUsage>;
  ```
- Route: `GET /contracts/contract-templates/:id/usage` → `{ data: { quoteCount, signedCount } }`, guarded by `scopes` + `readPerm` (= `AGREEMENTS_READ` after W02, `templates.ts:35`).

**Where the counts come from — verified column paths.**
- `signedCount`: `contract_documents.template_id`. The Drizzle table is `contractDocuments` with `templateId` (its sibling `templateVersionId` is `apps/api/src/db/schema/contractDocuments.ts:73`), and `listContractDocuments` already selects both. Plain `count(*) WHERE template_id = :id` under the caller's org condition.
- `quoteCount`: **there is no `quote_blocks.template_version_id` column** — `grep -rn "templateVersionId\|template_version_id" apps/api/src/db/schema/` returns exactly one hit, the `contract_documents` one above. A contract block stores its pin inside jsonb: `quote_blocks.content` is `jsonb('content')` (`apps/api/src/db/schema/quotes.ts:148`) and the parser at `apps/api/src/services/contractTemplateRender.ts:70-75` requires both `content.templateId` and `content.templateVersionId` as strings. So: count **distinct `quote_id`** over `quote_blocks` where `block_type = 'contract'` and `content->>'templateVersionId'` is any version of this template. Resolving through `contract_template_versions` rather than trusting `content->>'templateId'` is what makes it "any version of this template" per §6, and it survives a block whose `templateId` was written by an older path.

**Tenancy (state it, add no machinery).** The handler runs inside the request's `withDbAccessContext` transaction like every other route on this router — no `withSystemDbAccessContext`, no `runOutsideDbContext`. Two layers of access control: `getTemplateOr404(templateId)` plus this file's existing template read assertion 404s an invisible template **before** any counting, so the counts can never act as an existence oracle; and both aggregates carry `auth.orgCondition(...)` on their own org column, so a partner-wide template reports only the orgs this caller may read.

- [ ] **Step 1: Write the failing route tests**

Add `getTemplateUsage: vi.fn(),` to the mock at `templates.test.ts:7-21`, then append inside `describe('contract template routes')`:

```ts
  it('GET /:id/usage returns the quote and signed-agreement counts', async () => {
    (svc.getTemplateUsage as any).mockResolvedValue({ quoteCount: 3, signedCount: 7 });
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/usage`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { quoteCount: 3, signedCount: 7 } });
    expect(svc.getTemplateUsage).toHaveBeenCalledWith(expect.anything(), TEMPLATE_ID);
  });

  it('GET /:id/usage 404s a template the caller cannot see, leaking no counts', async () => {
    (svc.getTemplateUsage as any).mockRejectedValue(
      new ContractTemplateServiceError('Template not found', 404, 'NOT_FOUND'),
    );
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/usage`, { method: 'GET' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('NOT_FOUND');
    expect(body).not.toHaveProperty('data');
  });

  it('GET /:id/usage rejects a non-uuid id before the service is called', async () => {
    const res = await app().request(`${BASE}/not-a-uuid/usage`, { method: 'GET' });
    expect(res.status).toBe(400);
    expect(svc.getTemplateUsage).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/contracts/templates.test.ts`
Expected: FAIL — no such route (404/400 mismatch) and `svc.getTemplateUsage` undefined.

- [ ] **Step 3: Implement the service function**

First confirm the real access-helper name — `grep -n "function assertTemplate" apps/api/src/services/contractTemplateService.ts` and read how `getTemplate` (`:285-286`) pairs `getTemplateOr404` with it. Mirror that pair exactly; the name below is a placeholder for whatever this file actually calls it.

Append after `archiveTemplate` (`:365`):

```ts
/** Spec §6 reciprocal link: what this agreement template is actually used by.
 *
 *  `quoteCount` — DISTINCT quotes carrying a `contract` block pinned to ANY
 *  version of this template. A contract block has no FK: its pin lives in the
 *  jsonb `quote_blocks.content` as `{templateId, templateVersionId}` (the shape
 *  contractTemplateRender.ts:70-75 parses), so the match is a jsonb text
 *  extraction against this template's version ids. Going through the version
 *  table rather than content->>'templateId' is what makes it "any version", and
 *  count(distinct quote_id) is what stops a quote with two blocks on two
 *  versions of the same template from being counted twice.
 *
 *  `signedCount` — contract_documents rows stamped with this template.
 *
 *  Runs under the request's ambient withDbAccessContext (a plain route-handler
 *  path — never escalate here). Both aggregates carry the caller's org
 *  condition, so a partner-wide template reports only the orgs this caller can
 *  read, and the 404 above fires first so the counts are never an existence
 *  oracle for an invisible template. */
export async function getTemplateUsage(auth: AuthContext, templateId: string): Promise<TemplateUsage> {
  const template = await getTemplateOr404(templateId);
  assertTemplateReadAccess(auth, template);

  const versionIds = db
    .select({ id: contractTemplateVersions.id })
    .from(contractTemplateVersions)
    .where(eq(contractTemplateVersions.templateId, templateId));

  const quoteConds: SQL[] = [
    eq(quoteBlocks.blockType, 'contract'),
    inArray(sql`${quoteBlocks.content}->>'templateVersionId'`, versionIds),
  ];
  const quoteOrgCond = auth.orgCondition(quoteBlocks.orgId);
  if (quoteOrgCond) quoteConds.push(quoteOrgCond);

  const docConds: SQL[] = [eq(contractDocuments.templateId, templateId)];
  const docOrgCond = auth.orgCondition(contractDocuments.orgId);
  if (docOrgCond) docConds.push(docOrgCond);

  const [quoteRow] = await db
    .select({ n: sql<number>`count(distinct ${quoteBlocks.quoteId})::int` })
    .from(quoteBlocks)
    .where(and(...quoteConds));
  const [docRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contractDocuments)
    .where(and(...docConds));

  return { quoteCount: quoteRow?.n ?? 0, signedCount: docRow?.n ?? 0 };
}
```

and next to the other exported types (`:36-38`):

```ts
/** Spec §6: what a template is used by — the editor header and the archive confirm. */
export interface TemplateUsage { quoteCount: number; signedCount: number }
```

Imports: add `quoteBlocks` and `contractDocuments`. `contractTemplates`/`contractTemplateVersions` already come from `'../db/schema'` (`:12`) — check whether that barrel also re-exports the other two (`grep -n "contractDocuments\|quotes" apps/api/src/db/schema/index.ts`) and prefer the barrel; otherwise import `contractDocuments` from `'../db/schema/contractDocuments'` and `quoteBlocks` from `'../db/schema/quotes'`, matching `contractDocumentService.ts:25-27`. `and`, `eq`, `inArray`, `sql` and the `SQL` type are already imported at `:3`.

- [ ] **Step 4: Implement the route**

Add immediately after the `GET /:id` handler in `apps/api/src/routes/contracts/templates.ts` (it starts at `:97`); `'/:id/usage'` and `'/:id'` are distinct Hono patterns, so ordering between them does not matter — but keep it above the `/:id/versions/...` block for readability:

```ts
// GET /:id/usage — spec §6 reciprocal link. Counts only; the editor renders
// "Used on N quotes · M signed agreements" and the archive confirm repeats it.
contractTemplateRoutes.get('/:id/usage', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try {
    const { id } = c.req.valid('param');
    return c.json({ data: await getTemplateUsage(authFrom(c), id) });
  } catch (err) {
    return handleTemplateError(c, err);
  }
});
```

and add `getTemplateUsage` to the service import block at `:14-30`.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && npx vitest run src/routes/contracts/templates.test.ts src/services/contractTemplateService.test.ts && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: PASS; no type errors. If `inArray(sql\`…\`, <subquery>)` does not typecheck in this Drizzle version, fall back to a raw predicate: ``sql`${quoteBlocks.content}->>'templateVersionId' IN (SELECT id::text FROM contract_template_versions WHERE template_id = ${templateId})` `` — the `::text` cast is load-bearing, `->>` yields text and comparing it to `uuid` raises 42883.

- [ ] **Step 6: Sanity-check the counts against a live stack**

Run (test stack up, `pnpm wt-stack up`): in psql, for a template you know is on one quote and one signed agreement, run both aggregates by hand; then add a second contract block to the same quote pinned to a *different* version of the same template and re-run.
Expected: `quoteCount` stays 1. If it becomes 2 the `distinct` was dropped — fix before shipping, that number goes in an archive-confirmation dialog.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/contracts/templates.ts apps/api/src/routes/contracts/templates.test.ts apps/api/src/services/contractTemplateService.ts
git commit -m "feat(billing): agreement-template usage counts endpoint (W03)"
```

---

### Task 3: Web API clients — list params and the usage fetcher

**Files:**
- Modify: `apps/web/src/lib/api/contractDocuments.ts` (`ListContractDocumentsQuery` at `:34-37`, `buildQuery` at `:39-45`)
- Modify: `apps/web/src/lib/api/contractTemplates.ts` (append next to the other wrappers; `BASE` at `:16` is **unchanged**)
- Test: `apps/web/src/lib/api/contractDocuments.test.ts` — **new file**

**Do these files have tests today?** Checked: `ls apps/web/src/lib/api | grep -i contract` → `contractDocuments.ts`, `contracts.ts`, `contracts.updateLine.test.ts`, `contractTemplates.ts`. Only `contracts.ts` has one (and only for `updateLine`). `buildQuery` is now branching prose that the whole Agreements area depends on, so it gets the new `contractDocuments.test.ts`; `getTemplateUsage` is a one-line `fetchWithAuth` passthrough with no branching and is covered through `AgreementTemplateEditor.test.tsx` (Task 5) — **do not** add a test file for it.

**Interfaces:**
```ts
// contractDocuments.ts
export type SignedAgreementLinkFilter = 'all' | 'linked' | 'unlinked';
export interface ListContractDocumentsQuery {
  contractId?: string;
  orgId?: string;
  /** Omitted means the server's default, which is 'unlinked' — send 'all' for the inventory. */
  linked?: SignedAgreementLinkFilter;
  /** @deprecated legacy spelling of `linked: 'unlinked'`. */
  unattached?: boolean;
}

// contractTemplates.ts
export interface TemplateUsage { quoteCount: number; signedCount: number }
export function getTemplateUsage(id: string): Promise<Response>;
```

- [ ] **Step 1: Write the failing client test**

Create `apps/web/src/lib/api/contractDocuments.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import { listContractDocuments, contractDocumentPdfPath } from './contractDocuments';

describe('listContractDocuments query building', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends no query string at all when nothing is asked for', async () => {
    await listContractDocuments();
    expect(fetchWithAuth).toHaveBeenCalledWith('/contracts/contract-documents');
  });

  it('sends linked=all for the full inventory (the server default is unlinked)', async () => {
    await listContractDocuments({ linked: 'all' });
    expect(fetchWithAuth).toHaveBeenCalledWith('/contracts/contract-documents?linked=all');
  });

  it('combines orgId with the link filter', async () => {
    await listContractDocuments({ orgId: 'org-1', linked: 'all' });
    const url = fetchWithAuth.mock.calls[0]![0] as string;
    expect(url.startsWith('/contracts/contract-documents?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('orgId')).toBe('org-1');
    expect(params.get('linked')).toBe('all');
  });

  it('still supports contractId for the contract-detail embed', async () => {
    await listContractDocuments({ contractId: 'ct-1' });
    expect(fetchWithAuth).toHaveBeenCalledWith('/contracts/contract-documents?contractId=ct-1');
  });

  // The path is asserted here because the e2e PDF regex keys off it
  // (quote-contract-proposal.spec.ts:332) — renaming it silently reddens e2e only.
  it('builds the PDF path under the unchanged contracts mount', () => {
    expect(contractDocumentPdfPath('doc-1')).toBe('/contracts/contract-documents/doc-1/pdf');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/lib/api/contractDocuments.test.ts`
Expected: FAIL on the `linked` / `orgId` cases — `buildQuery` (`:39-45`) knows only `contractId` and `unattached`.

- [ ] **Step 3: Implement**

In `apps/web/src/lib/api/contractDocuments.ts`, replace `:34-45`:

```ts
/** Spec §6 link-state filter. NOTE the asymmetry: the SERVER defaults an omitted
 *  `linked` to 'unlinked' (back-compat with the pre-Agreements Documents tab), so
 *  a caller that wants the whole inventory must say so. SignedAgreementsPage
 *  sends 'all' unless its "Unlinked only" chip is on. */
export type SignedAgreementLinkFilter = 'all' | 'linked' | 'unlinked';

export interface ListContractDocumentsQuery {
  contractId?: string;
  orgId?: string;
  linked?: SignedAgreementLinkFilter;
  /** @deprecated legacy spelling of `linked: 'unlinked'`; kept until no caller sends it. */
  unattached?: boolean;
}

function buildQuery(q: ListContractDocumentsQuery): string {
  const params = new URLSearchParams();
  if (q.contractId) params.set('contractId', q.contractId);
  if (q.orgId) params.set('orgId', q.orgId);
  if (q.linked) params.set('linked', q.linked);
  if (q.unattached) params.set('unattached', 'true');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
```

In `apps/web/src/lib/api/contractTemplates.ts`, append next to the other template wrappers:

```ts
/** Spec §6: `{ quoteCount, signedCount }` for the editor header and archive confirm. */
export interface TemplateUsage { quoteCount: number; signedCount: number }

export function getTemplateUsage(id: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}/usage`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/web && npx vitest run src/lib/api/contractDocuments.test.ts && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec tsc --noEmit`
Expected: PASS (5 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api/contractDocuments.ts apps/web/src/lib/api/contractDocuments.test.ts apps/web/src/lib/api/contractTemplates.ts
git commit -m "feat(billing): web clients for the agreement link filter and template usage (W03)"
```

---

### Task 4: Web — `AgreementsShell` and the `agreements.*` locale namespace

**Files:**
- Create: `apps/web/src/components/agreements/AgreementsShell.tsx`
- Test: `apps/web/src/components/agreements/AgreementsShell.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json` (new top-level `agreements` object beside the existing `contracts` object at `billing.json:2`)
- Modify: the same 8 `pages.json` (page titles; `contracts`/`contractsDetail`/`contractsNew` sit at `en/pages.json:56-58`)

**Interfaces:**
```ts
export interface AgreementsShellProps {
  tab: 'templates' | 'signed';
  children: React.ReactNode;
}
export default function AgreementsShell(props: AgreementsShellProps): JSX.Element;
```

**Why real `<a>` links and not `useHashState` tabs.** `ContractsTabs.tsx:27-32` drives its tabs with `window.location.hash`, which is exactly the thing spec §1 complains about: a template could not be linked to, bookmarked, or opened in a new tab. The shell's two "tabs" are anchors to `/agreements/templates` and `/agreements/signed`; the active one is styled from the `tab` prop (server-rendered, so no hydration mismatch) and carries `aria-current="page"`. No `role="tablist"` — these are navigation links, and labelling them as tabs would promise arrow-key semantics the browser will not deliver.

**New locale keys — a new top-level `agreements` object inside the existing `billing.json` namespace** (not a new namespace file, so no `translationCoverage` baseline entry has to be created). English values are normative; the other seven need real translations, and `apps/web/src/locales/TERMINOLOGY.md` already pins the canonical rendering of "agreement template" / "signed agreement" per spec §2 — use it.

`billing.json` → `agreements.*`:

| Key | English |
|---|---|
| `agreements.tabs.templates` | Agreement templates |
| `agreements.tabs.signed` | Signed agreements |
| `agreements.signedPage.title` | Signed agreements |
| `agreements.signedPage.description` | Every agreement your customers have signed. Link one to a contract so it shows on the contract it governs. |
| `agreements.signedPage.unlinkedOnly` | Unlinked only |
| `agreements.signedPage.empty.title` | No signed agreements yet |
| `agreements.signedPage.empty.description` | An agreement is signed when a customer accepts a quote that carries one. |
| `agreements.signedPage.emptyUnlinked.title` | No unlinked signed agreements |
| `agreements.signedPage.emptyUnlinked.description` | Every signed agreement is already filed against a contract. |
| `agreements.signedPage.columns.contract` | Contract |
| `agreements.signedPage.viewContract` | View contract |
| `agreements.signedPage.notLinked` | Not linked |
| `agreements.signedPage.rowSubtitle` | Accepted with quote {{quoteNumber}} by {{signer}} on {{date}} |
| `agreements.signedPage.rowSubtitleNoQuote` | Signed by {{signer}} on {{date}} |
| `agreements.templateEditor.usage` | Used on {{quotes}} quotes · {{signed}} signed agreements |
| `agreements.templateEditor.usageUnavailable` | Usage unavailable |
| `agreements.templateEditor.backToTemplates` | Back to agreement templates |
| `agreements.templateEditor.archiveConfirm.title` | Archive this agreement template? |
| `agreements.templateEditor.archiveConfirm.message` | Used on {{quotes}} quotes · {{signed}} signed agreements. Quotes already pinned to it keep working, but no new agreement sections can be added. |
| `agreements.templateEditor.archiveConfirm.confirm` | Archive template |
| `agreements.contractPill.under` | Under {{template}} v{{n}} |

`pages.json` → `titles.*`: `agreementTemplates` "Agreement templates", `agreementTemplateDetail` "Agreement template", `agreementTemplateNew` "New agreement template", `signedAgreements` "Signed agreements".

The list page itself keeps reusing W01's `contracts.templatesTab.*` keys (title, description, create dialog, columns, statuses) — they were already rewritten to the agreement vocabulary in §3, and duplicating them under `agreements.*` would give the same sentence two catalogs to drift between.

**Deliberately not pluralised.** `agreements.templateEditor.usage` interpolates raw counts rather than using i18next `_one`/`_other` suffixes. The English wording is pinned verbatim by spec §6, the counts are frequently 0, and a plural family multiplies the key count by 4 across 8 locales for a line that is a footnote. If a translator flags it for a language with richer plural rules, revisit as its own change — not silently here.

- [ ] **Step 1: Write the failing shell test**

Create `apps/web/src/components/agreements/AgreementsShell.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/lib/i18n';
import AgreementsShell from './AgreementsShell';

describe('AgreementsShell', () => {
  it('renders both tabs as real links to their own routes', () => {
    render(<AgreementsShell tab="templates"><div data-testid="child" /></AgreementsShell>);
    expect(screen.getByTestId('agreements-shell')).toBeInTheDocument();
    expect(screen.getByTestId('agreements-tab-templates')).toHaveAttribute('href', '/agreements/templates');
    expect(screen.getByTestId('agreements-tab-signed')).toHaveAttribute('href', '/agreements/signed');
    // Anchors, not buttons — a template must be linkable/bookmarkable (spec §1).
    expect(screen.getByTestId('agreements-tab-templates').tagName).toBe('A');
    expect(screen.getByTestId('agreements-tab-signed').tagName).toBe('A');
  });

  it('marks only the active tab as the current page', () => {
    const { rerender } = render(<AgreementsShell tab="templates"><div /></AgreementsShell>);
    expect(screen.getByTestId('agreements-tab-templates')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('agreements-tab-signed')).not.toHaveAttribute('aria-current');
    rerender(<AgreementsShell tab="signed"><div /></AgreementsShell>);
    expect(screen.getByTestId('agreements-tab-signed')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('agreements-tab-templates')).not.toHaveAttribute('aria-current');
  });

  // The one-line relationship sentence is the whole point of the shell (spec §3):
  // it is the only place the UI states how the three objects relate.
  it('renders the relationship sentence from the shared templatesTab description key', () => {
    render(<AgreementsShell tab="signed"><div /></AgreementsShell>);
    expect(screen.getByTestId('agreements-shell-description')).toHaveTextContent(
      /the signed copy is filed against the contract that quote creates/i,
    );
  });

  it('renders its children', () => {
    render(<AgreementsShell tab="templates"><div data-testid="child" /></AgreementsShell>);
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/agreements/AgreementsShell.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the locale keys in all 8 catalogs**

Insert the `agreements` object as a sibling of `contracts` in each `billing.json`, and the four `titles.*` entries in each `pages.json`. Keep every `{{token}}` byte-identical across locales — `localeParity.test.ts` compares the token sets, and a translated `{{assinante}}` fails it.

- [ ] **Step 4: Implement the shell**

Create `apps/web/src/components/agreements/AgreementsShell.tsx`:

```tsx
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

export interface AgreementsShellProps {
  tab: 'templates' | 'signed';
  children: ReactNode;
}

const TABS = [
  { id: 'templates', href: '/agreements/templates', labelKey: 'agreements.tabs.templates', testId: 'agreements-tab-templates' },
  { id: 'signed', href: '/agreements/signed', labelKey: 'agreements.tabs.signed', testId: 'agreements-tab-signed' },
] as const;

/**
 * The /agreements area chrome (spec §6).
 *
 * The two tabs are REAL LINKS, not hash state: spec §1's complaint is that a
 * template could not be linked to at all, and ContractsTabs.tsx:27-32's
 * `window.location.hash` idiom is what produced that. Active styling comes from
 * the `tab` prop, which the Astro page passes at SSR time — no hash read, so no
 * hydration mismatch (#2421) and no flash of the wrong tab.
 *
 * The page description is the ONE place the UI states how agreement template,
 * signed agreement and contract relate. It deliberately reuses W01's
 * `contracts.templatesTab.description` rather than a copy under `agreements.*`:
 * one sentence, one catalog entry, no drift.
 */
export default function AgreementsShell({ tab, children }: AgreementsShellProps) {
  const { t } = useTranslation('billing');
  return (
    <div className="space-y-4" data-testid="agreements-shell">
      <p className="text-sm text-muted-foreground" data-testid="agreements-shell-description">
        {t('contracts.templatesTab.description')}
      </p>
      <nav className="flex gap-1 border-b" aria-label={t('agreements.tabs.templates')}>
        {TABS.map((item) => {
          const active = item.id === tab;
          return (
            <a
              key={item.id}
              href={item.href}
              data-testid={item.testId}
              aria-current={active ? 'page' : undefined}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(item.labelKey)}
            </a>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
```

- [ ] **Step 5: Run to verify pass, including the locale suites**

Run:
```bash
cd apps/web && npx vitest run \
  src/components/agreements/AgreementsShell.test.tsx \
  src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/translationCoverage.test.ts \
  src/lib/i18n/terminologyQuality.test.ts
```
Expected: PASS. A `translationCoverage` failure names the locale and namespace whose duplicate count grew — that is an untranslated string, **translate it**; do not raise the baseline.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/agreements apps/web/src/locales
git commit -m "feat(billing): agreements area shell and locale namespace (W03)"
```

---

### Task 5: Web — the `/agreements` pages and the three moved components

The largest task; do it in the sub-step order below, committing three times, because each half has its own moved test file.

**Files:**
- Create: `apps/web/src/pages/agreements/templates/index.astro`, `apps/web/src/pages/agreements/templates/[id].astro`, `apps/web/src/pages/agreements/signed/index.astro`
- Move: `apps/web/src/components/contracts/TemplatesTab.tsx` → `apps/web/src/components/agreements/TemplatesPage.tsx`
- Move: `apps/web/src/components/contracts/TemplateEditor.tsx` → `apps/web/src/components/agreements/AgreementTemplateEditor.tsx`
- Move: `apps/web/src/components/contracts/DocumentsTab.tsx` → `apps/web/src/components/agreements/SignedAgreementsPage.tsx`
- Move + edit tests: `TemplatesTab.test.tsx` → `agreements/TemplatesPage.test.tsx`; `TemplateEditor.test.tsx` → `agreements/AgreementTemplateEditor.test.tsx`; `TemplateEditor.strippedmarkup.test.tsx` → `agreements/AgreementTemplateEditor.strippedmarkup.test.tsx`; `DocumentsTab.test.tsx` → `agreements/SignedAgreementsPage.test.tsx`
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx` — the `quotes.editor.contract.noTemplates` `<Trans>` link W01 pointed at `/contracts#tab=templates` retargets to `/agreements/templates` (spec §3 says W03 does this)

Use `git mv` for every move so the diff reads as a rename and the file history survives.

**Interfaces:**
```ts
// TemplatesPage.tsx — no props; the create dialog opens from `openCreate`.
export default function TemplatesPage(props: { openCreate?: boolean }): JSX.Element;

// AgreementTemplateEditor.tsx — `onClose` is GONE; navigation replaces it.
export default function AgreementTemplateEditor(props: { templateId: string }): JSX.Element;

// SignedAgreementsPage.tsx
export interface SignedAgreementsPageProps {
  /** Org-record embed: pin the list to one organization and hide the Organization column. */
  lockedOrgId?: string;
  /** Contract-detail embed: pin the list to one contract, hide the Contract column and the link action. */
  lockedContractId?: string;
  /** Start with the "Unlinked only" chip on. Default false (see scope decision 2). */
  defaultUnlinkedOnly?: boolean;
}
export default function SignedAgreementsPage(props: SignedAgreementsPageProps): JSX.Element;
```

#### 5a — the three Astro pages

Thin island hosts, mirroring `apps/web/src/pages/contracts/index.astro` and `[id].astro` exactly (both are 8 and 12 lines).

- [ ] **Step 1: Write them**

`apps/web/src/pages/agreements/templates/index.astro`:
```astro
---
import DashboardLayout from '../../../layouts/DashboardLayout.astro';
import AgreementsShell from '../../../components/agreements/AgreementsShell';
import TemplatesPage from '../../../components/agreements/TemplatesPage';
---

<DashboardLayout titleKey="titles.agreementTemplates">
  <AgreementsShell tab="templates" client:load>
    <TemplatesPage client:load />
  </AgreementsShell>
</DashboardLayout>
```

`apps/web/src/pages/agreements/signed/index.astro` is the same shape with `titleKey="titles.signedAgreements"`, `tab="signed"` and `<SignedAgreementsPage client:load />`.

`apps/web/src/pages/agreements/templates/[id].astro` — `id === 'new'` opens the list with its create dialog already open, mirroring how `pages/contracts/[id].astro` switches on the literal `new`:
```astro
---
import DashboardLayout from '../../../layouts/DashboardLayout.astro';
import AgreementsShell from '../../../components/agreements/AgreementsShell';
import TemplatesPage from '../../../components/agreements/TemplatesPage';
import AgreementTemplateEditor from '../../../components/agreements/AgreementTemplateEditor';

// `id` is a template UUID, or the literal `new` — which renders the LIST with its
// create dialog open, because a template cannot be authored until it exists
// (create returns the id the editor then loads). Mirrors pages/contracts/[id].astro.
const { id } = Astro.params;
const isNew = id === 'new';
const titleKey = isNew ? 'titles.agreementTemplateNew' : 'titles.agreementTemplateDetail';
---

<DashboardLayout titleKey={titleKey}>
  <AgreementsShell tab="templates" client:load>
    {isNew
      ? <TemplatesPage openCreate client:load />
      : <AgreementTemplateEditor templateId={id} client:load />}
  </AgreementsShell>
</DashboardLayout>
```

> **Nested-island check.** `AgreementsShell` is `client:load` and receives a `client:load` child. Astro supports this, but the child arrives as a slot, not as a React element. If `astro check` or a runtime hydration warning objects, flatten it: drop the `client:load` on the shell and let each page component render `<AgreementsShell>` itself (the shell is pure presentation over `t()` and would then hydrate with the child). Decide by the Step 3 check, do not guess.

- [ ] **Step 2: Add `titles.*` if Task 4 did not**

`titles.agreementTemplates`, `titles.agreementTemplateDetail`, `titles.agreementTemplateNew`, `titles.signedAgreements` in all 8 `pages.json`.

- [ ] **Step 3: Verify the routes build**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check`
Expected: no errors. `astro check` is the only thing that typechecks `.astro` files — `tsc --noEmit` skips them.

#### 5b — `TemplatesPage`: row click navigates

- [ ] **Step 4: Move the files**

```bash
git mv apps/web/src/components/contracts/TemplatesTab.tsx apps/web/src/components/agreements/TemplatesPage.tsx
git mv apps/web/src/components/contracts/TemplatesTab.test.tsx apps/web/src/components/agreements/TemplatesPage.test.tsx
```
Fix the now-wrong relative imports (`'../../stores/auth'`, `'../../lib/runAction'`, `'../billing/shared/StatusPill'`, `'../../lib/api/contractTemplates'` all still resolve — the directory depth is identical; only `'./TemplateEditor'` breaks, and it is being deleted anyway).

- [ ] **Step 5: Update the moved test first (red)**

Edits to `apps/web/src/components/agreements/TemplatesPage.test.tsx`:
- Drop the `vi.mock('./TemplateEditor', …)` stub (`TemplatesTab.test.tsx:26`) — the page no longer renders the editor.
- Change `import TemplatesTab from './TemplatesTab'` to `import TemplatesPage from './TemplatesPage'` and every `render(<TemplatesTab />)`.
- Keep all five existing cases as-is (`:89` row/badge, `:104` org-scoped create with no org, `:121` create with orgId, `:143` partner-wide create, `:159` selector hidden for org scope) — none of them touched `selectedId`.
- Add three:

```tsx
  it('navigates to the template route instead of swapping in an editor', async () => {
    render(<TemplatesPage />);
    const rows = await screen.findAllByTestId('contract-template-row');
    fireEvent.click(within(rows[0]).getByTestId('contract-template-open'));
    expect(navigateTo).toHaveBeenCalledWith('/agreements/templates/11111111-1111-1111-1111-111111111111');
    // The editor must NOT mount here — it lives on its own route now (spec §6).
    expect(screen.queryByTestId('agreement-template-editor')).not.toBeInTheDocument();
  });

  it('navigates to the new template after creating one', async () => {
    api.createContractTemplate.mockResolvedValue(resp({ data: { id: 'tpl-new' } }));
    render(<TemplatesPage />);
    // …open the dialog, fill the name, pick partner-wide, submit (as in the :143 case)…
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/agreements/templates/tpl-new'));
  });

  it('opens the create dialog on mount when openCreate is set (the /new route)', async () => {
    render(<TemplatesPage openCreate />);
    expect(await screen.findByTestId('contract-template-create-dialog')).toBeInTheDocument();
  });
```

`navigateTo` is already mocked at `TemplatesTab.test.tsx:8`; hoist it into a `const navigateTo = vi.fn()` so it can be asserted.

- [ ] **Step 6: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/agreements/TemplatesPage.test.tsx`
Expected: FAIL on the three new cases.

- [ ] **Step 7: Implement**

In `apps/web/src/components/agreements/TemplatesPage.tsx`:
- Delete the `selectedId` state (`TemplatesTab.tsx:39`), the `TemplateEditor` import (`:10`) and the whole `if (selectedId) { … }` early return (`:149-159`).
- Add `{ openCreate = false }: { openCreate?: boolean }` to the signature and, right after the other effects, `useEffect(() => { if (openCreate) openDialog(); }, [openCreate]);` — `openDialog` (`:91-98`) already resets every field, so this is exactly the "New" button's behaviour.
- Row open (`:232-239`) becomes a real link so it is middle-clickable, which a `<button>` never was:
  ```tsx
  <a
    href={`/agreements/templates/${tpl.id}`}
    onClick={(e) => { e.preventDefault(); void navigateTo(`/agreements/templates/${tpl.id}`); }}
    className="font-medium text-primary hover:underline"
    data-testid="contract-template-open"
  >
    {tpl.name}
  </a>
  ```
  (`navigateTo` is already imported at `:5`. The `href` gives real link semantics; the handler keeps the soft view-transition navigation.)
- `submitCreate` (`:127`) replaces `if (created?.data?.id) setSelectedId(created.data.id);` with `if (created?.data?.id) void navigateTo(\`/agreements/templates/${created.data.id}\`);`, and the `await load()` immediately above it can go — the page is about to unmount.
- Keep `data-testid="contract-templates-tab"` on the root (`:167`) so `AgreementsPage.ts` and the moved tests keep one stable handle; the `title`/`description` header block (`:169-172`) is **removed** — `AgreementsShell` renders the description now and the page title comes from `DashboardLayout`.

- [ ] **Step 8: Run to verify pass**

Run: `cd apps/web && npx vitest run src/components/agreements/TemplatesPage.test.tsx`
Expected: PASS (8 tests).

#### 5c — `AgreementTemplateEditor`: back link, usage line, archive confirm

- [ ] **Step 9: Move the files and update the tests first (red)**

```bash
git mv apps/web/src/components/contracts/TemplateEditor.tsx apps/web/src/components/agreements/AgreementTemplateEditor.tsx
git mv apps/web/src/components/contracts/TemplateEditor.test.tsx apps/web/src/components/agreements/AgreementTemplateEditor.test.tsx
git mv apps/web/src/components/contracts/TemplateEditor.strippedmarkup.test.tsx apps/web/src/components/agreements/AgreementTemplateEditor.strippedmarkup.test.tsx
```

`AgreementTemplateEditor.test.tsx`: rename the import and every `render(<TemplateEditor templateId="…" onClose={…} />)` to drop `onClose`. All seven existing cases (`:76` publish, `:86` dirty-blocks-publish, `:102` re-enable after normalising save, `:132` new-version confirm, `:158` new-version clears, `:173` manual variables, `:180` archived hides affordances) keep their assertions verbatim — none of them referenced `onClose`. Add a `getTemplateUsage` mock to the `contractTemplates` module mock, and three cases:

```tsx
  it('shows the usage line from the usage endpoint', async () => {
    api.getTemplateUsage.mockResolvedValue(resp({ data: { quoteCount: 3, signedCount: 7 } }));
    render(<AgreementTemplateEditor templateId={TEMPLATE_ID} />);
    const usage = await screen.findByTestId('agreement-template-usage');
    expect(usage).toHaveTextContent('3');
    expect(usage).toHaveTextContent('7');
  });

  it('renders the editor without a usage line when the usage call fails, never a broken count', async () => {
    api.getTemplateUsage.mockResolvedValue(resp({ error: 'boom' }, 500));
    render(<AgreementTemplateEditor templateId={TEMPLATE_ID} />);
    await screen.findByTestId('agreement-template-editor');
    expect(screen.queryByTestId('agreement-template-usage')).not.toBeInTheDocument();
  });

  it('links Back to the templates list', async () => {
    render(<AgreementTemplateEditor templateId={TEMPLATE_ID} />);
    expect(await screen.findByTestId('agreement-template-editor-back'))
      .toHaveAttribute('href', '/agreements/templates');
  });

  it('shows the usage counts in the archive confirmation', async () => {
    api.getTemplateUsage.mockResolvedValue(resp({ data: { quoteCount: 3, signedCount: 7 } }));
    render(<AgreementTemplateEditor templateId={TEMPLATE_ID} />);
    fireEvent.click(await screen.findByTestId('agreement-template-archive'));
    const dialog = await screen.findByTestId('agreement-template-archive-confirm-dialog');
    expect(dialog).toHaveTextContent('3');
    expect(dialog).toHaveTextContent('7');
    expect(dialog).toHaveTextContent(/keep working/i);
  });
```

`AgreementTemplateEditor.strippedmarkup.test.tsx` needs only the import/name change — both its cases (`:87`, `:109`) are about `saveDraft` toasts.

- [ ] **Step 10: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/agreements/AgreementTemplateEditor.test.tsx src/components/agreements/AgreementTemplateEditor.strippedmarkup.test.tsx`
Expected: FAIL on the four new cases; the strippedmarkup pair should already be green after the rename.

- [ ] **Step 11: Implement**

In `apps/web/src/components/agreements/AgreementTemplateEditor.tsx`:
- Props (`:40-43`) become `interface Props { templateId: string }` — `onClose` is deleted.
- Root testid (`:219`) becomes `agreement-template-editor` (spec §6). **Update `e2e-tests/tests/quote-contract-proposal.spec.ts:85` in Task 10 accordingly** — that is the one editor testid the e2e spec touches.
- The back control (`:222-232`) becomes an unconditional anchor:
  ```tsx
  <a href="/agreements/templates" data-testid="agreement-template-editor-back"
     className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
    <ArrowLeft className="h-3.5 w-3.5" />
    {t('agreements.templateEditor.backToTemplates')}
  </a>
  ```
- Add usage state and a load beside the existing one:
  ```tsx
  const [usage, setUsage] = useState<TemplateUsage | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getTemplateUsage(templateId).catch(() => null);
      if (!res?.ok) return;                       // usage is decoration; a failure is silent
      const body = (await res.json().catch(() => null)) as { data?: TemplateUsage } | null;
      if (!cancelled && body?.data) setUsage(body.data);
    })();
    return () => { cancelled = true; };
  }, [templateId]);
  ```
  Rendered under the `<h2>` in the header block (`:233`):
  ```tsx
  {usage && (
    <span className="text-xs text-muted-foreground" data-testid="agreement-template-usage">
      {t('agreements.templateEditor.usage', { quotes: usage.quoteCount, signed: usage.signedCount })}
    </span>
  )}
  ```
  **Deliberately silent on failure.** A wrong or "—" count in a header that also feeds an archive confirmation is worse than no count; the archive dialog degrades the same way (next bullet).
- Archive moves here from the list. The list's archive button (`TemplatesPage.tsx:272-279`) **stays** for bulk-ish work, but the editor gets its own `agreement-template-archive` button (rendered only when `!archived`, beside "New version" at `:241`) wired to `archiveContractTemplate` through `runAction`, then `void navigateTo('/agreements/templates')`. It opens a second `ConfirmDialog` (the component is already imported at `:10`) with `confirmTestId="agreement-template-archive-confirm"`, `data-testid="agreement-template-archive-confirm-dialog"` on the dialog, title `agreements.templateEditor.archiveConfirm.title`, and message `t('agreements.templateEditor.archiveConfirm.message', { quotes: usage?.quoteCount ?? 0, signed: usage?.signedCount ?? 0 })`.
  > Check `apps/web/src/components/shared/ConfirmDialog.tsx`'s prop list before writing the dialog — if it has no `data-testid` passthrough, put the testid on a wrapping element or add the prop; do not invent one.

- [ ] **Step 12: Run to verify pass**

Run: `cd apps/web && npx vitest run src/components/agreements/`
Expected: PASS across `AgreementsShell`, `TemplatesPage`, both editor files.

- [ ] **Step 13: Commit 5a–5c**

```bash
git add apps/web/src/pages/agreements apps/web/src/components/agreements apps/web/src/components/contracts apps/web/src/locales
git commit -m "feat(billing): agreement templates get their own routes and editor (W03)"
```

#### 5d — `SignedAgreementsPage`

- [ ] **Step 14: Move and update the test first (red)**

```bash
git mv apps/web/src/components/contracts/DocumentsTab.tsx apps/web/src/components/agreements/SignedAgreementsPage.tsx
git mv apps/web/src/components/contracts/DocumentsTab.test.tsx apps/web/src/components/agreements/SignedAgreementsPage.test.tsx
```

Edits to `SignedAgreementsPage.test.tsx`:
- Rename the import and the `describe` title.
- **`:58` "fetches unattached documents (contract_id IS NULL)" changes meaning** — the page now asks for everything by default. Rewrite its `expect` to `expect.objectContaining({ linked: 'all' })` and rename it "fetches the whole inventory by default".
- `:72` empty state and `:78` link-error and `:90` link-and-reload keep their assertions; `:90`'s second-call count still holds.
- Add:

```tsx
  it('refetches with linked=unlinked when the Unlinked only chip is turned on', async () => {
    render(<SignedAgreementsPage />);
    await screen.findByTestId('signed-agreements-tab');
    fireEvent.click(screen.getByTestId('signed-agreements-unlinked-filter'));
    await waitFor(() =>
      expect(docsApi.listContractDocuments).toHaveBeenLastCalledWith(
        expect.objectContaining({ linked: 'unlinked' }),
      ),
    );
    expect(window.location.hash).toContain('unlinked=1');
  });

  it('starts with the chip on and asks for unlinked when defaultUnlinkedOnly is set', async () => {
    render(<SignedAgreementsPage defaultUnlinkedOnly />);
    await waitFor(() =>
      expect(docsApi.listContractDocuments).toHaveBeenCalledWith(expect.objectContaining({ linked: 'unlinked' })),
    );
  });

  it('pins to one org and hides the Organization column when lockedOrgId is set', async () => {
    render(<SignedAgreementsPage lockedOrgId="org-1" />);
    await waitFor(() =>
      expect(docsApi.listContractDocuments).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'org-1', linked: 'all' }),
      ),
    );
    expect(screen.queryByText('Organization')).not.toBeInTheDocument();
  });

  it('pins to one contract, hides the Contract column and offers no link action', async () => {
    render(<SignedAgreementsPage lockedContractId="ct-1" />);
    await waitFor(() =>
      expect(docsApi.listContractDocuments).toHaveBeenCalledWith(expect.objectContaining({ contractId: 'ct-1' })),
    );
    const rows = await screen.findAllByTestId('contract-document-unattached-row');
    expect(within(rows[0]).queryByTestId('contract-document-link-open')).not.toBeInTheDocument();
  });

  it('renders the acceptance subtitle from the quote, signer and signed date', async () => {
    render(<SignedAgreementsPage />);
    const rows = await screen.findAllByTestId('contract-document-unattached-row');
    expect(within(rows[0]).getByTestId('signed-agreement-subtitle'))
      .toHaveTextContent(/Q-2026-0001.*Jane Doe/);
  });

  it('links a linked row to its contract', async () => {
    docsApi.listContractDocuments.mockResolvedValue(resp({ data: [{ ...UNATTACHED_DOC, contractId: 'ct-9' }] }));
    render(<SignedAgreementsPage />);
    const rows = await screen.findAllByTestId('contract-document-unattached-row');
    expect(within(rows[0]).getByTestId('signed-agreement-contract-link')).toHaveAttribute('href', '/contracts/ct-9');
  });
```

The fixture at `DocumentsTab.test.tsx:33-47` already carries `signerName: 'Jane Doe'`, `signedAt`, `quoteNumber: 'Q-2026-0001'` and `contractId: null` — no fixture changes needed.

- [ ] **Step 15: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/agreements/SignedAgreementsPage.test.tsx`
Expected: FAIL on the six new cases and on the rewritten `:58`.

- [ ] **Step 16: Implement**

In `apps/web/src/components/agreements/SignedAgreementsPage.tsx`:
- Props per the interface above. Root testid (`DocumentsTab.tsx:153`) becomes `signed-agreements-tab`; the header block (`:154-157`) renders `agreements.signedPage.title` / `.description` **only when neither locking prop is set** (inside an embed, `OrgBillingTab`'s `<summary>` and the contract page's own heading already say it).
- Chip state via `useHashState`, matching `ContractsTabs.tsx`'s read/write split (the hook reads; the caller writes the hash):
  ```tsx
  // CLAUDE.md: hash for transient UI state, never query params. Embeds do NOT
  // read the hash — two lists on one page (org record) would fight over it.
  const [unlinkedOnly, setUnlinkedOnly] = useHashState<boolean>(
    defaultUnlinkedOnly,
    (h) => (locked ? undefined : new URLSearchParams(h).get('unlinked') === '1' || undefined),
  );
  const toggleUnlinked = () => {
    const next = !unlinkedOnly;
    setUnlinkedOnly(next);
    if (!locked) window.location.hash = next ? 'unlinked=1' : '';
  };
  ```
  where `const locked = Boolean(lockedOrgId || lockedContractId)`.
- The chip itself, rendered only when `!lockedContractId` (a per-contract list has nothing to filter):
  ```tsx
  <button type="button" onClick={toggleUnlinked} aria-pressed={unlinkedOnly}
          data-testid="signed-agreements-unlinked-filter"
          className={`rounded-full border px-3 py-1 text-xs font-medium ${unlinkedOnly ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}`}>
    {t('agreements.signedPage.unlinkedOnly')}
  </button>
  ```
- `load()` (`DocumentsTab.tsx:65-80`) swaps its query:
  ```ts
  const res = await listContractDocuments(
    lockedContractId
      ? { contractId: lockedContractId }
      : { orgId: lockedOrgId, linked: unlinkedOnly ? 'unlinked' : 'all' },
  );
  ```
  and `unlinkedOnly` / `lockedOrgId` / `lockedContractId` join its `useCallback` deps. **`linked` must be sent explicitly** — an omitted param means `unlinked` server-side (Task 1).
- Columns per spec §6: Template · Organization · Signer · Signed · Quote · **Contract**. Organization (`:182`) is dropped when `lockedOrgId`; Contract is dropped when `lockedContractId`. The Contract cell is
  ```tsx
  {doc.contractId ? (
    <a href={`/contracts/${doc.contractId}`} data-testid="signed-agreement-contract-link" className="text-primary hover:underline">
      {t('agreements.signedPage.viewContract')}
    </a>
  ) : (
    <span className="text-muted-foreground">{t('agreements.signedPage.notLinked')}</span>
  )}
  ```
  > **Why a generic "View contract" and not the contract's name.** The list row (`contractDocumentService.ts` projection) carries `contractId` but no contract name — adding one means a join on `contracts` in a list endpoint whose only other consumer is a per-contract view. Not worth an API change in this wave; file it as a follow-up if operators ask for the name.
- Row subtitle under the Template cell (`:192-197`), using fields the list already returns (`signerName`, `signedAt`, `quoteNumber` — all present in the projection and in `ContractDocument` at `contractDocuments.ts:17-32`):
  ```tsx
  <div className="text-xs text-muted-foreground" data-testid="signed-agreement-subtitle">
    {doc.quoteNumber
      ? t('agreements.signedPage.rowSubtitle', {
          quoteNumber: doc.quoteNumber,
          signer: doc.signerName ?? '—',
          date: doc.signedAt ? formatDate(doc.signedAt) : '—',
        })
      : t('agreements.signedPage.rowSubtitleNoQuote', {
          signer: doc.signerName ?? '—',
          date: doc.signedAt ? formatDate(doc.signedAt) : '—',
        })}
  </div>
  ```
  (`formatDate` is already imported at `:11`. The no-quote variant exists because `quoteId`/`quoteNumber` are left-joined and genuinely null for a document whose quote was deleted.)
- The link action (`:217-224`) renders only when `!doc.contractId && !lockedContractId`.
- Empty state picks `agreements.signedPage.emptyUnlinked.*` when the chip is on, `agreements.signedPage.empty.*` otherwise — "No signed agreements yet" under an active filter is a lie.
- Keep `contract-document-unattached-row`, `contract-document-link-open`, `contract-document-link-dialog`, `contract-document-link-select`, `contract-document-link-confirm`, `contract-document-download-*` as they are. They are no longer accurate names, but renaming them buys nothing here and costs every moved assertion.

- [ ] **Step 17: Check the file size**

Run: `wc -l apps/web/src/components/agreements/SignedAgreementsPage.tsx`
Expected: under 450. If over, extract `DocumentsTab.tsx:234-298` (the link dialog) into `components/agreements/LinkSignedAgreementDialog.tsx` taking `{ doc, onClose, onLinked }`, and move `:103-150`'s dialog state with it.

- [ ] **Step 18: Run to verify pass**

Run: `cd apps/web && npx vitest run src/components/agreements/ && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check`
Expected: PASS; no type errors. `astro check` will now also fail on any remaining importer of the three moved files — Task 6 and Task 8 fix those, so a red here naming `ContractsTabs.tsx` or `ContractDetail.tsx` is expected and is what sequences the next two tasks.

- [ ] **Step 19: Retarget the QuoteEditor empty-state link**

In `apps/web/src/components/billing/quotes/QuoteEditor.tsx`, the `<Trans>` rendering `quotes.editor.contract.noTemplates` points at `/contracts#tab=templates` (W01's target, spec §3 footnote). Change the anchor to `/agreements/templates`. Grep first: `grep -n "tab=templates" apps/web/src -r`.

- [ ] **Step 20: Commit 5d**

```bash
git add apps/web/src/components/agreements apps/web/src/components/billing/quotes/QuoteEditor.tsx
git commit -m "feat(billing): signed agreements page with link filter and embeds (W03)"
```

---

### Task 6: Web — `/contracts` loses two tabs and redirects the old deep links

**Files:**
- Modify: `apps/web/src/components/contracts/ContractsTabs.tsx` (whole file; it is 96 lines)
- Modify: `apps/web/src/components/contracts/ContractsList.tsx` (currency-mismatch banner)
- Modify: `apps/web/src/components/contracts/ContractsTabs.currency.test.tsx`
- Create: `apps/web/src/components/contracts/ContractsTabs.redirect.test.tsx`
- Modify: the 8 `billing.json` (banner copy)

**Interfaces:** none exported change; `ContractsTabs` keeps its default export and no props.

**Target shape.** `Tab` narrows from four (`ContractsTabs.tsx:16`) to `'contracts' | 'currency-mismatches'`. In the **default** state there is no tab bar at all — spec §6's "Net: `/contracts` has no tab bar in the default state". The currency-mismatch report is reached from a banner on `ContractsList`, which sets `#tab=currency-mismatches`; on that view a single "Back to contracts" control returns. The `contracts-tabs` testid moves to the outer wrapper so `quote-contract-proposal.spec.ts:48,289` keep a hydration handle (Task 10 keeps using it).

- [ ] **Step 1: Write the failing redirect test**

Create `apps/web/src/components/contracts/ContractsTabs.redirect.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import '@/lib/i18n';

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
vi.mock('./ContractsList', () => ({ ContractsList: () => <div data-testid="stub-list" />, default: () => <div data-testid="stub-list" /> }));
vi.mock('./CurrencyMismatchesTab', () => ({ default: () => <div data-testid="stub-currency" /> }));

import ContractsTabs from './ContractsTabs';

describe('ContractsTabs legacy deep links', () => {
  beforeEach(() => { vi.clearAllMocks(); window.location.hash = ''; });

  it('redirects #tab=templates to the agreement templates route', () => {
    window.location.hash = 'tab=templates';
    render(<ContractsTabs />);
    expect(navigateTo).toHaveBeenCalledWith('/agreements/templates', { replace: true });
  });

  it('redirects #tab=documents to the signed agreements route', () => {
    window.location.hash = 'tab=documents';
    render(<ContractsTabs />);
    expect(navigateTo).toHaveBeenCalledWith('/agreements/signed', { replace: true });
  });

  it('leaves #tab=currency-mismatches alone', () => {
    window.location.hash = 'tab=currency-mismatches';
    render(<ContractsTabs />);
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('renders the contracts list with no tab bar by default', () => {
    render(<ContractsTabs />);
    expect(document.querySelector('[data-testid="contracts-tab-contracts"]')).toBeNull();
    expect(document.querySelector('[data-testid="contracts-tab-templates"]')).toBeNull();
    expect(document.querySelector('[data-testid="contracts-tab-documents"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractsTabs.redirect.test.tsx`
Expected: FAIL — the component still renders four tab buttons and never navigates.

- [ ] **Step 3: Implement `ContractsTabs`**

Rewrite `apps/web/src/components/contracts/ContractsTabs.tsx`:

```tsx
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { useHashState } from '@/lib/useHashState';
import { ContractsList } from './ContractsList';
import CurrencyMismatchesTab from './CurrencyMismatchesTab';

// The contracts landing page (spec §6). Agreement templates and signed
// agreements moved out to /agreements in W03, so what is left is the contracts
// LIST plus the read-only currency-mismatch report — and the report is reached
// from a banner on the list, not a tab. Net: no tab bar in the default state.
type Tab = 'contracts' | 'currency-mismatches';

// Deep links minted before the split. `navigateTo(..., { replace: true })` keeps
// them out of the back stack, so Back from /agreements/templates returns to
// whatever the user was on before, not to a URL that immediately re-redirects.
const LEGACY_REDIRECTS: Record<string, string> = {
  templates: '/agreements/templates',
  documents: '/agreements/signed',
};

function parseTab(hash: string): Tab | undefined {
  return new URLSearchParams(hash).get('tab') === 'currency-mismatches' ? 'currency-mismatches' : undefined;
}

export default function ContractsTabs() {
  const { t } = useTranslation('billing');
  const [tab, setTab] = useHashState<Tab>('contracts', parseTab);

  useEffect(() => {
    const redirect = () => {
      const raw = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('tab');
      const target = raw ? LEGACY_REDIRECTS[raw] : undefined;
      if (target) void navigateTo(target, { replace: true });
    };
    redirect();
    window.addEventListener('hashchange', redirect);
    return () => window.removeEventListener('hashchange', redirect);
  }, []);

  const showContracts = () => { setTab('contracts'); window.location.hash = ''; };

  return (
    <div className="space-y-4" data-testid="contracts-tabs">
      {tab === 'currency-mismatches' ? (
        <>
          <button type="button" onClick={showContracts} data-testid="contracts-back-to-list"
                  className="text-xs text-muted-foreground hover:underline">
            {t('contracts.contractWorkspace.backToContracts')}
          </button>
          <CurrencyMismatchesTab />
        </>
      ) : (
        <ContractsList />
      )}
    </div>
  );
}
```

Verify the `ContractsList` export shape before writing the import — `ContractsTabs.tsx:4` uses the named `{ ContractsList }` while `OrgBillingTab.tsx:3` imports it as default, so the module has both; keep whichever the file already used.

- [ ] **Step 4: Add the banner to `ContractsList`**

New keys in the 8 `billing.json` under `contracts.contractsList.currencyBanner`:

| Key | English |
|---|---|
| `contracts.contractsList.currencyBanner.count` | {{count}} contracts bill in a currency that differs from their organization's. |
| `contracts.contractsList.currencyBanner.countPlus` | {{count}}+ contracts bill in a currency that differs from their organization's. |
| `contracts.contractsList.currencyBanner.review` | Review them |

In `ContractsList.tsx`, add a mount-time probe and render the banner above the table:

```tsx
// Spec §6: the currency-mismatch report stops being a tab and becomes a banner
// here. The report endpoint is cursor-paged with no total (see
// ContractCurrencyMismatchReport at lib/api/contracts.ts:206-209), so the banner
// asks for one page and says "50+" when there is a next cursor rather than
// inventing a number. A failed probe renders nothing — this is an affordance,
// not data.
const [mismatches, setMismatches] = useState<{ count: number; more: boolean } | null>(null);
useEffect(() => {
  let cancelled = false;
  void (async () => {
    const res = await listContractCurrencyMismatches({ limit: 50 }).catch(() => null);
    if (!res?.ok) return;
    const body = (await res.json().catch(() => null)) as { data?: ContractCurrencyMismatchReport } | null;
    if (!cancelled && body?.data?.items.length) {
      setMismatches({ count: body.data.items.length, more: body.data.nextCursor !== null });
    }
  })();
  return () => { cancelled = true; };
}, []);
```

```tsx
{mismatches && (
  <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
       data-testid="contracts-currency-mismatch-banner">
    <span>{t(mismatches.more ? 'contracts.contractsList.currencyBanner.countPlus' : 'contracts.contractsList.currencyBanner.count', { count: mismatches.count })}</span>
    <a href="#tab=currency-mismatches" data-testid="contracts-currency-mismatch-open"
       className="font-medium text-primary hover:underline">
      {t('contracts.contractsList.currencyBanner.review')}
    </a>
  </div>
)}
```

A plain `<a href="#tab=…">` is enough: `ContractsTabs`'s `useHashState` already subscribes to `hashchange` (`useHashState.ts:66`), so the click swaps the view without a navigation.

- [ ] **Step 5: Update `ContractsTabs.currency.test.tsx`**

All six cases (`:56,:68,:91,:101,:117,:125`) exercise `CurrencyMismatchesTab` through the tab bar. Change `:56` ("defaults to the contracts list and only mounts the report when selected") to drive the banner link instead of `contracts-tab-currency-mismatches`, and set `window.location.hash = 'tab=currency-mismatches'` before `render` in the other five so the report mounts. Their assertions about rows, read-only-ness, paging and errors are unchanged.

- [ ] **Step 6: Run to verify pass**

Run: `cd apps/web && npx vitest run src/components/contracts/`
Expected: PASS. Any failure naming `TemplatesTab`/`DocumentsTab`/`TemplateEditor` means a stale importer survived Task 5 — `grep -rn "TemplatesTab\|DocumentsTab\|TemplateEditor" apps/web/src` must return nothing outside `components/agreements/`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/contracts apps/web/src/locales
git commit -m "feat(billing): contracts page drops the template and document tabs (W03)"
```

---

### Task 7: Web — the Agreements sidebar item

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (billing section items at `:321-325`; `pathAliases` at `:459-462`; the lucide import block at the top)
- Modify: `apps/web/src/components/layout/Sidebar.nav.test.tsx` (the labelKey contract at `:253-259`)
- Modify: `apps/web/src/components/layout/Sidebar.rbac.test.tsx` (`PARTNER_BILLING` at `:44-50`; the assertion blocks at `:102-103` and `:146-147`)
- Modify: the 8 `common.json` (`nav.*` block; `nav.contracts` is `en/common.json:36`)

**Interfaces:** the new `NavItem` (type at `Sidebar.tsx:152-170`):

```ts
{ name: 'Agreements', labelKey: 'nav.agreements', href: '/agreements/templates', icon: ScrollText, partnerScopeOnly: true, requiredPermission: { resource: 'agreements', action: 'read' } },
```

placed **immediately after** the Contracts item (`Sidebar.tsx:323`), inside the `billing` section — which already carries `requiresModule: 'service_management'` at the section level (`:317`), so the spec's "requiresModule service_management (inherited)" needs no per-item flag.

**Icon.** `ScrollText` — verified available and already used in this app (`apps/web/src/components/organizations/record/OrgOverviewTab.tsx:2,162` and `apps/web/src/components/settings/PartnerSettingsPage.tsx:12,109`), so it exists in the installed `lucide-react@^1.21.0` and needs no version check. It is **not** `FileSignature` (unused today) and not `FileText`, which `Sidebar.tsx:321` already gives Quotes — two `FileText` items three rows apart in the same section is exactly the "which one is which" confusion this wave exists to remove. Add `ScrollText` to the `lucide-react` import at the top of `Sidebar.tsx`.

**Active state for nested routes — checked.** `Sidebar.tsx:711-713` computes `matches` as `resolvedPath === item.href || resolvedPath.startsWith(item.href + '/')`, longest-href wins (`:714-716`). So:
- `/agreements/templates` → exact match. ✅
- `/agreements/templates/<uuid>` → prefix match. ✅
- `/agreements/signed` → **no match** (it is not under `/agreements/templates/`), so the item would go dark on the Signed tab. Fix it the way the repo already fixes this exact class — `pathAliases` (`:459-462`, which maps `/software-inventory` and `/software-policies` onto `/software`):
  ```ts
  const pathAliases: Record<string, string> = {
    '/software-inventory': '/software',
    '/software-policies': '/software',
    // The Agreements nav item points at the Templates tab; the Signed tab is a
    // sibling route, not a child, so prefix matching (Sidebar.tsx:713) would
    // leave the item unhighlighted there.
    '/agreements/signed': '/agreements/templates',
  };
  ```

- [ ] **Step 1: Write the failing RBAC assertions**

In `apps/web/src/components/layout/Sidebar.rbac.test.tsx`:
- Add `{ resource: 'agreements', action: 'read' }, { resource: 'agreements', action: 'write' },` to `PARTNER_BILLING` (`:44-50`) — W02's migration back-fills exactly that for the seeded role, so the fixture must match the seed or the test is testing fiction.
- In the "Partner Billing sees only its billing items" case, add `expect(has(container, '/agreements/templates')).toBe(true);` beside the `/contracts` assertion (`:102`).
- In the no-billing-grants case, add `expect(has(container, '/agreements/templates')).toBe(false);` beside its `/contracts` assertion (`:146`).
- Add a dedicated case:
  ```tsx
  it('shows Agreements for agreements:read alone and hides it without', async () => {
    state.user.permissions = [{ resource: 'agreements', action: 'read' }];
    const { container, rerender } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(has(container, '/agreements/templates')).toBe(true));
    // contracts:read alone must NOT reveal it — the whole point of the W02 split.
    state.user.permissions = [{ resource: 'contracts', action: 'read' }];
    rerender(<Sidebar currentPath="/" />);
    await waitFor(() => expect(has(container, '/agreements/templates')).toBe(false));
  });
  ```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/layout/Sidebar.rbac.test.tsx src/components/layout/Sidebar.nav.test.tsx`
Expected: FAIL — no such nav item, and `Sidebar.nav.test.tsx:253-259` ("gives every top-level item a key that resolves in both locales") will fail the moment the item exists without `nav.agreements` in `common.json`.

- [ ] **Step 3: Add `nav.agreements` ×8**

English "Agreements". `Sidebar.nav.test.tsx:256` asserts `i18n.t(labelKey, { lng: 'pt-BR' }) !== labelKey` and `:257` asserts the `en` value equals `item.name` — so `name` must be exactly `'Agreements'`, and the pt-BR value must be a real translation ("Contratos" is already `nav.contracts`; use the TERMINOLOGY.md rendering for "agreement", e.g. "Acordos"). Check `apps/web/src/locales/TERMINOLOGY.md` for the canonical term per locale before writing any of the eight.

- [ ] **Step 4: Add the nav item and the path alias**

As specified above.

- [ ] **Step 5: Run the whole Sidebar suite**

Run: `cd apps/web && npx vitest run src/components/layout/ src/lib/i18n/`
Expected: PASS — including `Sidebar.billing`, `Sidebar.module`, `Sidebar.featuregate` and `Sidebar.collapsedrail` tests, any of which may assert an item count for the billing section. If one does, update its expected count and say why in the diff.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/layout apps/web/src/locales
git commit -m "feat(billing): Agreements sidebar item (W03)"
```

---

### Task 8: Web — the "Under {{template}} v{{n}}" pill, and contract detail reuses the shared list

**Files:**
- Modify: `apps/web/src/components/contracts/ContractWorkspace.tsx` (header block at `:111-133`)
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx` (`:29` import, `:483` render)
- Delete: `apps/web/src/components/contracts/ContractDocumentsSection.tsx`
- Modify: `apps/web/src/components/contracts/ContractDetail.documents.test.tsx`
- Create: `apps/web/src/components/contracts/ContractWorkspace.agreement.test.tsx`

**Decision: lift the fetch into `ContractWorkspace`; do not thread a callback.** The two candidates were (a) a small `listContractDocuments({ contractId })` call in `ContractWorkspace`, and (b) an `onLoaded(docs)` callback out of the embedded list. (b) loses: the pill lives in `ContractWorkspace`'s header (`:111-133`) but the list is mounted two levels down inside `ContractDetail` (`:483`), so the callback has to be prop-drilled through `ContractDetail`'s `{ detail, onChanged }` signature, and — worse — the pill would then be **absent for a draft contract**, because `ContractWorkspace:107` renders `ContractEditor` instead of `ContractDetail` for drafts and the list never mounts. A draft contract auto-created from an accepted quote is precisely the case where "Under <MSA> v1" is the most useful thing on the screen.

The cost of (a) is one duplicate `GET /contracts/contract-documents?contractId=…` per contract page (the embedded list issues its own). That is a small JSON list already scoped to one contract, with no PDF bytes in the projection (`contractDocumentService.ts` selects `byteSize`/`sha256`, never `pdfData`). Accepted; noted in the code comment so nobody "optimises" it back into prop-drilling without reading this.

**Which document the pill names.** Spec §6: "first by `created_at`". `listContractDocuments` orders `desc(contractDocuments.createdAt)`, so the first-created row is the **last** element of the returned array — `docs[docs.length - 1]`, not `docs[0]`. Getting this backwards is silent (both are real templates) and only shows up on a contract with two signed agreements.

- [ ] **Step 1: Write the failing pill test**

Create `apps/web/src/components/contracts/ContractWorkspace.agreement.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@/lib/i18n';

const api = vi.hoisted(() => ({ getContract: vi.fn(), listContractDocuments: vi.fn() }));
vi.mock('../../lib/api/contracts', async (o) => ({ ...(await o<typeof import('../../lib/api/contracts')>()), getContract: api.getContract }));
vi.mock('../../lib/api/contractDocuments', async (o) => ({ ...(await o<typeof import('../../lib/api/contractDocuments')>()), listContractDocuments: api.listContractDocuments }));
vi.mock('./ContractDetail', () => ({ default: () => <div data-testid="stub-detail" /> }));
vi.mock('./ContractEditor', () => ({ default: () => <div data-testid="stub-editor" /> }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import ContractWorkspace from './ContractWorkspace';

const resp = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'd1', orgId: 'org-1', contractId: 'ct-1', quoteId: 'q1', templateId: 't1', templateVersionId: 'v1',
  templateName: 'Master Services Agreement', templateVersionNumber: 2, signerName: 'Jane Doe',
  signedAt: '2026-06-01T00:00:00Z', quoteNumber: 'Q-1', byteSize: 1, sha256: 'a', createdAt: '2026-06-01T00:00:00Z',
  ...over,
});

describe('ContractWorkspace agreement pill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getContract.mockResolvedValue(resp({ data: { contract: { id: 'ct-1', name: 'Acme MSA', status: 'active' } } }));
  });

  it('names the FIRST-created signed agreement, not the newest', async () => {
    // The API returns newest-first (contractDocumentService orders desc), so the
    // first-created row is the LAST element.
    api.listContractDocuments.mockResolvedValue(resp({ data: [
      doc({ id: 'd2', templateName: 'Addendum', templateVersionNumber: 5, createdAt: '2026-07-01T00:00:00Z' }),
      doc({ id: 'd1', templateName: 'Master Services Agreement', templateVersionNumber: 2 }),
    ] }));
    render(<ContractWorkspace contractId="ct-1" />);
    const pill = await screen.findByTestId('contract-under-agreement-pill');
    expect(pill).toHaveTextContent('Master Services Agreement');
    expect(pill).toHaveTextContent('2');
    expect(pill).not.toHaveTextContent('Addendum');
  });

  it('renders no pill when the contract has no signed agreement', async () => {
    api.listContractDocuments.mockResolvedValue(resp({ data: [] }));
    render(<ContractWorkspace contractId="ct-1" />);
    await screen.findByTestId('contract-workspace');
    expect(screen.queryByTestId('contract-under-agreement-pill')).not.toBeInTheDocument();
  });

  it('renders no pill (and no error) when the documents fetch fails', async () => {
    api.listContractDocuments.mockResolvedValue(resp({ error: 'boom' }, 500));
    render(<ContractWorkspace contractId="ct-1" />);
    await screen.findByTestId('contract-workspace');
    expect(screen.queryByTestId('contract-under-agreement-pill')).not.toBeInTheDocument();
  });

  it('shows the pill on a DRAFT contract too, where the detail view never mounts', async () => {
    api.getContract.mockResolvedValue(resp({ data: { contract: { id: 'ct-1', name: 'Q-1 — Monthly', status: 'draft' } } }));
    api.listContractDocuments.mockResolvedValue(resp({ data: [doc()] }));
    render(<ContractWorkspace contractId="ct-1" />);
    expect(await screen.findByTestId('contract-under-agreement-pill')).toBeInTheDocument();
  });

  it('links the pill to the signed agreements section on the page', async () => {
    api.listContractDocuments.mockResolvedValue(resp({ data: [doc()] }));
    render(<ContractWorkspace contractId="ct-1" />);
    expect(await screen.findByTestId('contract-under-agreement-pill'))
      .toHaveAttribute('href', '#signed-agreements');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractWorkspace.agreement.test.tsx`
Expected: FAIL — no such testid.

- [ ] **Step 3: Implement the pill**

In `apps/web/src/components/contracts/ContractWorkspace.tsx`, add beside the existing `load` effect (`:63`):

```tsx
  // Spec §6 reciprocal link: name the agreement this contract sits under.
  //
  // Fetched HERE rather than bubbled out of the embedded SignedAgreementsPage
  // (ContractDetail.tsx:483) on purpose: a DRAFT contract renders ContractEditor,
  // not ContractDetail (:107), so that list never mounts — and a draft
  // auto-created from an accepted quote is exactly when this pill matters most.
  // The cost is one duplicate contractId-scoped list GET; the projection carries
  // no PDF bytes, so it is cheap.
  //
  // "First by created_at" (spec §6) = the LAST element: the service orders
  // desc(createdAt).
  const [firstAgreement, setFirstAgreement] = useState<ContractDocument | null>(null);
  useEffect(() => {
    if (isNew || !contractId) return;
    let cancelled = false;
    void (async () => {
      const res = await listContractDocuments({ contractId }).catch(() => null);
      if (!res?.ok) return;                 // decoration; a failure is silent
      const body = (await res.json().catch(() => null)) as { data?: ContractDocument[] } | null;
      const docs = body?.data ?? [];
      if (!cancelled && docs.length) setFirstAgreement(docs[docs.length - 1]!);
    })();
    return () => { cancelled = true; };
  }, [isNew, contractId]);
```

and render it inside the title row (after the `StatusPill` at `:116-120`, and also in the `isNew === false` draft path — it lives in the shared header, so one placement covers both):

```tsx
{firstAgreement && (
  <a href="#signed-agreements" data-testid="contract-under-agreement-pill"
     className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/70">
    {t('agreements.contractPill.under', {
      template: firstAgreement.templateName,
      n: firstAgreement.templateVersionNumber,
    })}
  </a>
)}
```

Import `listContractDocuments` and the `ContractDocument` type from `'../../lib/api/contractDocuments'`.

> **Note the draft path.** `ContractWorkspace`'s draft branch is the `showEditor` ternary at `:134-138`, which sits *below* the shared header at `:110-133` — so a single placement in that header genuinely covers draft and active. The `isNew` branch at `:65-80` is a different, earlier return and deliberately gets no pill (there is no contract yet).

- [ ] **Step 4: Replace `ContractDocumentsSection` with the shared list**

In `apps/web/src/components/contracts/ContractDetail.tsx`: change the import (`:29`) to `SignedAgreementsPage` from `'../agreements/SignedAgreementsPage'`, and the render (`:483`) to

```tsx
<section id="signed-agreements" data-testid="contract-documents-section">
  <h3 className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
    {t('contracts.contractDetail.documents.title')}
  </h3>
  <p className="px-3 py-1 text-xs text-muted-foreground">{t('contracts.contractDetail.documents.subtitle')}</p>
  <SignedAgreementsPage lockedContractId={contract.id} />
</section>
```

`contracts.contractDetail.documents.subtitle` is W01's new key ("Accepted with the quote, pinned to the template version the customer saw."). The `contract-documents-section` testid is **kept** — `quote-contract-proposal.spec.ts:322` waits on it. The `id="signed-agreements"` anchor is the pill's target.

Then `git rm apps/web/src/components/contracts/ContractDocumentsSection.tsx`.

- [ ] **Step 5: Update `ContractDetail.documents.test.tsx`**

Its `:86` and `:107` testid assertions and the hardcoded path at `:127` (`/contracts/contract-documents/…/pdf`) all still hold — the path is unchanged (scope decision 1) and the shared list keeps the `contract-document-row`/`contract-document-download-*` testids. What changes: `contract-document-row` was `ContractDocumentsSection`'s row testid while `SignedAgreementsPage` uses `contract-document-unattached-row`. **Pick one** — rename the shared list's row testid to `contract-document-row` (it is no longer "unattached"-specific and the name is now wrong anyway), and update the four `SignedAgreementsPage.test.tsx` references plus the new cases from Task 5d. This is the one testid rename worth doing; do it in a single `sed` and re-run both suites.

- [ ] **Step 6: Run to verify pass**

Run: `cd apps/web && npx vitest run src/components/contracts/ src/components/agreements/ && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check`
Expected: PASS; no type errors; `grep -rn "ContractDocumentsSection" apps/web/src` returns nothing.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/contracts apps/web/src/components/agreements
git commit -m "feat(billing): contract header names the agreement it sits under (W03)"
```

---

### Task 9: Web — the org record's Agreements section

**Files:**
- Modify: `apps/web/src/components/organizations/record/OrgBillingTab.tsx`
- Modify: `apps/web/src/components/organizations/record/OrgBillingTab.test.tsx`
- Modify: the 8 `organizations.json` (`orgRecord.billing.sections.*`; the existing three are at `en/organizations.json` under that path)

**Interfaces:** no signature change — `OrgBillingTab({ orgId })` gains a fourth gated section.

**Placement and gate.** After Quotes (last), so the three existing sections keep their order and `OrgBillingTab.test.tsx:55-64`'s ordering assertion only grows. Gated on `can('agreements', 'read')` — its **own** grant, exactly as the file's docblock (`:24-31`) describes for the other three, and exactly why W02 made `TAB_PERMISSION.billing` (`orgRecordTabs.ts:54-58`) an ANY-of including `agreements:read`. Props: `lockedOrgId={orgId}` and **no** `defaultUnlinkedOnly` (scope decision 2 — the embed shows everything for that org).

- [ ] **Step 1: Write the failing test**

In `apps/web/src/components/organizations/record/OrgBillingTab.test.tsx`:
- Add a stub beside the other three (`:12-26`):
  ```tsx
  vi.mock('../../agreements/SignedAgreementsPage', () => ({
    default: ({ lockedOrgId, defaultUnlinkedOnly }: { lockedOrgId?: string; defaultUnlinkedOnly?: boolean }) => (
      <div data-testid="stub-signed-agreements">agreements:{lockedOrgId}:{String(defaultUnlinkedOnly)}</div>
    ),
  }));
  ```
- Extend the all-grants case (`:47-53`) with `expect(screen.getByTestId('stub-signed-agreements')).toHaveTextContent(\`agreements:${ORG_ID}:undefined\`);` — the `:undefined` half is the assertion that the embed does **not** default to unlinked-only.
- Extend the ordering case (`:55-64`): `toHaveLength(4)` and `sections[3]` is `org-billing-section-agreements`.
- Extend the "opens all sections by default" case (`:66-72`) with the new testid.
- Add the exactly-one-grant case, mirroring `:74-82` and `:84-90`:
  ```tsx
  it('shows only the Agreements section for a user with agreements:read alone', () => {
    grantedPermissions.current = [{ resource: 'agreements', action: 'read' }];
    render(<OrgBillingTab orgId={ORG_ID} />);
    expect(screen.queryByTestId('stub-contracts-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stub-invoices-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stub-quotes-page')).not.toBeInTheDocument();
    expect(screen.getByTestId('stub-signed-agreements')).toBeInTheDocument();
  });
  ```
- And the converse, which is the whole reason W02 split the permission:
  ```tsx
  it('hides Agreements for a user holding contracts:read but not agreements:read', () => {
    grantedPermissions.current = [{ resource: 'contracts', action: 'read' }];
    render(<OrgBillingTab orgId={ORG_ID} />);
    expect(screen.getByTestId('stub-contracts-list')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-signed-agreements')).not.toBeInTheDocument();
  });
  ```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/organizations/record/OrgBillingTab.test.tsx`
Expected: FAIL — no such section.

- [ ] **Step 3: Add `orgRecord.billing.sections.agreements` ×8**

English "Agreements"; real translations elsewhere (same term as `nav.agreements`, so reuse the TERMINOLOGY.md rendering and the two will agree).

- [ ] **Step 4: Implement**

In `OrgBillingTab.tsx`, add `const showAgreements = can('agreements', 'read');` beside `:37-39` and, after the Quotes block (`:64-72`):

```tsx
      {showAgreements && (
        <details open className="rounded-lg border bg-card" data-testid="org-billing-section-agreements">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
            {t('orgRecord.billing.sections.agreements')}
          </summary>
          <div className="border-t px-4 py-4">
            {/* Everything this org has signed — NOT just the unlinked ones. The
                "Unlinked only" chip is a triage tool for the standalone page
                (spec §6 + W03 scope decision 2); on a customer record the
                question is "what has this customer agreed to". */}
            <SignedAgreementsPage lockedOrgId={orgId} />
          </div>
        </details>
      )}
```

Extend the file's docblock (`:24-31`) to say four sections, not three.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/web && npx vitest run src/components/organizations/record/`
Expected: PASS, including `orgRecordTabs.test.ts` (W02 already added `agreements:read` to `TAB_PERMISSION.billing`; if that suite reds here, W02 is incomplete — stop).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/organizations apps/web/src/locales
git commit -m "feat(billing): org record lists that customer's signed agreements (W03)"
```

---

### Task 10: E2E — page object and the proposal-lifecycle spec

**Files:**
- Create: `e2e-tests/pages/AgreementsPage.ts`
- Modify: `e2e-tests/tests/quote-contract-proposal.spec.ts`

**Interfaces (following `e2e-tests/pages/QuotesPage.ts`'s shape: a `url`, a `constructor(private page: Page)`, locator methods, `goto()` using `waitForAppReady`, then task methods):**

```ts
export class AgreementsPage {
  templatesUrl = '/agreements/templates';
  signedUrl = '/agreements/signed';
  constructor(private page: Page);

  shell = () => this.page.getByTestId('agreements-shell');
  templatesTabLink = () => this.page.getByTestId('agreements-tab-templates');
  signedTabLink = () => this.page.getByTestId('agreements-tab-signed');
  list = () => this.page.getByTestId('contract-templates-tab');
  createOpen = () => this.page.getByTestId('contract-templates-create-btn');
  createDialog = () => this.page.getByTestId('contract-template-create-dialog');
  createName = () => this.page.getByTestId('contract-template-name');
  ownerPartner = () => this.page.getByTestId('contract-template-owner-partner');
  ownerOrg = () => this.page.getByTestId('contract-template-org');
  createSubmit = () => this.page.getByTestId('contract-template-create-submit');
  editor = () => this.page.getByTestId('agreement-template-editor');
  usage = () => this.page.getByTestId('agreement-template-usage');
  signedList = () => this.page.getByTestId('signed-agreements-tab');
  unlinkedFilter = () => this.page.getByTestId('signed-agreements-unlinked-filter');

  async gotoTemplates(): Promise<void>;
  async gotoTemplatesViaSidebar(): Promise<void>;
  async gotoSigned(): Promise<void>;
  /** Create a partner-wide (or org-scoped) template and land in its editor; returns the id. */
  async createTemplate(name: string): Promise<string>;
}
```

**Sidebar navigation — verified constraint.** Sidebar nav links carry **no** `data-testid` (`apps/web/src/components/layout/Sidebar.tsx:828-830` renders a bare `<a href={item.href}>`). `gotoTemplatesViaSidebar` therefore locates by href — `this.page.locator('nav a[href="/agreements/templates"]')` — which is stable and needs no source change. Do **not** add a testid to `Sidebar.tsx` for this; several sidebar suites assert on the rendered structure and the href locator is equally precise.

- [ ] **Step 1: Write the page object**

Model it on `e2e-tests/pages/QuotesPage.ts` — same import line (`import { expect, type Page } from '@playwright/test';` plus `waitForAppReady`/`waitForHydration` from `./hydration`), same docblock style naming which spec it serves. `gotoTemplates()` is `await this.page.goto(this.templatesUrl); await waitForAppReady(this.page, 'agreements-shell');`. `gotoTemplatesViaSidebar()` clicks the href locator, then `await this.page.waitForURL(/\/agreements\/templates$/)` and the same `waitForAppReady`; if the Billing section renders collapsed, expand it first by clicking the section header before the link (check `Sidebar.tsx`'s auto-expand at `:721-729` — the section auto-expands only for the *active* page, so from `/billing/quotes` Billing is already open and from elsewhere it may not be).

`createTemplate(name)` reproduces the spec's steps `:52-84`: open the dialog, fill the name, `check()` `contract-template-owner-partner` when it exists else `selectOption({ index: 1 })` on `contract-template-org`, then `Promise.all([page.waitForResponse(POST /\/contracts\/contract-templates$/), createSubmit().click()])` and return `data.id` from the JSON. **The POST regex is unchanged** (scope decision 1).

- [ ] **Step 2: Update the spec — the exact lines**

| Line | Today | Becomes |
|---|---|---|
| `:47` | `await page.goto('/contracts');` | `await agreements.gotoTemplatesViaSidebar();` — this is spec §6's "the e2e spec is updated to navigate via the sidebar to `/agreements/templates`" |
| `:48` | `getByTestId('contracts-tabs').waitFor()` | **delete** (folded into the page object's `waitForAppReady('agreements-shell')`) |
| `:49` | `waitForHydration(page, 'contracts-tabs')` | `await waitForHydration(page, 'agreements-shell');` |
| `:50` | `getByTestId('contracts-tab-templates').click()` | **delete** — there is no such tab any more |
| `:51` | `getByTestId('contract-templates-tab').waitFor()` | keep (the list root testid is unchanged) |
| `:53` | `getByTestId('contract-templates-create-btn').click()` | keep — or replace `:52-84` wholesale with `const templateId = await agreements.createTemplate(templateName);` |
| `:76` | `/\/contracts\/contract-templates$/` POST regex | **unchanged** (scope decision 1) |
| `:85` | `getByTestId('contract-template-editor')` | `getByTestId('agreement-template-editor')` — the one editor testid that moves (Task 5c) |
| `:288` | `await page.goto('/contracts');` | keep — step 5 really is about the billing contract |
| `:289-290` | `contracts-tabs` waits | keep — the testid survives on `ContractsTabs`'s wrapper (Task 6) |
| `:322` | `getByTestId('contract-documents-section')` | keep — `ContractDetail.tsx` retains it on the wrapping `<section>` (Task 8) |
| `:324` | `getByTestId('contract-document-row')` | keep — Task 8 step 5 renames the shared list's row testid to exactly this |
| `:328` | `[data-testid^="contract-document-download-"]` | keep |
| `:332` | `/\/contracts\/contract-documents\/[^/]+\/pdf$/` | **unchanged** (scope decision 1) |

Everything between `:86` and `:287` (body authoring, save, publish, quote build, send, portal accept) is untouched: those testids all live inside the editor body or other pages.

Add, right after the existing imports at the top of the spec:
```ts
import { AgreementsPage } from '../pages/AgreementsPage';
```
and `const agreements = new AgreementsPage(page);` as the first line of the test body.

- [ ] **Step 3: Add one new assertion while you are here**

After `:85`'s editor wait, assert the reciprocal link actually renders:
```ts
    // W03 spec §6: the editor states what the template is used by.
    await expect(agreements.usage()).toBeVisible({ timeout: 15_000 });
```
A brand-new template is used by nothing, so this asserts the *line* renders (with zeros), not a particular count — the counts are unit-tested in Task 2 and Task 5c.

- [ ] **Step 4: Run the spec against a live stack**

Run: `pnpm wt-stack up`, then `cd e2e-tests && npx playwright test tests/quote-contract-proposal.spec.ts --reporter=line`
Expected: PASS. A failure at `:47` usually means the Billing sidebar section was collapsed — fix the page object's expand, not the spec.

- [ ] **Step 5: Commit**

```bash
git add e2e-tests/pages/AgreementsPage.ts e2e-tests/tests/quote-contract-proposal.spec.ts
git commit -m "test(e2e): navigate the proposal lifecycle through the agreements area (W03)"
```

---

### Task 11: Docs — split `agreements.mdx` out of `contracts.mdx`

**Files:**
- Create: `apps/docs/src/content/docs/features/agreements.mdx`
- Modify: `apps/docs/src/content/docs/features/contracts.mdx` (`## Contract Templates` at `:185` through `### Variables` ending just before `## Permissions` at `:215`; `## Permissions` `:215-217`; `## Related` `:219`)
- Modify: `apps/docs/src/content/docs/features/quotes.mdx` (`:196`, `:206`, `:252`)
- Modify: `apps/docs/astro.config.mjs` (the Billing & Invoicing `items` array, `:106-111`; `{ slug: 'features/contracts' }` is `:109`)

**Verified section boundaries.** `contracts.mdx` headings: `## Contract Templates` `:185`, `### Creating a Template` `:191`, `### Versions` `:200`, `### Variables` `:206`, `## Permissions` `:215`, `## Related` `:219`. (Spec §3/§6 cite `:153-182` from an earlier revision of the file; the live offsets are the ones above — re-check with `grep -n "^#" apps/docs/src/content/docs/features/contracts.mdx` before cutting, the file moves.)

- [ ] **Step 1: Create `agreements.mdx`**

Frontmatter mirrors `contracts.mdx:1-6`:
```mdx
---
title: Agreements
description: The MSA and standard-terms documents you attach to a quote, the versions your customers signed, and how a signed agreement connects to the contract it governs.
sidebar:
  label: "Agreements"
---

import { Aside, Steps } from '@astrojs/starlight/components';
```

Body: move `contracts.mdx:185-214` and rewrite to the spec §2 vocabulary — "contract template" → **agreement template**, "executed documents" (`:~204`) → **signed agreements**, and the wrong claim that templates attach to *accepted* quotes (spec §1) → they attach to **drafts** and freeze at acceptance. Keep the explicit anchor so old links resolve:

```mdx
## Agreement templates {#contract-templates}
```

Structure: an opening paragraph stating the three-object relationship (the same sentence the UI shows, spec §3), then `### Creating an agreement template` (navigation becomes **Agreements → Agreement templates**, button **New agreement template**), `### Versions`, `### Variables`, `### Signed agreements` (new — the `/agreements/signed` page, the "Unlinked only" filter, linking one to a contract, and that the org record shows a customer's own), and `## Permissions`:

```mdx
## Permissions

| Action | Permission |
|---|---|
| View agreement templates and signed agreements | `agreements:read` |
| Create, edit, publish and archive templates; link a signed agreement to a contract | `agreements:write` |

Managing partner-wide templates additionally requires full partner organization access.
```

`## Related`: link back to Recurring Contracts, to Quotes, and to the portal.

- [ ] **Step 2: Rewrite `contracts.mdx`**

Replace `:185-214` with a short cross-link that keeps the anchor working from the contracts side:

```mdx
## Agreements

The legal document a customer signs with a proposal — your MSA or standard terms — is an **agreement template**, and the copy they signed is a **signed agreement**. Both live in their own area now: see [Agreements](/features/agreements/). A signed agreement is filed against the contract the accepting quote created, and appears in the **Signed agreements** section of that contract.
```

Then rewrite `## Permissions` (`:215-217`) so it covers only the contract grants and points at the agreements page for `agreements:*`, and add `- [Agreements](/features/agreements/)` to `## Related` (`:219`).

- [ ] **Step 3: Retarget `quotes.mdx`**

`:196`, `:206` and `:252` all point at `/features/contracts/#contract-templates`. Retarget to `/features/agreements/#contract-templates` (the anchor is preserved by Step 1, so both halves of the link stay valid), and rewrite the surrounding "contract template library" wording to "agreement template library". `:251` ("where an accepted quote's recurring lines become agreements") should say **contracts**, not "agreements" — that sentence is about billing contracts and is now actively misleading under the new vocabulary.

- [ ] **Step 4: Register the page**

In `apps/docs/astro.config.mjs`, add `{ slug: 'features/agreements' },` immediately after `{ slug: 'features/contracts' },` (`:109`) inside the Billing & Invoicing group.

- [ ] **Step 5: Run the docs check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/docs exec astro check`
Expected: PASS. Then `PATH=… pnpm --filter @breeze/docs build` — Starlight resolves internal links at build time, so a typo'd `/features/agreements/` or a dropped anchor fails the build, not the check.

- [ ] **Step 6: Commit**

```bash
git add apps/docs
git commit -m "docs: split agreements out of the recurring contracts page (W03)"
```

---

### Task 12: Typecheck, full affected suites, PR

- [ ] **Step 1: Typecheck everything this wave touched**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec astro check
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/docs exec astro check
```
Expected: clean. `@breeze/shared` is untouched this wave (the list-query validator stayed route-local, Task 1).

- [ ] **Step 2: Run every touched suite**

```bash
cd apps/api && npx vitest run src/routes/contracts/ src/services/contractDocumentService.test.ts src/services/contractTemplateService.test.ts
cd apps/web && npx vitest run \
  src/components/agreements/ \
  src/components/contracts/ \
  src/components/layout/ \
  src/components/organizations/record/ \
  src/lib/api/contractDocuments.test.ts \
  src/lib/i18n/
```
Expected: all green. `src/lib/i18n/` is non-negotiable — it is the suite that catches a missing or English-copied translation across the ~30 keys this wave added.

- [ ] **Step 3: Confirm nothing still points at the old surfaces**

```bash
grep -rn "TemplatesTab\|DocumentsTab\|ContractDocumentsSection" apps/web/src e2e-tests || echo "clean"
grep -rn "tab=templates\|tab=documents" apps/web/src apps/docs/src e2e-tests
```
Expected: the first is `clean`. The second returns **only** `ContractsTabs.tsx`'s `LEGACY_REDIRECTS` map — any other hit is a link that now dead-ends through a redirect instead of going straight to the right page.

- [ ] **Step 4: Commit and open the PR — then STOP**

```bash
git add -A
git commit -m "feat(billing): agreements area — IA split (W03)"
git push -u origin HEAD
gh pr create --fill --title "feat(billing): agreements area — IA split (W03)" --body "$(cat <<'BODY'
Wave 3 of the Agreements vocabulary + IA split (spec §6).

- `/agreements/templates`, `/agreements/templates/:id` and `/agreements/signed` — agreement templates are finally linkable routes instead of component state.
- `/contracts` drops the Templates and Documents tabs; the currency-mismatch report moves to a banner on the list, so the default state has no tab bar. `#tab=templates` / `#tab=documents` redirect client-side.
- Reciprocal links: the contract header names the agreement it sits under, the template editor shows what it is used by (new `GET /contracts/contract-templates/:id/usage`), and the org record lists that customer's signed agreements.
- Signed agreements list gains `?linked=all|linked|unlinked` and `?orgId=`; the standalone page shows everything by default with an "Unlinked only" chip persisted in `#unlinked=1`.
- Contract detail now reuses the shared signed-agreements list (`lockedContractId`) instead of its own table.
- New docs page `features/agreements`; `contracts.mdx` keeps a cross-link and the `#contract-templates` anchor still resolves.

Scope changes vs. the approved spec, per the advisor quorum — see the plan's "Scope decisions" section: API paths are NOT renamed; the page defaults to the full inventory rather than unlinked-only; the API default for an omitted `?linked` stays `unlinked`; contract detail reuses the shared list.

Closes #5825
BODY
)"
```

**This is the final task. After the PR is open, STOP** — do not merge, do not start W04, do not "just also fix" anything the diff reveals. Report the PR URL.

---

## Risks and the things most likely to go wrong

1. **The `linked` default asymmetry.** The server treats an omitted `?linked` as `unlinked`; the web must send `linked=all`. Every place that forgets renders an almost-empty list that looks like "this customer has signed nothing" rather than an error. The Task 3 client test and the Task 5d embed tests are the guards; keep them.
2. **`docs[docs.length - 1]`.** The pill names the first-created agreement from a newest-first list. Reversing it is silent on a one-document contract, which is every contract in a fresh test stack.
3. **Nested `client:load` islands.** `AgreementsShell` wrapping a `client:load` child is the one structural unknown in Task 5a. Resolve it with `astro check` + a real browser load, not by assuming.
4. **Sidebar active state on `/agreements/signed`.** Prefix matching (`Sidebar.tsx:713`) does not cover a sibling route; the `pathAliases` entry is load-bearing and has no test of its own unless you add one to `Sidebar.nav.test.tsx`.
5. **Translation coverage.** ~30 new English strings across `billing.json`, `common.json`, `pages.json` and `organizations.json` × 7 translated locales. The temptation at the end of a long wave is to paste English and bump a baseline. Don't — `translationCoverage.test.ts`'s caps are the only thing standing between this feature and an English-only UI in six languages.
6. **Stale importers.** Three components move and one is deleted. `astro check` catches TypeScript importers; it does **not** catch a `vi.mock('./TemplateEditor')` path in a test file that is otherwise untouched. Task 12 step 3's grep is what catches those.
