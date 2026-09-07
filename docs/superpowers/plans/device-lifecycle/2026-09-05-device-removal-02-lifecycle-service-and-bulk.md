---
tracking_issue: LanternOps/breeze#5023
---
# Device Removal 02 — Lifecycle Service Hardening + Bulk Restore / Bulk Purge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A selection of removed devices offers exactly Restore and Delete permanently; both work in bulk; single and bulk share one hardened lifecycle service so a purge can never race a restore or destroy a pending agent uninstall.

**Architecture:** Extract `services/deviceLifecycle.ts` (`restoreRemovedDevice`, `purgeRemovedDevice`) that lock the `devices` row first, re-check state under the lock, and refuse purge while a `device_remove` uninstall is pending. Single routes become thin wrappers. Bulk restore is a synchronous self-managed route over `runBulkIsolated`. Bulk purge is a BullMQ job (`device-bulk-purge`) returning `202 { jobId }` with a status endpoint; the worker re-verifies org + status per device under a system context. The web bulk bar becomes selection-aware with a third gating set `REMOVED_ONLY_BULK_ACTIONS`.

**Tech Stack:** Hono, Drizzle, postgres-js, BullMQ, Vitest (API unit + integration); React, react-i18next, Vitest/jsdom (web).

**Spec:** `docs/superpowers/specs/device-lifecycle/2026-09-05-device-removal-completion-design.md` (PR 2). Issues: #2787 (closes), #3987 item 3.

## Global Constraints

- **Rigor: high** — data deletion + concurrency. TDD every task; integration suite in Task 3 is mandatory before the PR.
- Lock order everywhere: `devices` row `FOR UPDATE` FIRST, then anything in `device_commands`. (`deviceDeletion.ts:79` explains the AB-BA class; Restore currently violates it.)
- Purge REFUSES while a `self_uninstall` row with `uninstall_reasons @> {device_remove}` is `pending`/`sent` and unexpired → `409 UNINSTALL_PENDING`. The legacy fire-and-forget WS uninstall in `DELETE /:id/permanent` is REMOVED.
- No new tables. No migration. The only new persistent state is the BullMQ job payload in Redis.
- New static paths (`/bulk/restore`, `/bulk/permanent-delete`, `/bulk/purge-runs/:jobId`) are mounted BEFORE `coreRoutes` and guarded by a mount-order test.
- Bulk restore route is registered in `middleware/selfManagedDbContextRoutes.ts` (request tx must not be held across the loop — `auth.ts:738`).
- `DEVICES_DELETE` + `requireMfa()` on every new mutating route; `DEVICES_READ` on the status route. Partner-scope callers get **404** on another partner's job (mirror `routes/orgMerge.ts:246`).
- Max 500 ids per bulk call, enforced by zod AND re-enforced in the worker.
- Cascade lists untouched (no schema change) — but `cascadeDelete.test.ts` must stay green because it binds `deleteDeviceCascade` to the schema.
- Locale keys → all 8 locales in the same commit.
- Commit after each task. `cd apps/api && npx vitest run <file>`; never `pnpm --filter x test -- --run`.

---

### Task 1: `services/deviceLifecycle.ts` — restore + purge with lock-first, re-check, refusal

**Files:**
- Create: `apps/api/src/services/deviceLifecycle.ts`
- Create: `apps/api/src/services/deviceLifecycle.test.ts`

**Interfaces:**
- Consumes: `deleteDeviceCascade(tx, deviceId)` (`services/deviceDeletion.ts:75`), `releaseDeviceRemoveReason(tx, deviceId, reason)` and `UNINSTALL_REASON_DEVICE_REMOVE` (`services/deviceUninstallDrain.ts`), `dissolveLinkGroupIfBelowMinimum(tx, linkGroupId)` (`services/deviceLinkGroups.ts`), `Tx` type from `deviceUninstallDrain.ts:52`.
- Produces:
  ```ts
  export type DeviceLifecycleCode = 'NOT_FOUND' | 'NOT_REMOVED' | 'UNINSTALL_PENDING';
  export class DeviceLifecycleError extends Error {
    constructor(public readonly code: DeviceLifecycleCode, message: string) { super(message); }
    get status(): 404 | 409 { return this.code === 'NOT_FOUND' ? 404 : 409; }
  }
  export interface RestoreResult { device: typeof devices.$inferSelect; uninstallAlreadyDispatched: boolean }
  export interface PurgeResult { linkGroupDissolved: boolean }
  /** Locks devices row, re-checks status='decommissioned', releases device_remove reason, flips to 'offline'. */
  export async function restoreRemovedDevice(tx: Tx, deviceId: string): Promise<RestoreResult>
  /** Locks devices row, re-checks status='decommissioned', refuses on pending device_remove uninstall, cascades, dissolves link group. */
  export async function purgeRemovedDevice(tx: Tx, deviceId: string): Promise<PurgeResult>
  ```
  Both take a `Tx` because the caller owns the transaction (route: request tx or `db.transaction`; worker: `withSystemDbAccessContext` + `db.transaction`). Neither reads `auth` — the caller authorises first (`getDeviceWithOrgAndSiteCheck` or the worker's expected-org check).

- [ ] **Step 1: Write the failing tests** (compiled-SQL style with a fake `tx`, mirroring `deviceUninstallDrain.test.ts`)

```ts
// apps/api/src/services/deviceLifecycle.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./deviceDeletion', () => ({ deleteDeviceCascade: vi.fn(async () => undefined) }));
vi.mock('./deviceLinkGroups', () => ({ dissolveLinkGroupIfBelowMinimum: vi.fn(async () => true) }));
vi.mock('./deviceUninstallDrain', async (orig) => {
  const actual = await orig<typeof import('./deviceUninstallDrain')>();
  return { ...actual, releaseDeviceRemoveReason: vi.fn(async () => ({ cancelled: 1, retainedOtherOwner: 0, alreadyDispatched: 0 })) };
});

import { restoreRemovedDevice, purgeRemovedDevice, DeviceLifecycleError } from './deviceLifecycle';
import { deleteDeviceCascade } from './deviceDeletion';
import { releaseDeviceRemoveReason } from './deviceUninstallDrain';

const DEV = '11111111-1111-4111-8111-111111111111';

/** Minimal tx double: records the order of statements; scripted rows per call. */
function makeTx(script: { lockRow?: Record<string, unknown> | null; pendingUninstall?: boolean; updatedRow?: Record<string, unknown> }) {
  const calls: string[] = [];
  const tx = {
    execute: vi.fn(async (q: { queryChunks?: unknown } | string) => {
      const text = JSON.stringify(q);
      if (text.includes('FOR UPDATE')) { calls.push('lock'); return script.lockRow ? [script.lockRow] : []; }
      if (text.includes('self_uninstall')) { calls.push('pending-check'); return script.pendingUninstall ? [{ id: 'cmd' }] : []; }
      calls.push('execute'); return [];
    }),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: async () => { calls.push('update'); return [script.updatedRow ?? { id: DEV, status: 'offline' }]; } }) }) })),
    select: vi.fn(),
  };
  return { tx: tx as never, calls };
}

beforeEach(() => vi.clearAllMocks());

describe('restoreRemovedDevice', () => {
  it('locks the devices row BEFORE releasing the uninstall reason (lock order)', async () => {
    const { tx, calls } = makeTx({ lockRow: { id: DEV, status: 'decommissioned' } });
    vi.mocked(releaseDeviceRemoveReason).mockImplementation(async () => { calls.push('release'); return { cancelled: 1, retainedOtherOwner: 0, alreadyDispatched: 0 }; });
    await restoreRemovedDevice(tx, DEV);
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('release'));
    expect(calls.indexOf('release')).toBeLessThan(calls.indexOf('update'));
  });

  it('throws NOT_FOUND when the lock returns no row', async () => {
    const { tx } = makeTx({ lockRow: null });
    await expect(restoreRemovedDevice(tx, DEV)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('throws NOT_REMOVED when the locked row is no longer decommissioned', async () => {
    const { tx } = makeTx({ lockRow: { id: DEV, status: 'online' } });
    await expect(restoreRemovedDevice(tx, DEV)).rejects.toMatchObject({ code: 'NOT_REMOVED', status: 409 });
    expect(releaseDeviceRemoveReason).not.toHaveBeenCalled();
  });

  it('reports uninstallAlreadyDispatched from the release result', async () => {
    const { tx } = makeTx({ lockRow: { id: DEV, status: 'decommissioned' } });
    vi.mocked(releaseDeviceRemoveReason).mockResolvedValueOnce({ cancelled: 0, retainedOtherOwner: 0, alreadyDispatched: 1 });
    const r = await restoreRemovedDevice(tx, DEV);
    expect(r.uninstallAlreadyDispatched).toBe(true);
  });
});

describe('purgeRemovedDevice', () => {
  it('re-checks status under the lock and refuses a device that was restored concurrently', async () => {
    const { tx } = makeTx({ lockRow: { id: DEV, status: 'offline', link_group_id: null } });
    await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({ code: 'NOT_REMOVED' });
    expect(deleteDeviceCascade).not.toHaveBeenCalled();
  });

  it('refuses while a device_remove uninstall is still pending', async () => {
    const { tx } = makeTx({ lockRow: { id: DEV, status: 'decommissioned', link_group_id: null }, pendingUninstall: true });
    await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({ code: 'UNINSTALL_PENDING', status: 409 });
    expect(deleteDeviceCascade).not.toHaveBeenCalled();
  });

  it('cascades and dissolves the link group when eligible', async () => {
    const { tx, calls } = makeTx({ lockRow: { id: DEV, status: 'decommissioned', link_group_id: 'lg-1' } });
    const r = await purgeRemovedDevice(tx, DEV);
    expect(deleteDeviceCascade).toHaveBeenCalledWith(tx, DEV);
    expect(r.linkGroupDissolved).toBe(true);
    expect(calls[0]).toBe('lock');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module './deviceLifecycle'`)

```bash
cd apps/api && npx vitest run src/services/deviceLifecycle.test.ts
```

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/deviceLifecycle.ts
/**
 * Single-device lifecycle operations shared by the single routes
 * (routes/devices/core.ts), the bulk routes (routes/devices/bulkLifecycle.ts)
 * and the bulk-purge worker (jobs/deviceBulkPurge.ts). ONE implementation so
 * single and bulk cannot drift (#2787), and so the two latent defects found in
 * the pre-#2787 single routes stay fixed:
 *
 *  1. TOCTOU — permanent delete checked `status = 'decommissioned'` OUTSIDE the
 *     deletion transaction and never re-checked under the devices lock, so a
 *     Restore committing in between was silently purged. Both operations here
 *     lock first and decide second.
 *  2. Lock-order inversion — Restore released the uninstall reason (locking
 *     device_commands rows) BEFORE touching the devices row, opposite to the
 *     cascade's devices-first order (deviceDeletion.ts). AB-BA → 40P01. Both
 *     operations here take `devices FOR UPDATE` as their first statement.
 *
 * Purge additionally REFUSES while a `device_remove` self_uninstall is still
 * pending/sent and unexpired: device_commands is in the device cascade, so
 * purging would destroy the only thing that will ever clean the endpoint.
 *
 * Callers own authorisation and the transaction. Nothing here reads `auth`.
 */
import { and, arrayContains, eq, gt, inArray, sql } from 'drizzle-orm';
import { deviceCommands, devices } from '../db/schema';
import { deleteDeviceCascade } from './deviceDeletion';
import { dissolveLinkGroupIfBelowMinimum } from './deviceLinkGroups';
import {
  releaseDeviceRemoveReason,
  UNINSTALL_REASON_DEVICE_REMOVE,
  type Tx,
} from './deviceUninstallDrain';

export type DeviceLifecycleCode = 'NOT_FOUND' | 'NOT_REMOVED' | 'UNINSTALL_PENDING';

export class DeviceLifecycleError extends Error {
  constructor(public readonly code: DeviceLifecycleCode, message: string) {
    super(message);
    this.name = 'DeviceLifecycleError';
  }
  get status(): 404 | 409 {
    return this.code === 'NOT_FOUND' ? 404 : 409;
  }
}

export interface RestoreResult {
  device: typeof devices.$inferSelect;
  uninstallAlreadyDispatched: boolean;
}

export interface PurgeResult {
  linkGroupDissolved: boolean;
}

interface LockedRow { id: string; status: string; link_group_id: string | null }

/** First statement of every operation: devices row FOR UPDATE, then decide. */
async function lockDevice(tx: Tx, deviceId: string): Promise<LockedRow> {
  const rows = (await tx.execute(
    sql`SELECT id, status, link_group_id FROM devices WHERE id = ${deviceId} FOR UPDATE`,
  )) as unknown as LockedRow[];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) throw new DeviceLifecycleError('NOT_FOUND', 'Device not found');
  if (row.status !== 'decommissioned') {
    throw new DeviceLifecycleError('NOT_REMOVED', 'Device is not removed');
  }
  return row;
}

export async function restoreRemovedDevice(tx: Tx, deviceId: string): Promise<RestoreResult> {
  await lockDevice(tx, deviceId);
  // Release-then-flip inside the caller's transaction — the safety property is
  // the transaction; the order is secondary defense (see core.ts restore doc).
  const release = await releaseDeviceRemoveReason(tx, deviceId, 'device_restored');
  const [device] = await tx
    .update(devices)
    .set({ status: 'offline', updatedAt: new Date() })
    .where(eq(devices.id, deviceId))
    .returning();
  return { device, uninstallAlreadyDispatched: release.alreadyDispatched > 0 };
}

async function hasPendingDeviceRemoveUninstall(tx: Tx, deviceId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT id FROM device_commands
     WHERE device_id = ${deviceId}
       AND type = 'self_uninstall'
       AND status IN ('pending', 'sent')
       AND uninstall_reasons @> ARRAY[${UNINSTALL_REASON_DEVICE_REMOVE}]::text[]
       AND device_remove_expires_at > now()
     LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  return Array.isArray(rows) && rows.length > 0;
}

export async function purgeRemovedDevice(tx: Tx, deviceId: string): Promise<PurgeResult> {
  const row = await lockDevice(tx, deviceId);
  if (await hasPendingDeviceRemoveUninstall(tx, deviceId)) {
    throw new DeviceLifecycleError(
      'UNINSTALL_PENDING',
      'An agent uninstall is still queued for this device. Wait for it to check in, or restore the device and remove it again choosing "Leave the agent installed".',
    );
  }
  await deleteDeviceCascade(tx, deviceId);
  let linkGroupDissolved = false;
  if (row.link_group_id) {
    linkGroupDissolved = await dissolveLinkGroupIfBelowMinimum(tx, row.link_group_id);
  }
  return { linkGroupDissolved };
}
```

(Unused imports `and, arrayContains, gt, inArray, deviceCommands` — remove them; the raw SQL form is used so the `@>` and `now()` predicates match `isDeviceUninstallDraining` exactly.)

- [ ] **Step 4: Run — expect PASS** (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/deviceLifecycle.ts apps/api/src/services/deviceLifecycle.test.ts
git commit -m "feat(api): deviceLifecycle service — lock-first restore/purge, refuse purge on pending uninstall (#2787)"
```

---

### Task 2: Single routes become thin wrappers; drop the fire-and-forget uninstall

**Files:**
- Modify: `apps/api/src/routes/devices/core.ts:1631-1729` (restore) and `:1731-1908` (permanent)
- Test: `apps/api/src/routes/devices/cascadeDelete.test.ts` (behaviour half), `apps/api/src/routes/devices/core.permissions.test.ts` (unchanged, must stay green)

- [ ] **Step 1: Write the failing tests** (append to `cascadeDelete.test.ts` behaviour describe; the file already mocks `../../db`, auth, `deviceLinkGroups`, `agentWs`, and rigs `db.select` for `getDeviceWithOrgAndSiteCheck`)

```ts
vi.mock('../../services/deviceLifecycle', () => ({
  purgeRemovedDevice: vi.fn(),
  restoreRemovedDevice: vi.fn(),
  DeviceLifecycleError: class DeviceLifecycleError extends Error {
    constructor(public code: string, message: string) { super(message); }
    get status() { return this.code === 'NOT_FOUND' ? 404 : 409; }
  },
}));
import { purgeRemovedDevice, DeviceLifecycleError } from '../../services/deviceLifecycle';
import { sendCommandToAgent } from '../agentWs';

it('DELETE /:id/permanent delegates to purgeRemovedDevice and never fires a WS uninstall', async () => {
  rigDeviceLookup({ ...DECOMMISSIONED_DEVICE, agentId: 'agent-1' });
  vi.mocked(purgeRemovedDevice).mockResolvedValue({ linkGroupDissolved: false });
  const res = await app.request(`/devices/${DECOMMISSIONED_DEVICE.id}/permanent`, { method: 'DELETE', headers: { Authorization: 'Bearer t' } });
  expect(res.status).toBe(200);
  expect(purgeRemovedDevice).toHaveBeenCalledTimes(1);
  expect(sendCommandToAgent).not.toHaveBeenCalled();
});

it('DELETE /:id/permanent maps UNINSTALL_PENDING to 409 with the code in the body', async () => {
  rigDeviceLookup(DECOMMISSIONED_DEVICE);
  vi.mocked(purgeRemovedDevice).mockRejectedValue(new DeviceLifecycleError('UNINSTALL_PENDING', 'queued'));
  const res = await app.request(`/devices/${DECOMMISSIONED_DEVICE.id}/permanent`, { method: 'DELETE', headers: { Authorization: 'Bearer t' } });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'UNINSTALL_PENDING' });
});

it('DELETE /:id/permanent maps NOT_REMOVED (lost race with Restore) to 409', async () => {
  rigDeviceLookup(DECOMMISSIONED_DEVICE);
  vi.mocked(purgeRemovedDevice).mockRejectedValue(new DeviceLifecycleError('NOT_REMOVED', 'restored'));
  const res = await app.request(`/devices/${DECOMMISSIONED_DEVICE.id}/permanent`, { method: 'DELETE', headers: { Authorization: 'Bearer t' } });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'NOT_REMOVED' });
});
```

Use the file's existing decommissioned fixture name if it differs from `DECOMMISSIONED_DEVICE`.

- [ ] **Step 2: Run — expect FAIL**

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts
```

- [ ] **Step 3: Implement**

Restore route body (keep auth/lookup/400 pre-checks — the pre-check gives a friendly 400 for the common case; the service re-checks under lock for the race):
```ts
    let result: Awaited<ReturnType<typeof restoreRemovedDevice>>;
    try {
      result = await db.transaction((tx) => restoreRemovedDevice(tx, deviceId));
    } catch (err) {
      if (err instanceof DeviceLifecycleError) {
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      throw err;
    }
    writeRouteAudit(c, { orgId: device.orgId, action: 'device.restore', resourceType: 'device', resourceId: deviceId, resourceName: result.device.hostname ?? device.hostname, details: { uninstallAlreadyDispatched: result.uninstallAlreadyDispatched } });
    return c.json({ success: true, device: stripSensitiveDeviceFields(result.device), uninstallAlreadyDispatched: result.uninstallAlreadyDispatched });
```

Permanent route: delete the `uninstallSent` block (lines 1752-1765) and the `isAgentConnected`/`sendCommandToAgent`/`CommandTypes` usages it needed (remove the imports if now unused). Replace the `db.transaction(...)` body with:
```ts
    let linkGroupDissolved = false;
    try {
      const r = await db.transaction((tx) => purgeRemovedDevice(tx, deviceId));
      linkGroupDissolved = r.linkGroupDissolved;
    } catch (err: unknown) {
      if (err instanceof DeviceLifecycleError) {
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      const pgCode = pgErrorCode(err);
      if (pgCode === '23503') { /* keep existing branch, drop every `uninstallSent` clause */ }
      if (pgCode === '55P03') { /* keep existing branch, drop `uninstallSent` clause */ }
      console.error(`[devices] unhandled ${pgCode ?? 'non-postgres'} error during cascade delete of ${deviceId}`, err);
      throw err;
    }
```
Audit details drop `uninstallCommandSent`; response becomes `{ success: true }` (drop `agentUninstallSent` and the `warning` — the durable queue on Remove replaced it; the new refusal is the honest signal). Keep the `invalidateOrgDeviceCount` block.

- [ ] **Step 4: Run — expect PASS.** Then the neighbours: `npx vitest run src/routes/devices/core.permissions.test.ts src/routes/devices/core.decommission.test.ts src/routes/devices/cascadeDelete.test.ts` — all PASS (cascadeDelete's static half binds `CORE_DEVICE_CASCADE_DELETE_TABLES`; untouched).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/core.ts apps/api/src/routes/devices/cascadeDelete.test.ts
git commit -m "refactor(api): single restore/permanent-delete routes delegate to deviceLifecycle; drop WS fire-and-forget uninstall (#2787)"
```

---

### Task 3: Integration suite — the races, against real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/deviceLifecycle.integration.test.ts`

Model setup on `deviceUninstallDrain.integration.test.ts` (same dir: it creates partner/org/site/device via the integration db-utils and runs inside `withSystemDbAccessContext`).

- [ ] **Step 1: Write the tests**

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { queueDeviceUninstall } from '../../services/deviceUninstallDrain';
import { purgeRemovedDevice, restoreRemovedDevice, DeviceLifecycleError } from '../../services/deviceLifecycle';
// import the same fixture helpers deviceUninstallDrain.integration.test.ts uses (createTestOrg / createTestDevice / cleanup)

describe('deviceLifecycle (integration)', () => {
  // …beforeAll: create org + decommissioned device `devId`; afterAll: cleanup…

  it('purge refuses while a device_remove uninstall is pending, and the device row survives', async () => {
    await withSystemDbAccessContext(() => db.transaction((tx) => queueDeviceUninstall(tx, devId, null)));
    await expect(
      withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, devId))),
    ).rejects.toMatchObject({ code: 'UNINSTALL_PENDING' });
    const [row] = await withSystemDbAccessContext(() => db.execute(sql`SELECT id FROM devices WHERE id = ${devId}`)) as unknown as Array<{ id: string }>;
    expect(row?.id).toBe(devId);
  });

  it('purge racing restore: whichever commits second sees the other and does not double-act', async () => {
    // Restore first on connection A, then purge on connection B — purge must fail NOT_REMOVED.
    await withSystemDbAccessContext(() => db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE device_commands SET status='cancelled' WHERE device_id=${devId}`); // clear the pending uninstall from the previous test
      await restoreRemovedDevice(tx, devId);
    }));
    await expect(
      withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, devId))),
    ).rejects.toMatchObject({ code: 'NOT_REMOVED' });
    const [row] = await withSystemDbAccessContext(() => db.execute(sql`SELECT status FROM devices WHERE id = ${devId}`)) as unknown as Array<{ status: string }>;
    expect(row.status).toBe('offline');
  });

  it('purge succeeds on a removed device with no pending uninstall and removes the row', async () => {
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE devices SET status='decommissioned' WHERE id=${devId}`));
    await withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, devId)));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT id FROM devices WHERE id = ${devId}`)) as unknown as unknown[];
    expect(rows.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run against the local integration DB** (needs `DATABASE_URL`; see `vitest.integration.config.ts`)

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceLifecycle.integration.test.ts
```
Expected: 3 PASS. If the fixture helper names differ, read the sibling suite and use its helpers — do not hand-roll inserts.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/deviceLifecycle.integration.test.ts
git commit -m "test(api): deviceLifecycle integration — purge refuses pending uninstall, loses cleanly to restore (#2787)"
```

---

### Task 4: `POST /devices/bulk/restore` (synchronous, isolated per item)

**Files:**
- Create: `apps/api/src/routes/devices/bulkLifecycle.ts`
- Create: `apps/api/src/routes/devices/bulkLifecycle.test.ts`
- Create: `apps/api/src/routes/devices/bulkLifecycle.mountorder.test.ts`
- Modify: `apps/api/src/routes/devices/schemas.ts` (add `bulkDeviceIdsSchema`)
- Modify: `apps/api/src/routes/devices/index.ts` (mount before core)
- Modify: `apps/api/src/middleware/selfManagedDbContextRoutes.ts:30` + `.test.ts` MATCH/NO_MATCH arrays
- Modify: `apps/api/src/routes/devices/core.permissions.test.ts:367` lifecycle matrix

**Interfaces:**
- Produces: `POST /api/v1/devices/bulk/restore { deviceIds: string[] }` → `200 { succeeded: Array<{ deviceId: string; uninstallAlreadyDispatched: boolean }>, failed: Array<{ deviceId: string; code: 'NOT_FOUND' | 'NOT_REMOVED' | 'UNINSTALL_PENDING' | 'SITE_ACCESS_DENIED' | 'ERROR'; message: string }> }`.
- `export const bulkDeviceIdsSchema = z.object({ deviceIds: z.array(z.string().guid()).min(1).max(500) })` in `schemas.ts`.

- [ ] **Step 1: Write the failing tests**

`bulkLifecycle.test.ts` — mocks mirror `core.decommission.test.ts` (`../../db`, `../../middleware/auth`, `../../services/auditEvents`) plus:
```ts
vi.mock('../../services/deviceLifecycle', () => ({ restoreRemovedDevice: vi.fn(), purgeRemovedDevice: vi.fn(), DeviceLifecycleError: class extends Error { constructor(public code: string, m: string) { super(m); } get status() { return this.code === 'NOT_FOUND' ? 404 : 409; } } }));
vi.mock('./helpers', async (orig) => ({ ...(await orig<typeof import('./helpers')>()), getDeviceWithOrgAndSiteCheck: vi.fn() }));
```
Cases:
1. `restores every accessible removed device and reports per-device outcomes` — 3 ids: one restored (`uninstallAlreadyDispatched: false`), one throws `NOT_REMOVED`, one where `getDeviceWithOrgAndSiteCheck` returns `null` → expect `succeeded.length === 1`, `failed` has `{code:'NOT_REMOVED'}` and `{code:'NOT_FOUND'}`, status 200.
2. `rejects > 500 ids with 400` — body of 501 guids.
3. `dedupes repeated ids` — same id twice → `restoreRemovedDevice` called once.
4. `runs each item outside the request transaction` — assert `runOutsideDbContext` mock was called once and `withDbAccessContext` called once per unique id (that is what `runBulkIsolated` does; this pins that the route uses it and not a bare loop).

`bulkLifecycle.mountorder.test.ts` — copy `links.mountorder.test.ts` wholesale, change the request to `POST /devices/bulk/restore` with `{ deviceIds: [ORG_A_DEVICE] }`, assert `status !== 404` and `status !== 400` (core's `/:id/restore` would 404 "Device not found" for the literal id `bulk`).

`selfManagedDbContextRoutes.test.ts` — add to MATCH: `['POST', '/api/v1/devices/bulk/restore']`; to NO_MATCH: `['POST', '/api/v1/devices/bulk/restore/extra', 'extra segment must not match']`, `['POST', '/api/v1/devices/11111111-1111-4111-8111-111111111111/restore', 'single restore keeps ambient tx']`.

`core.permissions.test.ts` — add `['POST', '/devices/bulk/restore']` to `lifecyclePaths` with body `{ deviceIds: [ACCESSIBLE_DEVICE.id] }` (the loop sends no body today; extend it to send JSON for POSTs).

- [ ] **Step 2: Run all four — expect FAIL**

```bash
cd apps/api && npx vitest run src/routes/devices/bulkLifecycle src/middleware/selfManagedDbContextRoutes.test.ts src/routes/devices/core.permissions.test.ts
```

- [ ] **Step 3: Implement**

`schemas.ts`:
```ts
export const BULK_LIFECYCLE_MAX_DEVICES = 500;
export const bulkDeviceIdsSchema = z.object({
  deviceIds: z.array(z.string().guid()).min(1).max(BULK_LIFECYCLE_MAX_DEVICES),
});
```

`selfManagedDbContextRoutes.ts` — add:
```ts
  // #2787 bulk restore: one short RLS transaction per device via runBulkIsolated.
  // Holding the request tx across up to 500 restores would pin one connection
  // and every devices/device_commands lock until the last item finished.
  { method: 'POST', pattern: /^\/api\/v1\/devices\/bulk\/restore\/?$/ },
```

`bulkLifecycle.ts`:
```ts
import { Hono } from 'hono';
import { db } from '../../db';
import { zValidator } from '../../lib/validation';
import { runBulkIsolated } from '../../lib/bulkOps';
import { authMiddleware, requireScope, requirePermission, requireMfa, dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { restoreRemovedDevice, DeviceLifecycleError } from '../../services/deviceLifecycle';
import { bulkDeviceIdsSchema } from './schemas';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const bulkLifecycleRoutes = new Hono();
bulkLifecycleRoutes.use('*', authMiddleware);

type FailCode = 'NOT_FOUND' | 'NOT_REMOVED' | 'UNINSTALL_PENDING' | 'SITE_ACCESS_DENIED' | 'ERROR';
interface BulkFailed { deviceId: string; code: FailCode; message: string }

/**
 * POST /devices/bulk/restore — restore up to 500 removed devices (#2787).
 *
 * Synchronous: a restore is two small writes. Each device runs in its OWN
 * short RLS transaction via runBulkIsolated (this route is listed in
 * selfManagedDbContextRoutes, so no ambient request tx is held across the
 * loop). Authorisation goes through the same getDeviceWithOrgAndSiteCheck
 * chokepoint as the single route; the service re-checks state under lock.
 *
 * Static path — mounted before coreRoutes so `/:id/restore` can't eat it.
 */
bulkLifecycleRoutes.post(
  '/bulk/restore',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  zValidator('json', bulkDeviceIdsSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const ids = [...new Set(c.req.valid('json').deviceIds)];
    const ctx = dbAccessContextFromAuth(auth);
    const succeeded: Array<{ deviceId: string; uninstallAlreadyDispatched: boolean }> = [];
    const failed: BulkFailed[] = [];

    await runBulkIsolated(ctx, ids, async (deviceId) => {
      const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
      if (device === SITE_ACCESS_DENIED) { failed.push({ deviceId, code: 'SITE_ACCESS_DENIED', message: 'Access to this site denied' }); return; }
      if (!device) { failed.push({ deviceId, code: 'NOT_FOUND', message: 'Device not found' }); return; }
      try {
        const r = await db.transaction((tx) => restoreRemovedDevice(tx, deviceId));
        succeeded.push({ deviceId, uninstallAlreadyDispatched: r.uninstallAlreadyDispatched });
        writeRouteAudit(c, { orgId: device.orgId, action: 'device.restore', resourceType: 'device', resourceId: deviceId, resourceName: r.device.hostname ?? device.hostname, details: { uninstallAlreadyDispatched: r.uninstallAlreadyDispatched, bulk: true } });
      } catch (err) {
        if (err instanceof DeviceLifecycleError) { failed.push({ deviceId, code: err.code, message: err.message }); return; }
        console.error(`[devices] bulk restore failed for ${deviceId}:`, err);
        failed.push({ deviceId, code: 'ERROR', message: 'Restore failed' });
      }
    });

    return c.json({ succeeded, failed });
  },
);
```
(`runBulkIsolated` counts thrown errors; we swallow inside `perItem` and keep our own per-device arrays — the `BulkResult` return is ignored on purpose because the web needs per-device ids, not counts.)

`index.ts` — import `bulkLifecycleRoutes` and mount directly before `coreRoutes` with the standard "static path before `/:id`" comment.

- [ ] **Step 4: Run all four — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/bulkLifecycle.ts apps/api/src/routes/devices/bulkLifecycle.test.ts apps/api/src/routes/devices/bulkLifecycle.mountorder.test.ts apps/api/src/routes/devices/schemas.ts apps/api/src/routes/devices/index.ts apps/api/src/middleware/selfManagedDbContextRoutes.ts apps/api/src/middleware/selfManagedDbContextRoutes.test.ts apps/api/src/routes/devices/core.permissions.test.ts
git commit -m "feat(api): POST /devices/bulk/restore — per-item isolated bulk restore (#2787)"
```

---

### Task 5: Bulk purge — BullMQ job + `POST /bulk/permanent-delete` (202) + `GET /bulk/purge-runs/:jobId`

**Files:**
- Create: `apps/api/src/jobs/deviceBulkPurge.ts`
- Create: `apps/api/src/jobs/deviceBulkPurge.test.ts`
- Modify: `apps/api/src/routes/devices/bulkLifecycle.ts` (two more routes)
- Modify: `apps/api/src/routes/devices/bulkLifecycle.test.ts`, `bulkLifecycle.mountorder.test.ts`, `core.permissions.test.ts`
- Modify: `apps/api/src/services/workerRegistry.ts:~533` (register after `orgMerge`)

**Interfaces:**
- Produces:
  ```ts
  // jobs/deviceBulkPurge.ts
  export interface DeviceBulkPurgeJobPayload {
    jobId: string;                                  // uuid, also the BullMQ jobId suffix
    targets: Array<{ deviceId: string; orgId: string; hostname: string }>;
    actorUserId: string;
    actorEmail?: string;
    partnerId: string | null;                       // for status-route ownership check
  }
  export interface DeviceBulkPurgeResult {
    purged: string[];
    skipped: Array<{ deviceId: string; code: 'NOT_FOUND' | 'NOT_REMOVED' | 'UNINSTALL_PENDING' | 'ORG_CHANGED' | 'ERROR' }>;
  }
  export function getDeviceBulkPurgeQueue(): Queue
  export async function enqueueDeviceBulkPurge(payload: DeviceBulkPurgeJobPayload): Promise<{ id: string }>
  export function createDeviceBulkPurgeWorker(): Worker
  export async function initializeDeviceBulkPurgeWorker(): Promise<void>
  export async function shutdownDeviceBulkPurgeWorker(): Promise<void>
  ```
  - `POST /api/v1/devices/bulk/permanent-delete { deviceIds[] }` → `202 { jobId, accepted: number, rejected: Array<{ deviceId; code; message }> }` (up-front cheap checks: access, `status='decommissioned'`; a pending uninstall is NOT pre-checked here — the worker refuses it under lock, keeping one source of truth). If `accepted === 0` → `409 { error, rejected }` and no job.
  - `GET /api/v1/devices/bulk/purge-runs/:jobId` → `200 { state, progress: { done: number; total: number }, result: DeviceBulkPurgeResult | null, failedReason: string | null }`; 404 for unknown or other-partner jobs.

- [ ] **Step 1: Write the failing tests**

`jobs/deviceBulkPurge.test.ts` (mock `bullmq` `Queue`/`Worker` like `abuseSignalsSweep.test.ts:19` does; mock `../db` with `withSystemDbAccessContext: (fn) => fn()`, `runOutsideDbContext: (fn) => fn()`, `db.transaction: (fn) => fn(fakeTx)`; mock `../services/deviceLifecycle`, `../services/auditService`, `../services/agentOrgRateLimit`):
1. `skips a device whose org changed after enqueue (ORG_CHANGED) and never calls purgeRemovedDevice for it` — fakeTx.execute for the lock returns `{ id, status:'decommissioned', org_id:'other-org' }`.
2. `maps a DeviceLifecycleError to its code in skipped` — `purgeRemovedDevice` rejects `UNINSTALL_PENDING`.
3. `writes one device.permanent_delete audit row per purged device carrying bulkJobId, and invalidates the org device count once per org`.
4. `reports progress after every device` — `job.updateProgress` called `targets.length` times with `{ done, total }`.
5. `enqueue uses jobId device-bulk-purge-<uuid>`.

`bulkLifecycle.test.ts` additions:
6. `POST /bulk/permanent-delete pre-rejects a non-removed device and enqueues only the removed ones` → 202, `accepted: 1`, `rejected: [{ code: 'NOT_REMOVED' }]`, `enqueueDeviceBulkPurge` called with `targets.length === 1` and `partnerId: auth.partnerId`.
7. `POST /bulk/permanent-delete returns 409 and enqueues nothing when every device is rejected`.
8. `GET /bulk/purge-runs/:jobId returns 404 for another partner's job` — mock `getDeviceBulkPurgeQueue().getJob` → `{ data: { partnerId: 'other' }, getState: async () => 'active', progress: {done:1,total:3}, returnvalue: null, failedReason: null }` with `auth.scope = 'partner', partnerId = 'mine'`.
9. `GET /bulk/purge-runs/:jobId returns state + progress + result for the owner`.

`mountorder.test.ts`: add `POST /devices/bulk/permanent-delete` and `GET /devices/bulk/purge-runs/x` cases (not 404/400 from core).

`core.permissions.test.ts`: add `['POST', '/devices/bulk/permanent-delete']` to the lifecycle matrix (devices:delete + MFA).

- [ ] **Step 2: Run — expect FAIL**

```bash
cd apps/api && npx vitest run src/jobs/deviceBulkPurge.test.ts src/routes/devices/bulkLifecycle src/routes/devices/core.permissions.test.ts
```

- [ ] **Step 3: Implement the job**

```ts
// apps/api/src/jobs/deviceBulkPurge.ts
/**
 * Bulk permanent delete of REMOVED devices (#2787).
 *
 * Async on purpose: deleteDeviceCascade touches ~40 tables per device; 500 of
 * them inside one request would pin a pooled connection for minutes under the
 * request transaction (auth.ts wraps every handler in one) and one bad row
 * would abort them all. The route validates cheaply, enqueues, returns 202; the
 * web polls GET /devices/bulk/purge-runs/:jobId.
 *
 * Authorisation is re-derived per device under lock: the payload carries the
 * org each device belonged to when the operator confirmed. A device moved to
 * another org (or restored) between confirm and execution is SKIPPED, never
 * deleted under stale authorisation. Runs in a system DB context — the cascade
 * needs to see tables a tenant context deliberately hides (deviceDeletion.ts).
 *
 * Module shape mirrors jobs/orgMerge.ts (lazy Queue/Worker singletons,
 * enqueueOrReplaceStale, attempts: 1 — a retry could re-run a half-finished
 * purge list against devices whose state has moved on).
 */
import { Queue, Worker, type Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { captureException } from '../services/sentry';
import { getBullMQConnection, getRedis } from '../services/redis';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import { createAuditLog } from '../services/auditService';
import { invalidateOrgDeviceCount } from '../services/agentOrgRateLimit';
import { purgeRemovedDevice, DeviceLifecycleError } from '../services/deviceLifecycle';

const QUEUE_NAME = 'device-bulk-purge';
const JOB_NAME = 'device-bulk-purge';
export const DEVICE_BULK_PURGE_MAX_TARGETS = 500;

export interface DeviceBulkPurgeJobPayload {
  jobId: string;
  targets: Array<{ deviceId: string; orgId: string; hostname: string }>;
  actorUserId: string;
  actorEmail?: string;
  partnerId: string | null;
}

export type BulkPurgeSkipCode = 'NOT_FOUND' | 'NOT_REMOVED' | 'UNINSTALL_PENDING' | 'ORG_CHANGED' | 'ERROR';
export interface DeviceBulkPurgeResult {
  purged: string[];
  skipped: Array<{ deviceId: string; code: BulkPurgeSkipCode }>;
}

let purgeQueue: Queue | null = null;
let purgeWorker: Worker | null = null;

export function getDeviceBulkPurgeQueue(): Queue {
  if (!purgeQueue) purgeQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return purgeQueue;
}

export async function enqueueDeviceBulkPurge(payload: DeviceBulkPurgeJobPayload): Promise<{ id: string }> {
  return enqueueOrReplaceStale(
    getDeviceBulkPurgeQueue(), JOB_NAME, `device-bulk-purge-${payload.jobId}`, payload,
    { attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
    '[DeviceBulkPurge]',
  );
}

async function purgeOne(target: DeviceBulkPurgeJobPayload['targets'][number], payload: DeviceBulkPurgeJobPayload): Promise<BulkPurgeSkipCode | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
    // Lock + re-derive authorisation from CURRENT state before the service's
    // own lock-and-check (a second FOR UPDATE on the same row in the same tx
    // is a no-op).
    const rows = (await tx.execute(sql`SELECT org_id FROM devices WHERE id = ${target.deviceId} FOR UPDATE`)) as unknown as Array<{ org_id: string }>;
    if (!rows[0]) return 'NOT_FOUND';
    if (rows[0].org_id !== target.orgId) return 'ORG_CHANGED';
    try {
      await purgeRemovedDevice(tx, target.deviceId);
      return null;
    } catch (err) {
      if (err instanceof DeviceLifecycleError) return err.code;
      throw err;
    }
  })));
}

export function createDeviceBulkPurgeWorker(): Worker {
  return new Worker(QUEUE_NAME, async (job: Job<DeviceBulkPurgeJobPayload>) => {
    if (job.name !== JOB_NAME) return { skipped: true };
    const payload = job.data;
    const targets = payload.targets.slice(0, DEVICE_BULK_PURGE_MAX_TARGETS);
    const result: DeviceBulkPurgeResult = { purged: [], skipped: [] };
    const touchedOrgs = new Set<string>();

    for (const [i, target] of targets.entries()) {
      let code: BulkPurgeSkipCode | null;
      try {
        code = await purgeOne(target, payload);
      } catch (err) {
        console.error(`[DeviceBulkPurge] ${payload.jobId}: unexpected error purging ${target.deviceId}:`, err);
        captureException(err);
        code = 'ERROR';
      }
      if (code) {
        result.skipped.push({ deviceId: target.deviceId, code });
      } else {
        result.purged.push(target.deviceId);
        touchedOrgs.add(target.orgId);
        try {
          await createAuditLog({
            orgId: target.orgId, actorType: 'user', actorId: payload.actorUserId, actorEmail: payload.actorEmail,
            action: 'device.permanent_delete', resourceType: 'device', resourceId: target.deviceId, resourceName: target.hostname,
            details: { bulkJobId: payload.jobId }, result: 'success',
          });
        } catch (err) { console.error('[DeviceBulkPurge] audit write failed:', err); }
      }
      await job.updateProgress({ done: i + 1, total: targets.length });
    }

    for (const orgId of touchedOrgs) {
      try { void invalidateOrgDeviceCount(getRedis(), orgId); } catch (err) { console.error('[DeviceBulkPurge] device-count cache invalidation failed', err); }
    }
    return result;
  }, { connection: getBullMQConnection(), concurrency: 1 });
}

export async function initializeDeviceBulkPurgeWorker(): Promise<void> {
  purgeWorker = createDeviceBulkPurgeWorker();
  purgeWorker.on('error', (error) => { console.error('[DeviceBulkPurge] Worker error:', error); captureException(error); });
  purgeWorker.on('failed', (job, error) => { console.error(`[DeviceBulkPurge] Job ${job?.id} failed:`, error); captureException(error); });
}

export async function shutdownDeviceBulkPurgeWorker(): Promise<void> {
  if (purgeWorker) { await purgeWorker.close(); purgeWorker = null; }
  if (purgeQueue) { await purgeQueue.close(); purgeQueue = null; }
}
```

`workerRegistry.ts` — add directly after the `orgMerge` entry:
```ts
  {
    // #2787: async bulk permanent delete of removed devices.
    name: 'deviceBulkPurge',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/deviceBulkPurge');
      return { init: m.initializeDeviceBulkPurgeWorker, shutdown: m.shutdownDeviceBulkPurgeWorker };
    },
  },
```
(If `workerRegistry` has a closure-contract test asserting placement, run it and pick the placement it demands; `deviceLifecycle` → `deviceDeletion` does not import `agentWs`, so `'plain'`/default placement may be correct — the test decides.)

- [ ] **Step 4: Implement the two routes** (append to `bulkLifecycle.ts`)

```ts
import { randomUUID } from 'crypto';
import { enqueueDeviceBulkPurge, getDeviceBulkPurgeQueue, type DeviceBulkPurgeJobPayload, type DeviceBulkPurgeResult } from '../../jobs/deviceBulkPurge';

bulkLifecycleRoutes.post(
  '/bulk/permanent-delete',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  zValidator('json', bulkDeviceIdsSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const ids = [...new Set(c.req.valid('json').deviceIds)];
    const targets: DeviceBulkPurgeJobPayload['targets'] = [];
    const rejected: BulkFailed[] = [];
    for (const deviceId of ids) {
      const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
      if (device === SITE_ACCESS_DENIED) { rejected.push({ deviceId, code: 'SITE_ACCESS_DENIED', message: 'Access to this site denied' }); continue; }
      if (!device) { rejected.push({ deviceId, code: 'NOT_FOUND', message: 'Device not found' }); continue; }
      if (device.status !== 'decommissioned') { rejected.push({ deviceId, code: 'NOT_REMOVED', message: 'Device must be removed before permanent deletion' }); continue; }
      targets.push({ deviceId, orgId: device.orgId, hostname: device.hostname ?? device.displayName ?? deviceId });
    }
    if (targets.length === 0) {
      return c.json({ error: 'No selected device can be permanently deleted', rejected }, 409);
    }
    const jobId = randomUUID();
    await enqueueDeviceBulkPurge({ jobId, targets, actorUserId: auth.user.id, actorEmail: auth.user.email, partnerId: auth.partnerId ?? null });
    writeRouteAudit(c, { orgId: targets[0].orgId, action: 'device.bulk_permanent_delete.enqueued', resourceType: 'device_bulk_purge', resourceId: jobId, details: { accepted: targets.length, rejected: rejected.length, orgIds: [...new Set(targets.map(t => t.orgId))] } });
    return c.json({ jobId, accepted: targets.length, rejected }, 202);
  },
);

bulkLifecycleRoutes.get(
  '/bulk/purge-runs/:jobId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const jobId = c.req.param('jobId')!;
    const job = await getDeviceBulkPurgeQueue().getJob(`device-bulk-purge-${jobId}`);
    if (!job) return c.json({ error: 'Purge run not found' }, 404);
    const payload = job.data as DeviceBulkPurgeJobPayload | undefined;
    // jobId is a UUID the caller was handed, but a partner-scope caller must
    // still be denied another partner's run (mirror routes/orgMerge.ts:246).
    // Org-scope callers: every target org must be accessible.
    if (auth.scope === 'partner' && payload?.partnerId !== auth.partnerId) return c.json({ error: 'Purge run not found' }, 404);
    if (auth.scope === 'organization' && payload && !payload.targets.every(t => auth.canAccessOrg(t.orgId))) return c.json({ error: 'Purge run not found' }, 404);
    const state = await job.getState();
    const progress = (job.progress as { done: number; total: number } | number) ;
    return c.json({
      state,
      progress: typeof progress === 'object' ? progress : { done: 0, total: payload?.targets.length ?? 0 },
      result: (job.returnvalue as DeviceBulkPurgeResult | null) ?? null,
      failedReason: job.failedReason ?? null,
    });
  },
);
```

- [ ] **Step 5: Run — expect PASS** on all four files. Run `npx vitest run src/services/workerRegistry` (whatever tests exist) — PASS.

- [ ] **Step 6: Integration case for the worker** — append to `deviceLifecycle.integration.test.ts`:
```ts
it('bulk purge worker skips a device whose org changed after enqueue', async () => {
  // create removed device in org A; build payload with orgId = A; move the device to org B via UPDATE; run createDeviceBulkPurgeWorker()'s processor directly by importing the module and calling the processor function extracted for tests (export `processDeviceBulkPurgeJob(job)` from the job module and have the Worker call it).
  // assert result.skipped contains { code: 'ORG_CHANGED' } and the device row still exists.
});
```
Export `processDeviceBulkPurgeJob` from the job module (the Worker callback becomes `(job) => processDeviceBulkPurgeJob(job)`) so the integration test can drive it without Redis. Run the integration file — 4 PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/deviceBulkPurge.ts apps/api/src/jobs/deviceBulkPurge.test.ts apps/api/src/routes/devices/bulkLifecycle.ts apps/api/src/routes/devices/bulkLifecycle.test.ts apps/api/src/routes/devices/bulkLifecycle.mountorder.test.ts apps/api/src/routes/devices/core.permissions.test.ts apps/api/src/services/workerRegistry.ts apps/api/src/__tests__/integration/deviceLifecycle.integration.test.ts
git commit -m "feat(api): async bulk permanent delete — BullMQ job, 202 enqueue route, purge-run status (#2787)"
```

---

### Task 6: Web service functions

**Files:**
- Modify: `apps/web/src/services/deviceActions.ts`
- Test: `apps/web/src/services/deviceActions.test.ts`

**Interfaces:**
```ts
export interface BulkRestoreResult { succeeded: Array<{ deviceId: string; uninstallAlreadyDispatched: boolean }>; failed: Array<{ deviceId: string; code: string; message: string }> }
export async function bulkRestoreDevices(deviceIds: string[]): Promise<BulkRestoreResult>
export interface BulkPurgeStart { jobId: string; accepted: number; rejected: Array<{ deviceId: string; code: string; message: string }> }
export async function startBulkPurge(deviceIds: string[]): Promise<BulkPurgeStart>
export interface PurgeRun { state: string; progress: { done: number; total: number }; result: { purged: string[]; skipped: Array<{ deviceId: string; code: string }> } | null; failedReason: string | null }
export async function fetchPurgeRun(jobId: string): Promise<PurgeRun>
export const PURGE_POLL_INTERVAL_MS = 2000;
```

- [ ] **Step 1: Tests** — one per function asserting path, method, JSON body, and that a non-OK response throws with the API's `error` message (`getErrorMessage`). `startBulkPurge` on 409 must throw with the message and attach `rejected` (use a subclass `BulkPurgeRejectedError extends Error { rejected }`).
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** following `restoreDevice`'s shape (`fetchWithAuth`, `getErrorMessage`). **Step 4: PASS.**
- [ ] **Step 5: Commit** `feat(web): bulk restore / bulk purge service calls (#2787)`.

---

### Task 7: Gating — third classification set + contract test

**Files:**
- Modify: `apps/web/src/components/devices/bulkActionGating.ts`
- Modify: `apps/web/src/components/devices/DeviceList.test.tsx:1340-1385`

**Interfaces:**
```ts
export const REMOVED_ONLY_BULK_ACTIONS: ReadonlySet<string> = new Set(['restore', 'permanent-delete']);
export type BulkSelectionKind = 'active' | 'removed' | 'mixed';
export function classifyBulkSelection(statuses: readonly string[]): BulkSelectionKind
```

- [ ] **Step 1: Tests** (extend the existing describe at :1340; it renders the bulk menu and enumerates emitted actions via `emittedBulkActions()`)
```ts
it('classifies every emitted action into exactly one of the three sets', () => {
  const all = [...emittedBulkActions(), ...emittedBulkActionsForRemovedSelection()];
  for (const a of new Set(all)) {
    const n = [DECOMMISSION_BLOCKED_BULK_ACTIONS, INTENTIONALLY_UNGATED_BULK_ACTIONS, REMOVED_ONLY_BULK_ACTIONS].filter(s => s.has(a)).length;
    expect(n, `${a} is in ${n} sets`).toBe(1);
  }
});
it('an all-removed selection emits ONLY removed-only actions (+ compare)', () => {
  const emitted = emittedBulkActionsForRemovedSelection(); // render 3 decommissioned devices, select all, open menu, click every item, collect action names
  expect(emitted.sort()).toEqual(['compare', 'permanent-delete', 'restore']);
});
it('an active selection never emits a removed-only action', () => {
  expect(emittedBulkActions().some(a => REMOVED_ONLY_BULK_ACTIONS.has(a))).toBe(false);
});
it('classifyBulkSelection', () => {
  expect(classifyBulkSelection(['online', 'offline'])).toBe('active');
  expect(classifyBulkSelection(['decommissioned'])).toBe('removed');
  expect(classifyBulkSelection(['online', 'decommissioned'])).toBe('mixed');
});
```
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** in `bulkActionGating.ts` (doc comment: why a third set — removed-only actions are the inverse gate; the contract test forces classification so a new bulk button cannot be silently ungated). `classifyBulkSelection`: all `decommissioned` → `'removed'`; none → `'active'`; else `'mixed'`. The menu rendering itself lands in Task 8, so `emittedBulkActionsForRemovedSelection` will only pass after Task 8 — mark the two rendering tests `it.todo` here and un-todo them in Task 8, keeping the set/classify tests green now.
- [ ] **Step 4: PASS.** **Step 5: Commit** `feat(web): REMOVED_ONLY_BULK_ACTIONS + classifyBulkSelection (#2787)`.

---

### Task 8: DeviceList bulk bar is selection-aware

**Files:**
- Modify: `apps/web/src/components/devices/DeviceList.tsx:2056-2160`
- Modify: `apps/web/src/components/devices/DeviceList.test.tsx` (un-todo Task 7's rendering tests)
- Modify: `apps/web/src/locales/*/devices.json` — `deviceList.restoreSelected: "Restore Selected"`, `deviceList.permanentDeleteSelected: "Delete permanently…"`.

- [ ] **Step 1: Un-todo the tests; run — FAIL.**
- [ ] **Step 2: Implement.** Compute once above the JSX:
```ts
  const selectionKind = classifyBulkSelection(
    devices.filter(d => selectedIds.has(d.id)).map(d => d.status),
  );
```
Inside `bulk-actions-menu`, wrap the existing items in `{selectionKind !== 'removed' && (<>…all current buttons…</>)}` and add, for `selectionKind === 'removed'`:
```tsx
                {selectionKind === 'removed' && (
                  <>
                    <button type="button" data-testid="bulk-restore" onClick={() => handleBulkAction('restore')} className="w-full px-4 py-2 text-left text-sm text-success hover:bg-success/10">
                      {t('deviceList.restoreSelected')}
                    </button>
                    {selectedIds.size >= 2 && selectedIds.size <= 4 && (
                      <button type="button" data-testid="bulk-compare" onClick={() => handleBulkAction('compare')} className="w-full px-4 py-2 text-left text-sm hover:bg-muted">
                        {t('deviceList.compareSelected')}
                      </button>
                    )}
                    <hr className="my-1" />
                    <button type="button" data-testid="bulk-permanent-delete" onClick={() => handleBulkAction('permanent-delete')} className="w-full px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10">
                      {t('deviceList.permanentDeleteSelected')}
                    </button>
                  </>
                )}
```
Keep the `compare` item out of the active-branch duplicate (it already exists there). Add `data-testid="bulk-decommission"` to the existing Remove Selected button if absent (DevicesPage.test references it).
- [ ] **Step 3: PASS** (`npx vitest run src/components/devices/DeviceList.test.tsx`, plus `localeParity`).
- [ ] **Step 4: Commit** `feat(web): bulk bar offers only Restore / Delete permanently for a removed selection (#2787)`.

---

### Task 9: DevicesPage — bulk restore handler, `BulkPurgeDialog`, purge-run polling

**Files:**
- Create: `apps/web/src/components/devices/BulkPurgeDialog.tsx` + `.test.tsx`
- Modify: `apps/web/src/components/devices/DevicesPage.tsx` (`runBulkAction` switch, new state, JSX)
- Test: `apps/web/src/components/devices/DevicesPage.test.tsx`
- Locales: `devicesPage.bulkPurge.*`, `devicesPage.toasts.bulkRestored`, `bulkRestoreSomeFailed`, `bulkRestoreAllFailed`, `bulkRestoreUninstallAlreadySent`, `bulkPurgeStarted`, `bulkPurgeProgress`, `bulkPurgeDone`, `bulkPurgeDoneWithSkips`, `bulkPurgeFailed`.

**Interfaces:**
```ts
export interface BulkPurgeDialogProps {
  open: boolean;
  targets: Array<{ hostname: string; orgId?: string | null }>;
  onClose: () => void;
  onConfirm: () => void;
  isLoading?: boolean;
}
```
Renders `ConfirmDialog` with purge copy; children: bounded target list (first 5 hostnames + "and N more"), org count when > 1, and a text input `data-testid="bulk-purge-count"`; **Confirm disabled until input === String(targets.length)**. `ConfirmDialog` has no `confirmDisabled` prop — add one (`confirmDisabled?: boolean`, applied to the confirm button alongside `isLoading`), with a one-line test in `ConfirmDialog.test.tsx`.

- [ ] **Step 1: Tests**
  - `BulkPurgeDialog.test.tsx`: confirm disabled until the exact count is typed; shows "and 3 more" for 8 targets; `onConfirm` fires only after typing.
  - `DevicesPage.test.tsx`: (a) all-removed selection → Restore Selected → `bulkRestoreDevices` called with the 3 ids → success toast; (b) Delete permanently → dialog → type `3` → confirm → `startBulkPurge` called → `fetchPurgeRun` polled with fake timers until `state: 'completed'` → done toast + `fetchDevices` refetch; (c) a `startBulkPurge` 409 shows the error toast and does not poll.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement**
  - `runBulkAction`: add
    ```ts
        case 'restore': {
          const r = await bulkRestoreDevices(deviceIds);
          const dispatched = r.succeeded.filter(s => s.uninstallAlreadyDispatched).length;
          if (r.failed.length === 0) showToast({ type: 'success', message: t('devicesPage.toasts.bulkRestored', { count: r.succeeded.length }) });
          else if (r.succeeded.length === 0) showToast({ type: 'error', message: t('devicesPage.toasts.bulkRestoreAllFailed', { count: r.failed.length }) });
          else showToast({ type: 'error', message: t('devicesPage.toasts.bulkRestoreSomeFailed', { succeeded: r.succeeded.length, failed: r.failed.length }) });
          if (dispatched > 0) showToast({ type: 'warning', message: t('devicesPage.toasts.bulkRestoreUninstallAlreadySent', { count: dispatched }) });
          await fetchDevices();
          break;
        }
        case 'permanent-delete': {
          // Prune to rows still present in the current fetch (selection persists across filters).
          const present = new Set(devices.map(d => d.id));
          setPendingBulkPurge(selectedDevices.filter(d => present.has(d.id)));
          return;
        }
    ```
  - New state `pendingBulkPurge: Device[] | null`; `runBulkPurge(targets)` calls `startBulkPurge`, toasts `bulkPurgeStarted`, then polls `fetchPurgeRun(jobId)` every `PURGE_POLL_INTERVAL_MS` (pattern: `MergeOrgModal.tsx:209` — token ref to drop stale polls, stop on `completed`/`failed`, unmount-safe). On `completed`: `bulkPurgeDone` (or `bulkPurgeDoneWithSkips` with the skip count grouped by code) + `fetchDevices()`. On `failed`: `bulkPurgeFailed` with `failedReason`.
  - JSX: `<BulkPurgeDialog open targets=… onClose=… onConfirm={() => { const t = pendingBulkPurge; setPendingBulkPurge(null); void runBulkPurge(t); }} />`.
  - `handleBulkAction`: the network-row filter and the `DECOMMISSION_BLOCKED` gate are untouched; `restore`/`permanent-delete` fall through to `runBulkAction` (they are only emitted for an all-removed selection, so the mixed-selection confirm never triggers for them — pinned by Task 7's rendering test).
- [ ] **Step 4: PASS** — whole `DevicesPage.test.tsx`, `BulkPurgeDialog.test.tsx`, `ConfirmDialog.test.tsx`, `localeParity`, `keyUsage`, `no-silent-mutations`.
- [ ] **Step 5: Commit** `feat(web): bulk Restore + async bulk Delete permanently with type-the-count confirm (#2787)`.

---

### Task 10: PR

- [ ] `cd apps/api && npx vitest run src/routes/devices src/services/deviceLifecycle.test.ts src/jobs/deviceBulkPurge.test.ts src/middleware/selfManagedDbContextRoutes.test.ts` — green. Integration: `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceLifecycle.integration.test.ts src/__tests__/integration/deviceUninstallDrain.integration.test.ts` — green. `cd apps/web && npx vitest run src/components/devices src/services src/lib/i18n` — green. `pnpm lint`; tsc on both apps.
- [ ] Merge `origin/main` first. Bring up the worktree stack (`worktree-stack` skill) and walk: select 8 removed devices → menu shows only Restore / Delete permanently / Compare → Restore 2 → Delete permanently 6 with typed count → progress toast → rows gone. Screenshot both.
- [ ] Open PR `feat: bulk restore + async bulk permanent delete for removed devices; harden single lifecycle routes (#2787)`. Body: the two latent defects (TOCTOU, lock order) and how the service fixes them; the pending-uninstall refusal decision; why purge is async; the three gating sets. `Closes #2787. Refs #3987`. Stop at the PR.
