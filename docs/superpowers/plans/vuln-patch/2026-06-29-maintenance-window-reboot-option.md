# Maintenance Window Reboot-If-Pending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-policy maintenance-window option that automatically reboots a device during an active window when that device has a pending reboot.

**Architecture:** One new inline boolean (`rebootIfPending`) on the `maintenance` config-policy feature (Pattern B — no new table), plus a new BullMQ repeatable worker (`maintenanceRebootWorker`) that provides the "tick" maintenance windows lack. Each tick the worker finds online devices with `pending_reboot=true`, and for any whose effective maintenance policy is in an active window with `rebootIfPending` on, issues a reboot (warn-then-reboot on Windows, OS-scheduled reboot on Linux). Reboot issuance reuses the existing `queueCommandForExecution` / `schedule_reboot` / `reboot` machinery.

**Tech Stack:** TypeScript, Hono, Drizzle ORM (Postgres), BullMQ/Redis, Vitest, React/Astro (web).

## Global Constraints

- **Platforms:** Windows + Linux only. macOS is never rebooted (the agent always reports `pendingReboot=false` on macOS).
- **Grace period:** fixed at 5 minutes — single constant `MAINTENANCE_REBOOT_GRACE_MINUTES = 5`. No policy knob.
- **Worker cadence:** repeatable every 10 minutes (`repeat: { every: 10 * 60_000 }`).
- **Reboot commands:** Windows → `schedule_reboot { delayMinutes: 5, reason: 'Pending reboot — maintenance window', source: 'maintenance_window' }`; Linux → `reboot { delay: 5 }`.
- **Migrations:** idempotent (`ADD COLUMN IF NOT EXISTS`), date-prefixed `YYYY-MM-DD-<slug>.sql`, NO inner `BEGIN;`/`COMMIT;`, never edit a shipped migration.
- **DB context:** worker runs under `withSystemDbAccessContext`; use a short system context per device (do not hold one pooled connection across the whole candidate set). Never use the bare pool in request code.
- **Online safety:** `queueCommandForExecution` already returns `{ error }` and inserts **no** command row when `device.status !== 'online'` — so no reboot can be queued for delivery after the device reconnects outside the window. The worker also pre-filters to `status='online'`.
- **Attribution:** worker issues commands with no `userId` → `createdBy: null`, attributed as `system`.
- **Commit trailer:** end every commit message with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Data model — `rebootIfPending` column + decompose/assemble

Add the inline setting end-to-end on the API side. `inlineSettings` is validated generically (`z.record(z.string(), z.unknown())`) in `packages/shared`, so **no shared-validator change is needed** — normalization happens in the decompose step. The genuine gate for this task is schema/migration drift + typecheck; the field's behavior is exercised functionally by Task 2 (worker reads `settings.rebootIfPending`) and Task 4 (UI sends it).

**Files:**
- Create: `apps/api/migrations/2026-06-29-maintenance-reboot-if-pending.sql`
- Modify: `apps/api/src/db/schema/configurationPolicies.ts` (`configPolicyMaintenanceSettings`, after the `suppressScripts` line, ~205)
- Modify: `apps/api/src/services/configurationPolicy.ts` (decompose `case 'maintenance'` ~391; assemble `case 'maintenance'` ~717)

**Interfaces:**
- Produces: `configPolicyMaintenanceSettings.rebootIfPending` (boolean column, default false). After this task, `resolveMaintenanceConfigForDevice(deviceId)` returns a row whose `.rebootIfPending` is a `boolean`. Task 2 consumes `settings.rebootIfPending`.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-29-maintenance-reboot-if-pending.sql`:

```sql
-- Maintenance window: reboot devices with a pending reboot while the window is active.
-- Additive boolean on the existing maintenance-settings table (config policy Pattern B).
ALTER TABLE config_policy_maintenance_settings
  ADD COLUMN IF NOT EXISTS reboot_if_pending boolean NOT NULL DEFAULT false;
```

- [ ] **Step 2: Add the Drizzle column**

In `apps/api/src/db/schema/configurationPolicies.ts`, in `configPolicyMaintenanceSettings`, add immediately after the `suppressScripts` line:

```ts
  rebootIfPending: boolean('reboot_if_pending').notNull().default(false),
```

- [ ] **Step 3: Decompose the field on write**

In `apps/api/src/services/configurationPolicy.ts`, in the `case 'maintenance':` decompose block (`tx.insert(configPolicyMaintenanceSettings).values({ ... })`), add after the `suppressScripts` line:

```ts
        rebootIfPending: typeof s.rebootIfPending === 'boolean' ? s.rebootIfPending : false,
```

- [ ] **Step 4: Assemble the field on read**

In the same file, in the `case 'maintenance':` assemble block (the `return { ... }` after selecting the row), add:

```ts
        rebootIfPending: row.rebootIfPending,
```

- [ ] **Step 5: Verify drift + types**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter @breeze/api exec tsc --noEmit
pnpm db:check-drift
```
Expected: tsc passes with no errors; `db:check-drift` reports no drift (schema matches the new migration).

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-06-29-maintenance-reboot-if-pending.sql \
        apps/api/src/db/schema/configurationPolicies.ts \
        apps/api/src/services/configurationPolicy.ts
git commit -m "feat(config-policy): add maintenance rebootIfPending setting

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `maintenanceRebootWorker` (decision logic + sweep)

The core feature. A pure decision function holds all the branching (easy to test exhaustively); thin DB-backed helpers do the I/O; the sweep ties them together under a per-device system context.

**Files:**
- Create: `apps/api/src/jobs/maintenanceRebootWorker.ts`
- Create: `apps/api/src/jobs/maintenanceRebootWorker.test.ts`

**Interfaces:**
- Consumes (from Task 1): `resolveMaintenanceConfigForDevice(deviceId)` returns a row with `.rebootIfPending: boolean`.
- Consumes (existing): `isInMaintenanceWindow(settings)` → `{ active: boolean, ... }` (`apps/api/src/services/featureConfigResolver.ts`); `queueCommandForExecution(deviceId, type, payload, { expectedOrgId })` → `{ command?, error? }` (`apps/api/src/services/commandQueue.ts`).
- Produces: `decideRebootCommand(params)`, `getRebootCandidates()`, `hasRecentRebootCommand(deviceId)`, `processRebootCandidate(device, deps?)`, `runMaintenanceRebootSweep()`, `MAINTENANCE_REBOOT_GRACE_MINUTES`, `initializeMaintenanceRebootWorker()`, `shutdownMaintenanceRebootWorker()`. Task 3 consumes the last two.

- [ ] **Step 1: Write the failing test for the pure decision function**

Create `apps/api/src/jobs/maintenanceRebootWorker.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
// Mock the service modules so the test does not drag the websocket / resolver
// import chains into a DB-less unit run. processRebootCandidate is tested with
// injected deps; decideRebootCommand is pure (defined in the worker module).
vi.mock('../services/commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('../services/featureConfigResolver', () => ({
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));

import {
  decideRebootCommand,
  processRebootCandidate,
  MAINTENANCE_REBOOT_GRACE_MINUTES,
} from './maintenanceRebootWorker';

describe('decideRebootCommand', () => {
  it('returns null when rebootIfPending is false', () => {
    expect(decideRebootCommand({ rebootIfPending: false, windowActive: true, osType: 'windows' })).toBeNull();
  });

  it('returns null when the window is not active', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: false, osType: 'windows' })).toBeNull();
  });

  it('returns null on macOS even when active and enabled', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'macos' })).toBeNull();
  });

  it('issues schedule_reboot with a 5-minute grace on Windows', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'windows' })).toEqual({
      type: 'schedule_reboot',
      payload: {
        delayMinutes: MAINTENANCE_REBOOT_GRACE_MINUTES,
        reason: 'Pending reboot — maintenance window',
        source: 'maintenance_window',
      },
    });
  });

  it('issues a delayed reboot on Linux', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'linux' })).toEqual({
      type: 'reboot',
      payload: { delay: MAINTENANCE_REBOOT_GRACE_MINUTES },
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/jobs/maintenanceRebootWorker.test.ts`
Expected: FAIL — cannot import `decideRebootCommand` (module/file does not exist yet).

- [ ] **Step 3: Write the worker module**

Create `apps/api/src/jobs/maintenanceRebootWorker.ts`:

```ts
/**
 * Maintenance Reboot Worker
 *
 * Maintenance windows are pull-based — nothing fires when a window opens. This
 * repeatable worker is the tick: every 10 minutes it finds online devices that
 * have a pending reboot, and for any whose effective maintenance policy is in an
 * active window with `rebootIfPending` enabled, it issues a reboot.
 *
 * Windows gets the rich warn-then-reboot manager (schedule_reboot: staged toasts
 * + circuit-breaker). Linux gets an OS-scheduled reboot (`shutdown -r +5`, which
 * broadcasts a wall warning) because the warn-then-reboot manager is Windows-only.
 * macOS is never rebooted — the agent cannot detect a pending reboot there.
 */

import { Worker, Queue, Job } from 'bullmq';
import * as dbModule from '../db';
import { devices, deviceCommands } from '../db/schema';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import {
  resolveMaintenanceConfigForDevice,
  isInMaintenanceWindow,
} from '../services/featureConfigResolver';
import { queueCommandForExecution } from '../services/commandQueue';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const REBOOT_QUEUE = 'maintenance-reboot';
export const MAINTENANCE_REBOOT_GRACE_MINUTES = 5;
const DEDUP_WINDOW_MINUTES = 60;
const REBOOT_COMMAND_TYPES = ['reboot', 'schedule_reboot', 'reboot_safe_mode'];

type SweepJobData = { type: 'sweep' };

export type RebootCandidate = {
  id: string;
  orgId: string;
  osType: 'windows' | 'macos' | 'linux';
};

export type RebootDecision = { type: string; payload: Record<string, unknown> } | null;

// ── Pure decision logic ──────────────────────────────────────────────────────

export function decideRebootCommand(params: {
  rebootIfPending: boolean;
  windowActive: boolean;
  osType: 'windows' | 'macos' | 'linux';
}): RebootDecision {
  const { rebootIfPending, windowActive, osType } = params;
  if (!rebootIfPending || !windowActive) return null;
  if (osType === 'windows') {
    return {
      type: 'schedule_reboot',
      payload: {
        delayMinutes: MAINTENANCE_REBOOT_GRACE_MINUTES,
        reason: 'Pending reboot — maintenance window',
        source: 'maintenance_window',
      },
    };
  }
  if (osType === 'linux') {
    return { type: 'reboot', payload: { delay: MAINTENANCE_REBOOT_GRACE_MINUTES } };
  }
  return null; // macOS / unknown — never rebooted
}

// ── DB-backed helpers ────────────────────────────────────────────────────────

export async function getRebootCandidates(): Promise<RebootCandidate[]> {
  const rows = await db
    .select({ id: devices.id, orgId: devices.orgId, osType: devices.osType })
    .from(devices)
    .where(
      and(
        eq(devices.pendingReboot, true),
        eq(devices.status, 'online'),
        inArray(devices.osType, ['windows', 'linux']),
      ),
    );
  return rows as RebootCandidate[];
}

export async function hasRecentRebootCommand(deviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        inArray(deviceCommands.type, REBOOT_COMMAND_TYPES),
        inArray(deviceCommands.status, ['pending', 'sent']),
        gt(deviceCommands.createdAt, sql`now() - (${DEDUP_WINDOW_MINUTES} * interval '1 minute')`),
      ),
    )
    .limit(1);
  return !!row;
}

// ── Per-device processing (deps injectable for testing) ──────────────────────

export async function processRebootCandidate(
  device: RebootCandidate,
  deps = {
    resolveMaintenanceConfigForDevice,
    isInMaintenanceWindow,
    hasRecentRebootCommand,
    queueCommandForExecution,
  },
): Promise<{ issued: boolean; reason: string }> {
  const settings = await deps.resolveMaintenanceConfigForDevice(device.id);
  if (!settings) return { issued: false, reason: 'no-maintenance-policy' };

  const windowActive = deps.isInMaintenanceWindow(settings).active;
  const decision = decideRebootCommand({
    rebootIfPending: settings.rebootIfPending,
    windowActive,
    osType: device.osType,
  });
  if (!decision) return { issued: false, reason: 'no-action' };

  if (await deps.hasRecentRebootCommand(device.id)) {
    return { issued: false, reason: 'recent-reboot-command' };
  }

  const result = await deps.queueCommandForExecution(device.id, decision.type, decision.payload, {
    expectedOrgId: device.orgId,
  });
  if (result.error) {
    console.warn(`[MaintenanceReboot] device ${device.id}: ${result.error}`);
    return { issued: false, reason: result.error };
  }
  console.log(`[MaintenanceReboot] issued ${decision.type} to device ${device.id} (${device.osType})`);
  return { issued: true, reason: 'issued' };
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export async function runMaintenanceRebootSweep(): Promise<{ issued: number; checked: number }> {
  const candidates = await runWithSystemDbAccess(() => getRebootCandidates());
  let issued = 0;
  for (const device of candidates) {
    try {
      const res = await runWithSystemDbAccess(() => processRebootCandidate(device));
      if (res.issued) issued++;
    } catch (err) {
      console.error(`[MaintenanceReboot] error processing device ${device.id}:`, err);
    }
  }
  if (candidates.length > 0) {
    console.log(`[MaintenanceReboot] sweep: ${issued}/${candidates.length} reboot(s) issued`);
  }
  return { issued, checked: candidates.length };
}

// ── Queue / Worker / Lifecycle (mirrors backupSlaWorker.ts) ──────────────────

let rebootQueue: Queue | null = null;
function getRebootQueue(): Queue {
  if (!rebootQueue) {
    rebootQueue = new Queue(REBOOT_QUEUE, { connection: getBullMQConnection() });
  }
  return rebootQueue;
}

function createRebootWorker(): Worker<SweepJobData> {
  return new Worker<SweepJobData>(
    REBOOT_QUEUE,
    async (_job: Job<SweepJobData>) => runMaintenanceRebootSweep(),
    { connection: getBullMQConnection(), concurrency: 1, lockDuration: 120_000 },
  );
}

let rebootWorkerInstance: Worker<SweepJobData> | null = null;

export async function initializeMaintenanceRebootWorker(): Promise<void> {
  try {
    rebootWorkerInstance = createRebootWorker();
    attachWorkerObservability(rebootWorkerInstance, 'maintenanceRebootWorker');

    rebootWorkerInstance.on('error', (error) => {
      console.error('[MaintenanceReboot] Worker error:', error);
    });
    rebootWorkerInstance.on('failed', (job, error) => {
      console.error(`[MaintenanceReboot] Job ${job?.id} failed:`, error);
    });

    const queue = getRebootQueue();
    const sweepJob = await queue.add(
      'sweep',
      { type: 'sweep' as const },
      {
        repeat: { every: 10 * 60_000 },
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 20 },
      },
    );

    const repeatable = await queue.getRepeatableJobs();
    for (const job of repeatable) {
      if (job.name === 'sweep' && job.key !== sweepJob.repeatJobKey) {
        await queue.removeRepeatableByKey(job.key);
      }
    }

    console.log('[MaintenanceReboot] Maintenance reboot worker initialized');
  } catch (error) {
    console.error('[MaintenanceReboot] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownMaintenanceRebootWorker(): Promise<void> {
  if (rebootWorkerInstance) {
    await rebootWorkerInstance.close();
    rebootWorkerInstance = null;
  }
  if (rebootQueue) {
    await rebootQueue.close();
    rebootQueue = null;
  }
  console.log('[MaintenanceReboot] Maintenance reboot worker shut down');
}
```

- [ ] **Step 4: Run the pure-function tests and confirm they pass**

Run: `pnpm --filter @breeze/api exec vitest run src/jobs/maintenanceRebootWorker.test.ts`
Expected: the 5 `decideRebootCommand` tests PASS.

- [ ] **Step 5: Add orchestration tests for `processRebootCandidate`**

Append to `apps/api/src/jobs/maintenanceRebootWorker.test.ts`:

```ts
describe('processRebootCandidate', () => {
  const winDevice = { id: 'dev-1', orgId: 'org-1', osType: 'windows' as const };

  function makeDeps(overrides: Partial<Parameters<typeof processRebootCandidate>[1]> = {}) {
    return {
      resolveMaintenanceConfigForDevice: vi.fn().mockResolvedValue({ rebootIfPending: true }),
      isInMaintenanceWindow: vi.fn().mockReturnValue({ active: true }),
      hasRecentRebootCommand: vi.fn().mockResolvedValue(false),
      queueCommandForExecution: vi.fn().mockResolvedValue({ command: { id: 'cmd-1' } }),
      ...overrides,
    } as unknown as Parameters<typeof processRebootCandidate>[1];
  }

  it('issues the decided command and passes expectedOrgId', async () => {
    const deps = makeDeps();
    const res = await processRebootCandidate(winDevice, deps);
    expect(res.issued).toBe(true);
    expect(deps.queueCommandForExecution).toHaveBeenCalledWith(
      'dev-1',
      'schedule_reboot',
      expect.objectContaining({ delayMinutes: 5, source: 'maintenance_window' }),
      { expectedOrgId: 'org-1' },
    );
  });

  it('skips when no maintenance policy applies', async () => {
    const deps = makeDeps({
      resolveMaintenanceConfigForDevice: vi.fn().mockResolvedValue(null),
    } as never);
    const res = await processRebootCandidate(winDevice, deps);
    expect(res).toEqual({ issued: false, reason: 'no-maintenance-policy' });
    expect(deps.queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('skips (dedup) when a recent reboot command exists', async () => {
    const deps = makeDeps({
      hasRecentRebootCommand: vi.fn().mockResolvedValue(true),
    } as never);
    const res = await processRebootCandidate(winDevice, deps);
    expect(res).toEqual({ issued: false, reason: 'recent-reboot-command' });
    expect(deps.queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('does not issue when the device is offline (queue returns error)', async () => {
    const deps = makeDeps({
      queueCommandForExecution: vi.fn().mockResolvedValue({ error: 'Device is offline, cannot execute command' }),
    } as never);
    const res = await processRebootCandidate(winDevice, deps);
    expect(res.issued).toBe(false);
  });
});
```

- [ ] **Step 6: Run all worker tests and confirm they pass**

Run: `pnpm --filter @breeze/api exec vitest run src/jobs/maintenanceRebootWorker.test.ts`
Expected: all `decideRebootCommand` and `processRebootCandidate` tests PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/jobs/maintenanceRebootWorker.ts apps/api/src/jobs/maintenanceRebootWorker.test.ts
git commit -m "feat(jobs): maintenance reboot worker for pending reboots

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Register the worker in the server bootstrap

Wire init/shutdown into the worker registry so the repeatable job actually runs.

**Files:**
- Modify: `apps/api/src/index.ts` (import near the other `initialize*Worker` imports ~line 213; registry entry + shutdown wiring)

**Interfaces:**
- Consumes (Task 2): `initializeMaintenanceRebootWorker`, `shutdownMaintenanceRebootWorker`.

- [ ] **Step 1: Add the import**

In `apps/api/src/index.ts`, alongside the other job-worker imports (e.g. just after the `patchSchedulerWorker` import, ~line 213):

```ts
import { initializeMaintenanceRebootWorker, shutdownMaintenanceRebootWorker } from './jobs/maintenanceRebootWorker';
```

- [ ] **Step 2: Register init + shutdown**

Find how the existing workers are registered/torn down in `index.ts` (grep for `initializePatchSchedulerWorker` and `shutdownPatchSchedulerWorker`) and add `initializeMaintenanceRebootWorker` / `shutdownMaintenanceRebootWorker` in the exact same place and style (registry array entry or direct call, plus the matching shutdown). Run:

```bash
grep -n "PatchSchedulerWorker" apps/api/src/index.ts
```

Mirror both the init-side and shutdown-side usages you find for `PatchSchedulerWorker`.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(jobs): register maintenance reboot worker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Web — `rebootIfPending` toggle in MaintenanceTab

Expose the option in the config-policy UI, following the existing inline-settings + `ToggleRow` pattern.

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MaintenanceTab.tsx`
- Create: `apps/web/src/components/configurationPolicies/featureTabs/MaintenanceTab.test.tsx`

**Interfaces:**
- Consumes: existing `useFeatureLink(policyId).save(linkId, { featureType, featurePolicyId, inlineSettings })`, `ToggleRow` (local), `FeatureTabProps`.
- Produces: `inlineSettings.rebootIfPending` in the save payload (consumed by the API decompose from Task 1).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/configurationPolicies/featureTabs/MaintenanceTab.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MaintenanceTab from './MaintenanceTab';

const saveMock = vi.fn();
const removeMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: undefined,
    clearError: clearErrorMock,
  }),
}));

describe('MaintenanceTab — rebootIfPending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'maintenance',
      featurePolicyId: null,
      inlineSettings: {},
    });
  });

  it('renders the reboot-if-pending toggle', () => {
    render(
      <MaintenanceTab policyId="policy-1" existingLink={undefined} linkedPolicyId={null} onLinkChanged={vi.fn()} />,
    );
    expect(screen.getByText(/Reboot if a reboot is pending/i)).toBeTruthy();
  });

  it('defaults rebootIfPending to false in the save payload', async () => {
    render(
      <MaintenanceTab policyId="policy-1" existingLink={undefined} linkedPolicyId={null} onLinkChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0] as [string | null, { inlineSettings: Record<string, unknown> }];
    expect(payload.inlineSettings.rebootIfPending).toBe(false);
  });

  it('reflects an existing rebootIfPending value and keeps it on save', async () => {
    render(
      <MaintenanceTab
        policyId="policy-1"
        existingLink={{ id: 'link-1', featureType: 'maintenance', featurePolicyId: null, inlineSettings: { rebootIfPending: true } } as never}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0] as [string | null, { inlineSettings: Record<string, unknown> }];
    expect(payload.inlineSettings.rebootIfPending).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/configurationPolicies/featureTabs/MaintenanceTab.test.tsx`
Expected: FAIL — the toggle text is not found / `rebootIfPending` missing from payload.

- [ ] **Step 3: Add the field to the settings type + defaults**

In `MaintenanceTab.tsx`, in the `MaintenanceSettings` type add (after `suppressScripts`):

```ts
  rebootIfPending: boolean;
```

In the `defaults` object add (after `suppressScripts: false,`):

```ts
  rebootIfPending: false,
```

- [ ] **Step 4: Render the toggle**

In `MaintenanceTab.tsx`, add a new section immediately before the `{/* Notification toggles */}` block:

```tsx
      {/* Actions during window */}
      <div className="mt-6 space-y-3">
        <h3 className="text-sm font-semibold">Actions During Window</h3>
        <ToggleRow
          label="Reboot if a reboot is pending"
          description="During the window, reboot devices that have a pending reboot. Windows shows a countdown warning; Linux reboots via the OS with a warning to signed-in users. macOS is not supported."
          checked={settings.rebootIfPending}
          onChange={(v) => update('rebootIfPending', v)}
        />
      </div>
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/configurationPolicies/featureTabs/MaintenanceTab.test.tsx`
Expected: all 3 tests PASS.

- [ ] **Step 6: Typecheck the web app**

Run: `pnpm --filter @breeze/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/MaintenanceTab.tsx \
        apps/web/src/components/configurationPolicies/featureTabs/MaintenanceTab.test.tsx
git commit -m "feat(web): maintenance window reboot-if-pending toggle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final Verification

- [ ] **Run the full API + web test suites for the touched packages**

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/maintenanceRebootWorker.test.ts
pnpm --filter @breeze/web exec vitest run src/components/configurationPolicies/featureTabs/MaintenanceTab.test.tsx
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/web exec tsc --noEmit
```
Expected: all pass, no type errors.

- [ ] **Manual sanity (optional, real DB):** add a maintenance feature link with `rebootIfPending: true` and a window that is currently active (e.g. `recurrence: 'daily'`, large `durationHours`) to a policy assigned to a Windows device that is online with `pending_reboot=true`; confirm the next worker tick (≤10 min) issues a `schedule_reboot` and the device receives the countdown.

## Notes / Known Limitations (from the spec)

- macOS is unsupported because the agent always reports `pendingReboot=false` there.
- Linux uses an OS-scheduled `shutdown -r +5` (wall warning) rather than the rich Windows toasts, because the agent's warn-then-reboot *manager* is Windows-only. Richer Linux UX is a separate agent change.
- Offline devices never get a queued reboot: `queueCommandForExecution` refuses (and inserts no row) when `device.status !== 'online'`, and the worker also pre-filters to online devices — so a reboot cannot be delivered after the window via a stale pending command.
- The dedup guard (no `reboot`/`schedule_reboot`/`reboot_safe_mode` in `pending`/`sent` within 60 min) plus the agent's per-day circuit-breaker prevent re-issuing and reboot loops, and prevent colliding with a patch-job reboot.
