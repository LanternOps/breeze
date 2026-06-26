# Billing Bulk Actions + Detail Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add row-selection + bulk actions to the Quotes, Invoices, and Contracts list tables, and a draft-only Delete button to each of their detail screens.

**Architecture:** New per-action **bulk API endpoints** (one Hono route per entity file) loop over an id list and call the *existing* per-item service functions (`deleteDraftQuote`, `sendQuote`, `deleteDraftInvoice`, `issueInvoice`, `voidInvoice`, `deleteDraftContract`, `cancelContract`), collecting `{succeeded, skipped, failed, skippedReasons}` via a shared `runBulk` helper — mirroring the existing `POST /tickets/bulk` pattern. On the web, a reusable `useBulkSelection` hook + `BulkActionBar` component drive checkbox selection on all three tables. Detail-screen Delete reuses the **already-existing** `DELETE /:id` endpoints (draft-only) — no new API for that part. No new DB tables, no schema migration, no RLS changes: every bulk operation runs inside the request's existing `withDbAccessContext` and each reused service already enforces org access.

**Tech Stack:** Hono + Zod + Drizzle (API), React + Tailwind (web), Vitest (both).

## Global Constraints

- **No new tables / migrations / RLS work.** Bulk endpoints only reuse existing org-scoped service functions; detail-delete reuses existing routes. (Verified: `deleteDraftQuote`/`deleteDraftInvoice`/`deleteDraftContract` and lifecycle fns all call `assertOrg`/`requireOrgAccess` and run under the request's RLS context.)
- **All web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`) per CLAUDE.md. Catch with `handleActionError(err, fallback)`.
- **Do NOT modify `TARGET_GLOBS`** in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (avoids the count-drift squash hazard). Adding `runAction`-wrapped handlers inside already-listed files is fine.
- **Permission constants** (`packages/shared/src/constants/permissions.ts`, imported in routes as `PERMISSIONS` from `../../services/permissions`):
  - `QUOTES_WRITE` = quotes:write, `QUOTES_SEND` = quotes:send
  - `INVOICES_WRITE` = invoices:write, `INVOICES_SEND` = invoices:send
  - `CONTRACTS_WRITE` = contracts:write, `CONTRACTS_MANAGE` = contracts:manage
- **Bulk action → permission mapping:** delete → `*_WRITE`; quote send / invoice issue / invoice void → `*_SEND`; contract cancel → `CONTRACTS_MANAGE`. (One endpoint per action so the existing `requirePermission` middleware gates each correctly.)
- **Route ordering:** register bulk routes **before** the `/:id` CRUD routes in each entity's `index.ts` (matches the tickets precedent — `/bulk` before `/:id`).
- **Bulk id cap:** `z.array(z.string().guid()).min(1).max(200)`.
- **Web import paths:** `runAction, handleActionError` from `lib/runAction`; `fetchWithAuth` from `stores/auth`; `navigateTo` from `@/lib/navigation`; `showToast` from `components/shared/Toast`; `usePermissions` (→ `can`) from `lib/permissions`; `ConfirmDialog` from `components/shared/ConfirmDialog`.
- Run API tests with: `pnpm --filter @breeze/api exec vitest run <path>` (per memory: `db:migrate`/bare vitest gotchas). Run web tests with `pnpm --filter @breeze/web exec vitest run <path>`.

---

## File Structure

**Create:**
- `apps/api/src/lib/bulkOps.ts` — `runBulk()` helper + `BulkResult` type (shared by all bulk routes).
- `apps/api/src/routes/quotes/bulk.ts` — `quoteBulkRoutes` (`/bulk-delete`, `/bulk-send`).
- `apps/api/src/routes/quotes/bulk.test.ts`
- `apps/api/src/routes/invoices/bulk.ts` — `invoiceBulkRoutes` (`/bulk-delete`, `/bulk-issue`, `/bulk-void`).
- `apps/api/src/routes/invoices/bulk.test.ts`
- `apps/api/src/routes/contracts/bulk.ts` — `contractBulkRoutes` (`/bulk-delete`, `/bulk-cancel`).
- `apps/api/src/routes/contracts/bulk.test.ts`
- `apps/web/src/components/billing/bulk/useBulkSelection.ts` — selection hook.
- `apps/web/src/components/billing/bulk/useBulkSelection.test.ts`
- `apps/web/src/components/billing/bulk/BulkActionBar.tsx` — slide-up action bar.
- `apps/web/src/components/billing/bulk/BulkActionBar.test.tsx`

**Modify:**
- `packages/shared/src/validators/quotes.ts` — add `bulkQuoteIdsSchema`.
- `packages/shared/src/validators/invoices.ts` — add `bulkInvoiceIdsSchema`, `bulkVoidInvoicesSchema`.
- `packages/shared/src/validators/contracts.ts` — add `bulkContractIdsSchema`.
- `apps/api/src/routes/quotes/index.ts`, `invoices/index.ts`, `contracts/index.ts` — mount bulk routes before CRUD.
- `apps/web/src/components/billing/quotes/QuotesPage.tsx` — selection column + bar.
- `apps/web/src/components/billing/InvoicesPage.tsx` — selection column + bar.
- `apps/web/src/components/contracts/ContractsList.tsx` — selection column + bar.
- `apps/web/src/components/billing/quotes/QuoteDetail.tsx` — Delete (draft) button.
- `apps/web/src/components/billing/InvoiceDetail.tsx` — Delete (draft) button.
- `apps/web/src/components/contracts/ContractDetail.tsx` — Delete (draft) button.
- `apps/web/src/lib/api/quotes.ts` — add `deleteQuote(id)`.
- `apps/web/src/lib/api/contracts.ts` — add `deleteContract(id)`.

---

## Task 1: Shared bulk Zod schemas + `runBulk` helper

**Files:**
- Modify: `packages/shared/src/validators/quotes.ts`
- Modify: `packages/shared/src/validators/invoices.ts`
- Modify: `packages/shared/src/validators/contracts.ts`
- Create: `apps/api/src/lib/bulkOps.ts`
- Test: `apps/api/src/lib/bulkOps.test.ts`

**Interfaces:**
- Produces: `bulkQuoteIdsSchema`, `bulkInvoiceIdsSchema`, `bulkVoidInvoicesSchema`, `bulkContractIdsSchema` (all from `@breeze/shared`); `runBulk(ids, perItem)` → `Promise<BulkResult>`; `BulkResult = { total; succeeded; skipped; failed; skippedReasons: Record<string,number> }`.
- `runBulk` classifies a thrown error as **skipped** when it is an object with a numeric `status` in {400,403,404,409} (reads optional `.code`); anything else is **failed** (logged via `console.error`).

- [ ] **Step 1: Write the failing test for `runBulk`**

Create `apps/api/src/lib/bulkOps.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { runBulk } from './bulkOps';

class SvcError extends Error {
  constructor(msg: string, public status: number, public code?: string) { super(msg); }
}

describe('runBulk', () => {
  it('counts successes', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const r = await runBulk(['a', 'b', 'c'], fn);
    expect(r).toMatchObject({ total: 3, succeeded: 3, skipped: 0, failed: 0 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('treats 4xx service errors as skipped and tallies reasons by code', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SvcError('not a draft', 409, 'NOT_A_DRAFT'))
      .mockRejectedValueOnce(new SvcError('denied', 403, 'ORG_DENIED'));
    const r = await runBulk(['a', 'b', 'c'], fn);
    expect(r).toMatchObject({ total: 3, succeeded: 1, skipped: 2, failed: 0 });
    expect(r.skippedReasons).toEqual({ NOT_A_DRAFT: 1, ORG_DENIED: 1 });
  });

  it('treats unexpected errors as failed without throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    const r = await runBulk(['a'], fn);
    expect(r).toMatchObject({ total: 1, succeeded: 0, skipped: 0, failed: 1 });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/lib/bulkOps.test.ts`
Expected: FAIL — `Cannot find module './bulkOps'`.

- [ ] **Step 3: Implement `runBulk`**

Create `apps/api/src/lib/bulkOps.ts`:
```typescript
export interface BulkResult {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  skippedReasons: Record<string, number>;
}

const SKIP_STATUSES = new Set([400, 403, 404, 409]);

function asServiceError(err: unknown): { status: number; code?: string; message?: string } | null {
  if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    return err as { status: number; code?: string; message?: string };
  }
  return null;
}

/**
 * Run a per-item async operation over a list of ids, isolating per-item failures.
 * Expected 4xx service errors (not-a-draft, org-denied, not-found, invalid-state)
 * count as `skipped` (tallied by `.code`); anything else counts as `failed`.
 */
export async function runBulk(
  ids: string[],
  perItem: (id: string) => Promise<unknown>
): Promise<BulkResult> {
  const result: BulkResult = { total: ids.length, succeeded: 0, skipped: 0, failed: 0, skippedReasons: {} };
  for (const id of ids) {
    try {
      await perItem(id);
      result.succeeded++;
    } catch (err) {
      const svc = asServiceError(err);
      if (svc && SKIP_STATUSES.has(svc.status)) {
        result.skipped++;
        const code = svc.code ?? 'OTHER';
        result.skippedReasons[code] = (result.skippedReasons[code] ?? 0) + 1;
      } else {
        result.failed++;
        console.error('[runBulk] item failed:', id, err instanceof Error ? err.message : err);
      }
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/lib/bulkOps.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the shared Zod schemas**

In `packages/shared/src/validators/quotes.ts`, add (top-level export; `z` is already imported there):
```typescript
export const bulkQuoteIdsSchema = z.object({
  ids: z.array(z.string().guid()).min(1).max(200),
});
```

In `packages/shared/src/validators/invoices.ts`, add:
```typescript
export const bulkInvoiceIdsSchema = z.object({
  ids: z.array(z.string().guid()).min(1).max(200),
});
export const bulkVoidInvoicesSchema = bulkInvoiceIdsSchema.extend({
  reason: z.string().trim().min(1).max(500),
});
```

In `packages/shared/src/validators/contracts.ts`, add:
```typescript
export const bulkContractIdsSchema = z.object({
  ids: z.array(z.string().guid()).min(1).max(200),
});
```

- [ ] **Step 6: Verify the barrel re-exports them**

Run: `pnpm --filter @breeze/shared exec tsc --noEmit`
Expected: PASS. (These validator files are already re-exported via `@breeze/shared` — `createQuoteSchema` etc. import from there — so no index edit is needed. If tsc complains the new symbol is missing from `@breeze/shared`, add the export to the validators barrel/index and re-run.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/bulkOps.ts apps/api/src/lib/bulkOps.test.ts packages/shared/src/validators/quotes.ts packages/shared/src/validators/invoices.ts packages/shared/src/validators/contracts.ts
git commit -m "feat(billing): add runBulk helper + bulk request schemas"
```

---

## Task 2: Quotes bulk API endpoints

**Files:**
- Create: `apps/api/src/routes/quotes/bulk.ts`
- Test: `apps/api/src/routes/quotes/bulk.test.ts`
- Modify: `apps/api/src/routes/quotes/index.ts`

**Interfaces:**
- Consumes: `runBulk` (Task 1); `bulkQuoteIdsSchema` (Task 1); existing `deleteDraftQuote`, `sendQuote`, `quoteActorFrom`, `handleServiceError`.
- Produces: `quoteBulkRoutes`; `POST /quotes/bulk-delete` (write), `POST /quotes/bulk-send` (send) → `{ data: BulkResult }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/quotes/bulk.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/quoteService', () => ({ deleteDraftQuote: vi.fn() }));
vi.mock('../../services/quoteLifecycle', () => ({ sendQuote: vi.fn() }));
vi.mock('../../services/quoteTypes', () => ({
  QuoteServiceError: class QuoteServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  },
}));
const gate = vi.hoisted(() => ({ permGate: async (_c: any, next: any) => next() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    await next();
  },
  requireScope: () => async (c: any, next: any) => gate.permGate(c, next),
  requirePermission: () => async (c: any, next: any) => gate.permGate(c, next),
}));

import { quoteRoutes } from './index';
import { deleteDraftQuote } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { QuoteServiceError } from '../../services/quoteTypes';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function post(path: string, body: unknown) {
  return quoteRoutes.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('quote bulk routes', () => {
  beforeEach(() => { vi.clearAllMocks(); gate.permGate = async (_c: any, next: any) => next(); });

  it('bulk-delete deletes each id and reports counts', async () => {
    (deleteDraftQuote as any).mockResolvedValue(undefined);
    const res = await post('/bulk-delete', { ids: [A, B] });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ total: 2, succeeded: 2, skipped: 0, failed: 0 });
    expect(deleteDraftQuote).toHaveBeenCalledTimes(2);
  });

  it('bulk-delete tallies non-draft skips without failing the request', async () => {
    (deleteDraftQuote as any)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new QuoteServiceError('Quote is not a draft', 409, 'NOT_A_DRAFT'));
    const res = await post('/bulk-delete', { ids: [A, B] });
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data).toMatchObject({ succeeded: 1, skipped: 1 });
    expect(data.skippedReasons).toEqual({ NOT_A_DRAFT: 1 });
  });

  it('bulk-send sends each draft', async () => {
    (sendQuote as any).mockResolvedValue({});
    const res = await post('/bulk-send', { ids: [A] });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ succeeded: 1 });
    expect(sendQuote).toHaveBeenCalledWith(A, expect.anything());
  });

  it('rejects an empty id list with 400', async () => {
    const res = await post('/bulk-delete', { ids: [] });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/quotes/bulk.test.ts`
Expected: FAIL — route not found (404) / module not yet exported.

- [ ] **Step 3: Implement the bulk routes**

Create `apps/api/src/routes/quotes/bulk.ts`:
```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { bulkQuoteIdsSchema } from '@breeze/shared';
import { runBulk } from '../../lib/bulkOps';
import { deleteDraftQuote } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { quoteActorFrom, handleServiceError } from './quotes';

export const quoteBulkRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.QUOTES_WRITE.resource, PERMISSIONS.QUOTES_WRITE.action);
const sendPerm = requirePermission(PERMISSIONS.QUOTES_SEND.resource, PERMISSIONS.QUOTES_SEND.action);

quoteBulkRoutes.post('/bulk-delete', scopes, writePerm, zValidator('json', bulkQuoteIdsSchema), async (c) => {
  try {
    const actor = quoteActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulk(ids, (id) => deleteDraftQuote(id, actor)) });
  } catch (err) { return handleServiceError(c, err); }
});

quoteBulkRoutes.post('/bulk-send', scopes, sendPerm, zValidator('json', bulkQuoteIdsSchema), async (c) => {
  try {
    const actor = quoteActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulk(ids, (id) => sendQuote(id, actor)) });
  } catch (err) { return handleServiceError(c, err); }
});
```

- [ ] **Step 4: Mount the routes before CRUD**

In `apps/api/src/routes/quotes/index.ts`, add the import and register **before** `quoteCrudRoutes`:
```typescript
import { quoteBulkRoutes } from './bulk';
// ...
quoteRoutes.use('*', authMiddleware);
quoteRoutes.route('/', quoteBulkRoutes);      // bulk-* before /:id
quoteRoutes.route('/', quoteCrudRoutes);
quoteRoutes.route('/', quoteLifecycleRoutes);
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/quotes/bulk.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/quotes/bulk.ts apps/api/src/routes/quotes/bulk.test.ts apps/api/src/routes/quotes/index.ts
git commit -m "feat(api): quotes bulk-delete + bulk-send endpoints"
```

---

## Task 3: Invoices bulk API endpoints

**Files:**
- Create: `apps/api/src/routes/invoices/bulk.ts`
- Test: `apps/api/src/routes/invoices/bulk.test.ts`
- Modify: `apps/api/src/routes/invoices/index.ts`

**Interfaces:**
- Consumes: `runBulk`; `bulkInvoiceIdsSchema`, `bulkVoidInvoicesSchema`; existing `deleteDraftInvoice`, `issueInvoice`, `voidInvoice(id, reason, {reissue}, actor)`, `invoiceActorFrom`, `handleServiceError`.
- Produces: `invoiceBulkRoutes`; `POST /invoices/bulk-delete` (write), `POST /invoices/bulk-issue` (send), `POST /invoices/bulk-void` (send; body `{ ids, reason }`, `reissue` forced false in bulk) → `{ data: BulkResult }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/invoices/bulk.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/invoiceService', () => ({
  deleteDraftInvoice: vi.fn(), issueInvoice: vi.fn(), voidInvoice: vi.fn(),
}));
const gate = vi.hoisted(() => ({ permGate: async (_c: any, next: any) => next() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    await next();
  },
  requireScope: () => async (c: any, next: any) => gate.permGate(c, next),
  requirePermission: () => async (c: any, next: any) => gate.permGate(c, next),
}));

import { invoiceRoutes } from './index';
import { deleteDraftInvoice, issueInvoice, voidInvoice } from '../../services/invoiceService';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
function post(path: string, body: unknown) {
  return invoiceRoutes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('invoice bulk routes', () => {
  beforeEach(() => { vi.clearAllMocks(); gate.permGate = async (_c: any, next: any) => next(); });

  it('bulk-delete deletes each draft', async () => {
    (deleteDraftInvoice as any).mockResolvedValue(undefined);
    const res = await post('/bulk-delete', { ids: [A, B] });
    expect((await res.json()).data).toMatchObject({ succeeded: 2 });
    expect(deleteDraftInvoice).toHaveBeenCalledTimes(2);
  });

  it('bulk-issue issues each invoice', async () => {
    (issueInvoice as any).mockResolvedValue({});
    const res = await post('/bulk-issue', { ids: [A] });
    expect((await res.json()).data).toMatchObject({ succeeded: 1 });
    expect(issueInvoice).toHaveBeenCalledWith(A, expect.anything());
  });

  it('bulk-void requires a reason and passes reissue:false', async () => {
    (voidInvoice as any).mockResolvedValue({});
    const noReason = await post('/bulk-void', { ids: [A] });
    expect(noReason.status).toBe(400);

    const ok = await post('/bulk-void', { ids: [A], reason: 'duplicate' });
    expect(ok.status).toBe(200);
    expect(voidInvoice).toHaveBeenCalledWith(A, 'duplicate', { reissue: false }, expect.anything());
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/invoices/bulk.test.ts`
Expected: FAIL — routes not mounted.

- [ ] **Step 3: Implement the bulk routes**

Create `apps/api/src/routes/invoices/bulk.ts`:
```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { bulkInvoiceIdsSchema, bulkVoidInvoicesSchema } from '@breeze/shared';
import { runBulk } from '../../lib/bulkOps';
import { deleteDraftInvoice, issueInvoice, voidInvoice } from '../../services/invoiceService';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoiceBulkRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action);
const sendPerm = requirePermission(PERMISSIONS.INVOICES_SEND.resource, PERMISSIONS.INVOICES_SEND.action);

invoiceBulkRoutes.post('/bulk-delete', scopes, writePerm, zValidator('json', bulkInvoiceIdsSchema), async (c) => {
  try {
    const actor = invoiceActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulk(ids, (id) => deleteDraftInvoice(id, actor)) });
  } catch (err) { return handleServiceError(c, err); }
});

invoiceBulkRoutes.post('/bulk-issue', scopes, sendPerm, zValidator('json', bulkInvoiceIdsSchema), async (c) => {
  try {
    const actor = invoiceActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulk(ids, (id) => issueInvoice(id, actor)) });
  } catch (err) { return handleServiceError(c, err); }
});

invoiceBulkRoutes.post('/bulk-void', scopes, sendPerm, zValidator('json', bulkVoidInvoicesSchema), async (c) => {
  try {
    const actor = invoiceActorFrom(c);
    const { ids, reason } = c.req.valid('json');
    return c.json({ data: await runBulk(ids, (id) => voidInvoice(id, reason, { reissue: false }, actor)) });
  } catch (err) { return handleServiceError(c, err); }
});
```

- [ ] **Step 4: Mount before CRUD**

In `apps/api/src/routes/invoices/index.ts`, import and register `invoiceBulkRoutes` **before** `invoiceCrudRoutes` (right after `authMiddleware`):
```typescript
import { invoiceBulkRoutes } from './bulk';
// ...
invoiceRoutes.use('*', authMiddleware);
invoiceRoutes.route('/', invoiceBulkRoutes);     // bulk-* before /:id
invoiceRoutes.route('/', invoiceLifecycleRoutes);
// ...existing routes unchanged...
invoiceRoutes.route('/', invoiceCrudRoutes);
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/invoices/bulk.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/invoices/bulk.ts apps/api/src/routes/invoices/bulk.test.ts apps/api/src/routes/invoices/index.ts
git commit -m "feat(api): invoices bulk-delete + bulk-issue + bulk-void endpoints"
```

---

## Task 4: Contracts bulk API endpoints

**Files:**
- Create: `apps/api/src/routes/contracts/bulk.ts`
- Test: `apps/api/src/routes/contracts/bulk.test.ts`
- Modify: `apps/api/src/routes/contracts/index.ts`

**Interfaces:**
- Consumes: `runBulk`; `bulkContractIdsSchema`; existing `deleteDraftContract`, `cancelContract`, `contractActorFrom`, `handleContractError`.
- Produces: `contractBulkRoutes`; `POST /contracts/bulk-delete` (write), `POST /contracts/bulk-cancel` (manage) → `{ data: BulkResult }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/contracts/bulk.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/contractService', () => ({ deleteDraftContract: vi.fn(), cancelContract: vi.fn() }));
const gate = vi.hoisted(() => ({ permGate: async (_c: any, next: any) => next() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    await next();
  },
  requireScope: () => async (c: any, next: any) => gate.permGate(c, next),
  requirePermission: () => async (c: any, next: any) => gate.permGate(c, next),
}));

import { contractRoutes } from './index';
import { deleteDraftContract, cancelContract } from '../../services/contractService';

const A = '11111111-1111-1111-1111-111111111111';
function post(path: string, body: unknown) {
  return contractRoutes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('contract bulk routes', () => {
  beforeEach(() => { vi.clearAllMocks(); gate.permGate = async (_c: any, next: any) => next(); });

  it('bulk-delete deletes each draft', async () => {
    (deleteDraftContract as any).mockResolvedValue(undefined);
    const res = await post('/bulk-delete', { ids: [A] });
    expect((await res.json()).data).toMatchObject({ succeeded: 1 });
    expect(deleteDraftContract).toHaveBeenCalledWith(A, expect.anything());
  });

  it('bulk-cancel cancels each contract', async () => {
    (cancelContract as any).mockResolvedValue({});
    const res = await post('/bulk-cancel', { ids: [A] });
    expect((await res.json()).data).toMatchObject({ succeeded: 1 });
    expect(cancelContract).toHaveBeenCalledWith(A, expect.anything());
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/contracts/bulk.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the bulk routes**

Create `apps/api/src/routes/contracts/bulk.ts`:
```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { bulkContractIdsSchema } from '@breeze/shared';
import { runBulk } from '../../lib/bulkOps';
import { deleteDraftContract, cancelContract } from '../../services/contractService';
import { contractActorFrom, handleContractError } from './contracts';

export const contractBulkRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);
const managePerm = requirePermission(PERMISSIONS.CONTRACTS_MANAGE.resource, PERMISSIONS.CONTRACTS_MANAGE.action);

contractBulkRoutes.post('/bulk-delete', scopes, writePerm, zValidator('json', bulkContractIdsSchema), async (c) => {
  try {
    const actor = contractActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulk(ids, (id) => deleteDraftContract(id, actor)) });
  } catch (err) { return handleContractError(c, err); }
});

contractBulkRoutes.post('/bulk-cancel', scopes, managePerm, zValidator('json', bulkContractIdsSchema), async (c) => {
  try {
    const actor = contractActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulk(ids, (id) => cancelContract(id, actor)) });
  } catch (err) { return handleContractError(c, err); }
});
```

- [ ] **Step 4: Mount before CRUD**

In `apps/api/src/routes/contracts/index.ts`, import and register `contractBulkRoutes` **before** `contractCrudRoutes` (right after `authMiddleware`):
```typescript
import { contractBulkRoutes } from './bulk';
// ...
contractRoutes.use('*', authMiddleware);
contractRoutes.route('/', contractBulkRoutes);   // bulk-* before /:id
contractRoutes.route('/', contractLifecycleRoutes);
// ...existing routes unchanged...
contractRoutes.route('/', contractCrudRoutes);
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/contracts/bulk.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/contracts/bulk.ts apps/api/src/routes/contracts/bulk.test.ts apps/api/src/routes/contracts/index.ts
git commit -m "feat(api): contracts bulk-delete + bulk-cancel endpoints"
```

---

## Task 5: Web bulk-selection hook + action bar

**Files:**
- Create: `apps/web/src/components/billing/bulk/useBulkSelection.ts`
- Test: `apps/web/src/components/billing/bulk/useBulkSelection.test.ts`
- Create: `apps/web/src/components/billing/bulk/BulkActionBar.tsx`
- Test: `apps/web/src/components/billing/bulk/BulkActionBar.test.tsx`

**Interfaces:**
- Produces:
  - `useBulkSelection()` → `{ selectedIds: Set<string>; size: number; has(id): boolean; toggle(id): void; selectAll(ids: string[]): void; clear(): void }`.
  - `BulkActionBar({ count, actions, onClear, testIdPrefix })` where `actions: Array<{ key: string; label: string; variant?: 'default' | 'destructive'; disabled?: boolean; onClick: () => void }>`. Renders nothing when `count === 0`.

- [ ] **Step 1: Write the failing hook test**

Create `apps/web/src/components/billing/bulk/useBulkSelection.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBulkSelection } from './useBulkSelection';

describe('useBulkSelection', () => {
  it('toggles ids on and off', () => {
    const { result } = renderHook(() => useBulkSelection());
    act(() => result.current.toggle('a'));
    expect(result.current.has('a')).toBe(true);
    expect(result.current.size).toBe(1);
    act(() => result.current.toggle('a'));
    expect(result.current.has('a')).toBe(false);
    expect(result.current.size).toBe(0);
  });

  it('selectAll adds all ids and clear empties', () => {
    const { result } = renderHook(() => useBulkSelection());
    act(() => result.current.selectAll(['a', 'b', 'c']));
    expect(result.current.size).toBe(3);
    act(() => result.current.clear());
    expect(result.current.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/bulk/useBulkSelection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

Create `apps/web/src/components/billing/bulk/useBulkSelection.ts`:
```typescript
import { useCallback, useState } from 'react';

export interface BulkSelection {
  selectedIds: Set<string>;
  size: number;
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clear: () => void;
}

export function useBulkSelection(): BulkSelection {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelectedIds((prev) => new Set([...prev, ...ids]));
  }, []);

  const clear = useCallback(() => setSelectedIds(new Set()), []);
  const has = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  return { selectedIds, size: selectedIds.size, has, toggle, selectAll, clear };
}
```

- [ ] **Step 4: Run the hook test to confirm it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/bulk/useBulkSelection.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing action-bar test**

Create `apps/web/src/components/billing/bulk/BulkActionBar.test.tsx`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BulkActionBar } from './BulkActionBar';

describe('BulkActionBar', () => {
  it('renders nothing when count is 0', () => {
    const { container } = render(<BulkActionBar count={0} actions={[]} onClear={() => {}} testIdPrefix="quotes" />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the count and fires action + clear handlers', () => {
    const onClick = vi.fn();
    const onClear = vi.fn();
    render(
      <BulkActionBar
        count={2}
        actions={[{ key: 'delete', label: 'Delete', variant: 'destructive', onClick }]}
        onClear={onClear}
        testIdPrefix="quotes"
      />
    );
    expect(screen.getByTestId('quotes-bulk-bar')).toHaveTextContent('2 selected');
    fireEvent.click(screen.getByTestId('quotes-bulk-action-delete'));
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('quotes-bulk-clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/bulk/BulkActionBar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the action bar**

Create `apps/web/src/components/billing/bulk/BulkActionBar.tsx`:
```typescript
export interface BulkAction {
  key: string;
  label: string;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
  onClick: () => void;
}

export interface BulkActionBarProps {
  count: number;
  actions: BulkAction[];
  onClear: () => void;
  testIdPrefix: string;
}

export function BulkActionBar({ count, actions, onClear, testIdPrefix }: BulkActionBarProps) {
  if (count === 0) return null;
  return (
    <div
      className="absolute inset-x-0 bottom-0 z-10 border-t bg-background px-3 py-2 shadow-[0_-4px_12px_-6px_rgba(0,0,0,0.15)] animate-[fade-up_0.18s_ease-out_both]"
      data-testid={`${testIdPrefix}-bulk-bar`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium tabular-nums">{count} selected</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={a.onClick}
              disabled={a.disabled}
              data-testid={`${testIdPrefix}-bulk-action-${a.key}`}
              className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                a.variant === 'destructive'
                  ? 'border border-destructive/40 text-destructive hover:bg-destructive/10'
                  : 'border hover:bg-muted'
              }`}
            >
              {a.label}
            </button>
          ))}
          <button
            type="button"
            onClick={onClear}
            data-testid={`${testIdPrefix}-bulk-clear`}
            className="text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run the action-bar test to confirm it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/bulk/BulkActionBar.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/billing/bulk/
git commit -m "feat(web): reusable useBulkSelection hook + BulkActionBar"
```

---

## Task 6: Quotes list — selection column + bulk bar

**Files:**
- Modify: `apps/web/src/components/billing/quotes/QuotesPage.tsx`
- Test: `apps/web/src/components/billing/quotes/QuotesPage.bulk.test.tsx` (create)

**Interfaces:**
- Consumes: `useBulkSelection`, `BulkActionBar` (Task 5); `runAction`, `handleActionError`, `fetchWithAuth`, `showToast`, `usePermissions`, `BulkResult` shape `{ total, succeeded, skipped, failed, skippedReasons }`.
- Quote rows expose `qt.id` and `qt.status`. The table's wrapper must be `relative` so the absolutely-positioned bar anchors to it.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/billing/quotes/QuotesPage.bulk.test.tsx`. Mock `fetchWithAuth`, `showToast`, `navigateTo`, and the quotes list fetch the page uses; render, select two rows, click bulk delete, assert `POST /quotes/bulk-delete` body contains both ids. Skeleton:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));

import { QuotesPage } from './QuotesPage';

const json = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;
const Q1 = '11111111-1111-1111-1111-111111111111';
const Q2 = '22222222-2222-2222-2222-222222222222';

describe('QuotesPage bulk delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // initial list load
    fetchWithAuth.mockResolvedValueOnce(json({ data: [
      { id: Q1, orgId: 'o1', status: 'draft', total: '10', currencyCode: 'USD', createdAt: '2026-06-01' },
      { id: Q2, orgId: 'o1', status: 'draft', total: '20', currencyCode: 'USD', createdAt: '2026-06-02' },
    ] }));
  });

  it('selects rows and posts ids to /quotes/bulk-delete', async () => {
    render(<QuotesPage />);
    await screen.findByTestId(`quotes-row-${Q1}`);
    fireEvent.click(screen.getByTestId(`quotes-select-${Q1}`));
    fireEvent.click(screen.getByTestId(`quotes-select-${Q2}`));
    // bulk endpoint + refetch
    fetchWithAuth.mockResolvedValueOnce(json({ data: { total: 2, succeeded: 2, skipped: 0, failed: 0, skippedReasons: {} } }));
    fetchWithAuth.mockResolvedValueOnce(json({ data: [] }));
    fireEvent.click(screen.getByTestId('quotes-bulk-action-delete'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((c) => String(c[0]).includes('/quotes/bulk-delete'));
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string).ids).toEqual([Q1, Q2]);
    });
  });
});
```
> Note: adjust the initial-load mock + the page's named/default export to match the actual `QuotesPage` data-fetching shape when you open the file. The selection `data-testid`s (`quotes-select-<id>`) are added in Step 3.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/quotes/QuotesPage.bulk.test.tsx`
Expected: FAIL — `quotes-select-*` checkboxes don't exist yet.

- [ ] **Step 3: Add selection state, checkbox column, and bulk bar**

In `QuotesPage.tsx`:

1. Add imports:
```typescript
import { useBulkSelection } from '../bulk/useBulkSelection';
import { BulkActionBar } from '../bulk/BulkActionBar';
import { runAction, handleActionError } from '../../../lib/runAction';
import { fetchWithAuth } from '../../../stores/auth';
import { showToast } from '../../shared/Toast';
import { usePermissions } from '../../../lib/permissions';
```
(Several of these may already be imported — de-dupe.)

2. Inside the component, near other hooks:
```typescript
const bulk = useBulkSelection();
const { can } = usePermissions();
```

3. Add the bulk runner (place after the `rows` memo; `rows` is the rendered quote array, `refresh`/`load` is the page's existing list-refetch fn — use whatever it's named):
```typescript
const runBulkQuotes = useCallback(
  async (path: string, verb: string) => {
    const ids = Array.from(bulk.selectedIds);
    if (ids.length === 0) return;
    try {
      const result = await runAction<{ data: { succeeded: number; skipped: number; failed: number; skippedReasons?: Record<string, number> } }>({
        request: () => fetchWithAuth(path, { method: 'POST', body: JSON.stringify({ ids }) }),
        errorFallback: `Bulk ${verb} failed. Retry.`,
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true }),
      });
      const { succeeded, skipped, failed } = result.data;
      showToast(
        skipped + failed > 0
          ? { type: 'warning', message: `${succeeded} ${verb}, ${skipped} skipped${failed ? `, ${failed} failed` : ''}` }
          : { type: 'success', message: `${succeeded} ${verb}` }
      );
      bulk.clear();
      void refresh(); // <-- the page's existing list-refetch function
    } catch (err) {
      handleActionError(err, `Bulk ${verb} failed. Retry.`);
    }
  },
  [bulk, refresh]
);
```
> If the page already imports `navigateTo`/`loginPathWithNext`, reuse them; otherwise simplify `onUnauthorized` to the page's existing redirect pattern.

4. Wrap the table container so the bar anchors. The existing `<div className="overflow-x-auto">` becomes:
```tsx
<div className="relative">
  <div className="overflow-x-auto">
    <table className="w-full text-sm" data-testid="quotes-table">
      <thead>
        <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
          <th className="w-8 px-3 py-3">
            <input
              type="checkbox"
              aria-label="Select all quotes"
              data-testid="quotes-select-all"
              checked={rows.length > 0 && rows.every((r) => bulk.has(r.id))}
              onChange={(e) => (e.target.checked ? bulk.selectAll(rows.map((r) => r.id)) : bulk.clear())}
            />
          </th>
          <th className="px-3 py-3 font-medium">Number</th>
          {/* ...existing headers unchanged... */}
        </tr>
      </thead>
      <tbody>
        {rows.map((qt) => (
          <tr key={qt.id} onClick={() => void navigateTo(`/billing/quotes/${qt.id}`)} data-testid={`quotes-row-${qt.id}`} className="cursor-pointer border-t transition hover:bg-muted/40">
            <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                aria-label={`Select quote ${qt.quoteNumber ?? qt.id}`}
                data-testid={`quotes-select-${qt.id}`}
                checked={bulk.has(qt.id)}
                onChange={() => bulk.toggle(qt.id)}
              />
            </td>
            {/* ...existing cells unchanged... */}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
  <BulkActionBar
    count={bulk.size}
    onClear={bulk.clear}
    testIdPrefix="quotes"
    actions={[
      ...(can('quotes', 'send') ? [{ key: 'send', label: 'Send', onClick: () => void runBulkQuotes('/quotes/bulk-send', 'sent') }] : []),
      ...(can('quotes', 'write') ? [{ key: 'delete', label: 'Delete drafts', variant: 'destructive' as const, onClick: () => void runBulkQuotes('/quotes/bulk-delete', 'deleted') }] : []),
    ]}
  />
</div>
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/quotes/QuotesPage.bulk.test.tsx`
Expected: PASS.

- [ ] **Step 5: Guard against silent mutations + typecheck**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/__tests__/no-silent-mutations.test.ts && pnpm --filter @breeze/web exec tsc --noEmit`
Expected: PASS (QuotesPage.tsx is already in `TARGET_GLOBS`; the new handler uses `runAction`).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/billing/quotes/QuotesPage.tsx apps/web/src/components/billing/quotes/QuotesPage.bulk.test.tsx
git commit -m "feat(web): bulk select + send/delete on quotes list"
```

---

## Task 7: Invoices list — selection column + bulk bar

**Files:**
- Modify: `apps/web/src/components/billing/InvoicesPage.tsx`
- Test: `apps/web/src/components/billing/InvoicesPage.bulk.test.tsx` (create)

**Interfaces:** Same hook/bar/runner pattern as Task 6. Invoice bulk void needs a **reason**, so the void action opens a small reason dialog before posting (reuse the inline `Dialog` pattern already in `InvoiceDetail.tsx`, or `ConfirmDialog` is not enough since it has no text field). Invoice rows expose `inv.id`, `inv.status`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/billing/InvoicesPage.bulk.test.tsx` mirroring Task 6's test, but: data-testids are `invoices-select-<id>` / `invoices-bulk-action-delete`; the initial list mock uses invoice fields (`id, orgId, status, total, balance, currencyCode, issueDate, dueDate`); assert `POST /invoices/bulk-delete` carries both ids. Add a second test that clicking the void action opens `invoices-bulk-void-dialog`, typing a reason and submitting posts `/invoices/bulk-void` with `{ ids, reason }`.
```typescript
// ...same mock scaffold as Task 6 (fetchWithAuth, showToast, navigateTo, permissions=can()=>true)...
import { InvoicesPage } from './InvoicesPage';
// initial load: two draft invoices I1, I2
// test 1 (delete): select both → click invoices-bulk-action-delete → expect /invoices/bulk-delete body.ids == [I1, I2]
// test 2 (void):  select an issued invoice → click invoices-bulk-action-void → fill invoices-bulk-void-reason → click invoices-bulk-void-submit
//                 → expect /invoices/bulk-void body == { ids:[...], reason:'duplicate' }
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/InvoicesPage.bulk.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Apply the same edits as Task 6 §3 with `testIdPrefix="invoices"`, `data-testid={`invoices-select-${inv.id}`}`, container made `relative`, and a `runBulkInvoices(path, verb, extraBody?)` runner identical to `runBulkQuotes` but merging `extraBody` into the JSON (for the void reason). Add bulk void reason dialog state:
```typescript
const [voidOpen, setVoidOpen] = useState(false);
const [voidReason, setVoidReason] = useState('');
```
Bar actions:
```tsx
actions={[
  ...(can('invoices', 'send') ? [{ key: 'issue', label: 'Issue', onClick: () => void runBulkInvoices('/invoices/bulk-issue', 'issued') }] : []),
  ...(can('invoices', 'send') ? [{ key: 'void', label: 'Void', variant: 'destructive' as const, onClick: () => { setVoidReason(''); setVoidOpen(true); } }] : []),
  ...(can('invoices', 'write') ? [{ key: 'delete', label: 'Delete drafts', variant: 'destructive' as const, onClick: () => void runBulkInvoices('/invoices/bulk-delete', 'deleted') }] : []),
]}
```
Add a `Dialog` (mirroring `InvoiceDetail.tsx` lines 444–478) with `data-testid="invoices-bulk-void-dialog"`, a `data-testid="invoices-bulk-void-reason"` textarea bound to `voidReason`, and a submit button `data-testid="invoices-bulk-void-submit"` that calls `await runBulkInvoices('/invoices/bulk-void', 'voided', { reason: voidReason.trim() })` then `setVoidOpen(false)`, disabled while `!voidReason.trim()`.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/InvoicesPage.bulk.test.tsx`
Expected: PASS.

- [ ] **Step 5: Guard + typecheck**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/__tests__/no-silent-mutations.test.ts && pnpm --filter @breeze/web exec tsc --noEmit`
Expected: PASS (InvoicesPage.tsx already in `TARGET_GLOBS`).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/billing/InvoicesPage.tsx apps/web/src/components/billing/InvoicesPage.bulk.test.tsx
git commit -m "feat(web): bulk select + issue/void/delete on invoices list"
```

---

## Task 8: Contracts list — selection column + bulk bar

**Files:**
- Modify: `apps/web/src/components/contracts/ContractsList.tsx`
- Test: `apps/web/src/components/contracts/ContractsList.bulk.test.tsx` (create)

**Interfaces:** Same pattern as Task 6. Contract rows expose `ctr.id`, `ctr.status`. Bulk cancel is destructive → wrap it in a `ConfirmDialog` (no free text needed). Note: `ContractsList.tsx` is **not** in `no-silent-mutations` `TARGET_GLOBS` — do not add it; just ensure the handler uses `runAction` anyway for consistency.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/contracts/ContractsList.bulk.test.tsx` mirroring Task 6 with prefix `contracts`, testids `contract-select-<id>` (match existing `contract-row-<id>` convention), initial load of two draft contracts, select both, click `contracts-bulk-action-delete`, assert `POST /contracts/bulk-delete` body carries both ids.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/contracts/ContractsList.bulk.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Apply the Task 6 §3 edits to `ContractsList.tsx`: `relative` container, header checkbox `data-testid="contracts-select-all"`, per-row `data-testid={`contract-select-${ctr.id}`}` (cell wrapped with `onClick={(e) => e.stopPropagation()}`), a `runBulkContracts(path, verb)` runner identical to `runBulkQuotes`, and:
```tsx
const [cancelOpen, setCancelOpen] = useState(false);
// ...
<BulkActionBar
  count={bulk.size}
  onClear={bulk.clear}
  testIdPrefix="contracts"
  actions={[
    ...(can('contracts', 'manage') ? [{ key: 'cancel', label: 'Cancel', variant: 'destructive' as const, onClick: () => setCancelOpen(true) }] : []),
    ...(can('contracts', 'write') ? [{ key: 'delete', label: 'Delete drafts', variant: 'destructive' as const, onClick: () => void runBulkContracts('/contracts/bulk-delete', 'deleted') }] : []),
  ]}
/>
<ConfirmDialog
  open={cancelOpen}
  onClose={() => setCancelOpen(false)}
  onConfirm={() => { setCancelOpen(false); void runBulkContracts('/contracts/bulk-cancel', 'cancelled'); }}
  title="Cancel contracts"
  message={`Cancel ${bulk.size} selected contract(s)? Active and paused contracts will be cancelled; this cannot be undone.`}
  confirmLabel="Cancel contracts"
  confirmTestId="contracts-bulk-cancel-confirm"
/>
```
Add `import { ConfirmDialog } from '../shared/ConfirmDialog';` plus the bulk/runAction imports.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/contracts/ContractsList.bulk.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @breeze/web exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/contracts/ContractsList.tsx apps/web/src/components/contracts/ContractsList.bulk.test.tsx
git commit -m "feat(web): bulk select + cancel/delete on contracts list"
```

---

## Task 9: Detail-screen draft Delete buttons (quote, invoice, contract)

**Files:**
- Modify: `apps/web/src/lib/api/quotes.ts` — add `deleteQuote`.
- Modify: `apps/web/src/lib/api/contracts.ts` — add `deleteContract`.
- Modify: `apps/web/src/components/billing/quotes/QuoteDetail.tsx`
- Modify: `apps/web/src/components/billing/InvoiceDetail.tsx`
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx`
- Test: `apps/web/src/components/billing/quotes/QuoteDetail.delete.test.tsx` (create)
- Test: `apps/web/src/components/contracts/ContractDetail.delete.test.tsx` (create)

**Interfaces:**
- Consumes: existing `DELETE /:id` endpoints (quotes/invoices/contracts — all draft-only, already implemented); `ConfirmDialog`; `runAction`/`handleActionError`; `usePermissions`.
- Produces: `deleteQuote(id) => Promise<Response>` (api/quotes.ts), `deleteContract(id) => Promise<Response>` (api/contracts.ts). Delete buttons render only when `status === 'draft'` and the user has write permission; on success they toast and `navigateTo` the list.

- [ ] **Step 1: Add the api wrappers**

In `apps/web/src/lib/api/quotes.ts` (mirror `sendQuote`'s `fetchWithAuth` style already in that file):
```typescript
export function deleteQuote(id: string): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}`, { method: 'DELETE' });
}
```
In `apps/web/src/lib/api/contracts.ts` (mirror `contractTransition`):
```typescript
export function deleteContract(id: string): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}`, { method: 'DELETE' });
}
```

- [ ] **Step 2: Write the failing QuoteDetail delete test**

Create `apps/web/src/components/billing/quotes/QuoteDetail.delete.test.tsx`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const deleteQuote = vi.fn();
vi.mock('../../../lib/api/quotes', async (orig) => ({ ...(await orig<any>()), deleteQuote: (...a: unknown[]) => deleteQuote(...a) }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));

import { QuoteDetail } from './QuoteDetail';

const draftQuote = { id: 'q1', status: 'draft', /* ...minimal fields QuoteDetail needs... */ } as any;
const json = (p: unknown, status = 200) => ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(p) }) as unknown as Response;

describe('QuoteDetail delete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes a draft quote and navigates to the list', async () => {
    deleteQuote.mockResolvedValue(json({ data: { ok: true } }));
    render(<QuoteDetail quote={draftQuote} refresh={vi.fn()} />); // match actual props
    fireEvent.click(screen.getByTestId('quote-delete-open'));
    fireEvent.click(screen.getByTestId('quote-delete-confirm'));
    await waitFor(() => {
      expect(deleteQuote).toHaveBeenCalledWith('q1');
      expect(navigateTo).toHaveBeenCalledWith('/billing/quotes');
    });
  });
});
```
> Adjust `draftQuote` fields and `QuoteDetail` props to the real component signature when you open the file.

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/quotes/QuoteDetail.delete.test.tsx`
Expected: FAIL — no `quote-delete-open`.

- [ ] **Step 4: Implement the QuoteDetail delete button**

In `QuoteDetail.tsx` add `import { ConfirmDialog } from '../../shared/ConfirmDialog';`, `deleteQuote` to the existing `lib/api/quotes` import, and `useState` for `delOpen`/`deleting`. Add a handler mirroring `send`:
```typescript
const [delOpen, setDelOpen] = useState(false);
const [deleting, setDeleting] = useState(false);
const remove = useCallback(async () => {
  if (deleting) return;
  setDeleting(true);
  try {
    await runAction({
      request: () => deleteQuote(quote.id),
      errorFallback: 'Could not delete the draft.',
      successMessage: 'Draft deleted',
      onUnauthorized: UNAUTHORIZED,
    });
    setDelOpen(false);
    void navigateTo('/billing/quotes');
  } catch (err) {
    handleActionError(err, 'Could not delete the draft.');
  } finally {
    setDeleting(false);
  }
}, [deleting, quote.id]);
```
Render the trigger next to the existing Send button, draft-only + write-gated:
```tsx
{can('quotes', 'write') && quote.status === 'draft' && (
  <button
    type="button"
    onClick={() => setDelOpen(true)}
    data-testid="quote-delete-open"
    className="inline-flex w-full items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
  >
    Delete draft
  </button>
)}
<ConfirmDialog
  open={delOpen}
  onClose={() => setDelOpen(false)}
  onConfirm={() => void remove()}
  isLoading={deleting}
  title="Delete draft quote"
  message="This permanently deletes the draft quote. This cannot be undone."
  confirmLabel="Delete draft"
  confirmTestId="quote-delete-confirm"
/>
```
> `UNAUTHORIZED` / `can` already exist in this file (used by the Send action). Reuse them.

- [ ] **Step 5: Run the QuoteDetail test to confirm it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/billing/quotes/QuoteDetail.delete.test.tsx`
Expected: PASS.

- [ ] **Step 6: Add the InvoiceDetail delete button**

`InvoiceDetail.tsx` uses raw `fetchWithAuth`. Add (draft-only, write-gated), mirroring its `submitVoid` handler:
```tsx
{invoice.status === 'draft' && can('invoices', 'write') && (
  <button
    type="button"
    onClick={() => setDelOpen(true)}
    data-testid="invoice-delete-open"
    className="inline-flex w-full items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
  >
    Delete draft
  </button>
)}
```
Handler:
```typescript
const [delOpen, setDelOpen] = useState(false);
const [deleting, setDeleting] = useState(false);
const remove = useCallback(async () => {
  if (deleting) return;
  setDeleting(true);
  try {
    await runAction({
      request: () => fetchWithAuth(`/invoices/${invoice.id}`, { method: 'DELETE' }),
      errorFallback: 'Could not delete the draft.',
      successMessage: 'Draft deleted',
      onUnauthorized: UNAUTHORIZED,
    });
    setDelOpen(false);
    void navigateTo('/billing/invoices');
  } catch (err) {
    handleActionError(err, 'Could not delete the draft.');
  } finally {
    setDeleting(false);
  }
}, [deleting, invoice.id]);
```
Plus a `ConfirmDialog` with `confirmTestId="invoice-delete-confirm"` (import `ConfirmDialog` if not present).

- [ ] **Step 7: Write + run the ContractDetail delete test, then implement**

Create `apps/web/src/components/contracts/ContractDetail.delete.test.tsx` mirroring Step 2 (mock `../../lib/api/contracts` `deleteContract`, assert navigate to `/contracts`). Then in `ContractDetail.tsx` add `deleteContract` to the `lib/api/contracts` import and a draft-only, write-gated delete button + `ConfirmDialog`, mirroring the `transition` handler:
```typescript
const remove = useCallback(async () => {
  if (busy) return;
  setBusy(true);
  try {
    await runAction({
      request: () => deleteContract(contract.id),
      errorFallback: 'Could not delete the draft.',
      successMessage: 'Draft deleted',
      onUnauthorized: UNAUTHORIZED,
    });
    void navigateTo('/contracts');
  } catch (err) {
    handleActionError(err, 'Could not delete the draft.');
  } finally {
    setBusy(false);
  }
}, [busy, contract.id]);
```
Button (draft-only):
```tsx
{can('contracts', 'write') && contract.status === 'draft' && (
  <button type="button" onClick={() => setDelOpen(true)} data-testid="contract-delete-open"
    className="inline-flex w-full items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10">
    Delete draft
  </button>
)}
```
+ `ConfirmDialog` with `confirmTestId="contract-delete-confirm"`.

Run: `pnpm --filter @breeze/web exec vitest run src/components/contracts/ContractDetail.delete.test.tsx`
Expected: PASS.

- [ ] **Step 8: Guard + typecheck**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/__tests__/no-silent-mutations.test.ts && pnpm --filter @breeze/web exec tsc --noEmit`
Expected: PASS. (InvoiceDetail.tsx + ContractDetail.tsx are already in `TARGET_GLOBS`; QuoteDetail.tsx is not — both fine, handlers use `runAction`.)

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/api/quotes.ts apps/web/src/lib/api/contracts.ts \
  apps/web/src/components/billing/quotes/QuoteDetail.tsx apps/web/src/components/billing/quotes/QuoteDetail.delete.test.tsx \
  apps/web/src/components/billing/InvoiceDetail.tsx \
  apps/web/src/components/contracts/ContractDetail.tsx apps/web/src/components/contracts/ContractDetail.delete.test.tsx
git commit -m "feat(web): draft Delete action on quote/invoice/contract detail"
```

---

## Final verification

- [ ] **API suite (changed files):** `pnpm --filter @breeze/api exec vitest run src/lib/bulkOps.test.ts src/routes/quotes/bulk.test.ts src/routes/invoices/bulk.test.ts src/routes/contracts/bulk.test.ts` → all PASS.
- [ ] **Web suite (changed files):** `pnpm --filter @breeze/web exec vitest run src/components/billing/bulk src/components/billing/quotes src/components/billing/InvoicesPage.bulk.test.tsx src/components/contracts` → all PASS.
- [ ] **Lint + typecheck:** `pnpm --filter @breeze/api exec tsc --noEmit && pnpm --filter @breeze/web exec tsc --noEmit && pnpm lint` → clean.
- [ ] **Manual smoke (worktree-stack skill):** bring up the stack, select multiple draft quotes/invoices/contracts → bulk delete; bulk send quotes; bulk issue + bulk void invoices; bulk cancel contracts; on each detail screen delete a draft. Confirm toasts report succeeded/skipped counts and non-draft rows are skipped, not errored.

## Self-Review notes

- **Spec coverage:** bulk on all three tables (Tasks 6–8) with the user-selected action set — delete + send (quotes), delete + issue + void (invoices), delete + cancel (contracts) via API Tasks 2–4; draft Delete on all three detail screens (Task 9). ✔
- **No new RLS/migration** — reuses org-scoped services and existing `DELETE /:id`. ✔
- **Type consistency:** `BulkResult` fields (`total/succeeded/skipped/failed/skippedReasons`) are identical across API helper, routes, and web runners; `useBulkSelection` / `BulkActionBar` signatures match their consumers. ✔
- **Permission gating** matches the action→permission table for both API middleware and web `can()` button gating. ✔
- **Known follow-up (out of scope):** API `bulk.test.ts` files mock the service layer (route-level coverage). If you want end-to-end org-isolation coverage for the bulk paths, add an integration test under `apps/api/src/__tests__/integration/` — not required since the reused services already have isolation coverage.
