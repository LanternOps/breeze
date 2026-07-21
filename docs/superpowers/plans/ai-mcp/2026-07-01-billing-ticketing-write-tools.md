# Billing & Ticketing AI/MCP Write-Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Breeze AI/MCP surface full write coverage over the billing engine (invoices, catalog, contracts, quotes/proposals) and close the ticketing write gaps, while first repairing the currently-broken billing read tools and adding a contract test that prevents tool-registry drift.

**Architecture:** Each billing domain gets one **action-multiplexer** AI tool (`manage_invoices`, `manage_catalog`, `manage_contracts`, `manage_quotes`) that dispatches on an `action` enum to the existing actor-guarded service functions (`invoiceService`, `catalogService`, `contractService`, `quoteService`/`quoteLifecycle`). Ticketing extends the existing `manage_tickets` multiplexer with new actions. Every tool builds an actor (`{ userId, partnerId, accessibleOrgIds }`) from `AuthContext` and relies on the service layer's internal `requireOrgAccess` for org isolation; ticket-by-id actions additionally run `findTicketWithAccess` first because the ticket service does not self-enforce scope. Financial state transitions and cross-org moves are Tier 3 (human approval in-app / `ai:execute` + prod allowlist over MCP); draft/line edits are Tier 2 (auto-execute + audit).

**Tech Stack:** TypeScript, Hono, Vitest + Drizzle mocks, Zod (v4), Anthropic tool schema, existing `aiTools` registry.

## Global Constraints

- **Tier meaning (verbatim):** Tier 1 = auto-execute (read-only); Tier 2 = auto-execute + audit (low-risk mutation); Tier 3 = requires user approval (destructive/financial/cross-org); Tier 4 = blocked (never self-assigned). Base tier is carried inline on the registry entry (`tier: N`).
- **Authoritative tier source is the registry.** `getToolTier` reads `aiTools.get(name).tier`; both `mcpServer.ts` and `checkGuardrails` use it. `TOOL_TIERS` in `aiAgentSdkTools.ts` is a SEPARATE map used ONLY by the in-app technician SDK chat, which currently does not expose billing or ticketing at all. This plan is **MCP-server-first** (matching the existing billing/ticket precedent). In-app SDK exposure is an explicit opt-in (Task 6).
- **A working MCP tool requires exactly three registrations:** (1) registry entry via `aiTools.set(name, { tier, definition, handler })` with the module wired into `aiTools.ts`; (2) a Zod schema keyed by tool name in `toolInputSchemas` (`aiToolSchemas.ts`) — absence fail-closes every call; (3) a `TOOL_PERMISSIONS` RBAC entry (`aiGuardrails.ts`) — absence denies for any role. Action-multiplexers additionally need per-action tier entries in `TIER2_ACTIONS` / `TIER3_ACTIONS` (`aiGuardrails.ts`) for any action whose tier differs from the base.
- **Org scope:** billing tools call actor-guarded service functions (`requireOrgAccess` inside). Never wrap the system/public/background functions (`acceptQuote`, `generateDueInvoice`, `createContractWithLines`, `runOverdueSweep`, `runContractRenewalSweep`, `markViewed`/`markQuoteViewed`) or any raw `stripe*` service — they have no `accessibleOrgIds` guard. AI reaches Stripe only via `createInvoicePayLink` / `createQuotePayLink` (both take an `InvoiceActor`).
- **Ticket scope:** every by-id ticket action MUST call `findTicketWithAccess(ticketId, auth)` before mutating. `ticket_comments` has no `org_id` — resolve to the parent ticket and pass `expectedTicketId`.
- **Actor construction:** reuse the existing `actorFromAuth(auth)` helper pattern already in `aiToolsBilling.ts` / `aiToolsContracts.ts` (`{ userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds }`). Catalog uses the same shape (`CatalogActor`).
- **Error mapping:** wrap every service call in try/catch and convert typed `*ServiceError` to a JSON error string via a local `serviceErrorToJson` helper (pattern already in `aiToolsBilling.ts`). Re-throw anything that isn't a known service error.
- **File-size guideline:** keep each domain file focused; `manage_quotes` gets its own new file `aiToolsQuotes.ts`.

---

## File Structure

- `apps/api/src/services/aiToolsRegistryParity.test.ts` — **Create.** Contract test: every registry tool has a schema + RBAC entry.
- `apps/api/src/services/aiToolSchemas.ts` — **Modify.** Add schemas for the 6 broken read tools + the 4 new write multiplexers.
- `apps/api/src/services/aiGuardrails.ts` — **Modify.** Add `TOOL_PERMISSIONS` entries + `TIER2_ACTIONS`/`TIER3_ACTIONS` for the new/repaired tools.
- `apps/api/src/services/aiToolsBilling.ts` — **Modify.** Add `manage_invoices`.
- `apps/api/src/services/aiToolsCatalog.ts` — **Modify.** Add `manage_catalog`.
- `apps/api/src/services/aiToolsContracts.ts` — **Modify.** Add `manage_contracts`.
- `apps/api/src/services/aiToolsQuotes.ts` — **Create.** `manage_quotes` + `registerQuoteTools`.
- `apps/api/src/services/aiTools.ts` — **Modify.** Import + call `registerQuoteTools`.
- `apps/api/src/services/aiToolsTicketing.ts` — **Modify.** Add new actions to `manage_tickets`.
- Co-located `*.test.ts` per domain file.

---

### Task 0: Registry-parity contract test + repair the broken read tools

**Files:**
- Create: `apps/api/src/services/aiToolsRegistryParity.test.ts`
- Modify: `apps/api/src/services/aiToolSchemas.ts`
- Modify: `apps/api/src/services/aiGuardrails.ts`

**Interfaces:**
- Consumes: `aiTools` (Map) from `./aiTools`; `toolInputSchemas` from `./aiToolSchemas`; `TOOL_PERMISSIONS` from `./aiGuardrails`.
- Produces: the invariant that every registry key has a schema + RBAC entry — every later task's tools must satisfy it.

- [ ] **Step 1: Export the maps the test needs.** In `aiToolSchemas.ts`, confirm `toolInputSchemas` is exported (it is). In `aiGuardrails.ts`, confirm `TOOL_PERMISSIONS` is exported (it is). No code change if already exported.

- [ ] **Step 2: Write the failing parity test**

```ts
// apps/api/src/services/aiToolsRegistryParity.test.ts
import { describe, it, expect } from 'vitest';
import { aiTools } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS } from './aiGuardrails';

describe('aiTools registry parity', () => {
  const toolNames = Array.from(aiTools.keys());

  it('every registered tool has a Zod input schema (else executeTool fail-closes)', () => {
    const missing = toolNames.filter(name => !(name in toolInputSchemas));
    expect(missing, `Tools missing from toolInputSchemas: ${missing.join(', ')}`).toEqual([]);
  });

  it('every registered tool has a TOOL_PERMISSIONS RBAC entry (else denied for any role)', () => {
    const missing = toolNames.filter(name => !(name in TOOL_PERMISSIONS));
    expect(missing, `Tools missing from TOOL_PERMISSIONS: ${missing.join(', ')}`).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail (red confirms the current drift)**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiToolsRegistryParity.test.ts`
Expected: FAIL. Both assertions list at least `list_invoices, get_invoice, search_catalog, get_catalog_item, list_contracts, get_contract`.

- [ ] **Step 4: Add Zod schemas for the 6 broken read tools.** In `aiToolSchemas.ts`, add these entries inside the `toolInputSchemas` object (place near the other billing-adjacent schemas). Use the `uuid` helper already imported in that file.

```ts
  list_invoices: z.object({
    orgId: uuid.optional(),
    status: z.string().optional(),
    limit: z.number().optional(),
  }),
  get_invoice: z.object({
    invoiceId: uuid,
  }),
  search_catalog: z.object({
    query: z.string().optional(),
    kind: z.string().optional(),
    limit: z.number().optional(),
  }),
  get_catalog_item: z.object({
    catalogId: uuid,
  }),
  list_contracts: z.object({
    orgId: uuid.optional(),
    status: z.string().optional(),
    limit: z.number().optional(),
  }),
  get_contract: z.object({
    contractId: uuid,
  }),
```

> Before writing these, open `aiToolsCatalog.ts` and `aiToolsContracts.ts` and copy the EXACT property names each read tool reads from `input` (e.g. confirm the catalog search field is `query`/`kind` and the id field is `catalogId`/`contractId`). Match them exactly — a schema that omits a real field will strip it, and one that renames it will reject valid calls.

- [ ] **Step 5: Add `TOOL_PERMISSIONS` entries for the 6 read tools.** In `aiGuardrails.ts`, add to the `TOOL_PERMISSIONS` object:

```ts
  list_invoices: { resource: 'billing', action: 'read' },
  get_invoice: { resource: 'billing', action: 'read' },
  search_catalog: { resource: 'billing', action: 'read' },
  get_catalog_item: { resource: 'billing', action: 'read' },
  list_contracts: { resource: 'billing', action: 'read' },
  get_contract: { resource: 'billing', action: 'read' },
```

> Verify `'billing'` is a valid RBAC resource in this repo's permission model. Grep `apps/api/src` for an existing billing/invoice permission (`resource: 'billing'` or `'invoices'`). If billing uses a different resource string, use that instead; if there is no billing resource yet, use `'organizations'` with action `'read'` as the conservative fallback and note it in the commit message.

- [ ] **Step 6: Run the parity test to green**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiToolsRegistryParity.test.ts`
Expected: PASS (both assertions empty).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiToolsRegistryParity.test.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiGuardrails.ts
git commit -m "test(ai): add registry-parity guard and repair broken billing read tools"
```

---

### Task 1: `manage_invoices` (reference multiplexer)

This task establishes the **shared multiplexer skeleton** that Tasks 2–5 clone. Read it in full even if implementing a later task first.

**Files:**
- Modify: `apps/api/src/services/aiToolsBilling.ts`
- Modify: `apps/api/src/services/aiToolSchemas.ts`
- Modify: `apps/api/src/services/aiGuardrails.ts`
- Test: `apps/api/src/services/aiToolsBilling.manageInvoices.test.ts`

**Interfaces:**
- Consumes: `invoiceService` functions (`createManualInvoice`, `addManualLine`, `addCatalogLine`, `addBundleLine`, `addContractLine`, `updateLine`, `removeLine`, `updateInvoice`, `deleteDraftInvoice`, `assembleDraftFromOrg`, `assembleDraftFromTicket`, `issueInvoice`, `recordPayment`, `voidPayment`, `voidInvoice`), `createInvoicePayLink` from `./invoiceCheckout`, `InvoiceServiceError`/`InvoiceActor` from `./invoiceTypes`, existing `actorFromAuth`/`serviceErrorToJson` in `aiToolsBilling.ts`.
- Produces: registry tool `manage_invoices` (base tier 2). Action→tier map below is consumed by `aiGuardrails.ts`.

**Action table (name · tier · service fn · required input):**

| action | tier | service fn | required input |
|---|---|---|---|
| `create_draft` | 2 | `createManualInvoice({ orgId, siteId?, notes?, termsAndConditions? }, actor)` | `orgId` |
| `add_manual_line` | 2 | `addManualLine(invoiceId, line, actor)` | `invoiceId`, `line` |
| `add_catalog_line` | 2 | `addCatalogLine(invoiceId, catalogItemId, quantity, actor)` | `invoiceId`, `catalogItemId`, `quantity` |
| `add_bundle_line` | 2 | `addBundleLine(invoiceId, bundleId, quantity, actor)` | `invoiceId`, `bundleId`, `quantity` |
| `add_contract_line` | 2 | `addContractLine(invoiceId, …, actor)` | `invoiceId`, `contractId` |
| `update_line` | 2 | `updateLine(invoiceId, lineId, patch, actor)` | `invoiceId`, `lineId` |
| `remove_line` | 2 | `removeLine(invoiceId, lineId, actor)` | `invoiceId`, `lineId` |
| `update_header` | 2 | `updateInvoice(invoiceId, patch, actor)` | `invoiceId` |
| `delete_draft` | 2 | `deleteDraftInvoice(invoiceId, actor)` | `invoiceId` |
| `assemble_from_org` | 2 | `assembleDraftFromOrg({ orgId, siteId?, from, to }, actor)` | `orgId`, `from`, `to` |
| `assemble_from_ticket` | 2 | `assembleDraftFromTicket(ticketId, actor)` | `ticketId` |
| `issue` | **3** | `issueInvoice(invoiceId, actor)` | `invoiceId` |
| `void` | **3** | `voidInvoice(invoiceId, reason, { reissue }, actor)` | `invoiceId`, `reason` |
| `record_payment` | **3** | `recordPayment(invoiceId, payment, actor)` | `invoiceId`, `payment` |
| `void_payment` | **3** | `voidPayment(paymentId, actor)` | `paymentId` |
| `create_pay_link` | 2 | `createInvoicePayLink(invoiceId, actor)` | `invoiceId` |

> Before coding, open `invoiceService.ts` and copy the EXACT parameter object shapes for `add_manual_line`, `update_line` patch, `record_payment` (`RecordPaymentInput`), and `update_header`. The `line`/`patch`/`payment` objects below are passed through verbatim; their inner field names must match the service's input types.

- [ ] **Step 1: Write the failing test** (`aiToolsBilling.manageInvoices.test.ts`). Mock `./invoiceService` and `./invoiceCheckout`; assert dispatch + actor plumbing + error mapping.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./invoiceService', () => ({
  createManualInvoice: vi.fn().mockResolvedValue({ id: 'inv-1', status: 'draft' }),
  issueInvoice: vi.fn().mockResolvedValue({ id: 'inv-1', status: 'issued', number: 'INV-100' }),
}));
vi.mock('./invoiceCheckout', () => ({ createInvoicePayLink: vi.fn() }));

import { registerBillingTools } from './aiToolsBilling';
import * as invoiceService from './invoiceService';
import type { AiTool } from './aiTools';

const auth = {
  user: { id: 'u-1' },
  partnerId: 'p-1',
  accessibleOrgIds: ['org-1'],
} as any;

function getTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerBillingTools(map);
  const t = map.get('manage_invoices');
  if (!t) throw new Error('manage_invoices not registered');
  return t;
}

describe('manage_invoices', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create_draft calls createManualInvoice with an actor built from auth', async () => {
    const out = await getTool().handler({ action: 'create_draft', orgId: 'org-1' }, auth);
    expect(invoiceService.createManualInvoice).toHaveBeenCalledWith(
      { orgId: 'org-1', siteId: undefined, notes: undefined, termsAndConditions: undefined },
      { userId: 'u-1', partnerId: 'p-1', accessibleOrgIds: ['org-1'] },
    );
    expect(JSON.parse(out)).toMatchObject({ id: 'inv-1', status: 'draft' });
  });

  it('issue calls issueInvoice', async () => {
    await getTool().handler({ action: 'issue', invoiceId: 'inv-1' }, auth);
    expect(invoiceService.issueInvoice).toHaveBeenCalledWith('inv-1', expect.objectContaining({ userId: 'u-1' }));
  });

  it('unknown action returns a JSON error', async () => {
    const out = await getTool().handler({ action: 'nope' }, auth);
    expect(JSON.parse(out)).toHaveProperty('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiToolsBilling.manageInvoices.test.ts`
Expected: FAIL with "manage_invoices not registered".

- [ ] **Step 3: Implement `manage_invoices`.** In `aiToolsBilling.ts`, import the new service fns and register the tool inside `registerBillingTools`. This is the **shared skeleton** — later tasks reuse this exact shape with a different action switch.

```ts
// add imports at top of aiToolsBilling.ts
import {
  createManualInvoice, addManualLine, addCatalogLine, addBundleLine, addContractLine,
  updateLine, removeLine, updateInvoice, deleteDraftInvoice,
  assembleDraftFromOrg, assembleDraftFromTicket,
  issueInvoice, recordPayment, voidPayment, voidInvoice,
} from './invoiceService';
import { createInvoicePayLink } from './invoiceCheckout';

// inside registerBillingTools(aiTools), after the existing read tools:
aiTools.set('manage_invoices', {
  tier: 2 as AiToolTier,
  deviceArgs: [],
  definition: {
    name: 'manage_invoices',
    description:
      'Create and manage invoices for orgs the caller can access: build drafts, add/edit/remove lines, ' +
      'issue (finalize), void, record or void payments, and create a Stripe pay link. Issue/void/payment ' +
      'actions finalize financial state and require approval.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: [
            'create_draft', 'add_manual_line', 'add_catalog_line', 'add_bundle_line', 'add_contract_line',
            'update_line', 'remove_line', 'update_header', 'delete_draft',
            'assemble_from_org', 'assemble_from_ticket',
            'issue', 'void', 'record_payment', 'void_payment', 'create_pay_link',
          ],
        },
        orgId: { type: 'string', description: 'Organization UUID (create_draft, assemble_from_org)' },
        siteId: { type: 'string' },
        invoiceId: { type: 'string' },
        lineId: { type: 'string' },
        paymentId: { type: 'string' },
        catalogItemId: { type: 'string' },
        bundleId: { type: 'string' },
        contractId: { type: 'string' },
        ticketId: { type: 'string' },
        quantity: { type: 'number' },
        notes: { type: 'string' },
        termsAndConditions: { type: 'string' },
        reason: { type: 'string', description: 'Void reason (required for void)' },
        reissue: { type: 'boolean' },
        from: { type: 'string', description: 'ISO date (assemble_from_org)' },
        to: { type: 'string', description: 'ISO date (assemble_from_org)' },
        line: { type: 'object', description: 'Manual line fields' },
        patch: { type: 'object', description: 'Line or header patch fields' },
        payment: { type: 'object', description: 'Payment fields (amount, method, ...)' },
      },
      required: ['action'],
    },
  },
  handler: async (input, auth) => {
    const actor = actorFromAuth(auth);
    const s = (k: string) => (input[k] == null ? undefined : String(input[k]));
    try {
      switch (input.action) {
        case 'create_draft':
          return JSON.stringify(await createManualInvoice(
            { orgId: String(input.orgId), siteId: s('siteId'), notes: s('notes'), termsAndConditions: s('termsAndConditions') }, actor));
        case 'add_manual_line':
          return JSON.stringify(await addManualLine(String(input.invoiceId), input.line as any, actor));
        case 'add_catalog_line':
          return JSON.stringify(await addCatalogLine(String(input.invoiceId), String(input.catalogItemId), Number(input.quantity), actor));
        case 'add_bundle_line':
          return JSON.stringify(await addBundleLine(String(input.invoiceId), String(input.bundleId), Number(input.quantity), actor));
        case 'add_contract_line':
          return JSON.stringify(await addContractLine(String(input.invoiceId), input as any, actor));
        case 'update_line':
          return JSON.stringify(await updateLine(String(input.invoiceId), String(input.lineId), input.patch as any, actor));
        case 'remove_line':
          return JSON.stringify(await removeLine(String(input.invoiceId), String(input.lineId), actor));
        case 'update_header':
          return JSON.stringify(await updateInvoice(String(input.invoiceId), input.patch as any, actor));
        case 'delete_draft':
          return JSON.stringify(await deleteDraftInvoice(String(input.invoiceId), actor));
        case 'assemble_from_org':
          return JSON.stringify(await assembleDraftFromOrg(
            { orgId: String(input.orgId), siteId: s('siteId'), from: String(input.from), to: String(input.to) }, actor));
        case 'assemble_from_ticket':
          return JSON.stringify(await assembleDraftFromTicket(String(input.ticketId), actor));
        case 'issue':
          return JSON.stringify(await issueInvoice(String(input.invoiceId), actor));
        case 'void':
          return JSON.stringify(await voidInvoice(String(input.invoiceId), String(input.reason), { reissue: Boolean(input.reissue) }, actor));
        case 'record_payment':
          return JSON.stringify(await recordPayment(String(input.invoiceId), input.payment as any, actor));
        case 'void_payment':
          return JSON.stringify(await voidPayment(String(input.paymentId), actor));
        case 'create_pay_link':
          return JSON.stringify(await createInvoicePayLink(String(input.invoiceId), actor));
        default:
          return JSON.stringify({ error: `Unknown action: ${String(input.action)}` });
      }
    } catch (err) {
      const json = serviceErrorToJson(err);
      if (json) return json;
      throw err;
    }
  },
});
```

> Confirm `AiToolTier` is imported in `aiToolsBilling.ts` (it is — used by the read tools). Confirm the exact signatures of `addContractLine`, `updateLine`, `recordPayment` against `invoiceService.ts` and adjust the `input as any` / positional args to match; do not leave `as any` if a concrete input type is exported — import and use it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiToolsBilling.manageInvoices.test.ts`
Expected: PASS.

- [ ] **Step 5: Register schema + RBAC + action tiers.** In `aiToolSchemas.ts` add to `toolInputSchemas`:

```ts
  manage_invoices: z.object({
    action: z.enum([
      'create_draft', 'add_manual_line', 'add_catalog_line', 'add_bundle_line', 'add_contract_line',
      'update_line', 'remove_line', 'update_header', 'delete_draft',
      'assemble_from_org', 'assemble_from_ticket',
      'issue', 'void', 'record_payment', 'void_payment', 'create_pay_link',
    ]),
    orgId: uuid.optional(), siteId: uuid.optional(), invoiceId: uuid.optional(),
    lineId: uuid.optional(), paymentId: uuid.optional(), catalogItemId: uuid.optional(),
    bundleId: uuid.optional(), contractId: uuid.optional(), ticketId: uuid.optional(),
    quantity: z.number().optional(), notes: z.string().optional(), termsAndConditions: z.string().optional(),
    reason: z.string().optional(), reissue: z.boolean().optional(),
    from: z.string().optional(), to: z.string().optional(),
    line: z.record(z.string(), z.unknown()).optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
    payment: z.record(z.string(), z.unknown()).optional(),
  }),
```

In `aiGuardrails.ts` add to `TOOL_PERMISSIONS`:

```ts
  manage_invoices: {
    create_draft: { resource: 'billing', action: 'write' },
    add_manual_line: { resource: 'billing', action: 'write' },
    add_catalog_line: { resource: 'billing', action: 'write' },
    add_bundle_line: { resource: 'billing', action: 'write' },
    add_contract_line: { resource: 'billing', action: 'write' },
    update_line: { resource: 'billing', action: 'write' },
    remove_line: { resource: 'billing', action: 'write' },
    update_header: { resource: 'billing', action: 'write' },
    delete_draft: { resource: 'billing', action: 'write' },
    assemble_from_org: { resource: 'billing', action: 'write' },
    assemble_from_ticket: { resource: 'billing', action: 'write' },
    issue: { resource: 'billing', action: 'execute' },
    void: { resource: 'billing', action: 'execute' },
    record_payment: { resource: 'billing', action: 'execute' },
    void_payment: { resource: 'billing', action: 'execute' },
    create_pay_link: { resource: 'billing', action: 'write' },
  },
```

In `aiGuardrails.ts` add the Tier 3 escalations to `TIER3_ACTIONS`:

```ts
  manage_invoices: ['issue', 'void', 'record_payment', 'void_payment'],
```

- [ ] **Step 6: Run the parity test + billing test together to confirm no drift**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiToolsRegistryParity.test.ts src/services/aiToolsBilling.manageInvoices.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiToolsBilling.ts apps/api/src/services/aiToolsBilling.manageInvoices.test.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiGuardrails.ts
git commit -m "feat(ai): add manage_invoices write tool"
```

---

### Task 2: `manage_catalog`

**Files:**
- Modify: `apps/api/src/services/aiToolsCatalog.ts`, `aiToolSchemas.ts`, `aiGuardrails.ts`
- Test: `apps/api/src/services/aiToolsCatalog.manageCatalog.test.ts`

**Interfaces:**
- Consumes: `catalogService` (`createCatalogItem`, `updateCatalogItem`, `archiveCatalogItem`, `setOrgPriceOverride`, `removeOrgPriceOverride`, `setBundleComponents`), `CatalogServiceError`/`CatalogActor` from `./catalogService`.
- Produces: registry tool `manage_catalog` (base tier 2). All actions Tier 2 (no `TIER3_ACTIONS` entry needed).

**Action table:**

| action | tier | service fn | required |
|---|---|---|---|
| `create_item` | 2 | `createCatalogItem(input, actor)` | item fields |
| `update_item` | 2 | `updateCatalogItem(id, input, actor)` | `catalogId` |
| `archive_item` | 2 | `archiveCatalogItem(id, actor)` | `catalogId` |
| `set_org_price` | 2 | `setOrgPriceOverride(itemId, orgId, input, actor)` | `catalogId`, `orgId` |
| `remove_org_price` | 2 | `removeOrgPriceOverride(itemId, orgId, actor)` | `catalogId`, `orgId` |
| `set_bundle_components` | 2 | `setBundleComponents(bundleId, components, actor)` | `catalogId`, `components` |

- [ ] **Step 1:** Write `aiToolsCatalog.manageCatalog.test.ts` mocking `./catalogService`, asserting `create_item`/`update_item`/`archive_item` dispatch + actor (`{ userId, partnerId, accessibleOrgIds }`) + unknown-action error. Mirror the Task 1 test structure.
- [ ] **Step 2:** Run it; expected FAIL ("manage_catalog not registered").
- [ ] **Step 3:** In `aiToolsCatalog.ts`, add a local `actorFromAuth`/`serviceErrorToJson` (copy from `aiToolsBilling.ts`, mapping `CatalogServiceError`), import the six service fns, and register `manage_catalog` using the Task 1 skeleton with this action switch. Item/override/component payloads pass through as `input.item`/`input.override`/`input.components`; confirm exact field names against `catalogService.ts` input types (`CreateCatalogItemInput`, `OrgPriceOverrideInput`, `BundleComponentInput[]`) and import those types instead of `any`.
- [ ] **Step 4:** Run it; expected PASS.
- [ ] **Step 5:** Add `manage_catalog` Zod schema to `toolInputSchemas` (action enum above; `catalogId`/`orgId` as `uuid.optional()`; `item`/`override` as `z.record(z.string(), z.unknown()).optional()`; `components` as `z.array(z.record(z.string(), z.unknown())).optional()`). Add `TOOL_PERMISSIONS.manage_catalog` sub-map with every action `{ resource: 'billing', action: 'write' }`. No `TIER3_ACTIONS` entry.
- [ ] **Step 6:** Run parity + catalog tests; expected PASS.
- [ ] **Step 7:** Commit `feat(ai): add manage_catalog write tool`.

---

### Task 3: `manage_contracts`

**Files:**
- Modify: `apps/api/src/services/aiToolsContracts.ts`, `aiToolSchemas.ts`, `aiGuardrails.ts`
- Test: `apps/api/src/services/aiToolsContracts.manageContracts.test.ts`

**Interfaces:**
- Consumes: `contractService` (`createContract`, `updateContract`, `deleteDraftContract`, `addContractLineToContract`, `removeContractLine`, `activateContract`, `pauseContract`, `resumeContract`, `cancelContract`), `ContractServiceError`/`ContractActor`. Do NOT wrap `generateDueInvoice`/`createContractWithLines` (no actor).
- Produces: registry tool `manage_contracts` (base tier 2).

**Action table:**

| action | tier | service fn | required |
|---|---|---|---|
| `create_draft` | 2 | `createContract(input, actor)` | `orgId`, `name`, schedule fields |
| `update` | 2 | `updateContract(id, patch, actor)` | `contractId` |
| `delete_draft` | 2 | `deleteDraftContract(id, actor)` | `contractId` |
| `add_line` | 2 | `addContractLineToContract(id, line, actor)` | `contractId`, `line` |
| `remove_line` | 2 | `removeContractLine(id, lineId, actor)` | `contractId`, `lineId` |
| `activate` | **3** | `activateContract(id, actor)` | `contractId` |
| `pause` | **3** | `pauseContract(id, actor)` | `contractId` |
| `resume` | **3** | `resumeContract(id, actor)` | `contractId` |
| `cancel` | **3** | `cancelContract(id, actor)` | `contractId` |

- [ ] **Step 1:** Write `aiToolsContracts.manageContracts.test.ts` mocking `./contractService`; assert `create_draft`, `activate`, unknown-action. Mirror Task 1.
- [ ] **Step 2:** Run; expected FAIL.
- [ ] **Step 3:** In `aiToolsContracts.ts` add local `actorFromAuth`/`serviceErrorToJson` (ContractServiceError), import the nine fns, register `manage_contracts` with the skeleton. Pass `create_draft` fields as the `CreateContract` input object and `update` patch as `UpdateContractInput`; import those types.
- [ ] **Step 4:** Run; expected PASS.
- [ ] **Step 5:** Add `manage_contracts` Zod schema; `TOOL_PERMISSIONS.manage_contracts` sub-map (`create_draft`/`update`/`delete_draft`/`add_line`/`remove_line` → `write`; `activate`/`pause`/`resume`/`cancel` → `execute`); add `TIER3_ACTIONS.manage_contracts = ['activate', 'pause', 'resume', 'cancel']`.
- [ ] **Step 6:** Run parity + contracts tests; expected PASS.
- [ ] **Step 7:** Commit `feat(ai): add manage_contracts write tool`.

---

### Task 4: `manage_quotes` (new file)

**Files:**
- Create: `apps/api/src/services/aiToolsQuotes.ts`
- Modify: `apps/api/src/services/aiTools.ts` (import + call `registerQuoteTools`), `aiToolSchemas.ts`, `aiGuardrails.ts`
- Test: `apps/api/src/services/aiToolsQuotes.test.ts`

**Interfaces:**
- Consumes: `quoteService` (`createQuote`, `updateQuote`, `deleteDraftQuote`, `addBlock`, `updateBlock`, `deleteBlock`, `reorderBlocks`, `addManualLine`, `addCatalogLine`, `updateLine`, `removeLine`, `reorderLines`), `quoteLifecycle` (`sendQuote`, `declineQuoteByActor`), `quotePay` (`createQuotePayLink`), `QuoteServiceError`/`QuoteActor`. Do NOT wrap `acceptQuote`/`markQuoteViewed`.
- Produces: exported `registerQuoteTools(aiTools: Map<string, AiTool>): void` registering `manage_quotes` (base tier 2). Note `createQuotePayLink` takes an `InvoiceActor` (same shape).

**Action table:**

| action | tier | service fn |
|---|---|---|
| `create_draft` / `update` / `delete_draft` | 2 | `createQuote` / `updateQuote` / `deleteDraftQuote` |
| `add_block` / `update_block` / `delete_block` / `reorder_blocks` | 2 | `addBlock` / `updateBlock` / `deleteBlock` / `reorderBlocks` |
| `add_manual_line` / `add_catalog_line` / `update_line` / `remove_line` / `reorder_lines` | 2 | corresponding `quoteService` fns |
| `send` | **3** | `sendQuote(id, actor)` |
| `decline` | 2 | `declineQuoteByActor(id, reason, actor)` |
| `create_pay_link` | 2 | `createQuotePayLink(quoteId, actor)` |

- [ ] **Step 1:** Write `aiToolsQuotes.test.ts` importing `registerQuoteTools`, mocking `./quoteService`, `./quoteLifecycle`, `./quotePay`; assert `create_draft`, `send`, unknown-action.
- [ ] **Step 2:** Run; expected FAIL ("Cannot find module './aiToolsQuotes'" or not registered).
- [ ] **Step 3:** Create `aiToolsQuotes.ts` with the file-header doc comment (pattern from `aiToolsBilling.ts`), local `actorFromAuth`/`serviceErrorToJson` (QuoteServiceError), the imports, and `export function registerQuoteTools(aiTools)` registering `manage_quotes` via the skeleton. Confirm block/line input shapes against `quoteTypes.ts` and import the concrete types.
- [ ] **Step 4:** Run; expected PASS.
- [ ] **Step 5:** In `aiTools.ts` add `import { registerQuoteTools } from './aiToolsQuotes';` near the other billing imports (lines ~60-62) and `registerQuoteTools(aiTools);` in the registration block (near `registerContractTools(aiTools);`). Add `manage_quotes` Zod schema to `toolInputSchemas`; `TOOL_PERMISSIONS.manage_quotes` sub-map (`send` → `execute`, everything else → `write`); `TIER3_ACTIONS.manage_quotes = ['send']`.
- [ ] **Step 6:** Run parity + quotes tests; expected PASS.
- [ ] **Step 7:** Commit `feat(ai): add manage_quotes write tool`.

---

### Task 5: Extend `manage_tickets` with write-gap actions

**Files:**
- Modify: `apps/api/src/services/aiToolsTicketing.ts`, `aiToolSchemas.ts` (extend the existing `manage_tickets` schema), `aiGuardrails.ts` (extend `TIER2_ACTIONS`/`TIER3_ACTIONS`/`TOOL_PERMISSIONS.manage_tickets`)
- Test: `apps/api/src/services/aiToolsTicketing.writeGaps.test.ts`

**Interfaces:**
- Consumes: `ticketService` (`updateTicketFields`, `linkAlertToTicket`, `unlinkAlertFromTicket`, `createTicketFromAlert`, `editTicketComment`, `deleteTicketComment`, `moveTicketOrg`), the existing `findTicketWithAccess(ticketId, auth)` and `actorFrom(auth)` helpers already in `aiToolsTicketing.ts`.
- Produces: new `action` values on `manage_tickets`.

**New action table:**

| action | tier | service fn · scope pre-check |
|---|---|---|
| `update_fields` | 2 | `updateTicketFields(ticketId, fields, actor)` · `findTicketWithAccess` first |
| `link_alert` | 2 | `linkAlertToTicket(ticketId, alertId, actor)` · `findTicketWithAccess` + verify alert org |
| `unlink_alert` | 2 | `unlinkAlertFromTicket(ticketId, alertId, actor)` · `findTicketWithAccess` |
| `create_from_alert` | 2 | `createTicketFromAlert(alertId, actor, overrides)` · verify alert access via `findAlertWithAccess` |
| `edit_comment` | 2 | `editTicketComment(commentId, { content }, actor, { canManageAny, expectedTicketId })` · resolve parent ticket via `findTicketWithAccess(expectedTicketId)`, compute `canManageAny` from role |
| `delete_comment` | 2 | `deleteTicketComment(commentId, actor, { canManageAny, expectedTicketId })` · same as edit |
| `move_org` | **3** | `moveTicketOrg(ticketId, targetOrgId, actor)` · `findTicketWithAccess(ticketId)` AND `auth.canAccessOrg(targetOrgId)` |

- [ ] **Step 1:** Write `aiToolsTicketing.writeGaps.test.ts`: mock `./ticketService`, stub `findTicketWithAccess` to resolve a ticket; assert `update_fields` calls the service after the access check, and `move_org` requires `canAccessOrg(targetOrgId)` (returns error JSON when denied).
- [ ] **Step 2:** Run; expected FAIL (actions not handled → falls to unknown-action / no service call).
- [ ] **Step 3:** In `aiToolsTicketing.ts`, add the new `action` enum values to the `manage_tickets` `input_schema` and new `case` branches to its handler switch. For every by-id action call `findTicketWithAccess(ticketId, auth)` (or `findAlertWithAccess` for alerts) and return its error JSON if the check fails, BEFORE calling the service. For `edit_comment`/`delete_comment`, require `expectedTicketId`, run it through `findTicketWithAccess`, and set `canManageAny` from the caller's role (grep the file/`auth` for the existing role/permission accessor; if none, default `canManageAny: false` so authorship is enforced). For `move_org`, additionally require `auth.canAccessOrg(String(input.targetOrgId))`.
- [ ] **Step 4:** Run; expected PASS.
- [ ] **Step 5:** Extend the existing `manage_tickets` Zod schema in `aiToolSchemas.ts` with the new fields (`fields`, `alertId`, `commentId`, `expectedTicketId`, `targetOrgId`, `overrides`) and add the new enum values to its `action`. Add the new actions to `TOOL_PERMISSIONS.manage_tickets` (`update_fields`/`link_alert`/`unlink_alert`/`create_from_alert`/`edit_comment`/`delete_comment` → `{ resource: 'tickets', action: 'write' }`; `move_org` → `{ resource: 'tickets', action: 'write' }`). Add `move_org` to `TIER3_ACTIONS.manage_tickets` (append to the existing array) and the Tier 2 write actions to `TIER2_ACTIONS.manage_tickets`.
- [ ] **Step 6:** Run parity + ticketing tests; expected PASS.
- [ ] **Step 7:** Commit `feat(ai): extend manage_tickets with field/comment/alert/move actions`.

---

### Task 6 (optional): Expose the new tools in the in-app technician SDK chat

Only do this if billing/ticketing should be usable inside the in-app assistant (not just external MCP clients). Currently the entire billing + ticketing surface is MCP-only.

**Files:** Modify `apps/api/src/services/aiAgentSdkTools.ts`.

- [ ] **Step 1:** Add `manage_invoices`, `manage_catalog`, `manage_contracts`, `manage_quotes: 2` and `manage_tickets: 1` (base) to `TOOL_TIERS`. (Also add the six read tools if in-app read access is wanted.)
- [ ] **Step 2:** Add a `tool('manage_invoices', <description>, <zodRawShape>, makeHandler('manage_invoices', getAuth, onPreToolUse, onPostToolUse))` declaration in the `tools` array of `createBreezeMcpServer`, one per new tool, mirroring an existing multiplexer declaration (e.g. `manage_alerts` at ~line 851).
- [ ] **Step 3:** Run the SDK tool tests (`aiAgentSdk*.test.ts`) and the parity test; expected PASS.
- [ ] **Step 4:** Commit `feat(ai): expose billing/ticketing tools in the in-app assistant`.

---

## Self-Review Notes

- **Spec coverage:** invoices (T1), catalog (T2), contracts (T3), quotes (T4), tickets (T5) all covered; parity + read-tool repair (T0); optional in-app exposure (T6). Approval decision honored — issue/void/payment (T1), activate/pause/resume/cancel (T3), send (T4), move_org (T5) are Tier 3.
- **Excluded-by-design confirmed:** no task wraps `acceptQuote`, `generateDueInvoice`, `createContractWithLines`, sweep jobs, or raw `stripe*` services.
- **Type consistency:** actor shape `{ userId, partnerId, accessibleOrgIds }` used uniformly; `serviceErrorToJson` re-throws non-service errors in every task; every Tier-3 action appears in both `TOOL_PERMISSIONS` (as `execute`) and `TIER3_ACTIONS`.
- **Open verification points flagged inline** (must be checked against live code during execution): the `'billing'` RBAC resource string; exact service input type names for line/patch/payment/item/override/block objects; the role accessor for `canManageAny`.
