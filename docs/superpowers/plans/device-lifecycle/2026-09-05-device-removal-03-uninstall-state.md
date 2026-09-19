---
tracking_issue: LanternOps/breeze#5023
---
# Device Removal 03 — Pending-Uninstall State on a Removed Device Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A removed device tells the operator what happened to its queued agent uninstall — queued (with deadline), delivered, expired, cancelled, or none — so "did the agent actually come off?" has an answer on screen.

**Architecture:** `GET /devices/:id` derives an `uninstall` object from the newest `self_uninstall` row carrying the `device_remove` reason, read only after the device authorisation chokepoint (device_commands is intentionally unscoped). The web renders it as a badge beside the Removed status on the detail page and as a line in the Removed panel of `DeviceSettingsModal`.

**Tech Stack:** Hono + Drizzle (API); React + react-i18next (web).

**Spec:** `docs/superpowers/specs/device-lifecycle/2026-09-05-device-removal-completion-design.md` (PR 3). Issue: #3987 item 7 (final item — PR closes #3987).

## Global Constraints

- Read `device_commands` ONLY after `getDeviceWithOrgAndSiteCheck` has authorised the device (`device_commands` has no RLS — memory: intentionally system-scoped).
- `sent` means dispatched and acked by the agent's handler, NOT confirmed torn down (`core.ts` restore doc). Label it "delivered", never "uninstalled".
- Reaper expiry lands as `status='failed'`, `result.status='timeout'` (`jobs/staleCommandReaper.ts:313`). Map that to `expired`; any other `failed` → `failed`.
- `cancelled` = `status='cancelled'` (what `releaseDeviceRemoveReason` sets when Restore cancels it).
- Rows lacking the `device_remove` reason (tenant-offboarding, abuse suspension) are NOT this device's Remove — ignore them here.
- No schema change. Locale keys → all 8 locales.

---

### Task 1: API — derive `uninstall` on `GET /devices/:id`

**Files:**
- Create: `apps/api/src/services/deviceUninstallState.ts` + `.test.ts`
- Modify: `apps/api/src/routes/devices/core.ts:995-1140` (detail route; add one call + one response key)
- Test: `apps/api/src/routes/devices/core.uninstallState.test.ts` (new; mocks mirror `core.decommission.test.ts`)

**Interfaces:**
```ts
export type DeviceUninstallState = 'pending' | 'sent' | 'completed' | 'expired' | 'failed' | 'cancelled';
export interface DeviceUninstallStatus {
  state: DeviceUninstallState;
  queuedAt: string;            // ISO
  sentAt: string | null;       // executed_at
  completedAt: string | null;
  expiresAt: string | null;    // device_remove_expires_at
}
/** Newest self_uninstall row carrying the device_remove reason, or null. Caller MUST have authorised the device. */
export async function getDeviceUninstallStatus(deviceId: string): Promise<DeviceUninstallStatus | null>
```
Response: `GET /devices/:id` body gains `uninstall: DeviceUninstallStatus | null`.

- [ ] **Step 1: Service tests** (compiled-SQL style: mock `../db` `db.select` chain to return a scripted row; assert the mapping)
```ts
const base = { id: 'c1', status: 'pending', createdAt: new Date('2026-09-05T10:00:00Z'), executedAt: null, completedAt: null, result: null, deviceRemoveExpiresAt: new Date('2026-09-08T10:00:00Z') };
it('maps pending', …) → state 'pending', expiresAt '2026-09-08T10:00:00.000Z'
it('maps sent → sent with sentAt', …)
it('maps failed+timeout → expired', { status: 'failed', result: { status: 'timeout' } })
it('maps failed without timeout → failed')
it('maps cancelled', …) ; it('maps completed', …)
it('returns null when no device_remove row exists')
```
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement**
```ts
import { and, arrayContains, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { deviceCommands } from '../db/schema';
import { UNINSTALL_REASON_DEVICE_REMOVE } from './deviceUninstallDrain';

export async function getDeviceUninstallStatus(deviceId: string): Promise<DeviceUninstallStatus | null> {
  const [row] = await db
    .select({ status: deviceCommands.status, createdAt: deviceCommands.createdAt, executedAt: deviceCommands.executedAt, completedAt: deviceCommands.completedAt, result: deviceCommands.result, expiresAt: deviceCommands.deviceRemoveExpiresAt })
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'self_uninstall'), arrayContains(deviceCommands.uninstallReasons, [UNINSTALL_REASON_DEVICE_REMOVE])))
    .orderBy(desc(deviceCommands.createdAt))
    .limit(1);
  if (!row) return null;
  const timedOut = row.status === 'failed' && (row.result as { status?: string } | null)?.status === 'timeout';
  const state: DeviceUninstallState =
    timedOut ? 'expired'
    : row.status === 'pending' || row.status === 'sent' || row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled' ? row.status
    : 'failed';
  return { state, queuedAt: row.createdAt.toISOString(), sentAt: row.executedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null, expiresAt: row.expiresAt?.toISOString() ?? null };
}
```
- [ ] **Step 4: Route test** — `core.uninstallState.test.ts`: rig the detail route's lookups (copy the mock scaffold from `core.decommission.test.ts`; `db.select` returns the device for the chokepoint and `[]` for hardware/network/metrics/groups), mock `../../services/deviceUninstallState` → `{ state: 'pending', … }`, assert `GET /devices/:id` body has `uninstall.state === 'pending'`; second case: mock returns `null` → `uninstall: null`; third: the service is NOT called when the chokepoint returns `null` (404 path).
- [ ] **Step 5: Wire the route** — in `GET /:id` after the groups lookup: `const uninstall = device.status === 'decommissioned' ? await getDeviceUninstallStatus(deviceId) : null;` and add `uninstall,` to the `c.json({...})`. (Skipping the read for non-removed devices keeps the hot detail path unchanged.)
- [ ] **Step 6: PASS** all three files + `core.permissions.test.ts`. **Commit** `feat(api): GET /devices/:id reports pending-uninstall state for removed devices (#3987)`.

---

### Task 2: Web — badge on the detail page + line in the Removed panel

**Files:**
- Create: `apps/web/src/components/devices/UninstallStateBadge.tsx` + `.test.tsx`
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx` (next to the status pill for a `decommissioned` device — locate via `grep -n decommissioned DeviceDetails.tsx`)
- Modify: `apps/web/src/components/devices/DeviceSettingsModal.tsx:209-215` (Removed panel: add the line under `decommissionedDescription`)
- Modify: `apps/web/src/components/devices/DeviceList.tsx` `Device` type: add `uninstall?: { state: string; expiresAt: string | null; sentAt: string | null } | null`
- Locales: `devices.json` → `uninstallState.pending: "Agent uninstall queued — expires {{when}}"`, `pendingNoDeadline: "Agent uninstall queued"`, `sent: "Agent uninstall delivered"`, `completed: "Agent uninstalled"`, `expired: "Uninstall expired — the agent never checked in and may still be installed"`, `failed: "Agent uninstall failed"`, `cancelled: "Agent uninstall cancelled"`, `none: "Agent was left installed"` — all 8 locales.

**Interfaces:**
```ts
export interface UninstallStateBadgeProps { uninstall: Device['uninstall']; status: string; compact?: boolean }
```
Renders nothing unless `status === 'decommissioned'`. `uninstall === null` → `none` copy (muted). `pending` uses `formatRelativeTime(expiresAt)` from `@/lib/formatTime` (check the exact exported helper name in that module and use it) for `{{when}}`; falls back to `pendingNoDeadline` when `expiresAt` is null. Tone: `pending`/`sent` info, `completed` success, `expired`/`failed` warning, `cancelled`/`none` muted. `data-testid="uninstall-state"` with `data-state={state}`.

- [ ] **Step 1: Tests** — one render per state asserting copy and `data-state`; `returns null for a non-removed device`; `expired uses the warning tone class`.
- [ ] **Step 2: FAIL.** **Step 3: Implement** the badge; mount it in `DeviceDetails.tsx` beside the status pill, and in `DeviceSettingsModal` under the description with `compact`. DeviceSettingsModal receives `device` — the `uninstall` field arrives on the detail payload, so `DevicesPage`'s list rows won't have it; the badge renders `none` copy only when `uninstall === null` is *explicitly* present, and renders nothing when `uninstall === undefined` (list row). Pin that with a test.
- [ ] **Step 4: PASS** + `localeParity` + `keyUsage`. `npx tsc --noEmit`. **Commit** `feat(web): show agent-uninstall state on removed devices (#3987)`.

---

### Task 3: PR

- [ ] API + web suites above green; merge `origin/main` first; stack walk: remove a device with Uninstall while its agent is offline → detail shows "queued — expires in 3 days"; restore → "cancelled"; screenshot.
- [ ] PR `feat: surface agent-uninstall state on removed devices (#3987)` — `Closes #3987`. Stop at the PR.
