# Pax8 subscription → contract-line picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Pax8 Subscriptions table actionable — link a synced subscription to a contract line (creating a manual line inline when needed), change/pause/resume sync, and unlink — backed by one new `DELETE /pax8/subscriptions/link` endpoint.

**Architecture:** A small backend slice (new `unlinkPax8Subscription` service + `DELETE /pax8/subscriptions/link` route, no migration) plus frontend: a new `LinkSubscriptionPicker` component and per-row actions wired into `Pax8Integration.tsx`. Pause/resume and change-line reuse the existing upserting `POST /pax8/subscriptions/link`; the picker reuses the existing `listContracts`/`getContract`/`addContractLine` clients.

**Tech Stack:** Hono + Drizzle (api), Vitest (api unit, `mockSelectOnce` harness in `pax8.test.ts`), Astro + React islands + Testing Library (web), `fetchWithAuth`, `runAction`.

## Global Constraints

- Spec: `docs/superpowers/specs/billing/2026-06-25-pax8-subscription-contract-link-design.md`.
- Pax8 write routes are `partnerScopes + writePerm + requireMfa()`; mirror exactly for the new DELETE.
- Contract `money` is a **2-decimal string** (`/^\d+(\.\d{1,2})?$/`) — send `unitPrice` and `manualQuantity` as strings (`"36.00"`, `"5"`), NOT numbers.
- `contractLineInputSchema` requires `manualQuantity` for `lineType:'manual'`; `taxable` is required.
- The link service requires `lineType==='manual'` and `line.org === subscription.org`; the picker is scoped to `subscription.orgId` so this always holds.
- Web mutation handlers MUST wrap POST/PUT/PATCH/DELETE in `runAction`; `no-silent-mutations` guards this.
- `Pax8Integration.tsx` already has `ActionError`, `isMfaError`, `MFA_HINT`, `UNAUTHORIZED`, and an `integration` state object with `.id`.
- DOM hooks for tests use `data-testid` only.
- API tests: `pnpm --filter @breeze/api exec vitest run <path>`.
- Web tests: `pnpm --filter @breeze/web exec vitest run <path>`.
- No migration — `pax8_contract_line_links` exists and is RLS-covered.

---

### Task 1: `unlinkPax8Subscription` service

**Files:**
- Modify: `apps/api/src/services/pax8SyncService.ts`
- Test: `apps/api/src/services/pax8SyncService.test.ts`

**Interfaces:**
- Consumes: existing `db`, `pax8ContractLineLinks`, `and`, `eq` (already imported in this file).
- Produces: `unlinkPax8Subscription(input: { integrationId: string; subscriptionSnapshotId: string }): Promise<{ unlinked: boolean }>` — deletes the matching `pax8_contract_line_links` row; idempotent (0 rows → `{ unlinked: false }`); never touches `contract_lines.manual_quantity`.

- [ ] **Step 1: Write the failing test**

Append to `pax8SyncService.test.ts` (mirror the existing mock setup in that file; it already mocks `../db`). Use the file's existing `db` mock style. If the file mocks `db.delete(...).where(...).returning()`, assert on that chain:

```ts
import { unlinkPax8Subscription } from './pax8SyncService';

describe('unlinkPax8Subscription', () => {
  it('deletes the link row and reports unlinked when a row matched', async () => {
    // Arrange the db.delete().where().returning() mock to resolve [{ id: 'link-1' }].
    // (Follow the existing db-mock pattern in this file; see how linkPax8SubscriptionToContractLine
    //  tests stub db.insert(...).returning().)
    const result = await unlinkPax8Subscription({
      integrationId: '44444444-4444-4444-4444-444444444444',
      subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
    });
    expect(result).toEqual({ unlinked: true });
  });

  it('reports unlinked:false when no row matched (idempotent)', async () => {
    // Arrange the delete chain to resolve [].
    const result = await unlinkPax8Subscription({
      integrationId: '44444444-4444-4444-4444-444444444444',
      subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
    });
    expect(result).toEqual({ unlinked: false });
  });
});
```

> Before writing, read the top of `pax8SyncService.test.ts` to copy its exact `db` mock shape (how `db.insert`/`db.select` are stubbed) and replicate it for `db.delete(...).where(...).returning()`. Keep the two new tests consistent with that harness.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/pax8SyncService.test.ts`
Expected: FAIL — `unlinkPax8Subscription` is not exported.

- [ ] **Step 3: Implement the service**

Add to `pax8SyncService.ts` (near `linkPax8SubscriptionToContractLine`):

```ts
/**
 * Remove a Pax8 subscription ↔ contract-line link. Idempotent — deleting an
 * already-absent link returns { unlinked: false }. Intentionally does NOT reset
 * the contract line's manual_quantity: unlinking stops future quantity sync but
 * leaves the last-synced quantity in place so the bill doesn't change underfoot.
 */
export async function unlinkPax8Subscription(input: {
  integrationId: string;
  subscriptionSnapshotId: string;
}): Promise<{ unlinked: boolean }> {
  const deleted = await db
    .delete(pax8ContractLineLinks)
    .where(and(
      eq(pax8ContractLineLinks.integrationId, input.integrationId),
      eq(pax8ContractLineLinks.subscriptionSnapshotId, input.subscriptionSnapshotId),
    ))
    .returning({ id: pax8ContractLineLinks.id });
  return { unlinked: deleted.length > 0 };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/services/pax8SyncService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/pax8SyncService.ts apps/api/src/services/pax8SyncService.test.ts
git commit -m "feat(api): unlinkPax8Subscription service (idempotent, keeps manual_quantity)"
```

---

### Task 2: `DELETE /pax8/subscriptions/link` route

**Files:**
- Modify: `apps/api/src/routes/pax8.ts`
- Test: `apps/api/src/routes/pax8.test.ts`

**Interfaces:**
- Consumes: existing `partnerScopes`, `writePerm`, `requireMfa`, `db`, `pax8Integrations`, `pax8SubscriptionSnapshots`, `integrationScopeConditions`, `writeRouteAudit`, `and`, `eq`; plus `unlinkPax8Subscription` from Task 1.
- Produces: route `DELETE /pax8/subscriptions/link`, body `{ integrationId, subscriptionSnapshotId }`, returns `{ data: { unlinked: boolean } }`.

- [ ] **Step 1: Write the failing tests**

Add to `pax8.test.ts`. First extend the service mock (top of file, where `linkPax8SubscriptionToContractLine: vi.fn()` is) to also mock `unlinkPax8Subscription: vi.fn()`. Then add, inside `describe('pax8 routes', ...)`:

```ts
it('unlinks a subscription the caller can access', async () => {
  // 1) integration lookup → belongs to caller's partner
  mockSelectOnce([{ id: '44444444-4444-4444-4444-444444444444', partnerId: authState.partnerId }]);
  // 2) snapshot lookup → org the caller can access, same integration
  mockSelectOnce([{ orgId: ORG_A, integrationId: '44444444-4444-4444-4444-444444444444' }]);
  const { unlinkPax8Subscription } = await import('../services/pax8SyncService');
  (unlinkPax8Subscription as unknown as vi.Mock).mockResolvedValue({ unlinked: true });

  const res = await app.request('/pax8/subscriptions/link', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      integrationId: '44444444-4444-4444-4444-444444444444',
      subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
    }),
  });
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toMatchObject({ data: { unlinked: true } });
});

it('rejects unlinking a subscription in an org the caller cannot access (IDOR)', async () => {
  authState.canAccessOrg = false;
  mockSelectOnce([{ id: '44444444-4444-4444-4444-444444444444', partnerId: authState.partnerId }]);
  mockSelectOnce([{ orgId: '55555555-5555-5555-5555-555555555555', integrationId: '44444444-4444-4444-4444-444444444444' }]);

  const res = await app.request('/pax8/subscriptions/link', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      integrationId: '44444444-4444-4444-4444-444444444444',
      subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
    }),
  });
  expect(res.status).toBe(403);
});

it('returns 404 when the integration is not visible to the caller', async () => {
  mockSelectOnce([]); // partner predicate filtered it out
  const res = await app.request('/pax8/subscriptions/link', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      integrationId: '44444444-4444-4444-4444-444444444444',
      subscriptionSnapshotId: '66666666-6666-6666-6666-666666666666',
    }),
  });
  expect(res.status).toBe(404);
});
```

> `ORG_A` and `authState` already exist in `pax8.test.ts` (used by the GET /subscriptions tests). If `vi.Mock` typing is awkward, cast via `as unknown as ReturnType<typeof vi.fn>` or import `Mock` from vitest — match whatever the existing link test uses.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/pax8.test.ts`
Expected: FAIL — DELETE route returns 404/405 (not implemented) or `unlinkPax8Subscription` undefined.

- [ ] **Step 3: Implement the route**

Add `unlinkPax8Subscription` to the existing service import:

```ts
import { createPax8ClientForIntegration, linkPax8SubscriptionToContractLine, mapPax8Company, unlinkPax8Subscription } from '../services/pax8SyncService';
```

Add the route immediately after the existing `pax8Routes.post('/subscriptions/link', …)` block:

```ts
const unlinkSchema = z.object({
  integrationId: z.string().guid(),
  subscriptionSnapshotId: z.string().guid(),
});

pax8Routes.delete('/subscriptions/link', partnerScopes, writePerm, requireMfa(), zValidator('json', unlinkSchema), async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');
  const [integration] = await db
    .select({ id: pax8Integrations.id, partnerId: pax8Integrations.partnerId })
    .from(pax8Integrations)
    .where(and(...integrationScopeConditions(auth, body.integrationId)))
    .limit(1);
  if (!integration) return c.json({ error: 'Pax8 integration not found' }, 404);

  // Authorize on the subscription snapshot's org (unlink keys on the
  // subscription, and the link row may already be gone, so there is no contract
  // line to gate on). Also confirm the snapshot belongs to this integration.
  const [snapshot] = await db
    .select({ orgId: pax8SubscriptionSnapshots.orgId, integrationId: pax8SubscriptionSnapshots.integrationId })
    .from(pax8SubscriptionSnapshots)
    .where(eq(pax8SubscriptionSnapshots.id, body.subscriptionSnapshotId))
    .limit(1);
  if (!snapshot || snapshot.integrationId !== integration.id) return c.json({ error: 'Pax8 subscription not found' }, 404);
  if (snapshot.orgId && !auth.canAccessOrg(snapshot.orgId)) return c.json({ error: 'Access to subscription denied' }, 403);

  const result = await unlinkPax8Subscription({
    integrationId: integration.id,
    subscriptionSnapshotId: body.subscriptionSnapshotId,
  });
  writeRouteAudit(c, {
    orgId: snapshot.orgId ?? undefined,
    action: 'pax8.subscription.unlink_contract_line',
    resourceType: 'pax8_subscription_snapshot',
    resourceId: body.subscriptionSnapshotId,
    details: { integrationId: integration.id },
  });
  return c.json({ data: result });
});
```

> Confirm `writeRouteAudit`'s `orgId` accepts `undefined` (the `/companies/map` unmap path passes no org). If its type requires a string, gate the audit call behind `if (snapshot.orgId)` and still return the result.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/pax8.test.ts`
Expected: PASS (3 new tests + existing).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/pax8.ts apps/api/src/routes/pax8.test.ts
git commit -m "feat(api): DELETE /pax8/subscriptions/link to unlink a subscription"
```

---

### Task 3: `LinkSubscriptionPicker` component

**Files:**
- Create: `apps/web/src/components/integrations/LinkSubscriptionPicker.tsx`
- Test: `apps/web/src/components/integrations/LinkSubscriptionPicker.test.tsx`

**Interfaces:**
- Consumes: `listContracts`, `getContract`, `addContractLine` from `../../lib/api/contracts`; `fetchWithAuth` from `../../stores/auth`; `runAction`, `handleActionError`, `ActionError` from `../../lib/runAction`.
- Produces a default-exported component:
  ```ts
  interface LinkSubscriptionPickerProps {
    integrationId: string;
    subscription: { id: string; orgId: string; productName: string | null; quantity: number | null };
    onDone: () => void;   // call after a successful link
    onCancel: () => void;
  }
  ```
  testids: `pax8-link-contract`, `pax8-link-line`, `pax8-link-new-desc`, `pax8-link-new-price`, `pax8-link-sync`, `pax8-link-submit`, `pax8-link-cancel`. The line `<select>` includes a `__new__` option ("+ New manual line") that reveals the desc/price inputs.

**Behavior:** load active+draft contracts for `subscription.orgId` on mount; on contract select, fetch its manual lines; "Link" either creates a manual line first (when `__new__`) then POSTs the link, or POSTs the link to the chosen existing line. Money values are strings.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/integrations/LinkSubscriptionPicker.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const listContracts = vi.fn();
const getContract = vi.fn();
const addContractLine = vi.fn();
const fetchWithAuth = vi.fn();

vi.mock('../../lib/api/contracts', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/contracts')>()),
  listContracts: (...a: unknown[]) => listContracts(...a),
  getContract: (...a: unknown[]) => getContract(...a),
  addContractLine: (...a: unknown[]) => addContractLine(...a),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import LinkSubscriptionPicker from './LinkSubscriptionPicker';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const sub = { id: 'sub-1', orgId: 'org-1', productName: 'Microsoft 365 E3', quantity: 5 };

beforeEach(() => {
  listContracts.mockReset(); getContract.mockReset(); addContractLine.mockReset(); fetchWithAuth.mockReset();
  listContracts.mockResolvedValue(ok([{ id: 'c1', orgId: 'org-1', name: 'Acme Monthly', status: 'active' }]));
  getContract.mockResolvedValue(ok({
    contract: { id: 'c1' },
    lines: [{ id: 'line-existing', orgId: 'org-1', lineType: 'manual', description: 'Seats', unitPrice: '30.00', manualQuantity: '3' }],
  }));
  addContractLine.mockResolvedValue(ok({ id: 'line-new' }));
  fetchWithAuth.mockResolvedValue(ok({ id: 'link-1' }));
});

describe('LinkSubscriptionPicker', () => {
  it('links to an existing manual line', async () => {
    render(<LinkSubscriptionPicker integrationId="int-1" subscription={sub} onDone={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByTestId('pax8-link-contract'));
    fireEvent.change(screen.getByTestId('pax8-link-contract'), { target: { value: 'c1' } });
    await waitFor(() => screen.getByTestId('pax8-link-line'));
    fireEvent.change(screen.getByTestId('pax8-link-line'), { target: { value: 'line-existing' } });
    fireEvent.click(screen.getByTestId('pax8-link-submit'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    const [url, opts] = fetchWithAuth.mock.calls[0];
    expect(url).toBe('/pax8/subscriptions/link');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toMatchObject({ integrationId: 'int-1', subscriptionSnapshotId: 'sub-1', contractLineId: 'line-existing', syncEnabled: true });
    expect(addContractLine).not.toHaveBeenCalled();
  });

  it('creates a new manual line then links to it', async () => {
    render(<LinkSubscriptionPicker integrationId="int-1" subscription={sub} onDone={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByTestId('pax8-link-contract'));
    fireEvent.change(screen.getByTestId('pax8-link-contract'), { target: { value: 'c1' } });
    await waitFor(() => screen.getByTestId('pax8-link-line'));
    fireEvent.change(screen.getByTestId('pax8-link-line'), { target: { value: '__new__' } });
    fireEvent.change(screen.getByTestId('pax8-link-new-price'), { target: { value: '36.00' } });
    fireEvent.click(screen.getByTestId('pax8-link-submit'));
    await waitFor(() => expect(addContractLine).toHaveBeenCalled());
    const [cid, lineBody] = addContractLine.mock.calls[0];
    expect(cid).toBe('c1');
    expect(lineBody).toMatchObject({ lineType: 'manual', unitPrice: '36.00', manualQuantity: '5', taxable: false });
    const linkBody = JSON.parse(fetchWithAuth.mock.calls[0][1].body);
    expect(linkBody.contractLineId).toBe('line-new');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/integrations/LinkSubscriptionPicker.test.tsx`
Expected: FAIL — cannot resolve `./LinkSubscriptionPicker`.

- [ ] **Step 3: Implement the component**

```tsx
// apps/web/src/components/integrations/LinkSubscriptionPicker.tsx
import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { listContracts, getContract, addContractLine, type ContractSummary, type ContractLine } from '../../lib/api/contracts';

const NEW_LINE = '__new__';
const MONEY_RE = /^\d+(\.\d{1,2})?$/;

interface LinkSubscriptionPickerProps {
  integrationId: string;
  subscription: { id: string; orgId: string; productName: string | null; quantity: number | null };
  onDone: () => void;
  onCancel: () => void;
}

export default function LinkSubscriptionPicker({ integrationId, subscription, onDone, onCancel }: LinkSubscriptionPickerProps) {
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [contractId, setContractId] = useState('');
  const [lines, setLines] = useState<ContractLine[]>([]);
  const [lineId, setLineId] = useState('');
  const [newDesc, setNewDesc] = useState(subscription.productName ?? '');
  const [newPrice, setNewPrice] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await listContracts({ orgId: subscription.orgId });
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as { data?: ContractSummary[] } | null;
      setContracts((body?.data ?? []).filter((c) => c.status !== 'cancelled' && c.status !== 'expired'));
    })();
  }, [subscription.orgId]);

  const onContract = useCallback(async (id: string) => {
    setContractId(id);
    setLineId('');
    setLines([]);
    if (!id) return;
    const res = await getContract(id);
    if (!res.ok) return;
    const body = (await res.json().catch(() => null)) as { data?: { lines?: ContractLine[] } } | null;
    setLines((body?.data?.lines ?? []).filter((l) => l.lineType === 'manual'));
  }, []);

  const newPriceValid = MONEY_RE.test(newPrice.trim());
  const canSubmit = !busy && contractId !== '' && lineId !== '' && (lineId !== NEW_LINE || (newDesc.trim() !== '' && newPriceValid));

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      let contractLineId = lineId;
      if (lineId === NEW_LINE) {
        const line = await runAction<{ id: string }>({
          request: () => addContractLine(contractId, {
            lineType: 'manual',
            description: newDesc.trim(),
            unitPrice: newPrice.trim(),
            taxable: false,
            manualQuantity: String(subscription.quantity ?? 0),
          }),
          errorFallback: 'Could not create the contract line.',
          parseSuccess: (d) => (d as { data: { id: string } }).data,
        });
        contractLineId = line.id;
      }
      await runAction({
        request: () => fetchWithAuth('/pax8/subscriptions/link', {
          method: 'POST',
          body: JSON.stringify({ integrationId, subscriptionSnapshotId: subscription.id, contractLineId, syncEnabled }),
        }),
        errorFallback: 'Could not link the subscription.',
        successMessage: 'Subscription linked',
      });
      onDone();
    } catch (err) {
      handleActionError(err, 'Could not link the subscription.');
    } finally {
      setBusy(false);
    }
  }, [canSubmit, lineId, contractId, newDesc, newPrice, subscription, integrationId, syncEnabled, onDone]);

  return (
    <div className="mt-2 rounded-md border bg-background/40 p-3 text-sm" data-testid="pax8-link-picker">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Contract</span>
          <select
            value={contractId}
            onChange={(e) => void onContract(e.target.value)}
            data-testid="pax8-link-contract"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="">Select a contract…</option>
            {contracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {contractId && (
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Line</span>
            <select
              value={lineId}
              onChange={(e) => setLineId(e.target.value)}
              data-testid="pax8-link-line"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="">Select a line…</option>
              {lines.map((l) => <option key={l.id} value={l.id}>{l.description}</option>)}
              <option value={NEW_LINE}>+ New manual line</option>
            </select>
          </label>
        )}
      </div>

      {lineId === NEW_LINE && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <input
            type="text" value={newDesc} placeholder="Line description"
            onChange={(e) => setNewDesc(e.target.value)}
            data-testid="pax8-link-new-desc"
            className="h-9 rounded-md border bg-background px-3 text-sm"
          />
          <input
            type="text" inputMode="decimal" value={newPrice} placeholder="Unit price (e.g. 36.00)"
            onChange={(e) => setNewPrice(e.target.value)}
            data-testid="pax8-link-new-price"
            className="h-9 rounded-md border bg-background px-3 text-sm"
          />
        </div>
      )}

      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={syncEnabled} onChange={(e) => setSyncEnabled(e.target.checked)} data-testid="pax8-link-sync" />
          Keep quantity in sync
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} disabled={busy} data-testid="pax8-link-cancel"
            className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50">Cancel</button>
          <button type="button" onClick={() => void submit()} disabled={!canSubmit} data-testid="pax8-link-submit"
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Link</button>
        </div>
      </div>
    </div>
  );
}
```

> Confirm `ContractSummary` exposes `status` and `name`, and `ContractLine` exposes `lineType` and `description` (it does — `apps/web/src/lib/api/contracts.ts`). If `getContract`'s payload nests lines differently than `data.lines`, adjust the parse in `onContract` to match the real shape (verify against `ContractDetail`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/integrations/LinkSubscriptionPicker.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/integrations/LinkSubscriptionPicker.tsx apps/web/src/components/integrations/LinkSubscriptionPicker.test.tsx
git commit -m "feat(web): LinkSubscriptionPicker for Pax8 subscription → contract line"
```

---

### Task 4: Row actions in `Pax8Integration.tsx`

**Files:**
- Modify: `apps/web/src/components/integrations/Pax8Integration.tsx`
- Test: `apps/web/src/components/integrations/Pax8Integration.link.test.tsx` (new)

**Interfaces:**
- Consumes: `LinkSubscriptionPicker` (Task 3); existing `integration.id`, `subscriptions` state, `runAction`, `handleActionError`, `fetchWithAuth`, `isMfaError`, `MFA_HINT`.
- Produces: an actions cell in the subscriptions table; handlers `reloadSubscriptions`, `unlinkSubscription`, `toggleSync`; picker mount via `linkingSub` state.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/integrations/Pax8Integration.link.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('./LinkSubscriptionPicker', () => ({
  default: ({ onDone }: { onDone: () => void }) => (
    <button data-testid="mock-picker-done" onClick={onDone}>picker</button>
  ),
}));

import Pax8Integration from './Pax8Integration';

const ok = (data: unknown, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ data, ...extra }), { status: 200 });

// Route fetchWithAuth by URL+method so the component's initial load resolves and
// the subscriptions table renders with one linked + one unlinked row.
function routeFetch(linked = true) {
  fetchWithAuth.mockImplementation((url: string, opts?: { method?: string }) => {
    if (url.startsWith('/pax8/integration')) return Promise.resolve(ok({ id: 'int-1', configured: true, enabled: true, hasClientId: true, hasClientSecret: true }));
    if (url.startsWith('/pax8/companies')) return Promise.resolve(ok([]));
    if (url.startsWith('/pax8/subscriptions')) return Promise.resolve(ok([
      { id: 'sub-unlinked', orgId: 'org-1', productName: 'Item A', quantity: 2, contractLineId: null, syncEnabled: null },
      { id: 'sub-linked', orgId: 'org-1', productName: 'Item B', quantity: 3, contractLineId: 'line-1', syncEnabled: linked },
    ]));
    if (url.startsWith('/orgs/organizations')) return Promise.resolve(ok([{ id: 'org-1', name: 'Acme' }]));
    if (url === '/pax8/subscriptions/link') return Promise.resolve(ok({ unlinked: opts?.method === 'DELETE' }));
    return Promise.resolve(ok(null));
  });
}

beforeEach(() => { fetchWithAuth.mockReset(); });

describe('Pax8Integration subscription actions', () => {
  it('unlinks a linked subscription via DELETE', async () => {
    routeFetch(true);
    render(<Pax8Integration />);
    await waitFor(() => screen.getByTestId('pax8-subscription-unlink-sub-linked'));
    fireEvent.click(screen.getByTestId('pax8-subscription-unlink-sub-linked'));
    await waitFor(() => {
      const del = fetchWithAuth.mock.calls.find(([u, o]) => u === '/pax8/subscriptions/link' && o?.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(JSON.parse((del![1] as { body: string }).body)).toMatchObject({ integrationId: 'int-1', subscriptionSnapshotId: 'sub-linked' });
    });
  });

  it('opens the picker for an unlinked, mapped subscription', async () => {
    routeFetch(true);
    render(<Pax8Integration />);
    await waitFor(() => screen.getByTestId('pax8-subscription-link-sub-unlinked'));
    fireEvent.click(screen.getByTestId('pax8-subscription-link-sub-unlinked'));
    await waitFor(() => screen.getByTestId('mock-picker-done'));
  });
});
```

> The mock `fetchWithAuth` shapes above must match how `Pax8Integration` actually parses its initial load (integration object fields, the `data` arrays). Before finalizing, read the component's load functions and adjust the mocked response bodies so the subscriptions table renders. Keep the two assertions (DELETE called with the right body; picker opens) as the contract.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/integrations/Pax8Integration.link.test.tsx`
Expected: FAIL — no `pax8-subscription-unlink-*` / `pax8-subscription-link-*` testids yet.

- [ ] **Step 3: Implement the row actions**

In `Pax8Integration.tsx`:

1. Import the picker: `import LinkSubscriptionPicker from './LinkSubscriptionPicker';`

2. Add state: `const [linkingSub, setLinkingSub] = useState<Pax8Subscription | null>(null);`

3. Add a `reloadSubscriptions` callback that re-fetches `/pax8/subscriptions?limit=100` and `setSubscriptions(...)` (factor it out of the existing combined load if needed, or add a focused fetch). Then:

```tsx
const unlinkSubscription = useCallback(async (sub: Pax8Subscription) => {
  if (!integration) return;
  try {
    await runAction({
      request: () => fetchWithAuth('/pax8/subscriptions/link', {
        method: 'DELETE',
        body: JSON.stringify({ integrationId: integration.id, subscriptionSnapshotId: sub.id }),
      }),
      errorFallback: 'Could not unlink the subscription.',
      successMessage: 'Subscription unlinked',
      onUnauthorized: UNAUTHORIZED,
    });
    void reloadSubscriptions();
  } catch (err) {
    if (isMfaError(err)) { showToast({ type: 'error', message: MFA_HINT }); return; }
    handleActionError(err, 'Could not unlink the subscription.');
  }
}, [integration, reloadSubscriptions]);

const toggleSync = useCallback(async (sub: Pax8Subscription) => {
  if (!integration || !sub.contractLineId) return;
  try {
    await runAction({
      request: () => fetchWithAuth('/pax8/subscriptions/link', {
        method: 'POST',
        body: JSON.stringify({ integrationId: integration.id, subscriptionSnapshotId: sub.id, contractLineId: sub.contractLineId, syncEnabled: !sub.syncEnabled }),
      }),
      errorFallback: 'Could not update sync.',
      successMessage: sub.syncEnabled ? 'Sync paused' : 'Sync resumed',
      onUnauthorized: UNAUTHORIZED,
    });
    void reloadSubscriptions();
  } catch (err) {
    if (isMfaError(err)) { showToast({ type: 'error', message: MFA_HINT }); return; }
    handleActionError(err, 'Could not update sync.');
  }
}, [integration, reloadSubscriptions]);
```

4. Replace the read-only "Linked" status cell with an actions cell:

```tsx
<td className="px-3 py-2">
  {sub.orgId == null ? (
    <span className="text-xs text-muted-foreground">Map company first</span>
  ) : sub.contractLineId ? (
    <div className="flex flex-wrap gap-2">
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
        {sub.syncEnabled ? 'syncing' : 'linked'}
      </span>
      <button type="button" onClick={() => setLinkingSub(sub)} data-testid={`pax8-subscription-change-${sub.id}`}
        className="text-xs underline hover:text-foreground">Change</button>
      <button type="button" onClick={() => void toggleSync(sub)} data-testid={`pax8-subscription-togglesync-${sub.id}`}
        className="text-xs underline hover:text-foreground">{sub.syncEnabled ? 'Pause' : 'Resume'}</button>
      <button type="button" onClick={() => void unlinkSubscription(sub)} data-testid={`pax8-subscription-unlink-${sub.id}`}
        className="text-xs underline text-destructive hover:opacity-80">Unlink</button>
    </div>
  ) : (
    <button type="button" onClick={() => setLinkingSub(sub)} data-testid={`pax8-subscription-link-${sub.id}`}
      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted">Link</button>
  )}
</td>
```

5. Render the picker when `linkingSub` is set (e.g. below the table or in a row-expansion). Minimal: render under the table.

```tsx
{linkingSub && integration && (
  <LinkSubscriptionPicker
    integrationId={integration.id}
    subscription={{ id: linkingSub.id, orgId: linkingSub.orgId as string, productName: linkingSub.productName, quantity: linkingSub.quantity }}
    onDone={() => { setLinkingSub(null); void reloadSubscriptions(); }}
    onCancel={() => setLinkingSub(null)}
  />
)}
```

> `showToast` is already imported in this file (the MFA hint paths use it). Confirm the import; if not present, import from the same module the existing toasts use. Keep the existing "Linked" column header or rename it "Status / actions".

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @breeze/web exec vitest run src/components/integrations/Pax8Integration.link.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the existing Pax8 tests (no regression)**

Run: `pnpm --filter @breeze/web exec vitest run src/components/integrations`
Expected: existing `Pax8Integration.test.tsx` + new tests all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/integrations/Pax8Integration.tsx apps/web/src/components/integrations/Pax8Integration.link.test.tsx
git commit -m "feat(web): link/change/pause/unlink actions in Pax8 subscriptions table"
```

---

### Task 5: Guard rails

**Files:**
- Possibly modify: `apps/web/src/lib/runActionAllowlist.ts`
- Verify: `no-silent-mutations`, `astro check`, API typecheck.

- [ ] **Step 1: no-silent-mutations**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS — all new mutations (link, unlink, toggle, addContractLine) run through `runAction`. If a new handler is flagged, either wrap it in `runAction` (preferred) or add a justified allowlist entry.

- [ ] **Step 2: astro check (web type gate)**

Run: `cd apps/web && pnpm astro check`
Expected: no NEW errors attributable to the changed files (`Pax8Integration.tsx`, `LinkSubscriptionPicker.tsx`). Note: this worktree has pre-existing zod-4 `.guid()` errors in unrelated validator/form files — compare against the baseline count, don't chase pre-existing ones.

- [ ] **Step 3: API typecheck + full pax8 suite**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/pax8.test.ts src/services/pax8SyncService.test.ts`
Run: `pnpm --filter @breeze/api exec tsc --noEmit` (expect 0 errors in `pax8.ts` / `pax8SyncService.ts`).
Expected: green.

- [ ] **Step 4: Commit (only if a guard file changed)**

```bash
git add apps/web/src/lib/runActionAllowlist.ts
git commit -m "test(web): allowlist note for Pax8 link/unlink (wrapped by runAction)"
```

---

## Self-Review

**Spec coverage:**
- `DELETE /pax8/subscriptions/link` + org gate → Task 2. ✓
- `unlinkPax8Subscription` (idempotent, keeps manual_quantity) → Task 1. ✓
- Picker: contract scope, existing manual line, inline new manual line, syncEnabled → Task 3. ✓
- Row actions: link / change / pause-resume / unlink, unmapped hint → Task 4. ✓
- Money as string → enforced in Task 3 (`unitPrice`/`manualQuantity` strings) + Global Constraints. ✓
- runAction / no-silent-mutations → Tasks 3, 4, 5. ✓
- No migration → stated; nothing creates a table. ✓

**Placeholder scan:** the three "confirm shape" notes (db-mock harness in Task 1, `vi.Mock` typing in Task 2, initial-load response shapes in Task 4) are verification steps against real existing code, not deferred work — each has concrete fallback instructions. No `TODO`/`TBD` in code.

**Type consistency:** `unlinkPax8Subscription({ integrationId, subscriptionSnapshotId }) → { unlinked }` consistent across Tasks 1↔2. Picker prop `subscription` shape `{ id, orgId, productName, quantity }` consistent across Tasks 3↔4 (Task 4 maps `orgId as string` since the picker only mounts for mapped rows). Link POST body `{ integrationId, subscriptionSnapshotId, contractLineId, syncEnabled }` consistent across Tasks 3, 4, and the existing route. Money values are strings throughout.

**Resolved before drafting:** contract `money` is a 2-decimal string (`contracts.ts:3`); `contractLineInputSchema` requires `manualQuantity` for manual + `taxable`; add-line returns `{ data: line }` (`lines.ts:17`); link route auth/audit pattern (`pax8.ts:400`); `pax8.test.ts` uses a `mockSelectOnce` queue + `authState`/`ORG_A`; `Pax8Subscription` already carries `orgId`/`contractLineId`/`syncEnabled`/`quantity`/`productName`.
