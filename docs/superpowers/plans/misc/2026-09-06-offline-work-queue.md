---
tracking_issue: LanternOps/breeze#5128
---

# Offline Work Queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan wave-by-wave, task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any fire-and-forget device action (script, patch install, software install, reboot, inventory refresh, …) issued against an offline device is queued with an explicit deadline, delivered on the device's next heartbeat, re-checked for eligibility at the moment of delivery, and reported honestly as "queued — device offline" until it runs, expires, or is cancelled.

**Architecture:** Deferred delivery becomes a first-class property of `device_commands`: a nullable `deliver_by` deadline and an immutable `submitted_org_id`, one enqueue seam (`dispatchDeviceCommand`) that always states an `OfflinePolicy` (`reject` | `queue`) resolved from a fail-closed per-type registry, a reaper that separates the *delivery* clock from the *execution* clock, a shared claim-time eligibility filter beneath both claim paths, and late-binding payload preparation at delivery. Delivery transport is unchanged: the agent's existing HTTP heartbeat claim. No agent change in any wave.

**Tech Stack:** Hono routes + Drizzle (`apps/api`), hand-written SQL migrations, Zod validators in `packages/shared`, BullMQ reaper/worker jobs, Astro + React islands + Vitest/jsdom (`apps/web`).

**Spec:** `docs/superpowers/specs/misc/2026-09-06-offline-work-queue-design.md` (approved 2026-09-06). Section references below (§A–§J, OD-n) point into that document.

## Global Constraints

- **`device_commands` stays intentionally system-scoped.** No RLS policy, no `CORE_ORG_CASCADE_DELETE_ORDER` entry, no `CORE_TENANT_EXPORT_POLICY` entry. `submitted_org_id` is provenance, deliberately *not* named `org_id`, so `rls-coverage.integration.test.ts` auto-discovery does not reclassify the table. Say so in the migration header verbatim.
- **Two clocks, one owner.** `pending` rows expire at `deliver_by` (legacy rows with `deliver_by IS NULL` keep today's rule). `sent` rows expire at `executed_at + getCommandTimeoutMs`. Per-feature reapers (`script_executions`, `deployment_results`) must never independently expire *undelivered* work — they learn about delivery expiry only via `propagateTimedOutDeviceCommand`.
- **Every terminal write on `device_commands` is a CAS on the observed `(status, executed_at)`.** Never `status IN ('pending','sent')` as the sole guard on an UPDATE that terminalises.
- **`waitForCommandResult` is never combined with `{ kind: 'queue' }`.** Callers that wait for a result pass `reject`.
- **Fail-closed registry.** Every value in `CommandTypes` (`apps/api/src/services/commandQueue.ts`) must appear in `COMMAND_OFFLINE_POLICY_REGISTRY`; a unit test asserts full coverage; an unregistered type throws at enqueue.
- **Feature flag `DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED`** (default `false` until W4 lands, then `true`, then removed in W5) gates the `queue` arm only for callers that used to reject (`queueCommandForExecution`, patch executor, automations). Scripts, software installs, and the generic device-command routes queue regardless of the flag, as they do today.
- **Migrations:** `apps/api/migrations/YYYY-MM-DD-HHMMSS-<slug>.sql`, idempotent, no inner `BEGIN`/`COMMIT`, never edit a shipped file, never touch the closed `2026-08-06` block. Filenames run ahead of real time: at execution time run `ls apps/api/migrations/*.sql | sort | tail -1` and name yours to sort *after* it. As of authoring the newest is `2026-10-12-100000-config-policy-inheritance.sql`, so W1 uses `2026-10-13-100000-device-commands-deliver-by.sql` and W3 uses `2026-10-13-100100-patch-offline-queue.sql`.
- **Tests:** co-located `*.test.ts`; Drizzle chain mocks match the exact chain in the source; UUIDs are real UUIDs; run one file with `cd apps/api && npx vitest run <path>` (never `pnpm test -- --run`). Integration suites (`apps/api/src/__tests__/integration/*.integration.test.ts`) need a live DB and run only in the **Integration Tests** CI job — verify in the shard log that the new file actually executed.
- **Copy:** user-facing strings go through i18n (`apps/web/src/locales/en/*.json`); the deferred-work sentence is always "Runs when the device is online — expires {{date}}" and the chip is always "Queued — device offline".

---

## Tenancy / RLS / cascade impact (read once)

| Change | Tenancy consequence |
|---|---|
| `device_commands.deliver_by`, `.submitted_org_id` | None. Table is system-scoped by design (CLAUDE.md "Intentionally system-scoped"). Already in `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts`). `submitted_org_id` FK is `ON DELETE SET NULL` so erasing an org a device *left* never trips on its old rows. |
| `patch_job_result_status` + `'queued'` | Enum add only. |
| `patch_jobs.devices_queued` | `patch_jobs` is an org-cascade table → **new column must be classified** in `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) as `included`. `tenant-export-policy.integration.test.ts` fails otherwise. |
| `config_policy_patch_settings.offline_behavior` | Table has no `org_id`/`partner_id` (tenancy is transitive via `feature_link_id`); no export-policy entry, no cascade entry. Same shape the reboot-deferral columns used. |
| Automation action `whenOffline` | Inside the existing action-config jsonb (`excludedOpen`). Validator change only. |

## CI traps for this plan

- `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts` only run under **Integration Tests**; a unit-green W3 PR can still go red there if `devices_queued` is unclassified.
- `migrationRlsScope.test.ts` inspects migrations for DML; W1/W3 migrations are DDL-only, so no `set_config('breeze.scope', …)` is needed — do not add one.
- `apps/api/src/db/autoMigrate.test.ts` asserts ordering; if another migration lands ahead of yours, rename before merge (an unmerged migration is editable).
- Stacked PRs get **no** CI (`ci.yml` triggers on `pull_request: branches: [main]`). Each wave branches from `main`, not from the previous wave.

## File structure

**W1 — create**
- `apps/api/src/services/commandOfflinePolicy.ts` — `OfflinePolicy`, TTL classes, fail-closed registry, `resolveOfflinePolicy`, `deliverByFor`, flag read.
- `apps/api/src/services/commandOfflinePolicy.test.ts`
- `apps/api/src/services/dispatchDeviceCommand.ts` — the single enqueue seam.
- `apps/api/src/services/dispatchDeviceCommand.test.ts`
- `apps/api/src/services/commandClaimEligibility.ts` — claim-time filter + power-state barrier + per-type holds.
- `apps/api/src/services/commandClaimEligibility.test.ts`
- `apps/api/migrations/2026-10-13-100000-device-commands-deliver-by.sql`
- `apps/api/src/__tests__/integration/deviceCommandOfflineQueue.integration.test.ts`

**W1 — modify**
- `apps/api/src/db/schema/devices.ts` (`deviceCommands` columns)
- `apps/api/src/services/commandQueue.ts` (`queueCommand` options; `queueCommandForExecution` → seam; `precheckCommandExecution` grace deadline)
- `apps/api/src/services/commandDispatch.ts` (claim predicates + eligibility)
- `apps/api/src/services/commandDelivery.ts` (`prepareClaimedCommandsForDelivery` with refreshers)
- `apps/api/src/jobs/staleCommandReaper.ts` (two clocks, CAS, script/software reapers)
- `apps/api/src/services/scriptDispatch.ts` (`offlinePolicy`, `requireOnline` alias)
- `apps/api/src/services/softwareDeployment.ts` (persist-before-push, `s3Key` in payload)
- `apps/api/src/routes/agentWs.ts` (software reconciliation on the generic result path)
- `apps/api/src/routes/devices/commands.ts` (bulk/single/set_auto_update via seam; cancel endpoint; `status` filter on list)
- `apps/api/src/routes/devices/moveOrg.ts`, `apps/api/src/routes/devices/core.ts` (cancel-on-event)

**W2 — create/modify:** `packages/shared/src/types/scriptAdmission.ts`, `apps/api/src/services/scriptExecution.ts`, `apps/web/src/components/devices/DeviceQueuedActions.tsx` (+test), `apps/web/src/components/devices/DeviceDetails.tsx`, `apps/web/src/components/devices/DevicesPage.tsx`, `apps/web/src/components/scripts/executionStatus.ts`, locales.

**W3 — create/modify:** migration, `apps/api/src/db/schema/patches.ts`, `configurationPolicies.ts`, `packages/shared/src/validators/index.ts` (`patchInlineSettingsSchema`), `apps/api/src/services/patchJobFinalizer.ts` (+test), `apps/api/src/jobs/patchJobExecutor.ts`, `apps/api/src/jobs/patchSchedulerWorker.ts`, `apps/api/src/services/commandResultHandlers.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, web patch settings form.

**W4:** `packages/shared/src/validators/index.ts` (`automationActionSchema`), `apps/api/src/services/automationRuntime.ts`, `apps/api/src/services/automationActionResults.ts`, automation form.

**W5:** `apps/docs/src/content/docs/features/*.mdx`, `apps/api/src/services/aiToolsScripts.ts` (+ siblings), flag removal.

**W6 (after #3985 merges):** `apps/api/src/services/commandClaimEligibility.ts` principal rehydration via the recovery-authorization-subject shape.

---

## Wave 1 — Core: deadline column, policy seam, two-clock reaper, claim eligibility, cancel

Branch: `feature/5128-offline-work-queue/wave-<subissue#>` from `main`. Everything in this wave ships behind `DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED=false` for previously-rejecting callers; scripts, software and generic commands gain the deadline immediately (they already queue today).

### Task 1.1: Schema + migration for `deliver_by` and `submitted_org_id`

**Files:**
- Modify: `apps/api/src/db/schema/devices.ts` (the `deviceCommands` table, after `deviceRemoveExpiresAt`)
- Create: `apps/api/migrations/2026-10-13-100000-device-commands-deliver-by.sql`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing — run it), `apps/api/src/db/schema/deviceCommands.columns.test.ts` (create)

**Interfaces:**
- Produces: `deviceCommands.deliverBy: Date | null`, `deviceCommands.submittedOrgId: string | null` on `typeof deviceCommands.$inferSelect`.

- [ ] **Step 1: Write the failing schema test**

```ts
// apps/api/src/db/schema/deviceCommands.columns.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { deviceCommands } from './devices';

describe('deviceCommands deferred-delivery columns', () => {
  it('declares deliver_by as a nullable timestamptz', () => {
    const cols = getTableColumns(deviceCommands);
    expect(cols.deliverBy.name).toBe('deliver_by');
    expect(cols.deliverBy.notNull).toBe(false);
  });
  it('declares submitted_org_id as a nullable uuid (provenance, not tenancy)', () => {
    const cols = getTableColumns(deviceCommands);
    expect(cols.submittedOrgId.name).toBe('submitted_org_id');
    expect(cols.submittedOrgId.notNull).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`cols.deliverBy` undefined)

```bash
cd apps/api && npx vitest run src/db/schema/deviceCommands.columns.test.ts
```

- [ ] **Step 3: Add the columns to the Drizzle table**

```ts
// apps/api/src/db/schema/devices.ts — inside pgTable('device_commands', { ... }) after deviceRemoveExpiresAt
  // #5128 — deadline by which an agent must CLAIM this row (delivery clock).
  // NULL = legacy rule (execution timeout from created_at). See
  // services/commandOfflinePolicy.ts and jobs/staleCommandReaper.ts.
  deliverBy: timestamp('deliver_by', { withTimezone: true }),
  // #5128 — the device's org at enqueue. PROVENANCE, not tenancy: compared at
  // claim to cancel rows whose device has since moved org. Deliberately not
  // named org_id so RLS/cascade auto-discovery keeps this table system-scoped.
  submittedOrgId: uuid('submitted_org_id').references(() => organizations.id, { onDelete: 'set null' }),
```

(`organizations` is already imported in this file — confirm with `grep -n "organizations" apps/api/src/db/schema/devices.ts | head -2`.)

- [ ] **Step 4: Write the migration**

```sql
-- 2026-10-13-100000: deferred delivery for device commands (#5128).
--
-- deliver_by is the DELIVERY deadline: the instant by which an agent must have
-- claimed the row (pending -> sent). It is separate from the execution timeout
-- (services/commandTimeouts.ts), which the stale reaper applies to `sent` rows
-- from executed_at. NULL keeps today's rule for rows created before this
-- migration, so no backfill is needed and old pending rows behave as before.
--
-- submitted_org_id is PROVENANCE, NOT TENANCY. device_commands is intentionally
-- system-scoped (agent WS path, no RLS — see CLAUDE.md). This column records the
-- device's org at enqueue so claim-time eligibility can cancel rows whose device
-- has since moved org. It is deliberately not named org_id: the RLS-coverage and
-- cascade contract tests auto-discover `org_id` columns, and this table must
-- not be reclassified as tenant-scoped. ON DELETE SET NULL so erasing an org a
-- device has LEFT is never blocked by that device's historical rows.

ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS deliver_by timestamptz;
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS submitted_org_id uuid
  REFERENCES organizations(id) ON DELETE SET NULL;

-- Reaper scan for due deliveries; partial so 7-day rows are not rescanned.
CREATE INDEX IF NOT EXISTS idx_device_commands_deliver_by
  ON device_commands (deliver_by)
  WHERE status = 'pending' AND deliver_by IS NOT NULL;
```

- [ ] **Step 5: Run schema test, migration naming guard, autoMigrate test — expect PASS**

```bash
cd apps/api && npx vitest run src/db/schema/deviceCommands.columns.test.ts src/db/autoMigrate.test.ts
bash scripts/check-migration-naming.sh
```

- [ ] **Step 6: Apply locally and verify drift**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/devices.ts apps/api/src/db/schema/deviceCommands.columns.test.ts apps/api/migrations/2026-10-13-100000-device-commands-deliver-by.sql
git commit -m "feat(commands): add deliver_by and submitted_org_id to device_commands (#5128 W1)"
```

### Task 1.2: Offline-policy registry (fail-closed) and TTL classes

**Files:**
- Create: `apps/api/src/services/commandOfflinePolicy.ts`
- Test: `apps/api/src/services/commandOfflinePolicy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type OfflinePolicy = { kind: 'reject' } | { kind: 'queue'; deliverWithinMs: number };
  export type DeliveryTtlClass = 'live' | 'standard' | 'short' | 'power_state';
  export const REJECT_RACE_GRACE_MS: number;               // 5 min
  export function deliveryTtlMs(cls: DeliveryTtlClass): number;
  export function defaultOfflinePolicy(type: string): OfflinePolicy;   // throws UnregisteredCommandTypeError
  export function resolveOfflinePolicy(type: string, requested: OfflinePolicy | undefined, opts: { previouslyRejected: boolean }): OfflinePolicy;
  export function deliverByFor(policy: OfflinePolicy, now?: Date): Date;
  export function isOfflineQueueEnabled(): boolean;
  export class UnregisteredCommandTypeError extends Error {}
  export const COMMAND_OFFLINE_POLICY_REGISTRY: Readonly<Record<string, DeliveryTtlClass>>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/commandOfflinePolicy.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandTypes } from './commandQueue';
import {
  COMMAND_OFFLINE_POLICY_REGISTRY,
  REJECT_RACE_GRACE_MS,
  UnregisteredCommandTypeError,
  defaultOfflinePolicy,
  deliverByFor,
  deliveryTtlMs,
  resolveOfflinePolicy,
} from './commandOfflinePolicy';

describe('commandOfflinePolicy registry', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('covers every CommandTypes value (fail-closed)', () => {
    const missing = Object.values(CommandTypes).filter((t) => !(t in COMMAND_OFFLINE_POLICY_REGISTRY));
    expect(missing).toEqual([]);
  });

  it('throws for an unregistered type', () => {
    expect(() => defaultOfflinePolicy('definitely_not_a_command')).toThrow(UnregisteredCommandTypeError);
  });

  it('rejects live/interactive types and queues fire-and-forget types', () => {
    expect(defaultOfflinePolicy(CommandTypes.TERMINAL_START)).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy(CommandTypes.LIST_PROCESSES)).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy(CommandTypes.SCRIPT)).toEqual({ kind: 'queue', deliverWithinMs: deliveryTtlMs('standard') });
    expect(defaultOfflinePolicy(CommandTypes.REFRESH_INVENTORY)).toEqual({ kind: 'queue', deliverWithinMs: deliveryTtlMs('short') });
    expect(defaultOfflinePolicy('reboot')).toEqual({ kind: 'queue', deliverWithinMs: deliveryTtlMs('power_state') });
  });

  it('standard TTL is 7 days by default and env-tunable', () => {
    expect(deliveryTtlMs('standard')).toBe(7 * 24 * 60 * 60 * 1000);
    vi.stubEnv('DEVICE_COMMAND_QUEUE_TTL_HOURS', '48');
    expect(deliveryTtlMs('standard')).toBe(48 * 60 * 60 * 1000);
  });

  it('flag off + previouslyRejected keeps reject; flag on lets the registry queue', () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'false');
    expect(resolveOfflinePolicy(CommandTypes.INSTALL_PATCHES, undefined, { previouslyRejected: true })).toEqual({ kind: 'reject' });
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');
    expect(resolveOfflinePolicy(CommandTypes.INSTALL_PATCHES, undefined, { previouslyRejected: true }).kind).toBe('queue');
  });

  it('an explicit requested policy always wins', () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'false');
    expect(resolveOfflinePolicy(CommandTypes.INSTALL_PATCHES, { kind: 'queue', deliverWithinMs: 1000 }, { previouslyRejected: true }))
      .toEqual({ kind: 'queue', deliverWithinMs: 1000 });
  });

  it('deliverByFor: queue adds deliverWithinMs; reject adds the race grace', () => {
    const now = new Date('2026-09-06T00:00:00Z');
    expect(deliverByFor({ kind: 'queue', deliverWithinMs: 60_000 }, now).toISOString()).toBe('2026-09-06T00:01:00.000Z');
    expect(deliverByFor({ kind: 'reject' }, now).getTime()).toBe(now.getTime() + REJECT_RACE_GRACE_MS);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found)

```bash
cd apps/api && npx vitest run src/services/commandOfflinePolicy.test.ts
```

- [ ] **Step 3: Implement the module**

```ts
// apps/api/src/services/commandOfflinePolicy.ts
import { CommandTypes } from './commandQueue';

export type OfflinePolicy =
  | { kind: 'reject' }
  | { kind: 'queue'; deliverWithinMs: number };

/** TTL class = how long a queued row may wait for the device (OD-1). */
export type DeliveryTtlClass = 'live' | 'standard' | 'short' | 'power_state';

export const REJECT_RACE_GRACE_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export class UnregisteredCommandTypeError extends Error {
  constructor(type: string) {
    super(`Command type "${type}" has no entry in COMMAND_OFFLINE_POLICY_REGISTRY (services/commandOfflinePolicy.ts) — register it with a TTL class before dispatching it`);
    this.name = 'UnregisteredCommandTypeError';
  }
}

function envHours(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function deliveryTtlMs(cls: DeliveryTtlClass): number {
  switch (cls) {
    case 'live': return REJECT_RACE_GRACE_MS;
    case 'standard': return envHours('DEVICE_COMMAND_QUEUE_TTL_HOURS', 168) * HOUR_MS;
    case 'short': return envHours('DEVICE_COMMAND_QUEUE_SHORT_TTL_HOURS', 24) * HOUR_MS;
    case 'power_state': return envHours('DEVICE_COMMAND_QUEUE_POWER_STATE_TTL_HOURS', 24) * HOUR_MS;
  }
}

export function isOfflineQueueEnabled(): boolean {
  return process.env.DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED === 'true';
}

const C = CommandTypes;
const LIVE: readonly string[] = [
  C.LIST_PROCESSES, C.GET_PROCESS, C.KILL_PROCESS, C.LIST_SERVICES, C.GET_SERVICE, C.START_SERVICE,
  C.STOP_SERVICE, C.RESTART_SERVICE, C.EVENT_LOGS_LIST, C.EVENT_LOGS_QUERY, C.EVENT_LOG_GET,
  C.TASKS_LIST, C.TASK_GET, C.TASK_RUN, C.TASK_ENABLE, C.TASK_DISABLE, C.TASK_HISTORY,
  C.REGISTRY_KEYS, C.REGISTRY_VALUES, C.REGISTRY_GET, C.REGISTRY_SET, C.REGISTRY_DELETE,
  C.REGISTRY_KEY_CREATE, C.REGISTRY_KEY_DELETE, C.FILE_LIST, C.FILE_READ, C.FILE_WRITE, C.FILE_DELETE,
  C.FILE_MKDIR, C.FILE_RENAME, C.FILE_COPY, C.FILE_TRASH_LIST, C.FILE_TRASH_RESTORE, C.FILE_TRASH_PURGE,
  C.FILE_LIST_DRIVES, C.TERMINAL_START, C.TERMINAL_DATA, C.TERMINAL_RESIZE, C.TERMINAL_STOP,
  C.SCRIPT_CANCEL, C.TAKE_SCREENSHOT, C.COMPUTER_ACTION, C.COLLECT_BOOT_PERFORMANCE, C.VSS_STATUS,
  C.VSS_WRITER_LIST, C.MSSQL_DISCOVER, C.HYPERV_DISCOVER, C.HYPERV_VM_STATE, C.VM_RESTORE_ESTIMATE,
  C.VAULT_STATUS, C.WAKE_ON_LAN, C.CAPTURE_PPROF,
];
const SHORT: readonly string[] = [
  C.REFRESH_INVENTORY, C.SET_LOG_LEVEL, C.PERIPHERAL_POLICY_SYNC, C.PERIPHERAL_POLICY_SYNC_V2,
  C.MANAGE_STARTUP_ITEM, C.COLLECT_AUDIT_POLICY, C.SECURITY_COLLECT_STATUS, C.COLLECT_RELIABILITY_METRICS,
  C.SYSTEM_STATE_COLLECT, C.HARDWARE_PROFILE, C.ENCRYPTION_COLLECT_KEYS, C.HYPERV_CHECKPOINT,
];
const POWER_STATE: readonly string[] = ['reboot', 'shutdown', C.REBOOT_SAFE_MODE];

// Everything else in CommandTypes is 'standard'. Build the registry from
// CommandTypes so a NEW type cannot be added without also being classified
// (the coverage test above enforces that; a type added to CommandTypes but not
// to one of the lists lands in `standard`, which is the safe default for
// fire-and-forget work — a type that must NOT queue has to be listed in LIVE).
const registry: Record<string, DeliveryTtlClass> = {};
for (const type of Object.values(CommandTypes)) registry[type] = 'standard';
for (const t of LIVE) registry[t] = 'live';
for (const t of SHORT) registry[t] = 'short';
for (const t of POWER_STATE) registry[t] = 'power_state';
export const COMMAND_OFFLINE_POLICY_REGISTRY: Readonly<Record<string, DeliveryTtlClass>> = Object.freeze(registry);

export function defaultOfflinePolicy(type: string): OfflinePolicy {
  const cls = COMMAND_OFFLINE_POLICY_REGISTRY[type];
  if (!cls) throw new UnregisteredCommandTypeError(type);
  if (cls === 'live') return { kind: 'reject' };
  return { kind: 'queue', deliverWithinMs: deliveryTtlMs(cls) };
}

export function resolveOfflinePolicy(
  type: string,
  requested: OfflinePolicy | undefined,
  opts: { previouslyRejected: boolean },
): OfflinePolicy {
  if (requested) return requested;
  const def = defaultOfflinePolicy(type);
  if (def.kind === 'queue' && opts.previouslyRejected && !isOfflineQueueEnabled()) return { kind: 'reject' };
  return def;
}

export function deliverByFor(policy: OfflinePolicy, now: Date = new Date()): Date {
  const ms = policy.kind === 'queue' ? policy.deliverWithinMs : REJECT_RACE_GRACE_MS;
  return new Date(now.getTime() + ms);
}
```

Note: `'reboot'` and `'shutdown'` are generic command strings accepted by `routes/devices/commands.ts` (`createCommandSchema`) that are **not** in `CommandTypes`. Add them to the registry explicitly (they are, via `POWER_STATE`), and add `'lock'`, `'set_auto_update'`, and any other literal the route schema accepts: run `grep -n "z.enum" apps/api/src/routes/devices/schemas.ts` and mirror that enum into a `GENERIC_ROUTE_TYPES` list classified `standard` (except the power-state three). The coverage test must also iterate that enum — import it from `apps/api/src/routes/devices/schemas.ts` and add a second assertion.

- [ ] **Step 4: Run — expect PASS**

```bash
cd apps/api && npx vitest run src/services/commandOfflinePolicy.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/commandOfflinePolicy.ts apps/api/src/services/commandOfflinePolicy.test.ts
git commit -m "feat(commands): fail-closed offline-policy registry with TTL classes (#5128 W1)"
```

### Task 1.3: `queueCommand` accepts `deliverBy` + `submittedOrgId`; the seam `dispatchDeviceCommand`

**Files:**
- Modify: `apps/api/src/services/commandQueue.ts` — `queueCommand` (~628) options + insert values (~674); `queueCommandForExecution` (~841) becomes a thin adapter over the seam.
- Create: `apps/api/src/services/dispatchDeviceCommand.ts`, `apps/api/src/services/dispatchDeviceCommand.test.ts`
- Test (existing, must stay green): `apps/api/src/services/commandQueue.test.ts`, `commandQueueTransitions.test.ts`, `commandQueue.dbcontext.test.ts`

**Interfaces:**
- Consumes: `resolveOfflinePolicy`, `deliverByFor` (Task 1.2); `claimPendingCommandForDelivery`, `releaseClaimedCommandDelivery` (`commandDispatch.ts`); `decryptCommandForDelivery`, `sendCommandToAgent`, `toAgentCommandFrame` (already used inside `queueCommandForExecution`).
- Produces:
  ```ts
  // commandQueue.ts
  export async function queueCommand(deviceId, type, payload = {}, userId?, options: { commandId?: string; deliverBy?: Date; submittedOrgId?: string } = {}): Promise<QueuedCommand>;
  // dispatchDeviceCommand.ts
  export type DispatchDeviceCommandInput = {
    deviceId: string; type: string; payload?: CommandPayload; userId?: string;
    offlinePolicy?: OfflinePolicy; previouslyRejected?: boolean;
    expectedOrgId?: string; preferHeartbeat?: boolean;
  };
  export type DispatchDeviceCommandResult =
    | { ok: true; command: QueuedCommand; delivery: 'delivered' | 'queued_offline' | 'queued_live'; deliverBy: Date }
    | { ok: false; code: 'device_not_found' | 'device_offline' | 'device_decommissioned' | 'trust_denied'; error: string; trust?: { capability: 'device_execute'; reason: string } };
  export async function dispatchDeviceCommand(input: DispatchDeviceCommandInput): Promise<DispatchDeviceCommandResult>;
  ```
  `delivery: 'queued_live'` = device online but socket push failed or `preferHeartbeat`; row waits for the next heartbeat. `'queued_offline'` = device not online at enqueue.

- [ ] **Step 1: Failing tests for `queueCommand` stamping and the seam**

```ts
// apps/api/src/services/dispatchDeviceCommand.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queueCommandMock, claimMock, sendMock, assertAllowedMock, selectMock } = vi.hoisted(() => ({
  queueCommandMock: vi.fn(),
  claimMock: vi.fn(),
  sendMock: vi.fn(),
  assertAllowedMock: vi.fn(),
  selectMock: vi.fn(),
}));
vi.mock('../db', () => ({
  db: { select: (...a: unknown[]) => selectMock(...(a as [])) },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../db/schema', () => ({ devices: { id: 'devices.id' } }));
vi.mock('./commandQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./commandQueue')>();
  return { ...actual, queueCommand: (...a: unknown[]) => queueCommandMock(...(a as [])), decryptCommandForDelivery: vi.fn((c: unknown) => c), toAgentCommandFrame: vi.fn((c: unknown) => c) };
});
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: (...a: unknown[]) => claimMock(...(a as [])),
  releaseClaimedCommandDelivery: vi.fn(),
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: (...a: unknown[]) => sendMock(...(a as [])) }));
vi.mock('./partnerTrust.commands', () => ({ assertDeviceExecuteAllowed: (...a: unknown[]) => assertAllowedMock(...(a as [])) }));

import { dispatchDeviceCommand } from './dispatchDeviceCommand';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
function deviceRow(status: string) {
  return { id: DEVICE, orgId: ORG, status, agentId: 'agent-1' };
}
function selectReturning(row: unknown) {
  selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) });
}

describe('dispatchDeviceCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');
    queueCommandMock.mockImplementation(async (_d, type, _p, _u, opts) => ({ id: 'cmd-1', type, status: 'pending', deliverBy: opts.deliverBy, submittedOrgId: opts.submittedOrgId }));
  });

  it('offline device + queue policy → row persisted with deliver_by and submitted_org_id, delivery=queued_offline', async () => {
    selectReturning(deviceRow('offline'));
    const before = Date.now();
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory', offlinePolicy: { kind: 'queue', deliverWithinMs: 3_600_000 } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delivery).toBe('queued_offline');
    expect(res.deliverBy.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
    const opts = queueCommandMock.mock.calls[0]![4];
    expect(opts.submittedOrgId).toBe(ORG);
    expect(opts.deliverBy).toBeInstanceOf(Date);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('offline device + reject policy → device_offline error, no row', async () => {
    selectReturning(deviceRow('offline'));
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'list_processes' });
    expect(res).toMatchObject({ ok: false, code: 'device_offline', error: 'Device is offline, cannot execute command' });
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('online device → claim + push, delivery=delivered', async () => {
    selectReturning(deviceRow('online'));
    claimMock.mockResolvedValue({ id: 'cmd-1', executedAt: new Date() });
    sendMock.mockReturnValue(true);
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory' });
    expect(res.ok && res.delivery).toBe('delivered');
  });

  it('online device, push fails → row released, delivery=queued_live', async () => {
    selectReturning(deviceRow('online'));
    claimMock.mockResolvedValue({ id: 'cmd-1', executedAt: new Date() });
    sendMock.mockReturnValue(false);
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory' });
    expect(res.ok && res.delivery).toBe('queued_live');
  });

  it('expectedOrgId mismatch → device_not_found (never leaks existence)', async () => {
    selectReturning(deviceRow('online'));
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory', expectedOrgId: '33333333-3333-4333-8333-333333333333' });
    expect(res).toMatchObject({ ok: false, code: 'device_not_found' });
  });

  it('decommissioned device → device_decommissioned regardless of policy', async () => {
    selectReturning(deviceRow('decommissioned'));
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory', offlinePolicy: { kind: 'queue', deliverWithinMs: 1000 } });
    expect(res).toMatchObject({ ok: false, code: 'device_decommissioned' });
  });

  it('unregistered type throws before any DB write', async () => {
    selectReturning(deviceRow('online'));
    await expect(dispatchDeviceCommand({ deviceId: DEVICE, type: 'nope_not_real' })).rejects.toThrow(/COMMAND_OFFLINE_POLICY_REGISTRY/);
    expect(queueCommandMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd apps/api && npx vitest run src/services/dispatchDeviceCommand.test.ts
```

- [ ] **Step 3: Extend `queueCommand` options and insert**

In `apps/api/src/services/commandQueue.ts`:

```ts
export async function queueCommand(
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  userId?: string,
  options: { commandId?: string; deliverBy?: Date; submittedOrgId?: string } = {}
): Promise<QueuedCommand> {
```

and in the `.values({...})`:

```ts
      .values({
        ...(options.commandId ? { id: options.commandId } : {}),
        deviceId,
        type,
        payload,
        status: 'pending',
        createdBy: safeUserId,
        ...(options.deliverBy ? { deliverBy: options.deliverBy } : {}),
        ...(options.submittedOrgId ? { submittedOrgId: options.submittedOrgId } : {}),
      })
```

- [ ] **Step 4: Create the seam**

```ts
// apps/api/src/services/dispatchDeviceCommand.ts
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema';
import { sendCommandToAgent } from '../routes/agentWs';
import { claimPendingCommandForDelivery, releaseClaimedCommandDelivery } from './commandDispatch';
import { deliverByFor, resolveOfflinePolicy, type OfflinePolicy } from './commandOfflinePolicy';
import {
  decryptCommandForDelivery,
  queueCommand,
  toAgentCommandFrame,
  type CommandPayload,
  type QueuedCommand,
} from './commandQueue';
import { TrustDeniedError, assertDeviceExecuteAllowed } from './partnerTrust.commands';

export type DispatchDeviceCommandInput = {
  deviceId: string;
  type: string;
  payload?: CommandPayload;
  userId?: string;
  /** Explicit policy; omit to take the registry default. */
  offlinePolicy?: OfflinePolicy;
  /** True for callers that hard-rejected offline devices before #5128; the
   *  DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED flag gates their switch to queueing. */
  previouslyRejected?: boolean;
  /** Defense-in-depth for callers running under a system context. */
  expectedOrgId?: string;
  /** Skip the socket push even when connected (watchdog-style consumers). */
  preferHeartbeat?: boolean;
};

export type DispatchDeviceCommandResult =
  | { ok: true; command: QueuedCommand; delivery: 'delivered' | 'queued_offline' | 'queued_live'; deliverBy: Date }
  | {
      ok: false;
      code: 'device_not_found' | 'device_offline' | 'device_decommissioned' | 'trust_denied';
      error: string;
      trust?: { capability: 'device_execute'; reason: string };
    };

/**
 * The single enqueue seam for device commands (#5128 §D). Order: device lookup
 * → expectedOrgId → lifecycle → trust → resolve offline policy → persist row
 * (ALWAYS before any transport) → claim/prepare/push/release when connected.
 */
export async function dispatchDeviceCommand(input: DispatchDeviceCommandInput): Promise<DispatchDeviceCommandResult> {
  const policy = resolveOfflinePolicy(input.type, input.offlinePolicy, {
    previouslyRejected: input.previouslyRejected ?? false,
  }); // throws UnregisteredCommandTypeError before any DB access

  const [device] = await db.select().from(devices).where(eq(devices.id, input.deviceId)).limit(1);
  if (!device) return { ok: false, code: 'device_not_found', error: 'Device not found' };
  if (input.expectedOrgId !== undefined && device.orgId !== input.expectedOrgId) {
    return { ok: false, code: 'device_not_found', error: 'Device not found' };
  }
  if (device.status === 'decommissioned') {
    return { ok: false, code: 'device_decommissioned', error: 'Cannot send commands to a decommissioned device' };
  }

  try {
    await assertDeviceExecuteAllowed(input.deviceId, input.type, input.userId);
  } catch (e) {
    if (e instanceof TrustDeniedError) {
      return { ok: false, code: 'trust_denied', error: e.code, trust: { capability: e.capability, reason: e.reason } };
    }
    throw e;
  }

  const online = device.status === 'online';
  if (!online && policy.kind === 'reject') {
    return { ok: false, code: 'device_offline', error: `Device is ${device.status}, cannot execute command` };
  }

  const deliverBy = deliverByFor(policy);
  const command = await queueCommand(input.deviceId, input.type, input.payload ?? {}, input.userId, {
    deliverBy,
    submittedOrgId: device.orgId,
  });

  if (!online) return { ok: true, command, delivery: 'queued_offline', deliverBy };
  if (!device.agentId || input.preferHeartbeat) return { ok: true, command, delivery: 'queued_live', deliverBy };

  const claimed = await claimPendingCommandForDelivery(command.id);
  if (!claimed) return { ok: true, command, delivery: 'queued_live', deliverBy };
  const prepared = decryptCommandForDelivery({ id: command.id, type: input.type, deviceId: input.deviceId, payload: input.payload ?? {} });
  const sent = prepared ? sendCommandToAgent(device.agentId, toAgentCommandFrame(prepared)) : false;
  if (sent) return { ok: true, command: { ...command, status: 'sent' }, delivery: 'delivered', deliverBy };
  await releaseClaimedCommandDelivery(command.id, claimed.executedAt);
  return { ok: true, command, delivery: 'queued_live', deliverBy };
}
```

Check the exact export names `decryptCommandForDelivery` and `toAgentCommandFrame` exist in `commandQueue.ts` (they are used at ~889–893 inside `queueCommandForExecution`); if they live in another module, import from there and update the test mock path accordingly.

- [ ] **Step 5: Make `queueCommandForExecution` an adapter**

Replace the body of `queueCommandForExecution` (~841–911) with:

```ts
export async function queueCommandForExecution(
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  options: { userId?: string; preferHeartbeat?: boolean; expectedOrgId?: string; offlinePolicy?: OfflinePolicy } = {}
): Promise<QueueCommandForExecutionResult> {
  const res = await dispatchDeviceCommand({
    deviceId, type, payload,
    userId: options.userId,
    preferHeartbeat: options.preferHeartbeat,
    expectedOrgId: options.expectedOrgId,
    offlinePolicy: options.offlinePolicy,
    previouslyRejected: true,
  });
  if (!res.ok) {
    return res.code === 'trust_denied'
      ? { error: res.error, trust: res.trust }
      : { error: res.error };
  }
  return { command: res.command, delivery: res.delivery, deliverBy: res.deliverBy };
}
```

and extend the result type:

```ts
export interface QueueCommandForExecutionResult {
  command?: QueuedCommand;
  error?: string;
  trust?: { capability: 'device_execute'; reason: string };
  delivery?: 'delivered' | 'queued_offline' | 'queued_live';
  deliverBy?: Date;
}
```

`import type { OfflinePolicy } from './commandOfflinePolicy'` and `import { dispatchDeviceCommand } from './dispatchDeviceCommand'` at the top of `commandQueue.ts`. **Circular import check:** `dispatchDeviceCommand.ts` imports from `commandQueue.ts`, and `commandQueue.ts` now imports `dispatchDeviceCommand`. Both are function-level uses (no top-level evaluation of each other's exports), so ESM cycles resolve; run `cd apps/api && npx tsc --noEmit -p .` and the three existing `commandQueue*.test.ts` files to confirm.

- [ ] **Step 6: `precheckCommandExecution` / `dispatchPreparedCommand` stamp the grace deadline**

`executeCommand` is synchronous by contract (`waitForCommandResult`), so it stays `reject` — but its row must carry `deliver_by` so a race with a disconnect cannot linger. In `dispatchPreparedCommand` (the `queueCommand(...)` call at ~1211), pass:

```ts
  const submittedOrgId = device.orgId;
  const command = await queueCommand(deviceId, type, payloadForRow, options.userId, {
    deliverBy: deliverByFor({ kind: 'reject' }),
    submittedOrgId,
  });
```

(`device` is already in scope there — it is the `precheck.device` argument.)

- [ ] **Step 7: Run new + existing tests and typecheck — expect PASS**

```bash
cd apps/api && npx vitest run src/services/dispatchDeviceCommand.test.ts src/services/commandQueue.test.ts src/services/commandQueueTransitions.test.ts src/services/commandQueue.dbcontext.test.ts && npx tsc --noEmit -p .
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/commandQueue.ts apps/api/src/services/dispatchDeviceCommand.ts apps/api/src/services/dispatchDeviceCommand.test.ts
git commit -m "feat(commands): dispatchDeviceCommand seam with explicit offline policy (#5128 W1)"
```

### Task 1.4: Claim predicates, eligibility filter, power-state barrier

**Files:**
- Create: `apps/api/src/services/commandClaimEligibility.ts`, `apps/api/src/services/commandClaimEligibility.test.ts`
- Modify: `apps/api/src/services/commandDispatch.ts` (`claimPendingCommandForDelivery` ~8–29; `claimPendingCommandsForDevice` ~62–166)
- Test (existing): `apps/api/src/services/commandDispatch.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // commandClaimEligibility.ts
  export type ClaimCancelReason = 'device_moved_org' | 'device_lifecycle' | 'trust_denied' | 'requester_inactive' | 'held_maintenance_suppression';
  export type ClaimEligibilityDevice = { id: string; orgId: string; status: string; partnerId: string | null };
  export type ClaimCandidate = { id: string; type: string; createdBy: string | null; submittedOrgId: string | null; deliverBy: Date | null };
  export async function partitionClaimable(tx: Tx, device: ClaimEligibilityDevice, rows: ClaimCandidate[]): Promise<{ claimable: ClaimCandidate[]; cancelled: Array<{ id: string; reason: ClaimCancelReason }>; held: Array<{ id: string; reason: ClaimCancelReason }> }>;
  export const POWER_STATE_TYPES: ReadonlySet<string>;   // 'reboot' | 'shutdown' | 'reboot_safe_mode'
  export const typeHolds: Record<string, (deviceId: string) => Promise<boolean>>;   // W3 registers install_patches here
  ```
  `cancelled` rows are terminalised inside `tx` (`status='cancelled'`, `completedAt`, `result: { status: 'cancelled', reason }`, payload erased). `held` rows are left `pending` untouched (they will be re-evaluated on the next heartbeat).

- [ ] **Step 1: Failing tests**

```ts
// apps/api/src/services/commandClaimEligibility.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { assertAllowedMock, userStatusMock, updateMock } = vi.hoisted(() => ({
  assertAllowedMock: vi.fn(), userStatusMock: vi.fn(), updateMock: vi.fn(),
}));
vi.mock('./partnerTrust.commands', () => ({
  assertDeviceExecuteAllowed: (...a: unknown[]) => assertAllowedMock(...(a as [])),
  TrustDeniedError: class TrustDeniedError extends Error { code = 'trust_denied'; capability = 'device_execute'; reason = 'r'; },
}));
vi.mock('../db/schema', () => ({
  deviceCommands: { id: 'dc.id', status: 'dc.status', completedAt: 'dc.completedAt', result: 'dc.result', payload: 'dc.payload' },
  users: { id: 'users.id', status: 'users.status' },
}));
vi.mock('./sensitiveCommandPayload', () => ({ terminalPayloadErasureSet: () => ({ payload: null }) }));

import { partitionClaimable, typeHolds } from './commandClaimEligibility';

const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const device = { id: 'd1', orgId: ORG, status: 'online', partnerId: 'p1' };
const row = (over: Partial<Parameters<typeof partitionClaimable>[2][number]> = {}) => ({
  id: 'c1', type: 'refresh_inventory', createdBy: null, submittedOrgId: ORG, deliverBy: null, ...over,
});
function tx() {
  updateMock.mockReturnValue({ set: () => ({ where: async () => [] }) });
  return {
    update: (...a: unknown[]) => updateMock(...(a as [])),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => userStatusMock() }) }) }),
  } as never;
}

describe('partitionClaimable', () => {
  beforeEach(() => { vi.resetAllMocks(); assertAllowedMock.mockResolvedValue(undefined); userStatusMock.mockResolvedValue([{ status: 'active' }]); });

  it('passes an ordinary row through', async () => {
    const r = await partitionClaimable(tx(), device, [row()]);
    expect(r.claimable.map((x) => x.id)).toEqual(['c1']);
    expect(r.cancelled).toEqual([]);
  });

  it('cancels when the device moved org since enqueue', async () => {
    const r = await partitionClaimable(tx(), device, [row({ submittedOrgId: OTHER })]);
    expect(r.cancelled).toEqual([{ id: 'c1', reason: 'device_moved_org' }]);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('legacy rows with NULL submitted_org_id are not cancelled for org drift', async () => {
    const r = await partitionClaimable(tx(), device, [row({ submittedOrgId: null })]);
    expect(r.claimable).toHaveLength(1);
  });

  it('cancels on device lifecycle (quarantined) except self_uninstall', async () => {
    const r = await partitionClaimable(tx(), { ...device, status: 'quarantined' }, [row(), row({ id: 'c2', type: 'self_uninstall' })]);
    expect(r.cancelled).toEqual([{ id: 'c1', reason: 'device_lifecycle' }]);
    expect(r.claimable.map((x) => x.id)).toEqual(['c2']);
  });

  it('cancels on trust denial', async () => {
    const { TrustDeniedError } = await import('./partnerTrust.commands');
    assertAllowedMock.mockRejectedValue(new TrustDeniedError('x'));
    const r = await partitionClaimable(tx(), device, [row()]);
    expect(r.cancelled).toEqual([{ id: 'c1', reason: 'trust_denied' }]);
  });

  it('cancels when the requesting user is no longer active', async () => {
    userStatusMock.mockResolvedValue([{ status: 'disabled' }]);
    const r = await partitionClaimable(tx(), device, [row({ createdBy: USER })]);
    expect(r.cancelled).toEqual([{ id: 'c1', reason: 'requester_inactive' }]);
  });

  it('power-state rows are claimed alone and only when nothing is in flight', async () => {
    const r = await partitionClaimable(tx(), device, [row({ id: 'a', type: 'refresh_inventory' }), row({ id: 'b', type: 'reboot' })]);
    expect(r.claimable.map((x) => x.id)).toEqual(['a']);      // reboot deferred to a later heartbeat
    expect(r.held).toEqual([{ id: 'b', reason: 'power_state_barrier' }]);
  });

  it('a registered type hold keeps the row pending', async () => {
    typeHolds['install_patches'] = async () => true;
    const r = await partitionClaimable(tx(), device, [row({ type: 'install_patches' })]);
    expect(r.held).toEqual([{ id: 'c1', reason: 'held_maintenance_suppression' }]);
    delete typeHolds['install_patches'];
  });
});
```

Add `'power_state_barrier'` to `ClaimCancelReason` (it is a *hold* reason, listed in the same union for simplicity).

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/commandClaimEligibility.ts
import { and, eq, inArray } from 'drizzle-orm';
import type { db } from '../db';
import { deviceCommands, users } from '../db/schema';
import { TrustDeniedError, assertDeviceExecuteAllowed } from './partnerTrust.commands';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ClaimCancelReason =
  | 'device_moved_org' | 'device_lifecycle' | 'trust_denied' | 'requester_inactive'
  | 'held_maintenance_suppression' | 'power_state_barrier';
export type ClaimEligibilityDevice = { id: string; orgId: string; status: string; partnerId: string | null };
export type ClaimCandidate = { id: string; type: string; createdBy: string | null; submittedOrgId: string | null; deliverBy: Date | null };

export const POWER_STATE_TYPES: ReadonlySet<string> = new Set(['reboot', 'shutdown', 'reboot_safe_mode']);
/** Types exempt from lifecycle cancellation: the uninstall drain must still deliver. */
const LIFECYCLE_EXEMPT: ReadonlySet<string> = new Set(['self_uninstall']);
const NON_DELIVERABLE_LIFECYCLE: ReadonlySet<string> = new Set(['decommissioned', 'quarantined']);

/** Per-type "hold" predicates: true = leave pending this heartbeat. W3 registers install_patches. */
export const typeHolds: Record<string, (deviceId: string) => Promise<boolean>> = {};

/**
 * Splits claim candidates into claimable / cancelled / held (#5128 §G). Cancels
 * are written INSIDE the caller's claim transaction so a cancelled row can never
 * be delivered by a concurrent claim. Also enforces the power-state barrier
 * (§E.4): reboot/shutdown are claimed alone and only when nothing else is in
 * flight — `inFlight` is supplied by the caller from a `status='sent'` count.
 */
export async function partitionClaimable(
  tx: Tx,
  device: ClaimEligibilityDevice,
  rows: ClaimCandidate[],
  opts: { inFlight?: number } = {},
): Promise<{ claimable: ClaimCandidate[]; cancelled: Array<{ id: string; reason: ClaimCancelReason }>; held: Array<{ id: string; reason: ClaimCancelReason }> }> {
  const claimable: ClaimCandidate[] = [];
  const cancelled: Array<{ id: string; reason: ClaimCancelReason }> = [];
  const held: Array<{ id: string; reason: ClaimCancelReason }> = [];
  const requesterCache = new Map<string, boolean>();

  for (const row of rows) {
    if (row.submittedOrgId !== null && row.submittedOrgId !== device.orgId) { cancelled.push({ id: row.id, reason: 'device_moved_org' }); continue; }
    if (NON_DELIVERABLE_LIFECYCLE.has(device.status) && !LIFECYCLE_EXEMPT.has(row.type)) { cancelled.push({ id: row.id, reason: 'device_lifecycle' }); continue; }
    try {
      await assertDeviceExecuteAllowed(device.id, row.type, row.createdBy ?? undefined);
    } catch (e) {
      if (e instanceof TrustDeniedError) { cancelled.push({ id: row.id, reason: 'trust_denied' }); continue; }
      throw e;
    }
    if (row.createdBy) {
      let active = requesterCache.get(row.createdBy);
      if (active === undefined) {
        const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, row.createdBy)).limit(1);
        active = u?.status === 'active';
        requesterCache.set(row.createdBy, active);
      }
      if (!active) { cancelled.push({ id: row.id, reason: 'requester_inactive' }); continue; }
    }
    const hold = typeHolds[row.type];
    if (hold && (await hold(device.id))) { held.push({ id: row.id, reason: 'held_maintenance_suppression' }); continue; }
    claimable.push(row);
  }

  // Power-state barrier: a reboot/shutdown is claimed only as the sole row of a
  // batch with nothing in flight. Otherwise hold it for a later heartbeat.
  const power = claimable.filter((r) => POWER_STATE_TYPES.has(r.type));
  if (power.length > 0) {
    const others = claimable.filter((r) => !POWER_STATE_TYPES.has(r.type));
    const inFlight = opts.inFlight ?? 0;
    if (others.length > 0 || inFlight > 0) {
      for (const p of power) held.push({ id: p.id, reason: 'power_state_barrier' });
      claimable.splice(0, claimable.length, ...others);
    } else {
      claimable.splice(0, claimable.length, power[0]!);
      for (const p of power.slice(1)) held.push({ id: p.id, reason: 'power_state_barrier' });
    }
  }

  if (cancelled.length > 0) {
    const completedAt = new Date();
    for (const c of cancelled) {
      await tx.update(deviceCommands)
        .set({ status: 'cancelled', completedAt, result: { status: 'cancelled', reason: c.reason, cancelledBy: 'claim_eligibility' }, ...terminalPayloadErasureSet() })
        .where(and(eq(deviceCommands.id, c.id), eq(deviceCommands.status, 'pending')));
    }
  }
  return { claimable, cancelled, held };
}
```

Confirm the `users.status` column name with `grep -n "status" apps/api/src/db/schema/users.ts | head -3` and adjust (`isActive` boolean → `active = u?.isActive === true`).

- [ ] **Step 4: Wire into `commandDispatch.ts`**

In `claimPendingCommandForDelivery` add the deadline predicate:

```ts
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.status, 'pending'),
          or(isNull(deviceCommands.deliverBy), gt(deviceCommands.deliverBy, new Date())),
        ),
      )
```

In `claimPendingCommandsForDevice`, inside the transaction after `pendingCommands` is selected and before the `UPDATE ... SET status='sent'`:

```ts
    const [dev] = await tx.select({ id: devices.id, orgId: devices.orgId, status: devices.status, partnerId: devices.partnerId })
      .from(devices).where(eq(devices.id, deviceId)).limit(1);
    if (!dev) return [];
    const [{ inFlight }] = await tx.select({ inFlight: sql<number>`count(*)::int` })
      .from(deviceCommands)
      .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.status, 'sent'), eq(deviceCommands.targetRole, targetRole)));
    const { claimable } = await partitionClaimable(tx, dev, pendingCommands, { inFlight });
    const claimIds = claimable.map((c) => c.id);
    if (claimIds.length === 0) return [];
```

and add `or(isNull(deviceCommands.deliverBy), gt(deviceCommands.deliverBy, now))` to the `pendingCommands` SELECT's `and(...)`; the subsequent UPDATE must use `inArray(deviceCommands.id, claimIds)` instead of the full pending set. Import `devices` from `../db/schema`, `partitionClaimable` from `./commandClaimEligibility`, and `gt, isNull, or, sql` from `drizzle-orm`. The existing `FOR UPDATE SKIP LOCKED` stays on the SELECT.

- [ ] **Step 5: Update `commandDispatch.test.ts` mocks** — the `../db/schema` mock needs `devices: { id, orgId, status, partnerId }`, `deviceCommands.deliverBy`, `deviceCommands.submittedOrgId`, `deviceCommands.createdBy`, `users`. Add a test: a row whose `deliverBy` is in the past is excluded from the claim (assert the `gt`/`isNull` predicate appears in the SELECT's `where` args, following the file's existing `inArray` spy pattern — spy `gt` and `isNull` the same way).

- [ ] **Step 6: Run — expect PASS**

```bash
cd apps/api && npx vitest run src/services/commandClaimEligibility.test.ts src/services/commandDispatch.test.ts && npx tsc --noEmit -p .
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/commandClaimEligibility.ts apps/api/src/services/commandClaimEligibility.test.ts apps/api/src/services/commandDispatch.ts apps/api/src/services/commandDispatch.test.ts
git commit -m "feat(commands): claim-time eligibility, deliver_by predicate, power-state barrier (#5128 W1)"
```

### Task 1.5: Reaper — two clocks, CAS on observed state, `expired` result, single owner of the delivery clock

**Files:**
- Modify: `apps/api/src/jobs/staleCommandReaper.ts` — `reapStaleDeviceCommands` (~182–372), `reapStaleScriptExecutions` (~395–470), `reapStaleSoftwareDeploymentResults` (~940–1030); `apps/api/src/services/commandTimeouts.ts` (remove the `SOFTWARE_INSTALL → SEVEN_DAYS` line); `apps/api/src/services/propagateTimedOutDeviceCommand.ts` (or wherever `propagateTimedOutDeviceCommand` is exported — `grep -rn "export async function propagateTimedOutDeviceCommand" apps/api/src`).
- Test: `apps/api/src/jobs/staleCommandReaper.test.ts` (extend), `apps/api/src/jobs/staleCommandReaper.twoClocks.test.ts` (create)

**Interfaces:**
- Consumes: `deviceCommands.deliverBy`, `deviceCommands.executedAt`.
- Produces: command `result` shape for a delivery expiry: `{ status: 'expired', reason: 'not_delivered_before_deadline', error: string, timedOutBy: 'server' }`; `propagateTimedOutDeviceCommand` gains `kind: 'expired' | 'timeout'`.

- [ ] **Step 1: Failing tests** (`staleCommandReaper.twoClocks.test.ts`, mirroring the hoisted-mock header of `staleCommandReaper.test.ts` — copy lines 1–140 of that file verbatim for the mocks and `selectChain`/`updateChain` helpers, then add):

```ts
describe('reapStaleDeviceCommands — two clocks (#5128)', () => {
  const now = Date.now();
  const script = (over: Record<string, unknown>) => ({
    id: 'c1', type: 'script', payload: { timeoutSeconds: 300 }, status: 'pending',
    createdAt: new Date(now - 60 * 60 * 1000), executedAt: null, deliverBy: null, ...over,
  });

  it('pending row with a FUTURE deliver_by is not reaped even though the execution timeout has lapsed', async () => {
    selectMock.mockReturnValueOnce(selectChain([script({ deliverBy: new Date(now + 6 * 24 * 3600 * 1000) })]));
    const reaped = await reapStaleDeviceCommands();
    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('pending row past deliver_by is failed with an expired/not_delivered_before_deadline result', async () => {
    selectMock.mockReturnValueOnce(selectChain([script({ deliverBy: new Date(now - 1000) })]));
    const update = updateChain([{ id: 'c1' }]);
    updateMock.mockReturnValue(update);
    const reaped = await reapStaleDeviceCommands();
    expect(reaped).toBe(1);
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      result: expect.objectContaining({ status: 'expired', reason: 'not_delivered_before_deadline', timedOutBy: 'server' }),
    }));
  });

  it('legacy pending row (deliver_by NULL) keeps the created_at + execution-timeout rule', async () => {
    selectMock.mockReturnValueOnce(selectChain([script({ deliverBy: null })]));
    const update = updateChain([{ id: 'c1' }]);
    updateMock.mockReturnValue(update);
    expect(await reapStaleDeviceCommands()).toBe(1);
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: 'timeout' }) }));
  });

  it('terminal UPDATE is a CAS on the observed status (pending) — never IN (pending, sent)', async () => {
    selectMock.mockReturnValueOnce(selectChain([script({ deliverBy: new Date(now - 1000) })]));
    const update = updateChain([{ id: 'c1' }]);
    updateMock.mockReturnValue(update);
    await reapStaleDeviceCommands();
    const whereSql = new PgDialect().sqlToQuery(update.where.mock.calls[0]![0]);
    expect(whereSql.sql).toContain('"device_commands"."status" = $');
    expect(whereSql.sql).not.toMatch(/status" in \(/i);
  });
});
```

`updateChain` helper (add beside `selectChain` if the copied header lacks it):

```ts
function updateChain(returning: unknown) {
  const chain: Record<string, any> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(async () => returning);
  return chain;
}
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement in `reapStaleDeviceCommands`**

Replace the WHERE pre-filter and the per-row loop:

```ts
  const now = Date.now();
  const nowDate = new Date(now);
  const conservativeCutoff = new Date(now - SHORTEST_TIMEOUT_MS);
  const whereConditions = [
    inArray(deviceCommands.status, ['pending', 'sent']),
    // Genuinely-due rows first (#5128): a pending row is due when its own
    // deliver_by has passed; legacy/sent rows keep the conservative age cutoff.
    or(
      and(eq(deviceCommands.status, 'pending'), isNotNull(deviceCommands.deliverBy), lt(deviceCommands.deliverBy, nowDate)),
      and(isNull(deviceCommands.deliverBy), lt(deviceCommands.createdAt, conservativeCutoff)),
      and(eq(deviceCommands.status, 'sent'), lt(deviceCommands.createdAt, conservativeCutoff)),
    ),
  ];
  // ... existing excludedTypes + self_uninstall exemption pushes unchanged ...

  for (const cmd of staleCommands) {
    const timeoutMs = getCommandTimeoutMs(cmd.type, cmd.payload as Record<string, unknown> | null);
    let due: boolean;
    let kind: 'expired' | 'timeout';
    let errorMsg: string;
    if (cmd.status === 'pending' && cmd.deliverBy) {
      due = cmd.deliverBy.getTime() <= now;
      kind = 'expired';
      errorMsg = `Device did not reconnect before ${cmd.deliverBy.toISOString()}; command was never delivered`;
    } else if (cmd.status === 'sent' && cmd.executedAt) {
      due = now - cmd.executedAt.getTime() >= timeoutMs;
      kind = 'timeout';
      errorMsg = `Server-side timeout: no response from agent after ${Math.round(timeoutMs / 60000)} minutes`;
    } else {
      due = now - cmd.createdAt.getTime() >= timeoutMs;
      kind = 'timeout';
      errorMsg = `Command expired: agent never received the command (${Math.round(timeoutMs / 60000)} min timeout)`;
    }
    if (!due) continue;

    const completedAt = new Date();
    const result = kind === 'expired'
      ? { status: 'expired', reason: 'not_delivered_before_deadline', error: errorMsg, timedOutBy: 'server' }
      : { status: 'timeout', error: errorMsg, timedOutBy: 'server' };
    // CAS on the OBSERVED state: a row observed pending but claimed between the
    // SELECT and this UPDATE must not be failed the instant it was delivered.
    const observedGuard = cmd.status === 'sent'
      ? and(eq(deviceCommands.id, cmd.id), eq(deviceCommands.status, 'sent'), cmd.executedAt ? eq(deviceCommands.executedAt, cmd.executedAt) : isNull(deviceCommands.executedAt))
      : and(eq(deviceCommands.id, cmd.id), eq(deviceCommands.status, 'pending'));
    const updated = await db.update(deviceCommands)
      .set({ status: 'failed', completedAt, result, ...terminalPayloadErasureSet() })
      .where(observedGuard)
      .returning({ id: deviceCommands.id });
    if (updated.length === 0) continue;
    reaped++;
    await applyAutomationActionTerminal({ source: 'reaper', commandId: updated[0]!.id, terminalStatus: kind === 'expired' ? 'expired' : 'timed_out', error: errorMsg, completedAt });
    // ... existing backup/restore metric calls unchanged ...
    try {
      await propagateTimedOutDeviceCommand({ commandId: cmd.id, payload: (cmd.payload as Record<string, unknown> | null) ?? null, errorMsg, completedAt, kind });
    } catch (error) { /* existing handler */ }
  }
```

Add `deliverBy` and `executedAt` to the reaper's SELECT projection if it is not `select()` (check ~296). Import `isNotNull, isNull, or` from `drizzle-orm`. If `applyAutomationActionTerminal`'s `terminalStatus` union lacks `'expired'`, add it in `services/automationActionResults.ts` (W4 relies on it) and map it to the same terminal state as `timed_out` with `reason` preserved.

- [ ] **Step 4: `propagateTimedOutDeviceCommand` gets `kind`** — extend its input type with `kind: 'expired' | 'timeout'` and, for `expired`, write `errorMessage = 'Device did not reconnect before <deadline>'` and status `failed` (scripts: `script_executions.status='failed'`; software: `deployment_results.status='failed'`). Find the function with `grep -rn "export async function propagateTimedOutDeviceCommand" apps/api/src` and update its co-located test.

- [ ] **Step 5: `reapStaleScriptExecutions` — stop expiring undelivered work**

In the per-row loop, after computing `cmd`:

```ts
    // #5128: the delivery clock has ONE owner (reapStaleDeviceCommands). A
    // not-yet-running execution whose command is still pending is waiting for
    // the device; only the command reaper may expire it, and it propagates.
    if (exec.status !== 'running' && cmd && (cmd.status === 'pending' || cmd.status === 'sent')) continue;
```

(placed before `if (now - referenceTime < timeoutMs) continue;` so `running` rows keep today's `startedAt` rule and orphan executions with no command row still time out.)

- [ ] **Step 6: `reapStaleSoftwareDeploymentResults` — measure Tier 1 from claim time**

Add `commandExecutedAt: deviceCommands.executedAt` to the candidate projection and replace the `delivered` branch:

```ts
    const deliveredRef = row.commandExecutedAt ?? row.dispatchedAt;   // claim time when known
    const delivered = row.deviceCommandId === null || row.commandStatus === 'sent' || row.commandStatus === 'completed';
    if (delivered) {
      if (now - deliveredRef.getTime() < SOFTWARE_INSTALL_TIMEOUT_MS) continue;
      errorMessage = 'Server-side timeout: no response from agent';
    } else {
      // Queued for an offline device: NOT this reaper's clock. The command
      // reaper expires the row at deliver_by and propagates (#5128 §C).
      continue;
    }
```

Delete `SOFTWARE_QUEUED_EXPIRY_MS` and its import in `staleCommandReaper.test.ts`; remove the `if (commandType === CommandTypes.SOFTWARE_INSTALL) return SEVEN_DAYS;` line from `commandTimeouts.ts` so a *delivered* install times out on the agent's 55-min ceiling like any long command (add `SOFTWARE_INSTALL` to `LONG_TIMEOUT_TYPES` there if not already covered — check with `grep -n "SOFTWARE_INSTALL" apps/api/src/services/commandTimeouts.ts`). Update `commandTimeouts.test.ts` expectations.

- [ ] **Step 7: Run all reaper tests — expect PASS**

```bash
cd apps/api && npx vitest run src/jobs/staleCommandReaper src/services/commandTimeouts && npx tsc --noEmit -p .
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/jobs/staleCommandReaper.ts apps/api/src/jobs/staleCommandReaper.test.ts apps/api/src/jobs/staleCommandReaper.twoClocks.test.ts apps/api/src/services/commandTimeouts.ts apps/api/src/services/commandTimeouts.test.ts apps/api/src/services/propagateTimedOutDeviceCommand*.ts
git commit -m "fix(reaper): separate delivery deadline from execution timeout; CAS on observed state (#5128 W1)"
```

### Task 1.6: Late-binding delivery preparation (`prepareClaimedCommandsForDelivery`) + software persist-before-push

**Files:**
- Modify: `apps/api/src/services/commandDelivery.ts`; `apps/api/src/services/softwareDeployment.ts` (~113–140 dispatch, ~488–500 payload build); `apps/api/src/routes/agents/heartbeat.ts` (~350, ~771, ~1654 call sites — rename only); `apps/api/src/routes/agentWs.ts` (generic result path ~1655+ gains software reconciliation).
- Test: `apps/api/src/services/commandDelivery.test.ts` (extend or create), `apps/api/src/services/softwareDeployment.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  // commandDelivery.ts
  export type DeliveryRefresher = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  export const deliveryRefreshers: Record<string, DeliveryRefresher>;   // keyed by command type
  export async function prepareClaimedCommandsForDelivery(claimed: ClaimedCommand[], opts?): Promise<DeliverableCommand[]>;
  export const decryptClaimedCommandsForDelivery = prepareClaimedCommandsForDelivery;  // alias, removed in W5
  ```
  `dispatchSoftwareInstallToDevice` now returns `{ transport: 'ws' | 'queued'; deviceCommandId: string }` (never null) and its payload carries `s3Key` when the installer is S3-backed.

- [ ] **Step 1: Failing tests**

```ts
// apps/api/src/services/commandDelivery.test.ts — add
it('runs the per-type refresher before decrypt so time-limited fields are fresh at delivery', async () => {
  deliveryRefreshers['software_install'] = async (p) => ({ ...p, downloadUrl: 'https://fresh.example/installer' });
  const out = await prepareClaimedCommandsForDelivery([
    { id: 'c1', type: 'software_install', deviceId: 'd1', payload: { s3Key: 'k', downloadUrl: 'https://stale.example' }, executedAt: new Date() },
  ]);
  expect((out[0]!.payload as Record<string, unknown>).downloadUrl).toBe('https://fresh.example/installer');
  delete deliveryRefreshers['software_install'];
});
it('a refresher failure releases the row instead of delivering a stale payload', async () => {
  deliveryRefreshers['software_install'] = async () => { throw new Error('presign down'); };
  const out = await prepareClaimedCommandsForDelivery([{ id: 'c1', type: 'software_install', deviceId: 'd1', payload: {}, executedAt: new Date('2026-09-06T00:00:00Z') }]);
  expect(out).toEqual([]);
  expect(releaseClaimedCommandDelivery).toHaveBeenCalledWith('c1', new Date('2026-09-06T00:00:00Z'));
  delete deliveryRefreshers['software_install'];
});
```

```ts
// softwareDeployment.test.ts — add
it('persists the device_commands row BEFORE the WS push and pushes with the row id', async () => {
  sendCommandToAgentMock.mockReturnValue(true);
  const out = await dispatchSoftwareInstallToDevice('dep-1', { id: DEVICE, agentId: 'a1' }, { deploymentId: 'dep-1', retryCount: 0 }, USER, 0);
  expect(out.transport).toBe('ws');
  expect(out.deviceCommandId).toBeTruthy();
  expect(sendCommandToAgentMock.mock.calls[0]![1]).toMatchObject({ id: out.deviceCommandId, type: 'software_install' });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `prepareClaimedCommandsForDelivery`**

```ts
// commandDelivery.ts
export type DeliveryRefresher = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
/** Per-type hooks that re-materialise time-limited payload fields at the moment
 *  of delivery (#5128 §D). Registered by the owning feature module. */
export const deliveryRefreshers: Record<string, DeliveryRefresher> = {};

export async function prepareClaimedCommandsForDelivery(
  claimed: ClaimedCommand[],
  opts?: { reportedScriptSecretEnvVersion?: number },
): Promise<DeliverableCommand[]> {
  const refreshed: ClaimedCommand[] = [];
  for (const cmd of claimed) {
    const refresher = deliveryRefreshers[cmd.type];
    if (!refresher) { refreshed.push(cmd); continue; }
    try {
      const payload = cmd.payload && typeof cmd.payload === 'object' && !Array.isArray(cmd.payload) ? (cmd.payload as Record<string, unknown>) : {};
      refreshed.push({ ...cmd, payload: await refresher(payload) });
    } catch (err) {
      console.error('[commandDelivery] delivery refresher failed; releasing row for a later heartbeat', { commandId: cmd.id, type: cmd.type, error: err instanceof Error ? err.message : String(err) });
      if (cmd.executedAt) await releaseClaimedCommandDelivery(cmd.id, cmd.executedAt);
    }
  }
  // ...existing body of decryptClaimedCommandsForDelivery operating on `refreshed`...
}
export const decryptClaimedCommandsForDelivery = prepareClaimedCommandsForDelivery;
```

Also route the single-command push in `dispatchDeviceCommand` (Task 1.3) through the same refresher: call `deliveryRefreshers[type]?.(payload)` before `decryptCommandForDelivery`, releasing on failure.

- [ ] **Step 4: Software — register the refresher and persist first**

In `softwareDeployment.ts`, in the payload build (~488–500) add `s3Key: versionRecord.s3Key ?? undefined` next to `downloadUrl`, and register at module load:

```ts
deliveryRefreshers['software_install'] = async (payload) => {
  const s3Key = typeof payload.s3Key === 'string' ? payload.s3Key : null;
  if (!s3Key || !isS3Configured()) return payload;
  return { ...payload, downloadUrl: await getPresignedUrl(s3Key, 3600) };
};
```

Replace the body of `dispatchSoftwareInstallToDevice`:

```ts
  const res = await dispatchDeviceCommand({
    deviceId: device.id, type: 'software_install', payload, userId: createdBy ?? undefined,
    offlinePolicy: { kind: 'queue', deliverWithinMs: deliveryTtlMs('standard') },
  });
  if (!res.ok) throw new Error(`software_install dispatch refused: ${res.error}`);
  await db.update(deploymentResults).set({ deviceCommandId: res.command.id })
    .where(and(eq(deploymentResults.deploymentId, deploymentId), eq(deploymentResults.deviceId, device.id)));
  return { transport: res.delivery === 'delivered' ? 'ws' : 'queued', deviceCommandId: res.command.id };
```

Keep `deploymentId` and `retryCount` in the payload (the result reconciliation keys on them). Remove the `SW_INSTALL_COMMAND_ID_REGEX` special case as the *primary* path in `agentWs.ts` (~1075): keep it for in-flight frames from before the deploy, and add to the generic UUID path — right after the `command` row is loaded and before `submitCommandResult` — the same `if (command.type === 'software_install') { applySoftwareInstallResult({ deploymentId: payload.deploymentId, ... attemptNumber: payload.retryCount }) }` block that `routes/agents/commands.ts:551–572` already has. Extract that block into `services/softwareDeployment.ts` as `reconcileSoftwareInstallResult(command, normalizedData)` and call it from both routes so the two transports cannot drift.

- [ ] **Step 5: Rename call sites** — `heartbeat.ts` ×3: `decryptClaimedCommandsForDelivery` → `prepareClaimedCommandsForDelivery` (the alias keeps old imports compiling; rename anyway).

- [ ] **Step 6: Run — expect PASS**

```bash
cd apps/api && npx vitest run src/services/commandDelivery src/services/softwareDeployment src/routes/agentWs src/routes/agents/commands && npx tsc --noEmit -p .
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/commandDelivery.ts apps/api/src/services/commandDelivery.test.ts apps/api/src/services/softwareDeployment.ts apps/api/src/services/softwareDeployment.test.ts apps/api/src/routes/agentWs.ts apps/api/src/routes/agents/commands.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/services/dispatchDeviceCommand.ts
git commit -m "feat(commands): late-binding delivery preparation; software installs persist before push (#5128 W1)"
```

### Task 1.7: `dispatchScriptToDevice` takes `offlinePolicy`; generic device-command routes go through the seam; cancel endpoint; `status` filter

**Files:**
- Modify: `apps/api/src/services/scriptDispatch.ts` (~81 input type, ~193–218); `apps/api/src/routes/devices/commands.ts` (bulk ~150–269, single ~446–530, `set_auto_update` ~600–640, list ~858–900; add cancel route); `apps/api/src/routes/devices/schemas.ts` (if a response schema is declared).
- Test: `apps/api/src/services/scriptDispatch.test.ts` (extend), `apps/api/src/routes/devices/commands.test.ts` (extend or create), `apps/api/src/__tests__/devices.endpoints.test.ts` (existing route-scan — will flag the new route; add it to whatever allowlist it maintains).

**Interfaces:**
- `DispatchScriptInput.offlinePolicy?: OfflinePolicy` (new); `requireOnline?: boolean` kept as a deprecated alias → `{ kind: 'reject' }` (removed in W4).
- `DispatchScriptResult` ok-branch already has `delivered: boolean`; add `deliverBy: Date`.
- Routes: bulk response `{ commands, failed, skipped, queuedOffline: string[] }`; single response adds `delivery` and `deliverBy`; new `POST /:id/commands/:commandId/cancel` → `200 { id, status: 'cancelled' }` | `409 { error: 'Command is not pending' }`; `GET /:id/commands?status=pending` filters.

- [ ] **Step 1: Failing tests**

```ts
// scriptDispatch.test.ts — add
it('offline device + queue policy inserts the execution + command with a deliver_by (no live re-read)', async () => { /* mirror the existing "manual dispatch queues offline devices" case; assert queueCommand was called with options.deliverBy instanceof Date and options.submittedOrgId === device.orgId */ });
it('requireOnline:true is an alias for offlinePolicy reject', async () => { /* mirror the existing requireOnline rejection case unchanged */ });
```

```ts
// routes/devices/commands.test.ts — add (use the file's existing app/auth harness)
it('bulk: an offline device is queued and reported under queuedOffline, not failed', async () => { /* two devices, one offline; expect 201, body.queuedOffline = [offlineId], body.failed = [] */ });
it('cancel: flips a pending command to cancelled and 409s when already sent', async () => { /* ... */ });
it('list: ?status=pending returns only pending rows', async () => { /* assert eq(status,'pending') in where */ });
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: `scriptDispatch.ts`**

```ts
  requireOnline?: boolean;          // deprecated alias for offlinePolicy: { kind: 'reject' } — removed in W4
  offlinePolicy?: OfflinePolicy;
```

Replace the `if (input.requireOnline) { ... }` block:

```ts
  const offlinePolicy: OfflinePolicy = input.offlinePolicy ?? (input.requireOnline ? { kind: 'reject' } : defaultOfflinePolicy(CommandTypes.SCRIPT));
  if (offlinePolicy.kind === 'reject') {
    // ...existing live re-read + `device_offline` return, unchanged...
  }
  const deliverBy = deliverByFor(offlinePolicy);
```

and pass `{ deliverBy, submittedOrgId: device.orgId }` in the existing `queueCommand(...)` call; add `deliverBy` to the ok result.

- [ ] **Step 4: Generic routes through the seam**

Bulk (`/bulk/commands`): replace the try/insert block with

```ts
      const res = await dispatchDeviceCommand({ deviceId, type: data.type, payload: data.payload ?? {}, userId: auth.user.id });
      if (!res.ok) {
        failed.push({ deviceId, code: res.code === 'trust_denied' ? (res.error as TrustDenyCode) : 'INSERT_FAILED', message: res.error });
        continue;
      }
      commandList.push(sanitizeCommandForHistory(res.command));
      if (res.delivery === 'queued_offline') queuedOffline.push(deviceId);
```

(the seam already performs the trust check, so drop the route's own `assertDeviceExecuteAllowed`; keep the `refresh_inventory` ALREADY_PENDING dedup before the call). Return `{ commands: commandList, failed, skipped, queuedOffline }`. Single `/:id/commands` and `set_auto_update` likewise; single returns `{ ...sanitizeCommandForHistory(res.command), delivery: res.delivery, deliverBy: res.deliverBy }`.

- [ ] **Step 5: Cancel route**

```ts
commandsRoutes.post(
  '/:id/commands/:commandId/cancel',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const commandId = c.req.param('commandId')!;
    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) return c.json({ error: 'Access to this site denied' }, 403);
    const completedAt = new Date();
    const [row] = await db.update(deviceCommands)
      .set({ status: 'cancelled', completedAt, result: { status: 'cancelled', reason: 'user_cancelled', cancelledBy: auth.user.id }, ...terminalPayloadErasureSet() })
      .where(and(eq(deviceCommands.id, commandId), eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.status, 'pending')))
      .returning({ id: deviceCommands.id, type: deviceCommands.type, payload: deviceCommands.payload });
    if (!row) return c.json({ error: 'Command is not pending' }, 409);
    await propagateCancelledDeviceCommand({ commandId: row.id, type: row.type, payload: row.payload as Record<string, unknown> | null, completedAt });
    return c.json({ id: row.id, status: 'cancelled' });
  },
);
```

`propagateCancelledDeviceCommand` lives beside `propagateTimedOutDeviceCommand` and marks the owning record: `script_executions` → `cancelled`, `deployment_results` → `cancelled` (via `deviceCommandId`), `patch_job_results` → `skipped` with `errorMessage='cancelled'` (W3 fills the patch branch; W1 ships the script + software branches and a no-op default). Note: `terminalPayloadErasureSet()` nulls the payload — capture `row.payload` in `.returning` *before* the set applies? It does not: `returning` reflects post-update values. Instead SELECT the row first (`id, type, payload, status`) and then CAS-update; pass the selected payload to the propagator.

- [ ] **Step 6: List filter** — in `GET /:id/commands` read `status` from `c.req.query()`, validate against `['pending','sent','completed','failed','cancelled']`, and add `eq(deviceCommands.status, status)` to both the count and list `where` when present.

- [ ] **Step 7: Cancel-on-event** — `moveOrg.ts` (~297, inside the same `tx` right after the `devices` UPDATE) and `core.ts` decommission (~1813, inside the same `tx` after the status write):

```ts
      await tx.update(deviceCommands)
        .set({ status: 'cancelled', completedAt: new Date(), result: { status: 'cancelled', reason: 'device_moved_org' }, ...terminalPayloadErasureSet() })
        .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.status, 'pending')));
```

(decommission uses `reason: 'device_decommissioned'` and adds `ne(deviceCommands.type, 'self_uninstall')` so the uninstall drain row survives). Add one assertion to each route's existing test file.

- [ ] **Step 8: Run — expect PASS**

```bash
cd apps/api && npx vitest run src/services/scriptDispatch src/routes/devices/commands src/routes/devices/moveOrg src/routes/devices/core src/__tests__/devices.endpoints.test.ts && npx tsc --noEmit -p .
```

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/scriptDispatch.ts apps/api/src/services/scriptDispatch.test.ts apps/api/src/routes/devices/commands.ts apps/api/src/routes/devices/commands.test.ts apps/api/src/routes/devices/moveOrg.ts apps/api/src/routes/devices/core.ts apps/api/src/services/propagateTimedOutDeviceCommand*.ts apps/api/src/__tests__/devices.endpoints.test.ts
git commit -m "feat(commands): generic routes via the seam, cancel endpoint, cancel-on-move/decommission (#5128 W1)"
```

### Task 1.8: Integration test against real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/deviceCommandOfflineQueue.integration.test.ts`

Follow the harness used by `apps/api/src/__tests__/integration/scriptAdmission.integration.test.ts` (partner/org/device fixtures, `withSystemDbAccessContext`). Cases (each is its own `it`):

1. `dispatchDeviceCommand` with `queue` against `status='offline'` → row `pending`, `deliver_by ≈ now + ttl`, `submitted_org_id = org`.
2. Advance the clock past the *execution* timeout but not `deliver_by` (insert with `created_at` 2 h ago): `reapStaleDeviceCommands()` reaps 0.
3. Insert with `deliver_by` 1 s in the past: reaper reaps 1, `result.status='expired'`, `result.reason='not_delivered_before_deadline'`; a linked `script_executions` row is `failed` with the reconnect message (propagation), and `reapStaleScriptExecutions()` on the same fixture with a *future* `deliver_by` reaps 0.
4. `claimPendingCommandsForDevice` after flipping the device `online` returns the row and marks it `sent`; a second call returns nothing.
5. Row with `deliver_by` in the past is **not** returned by the claim.
6. Move the device to another org (`UPDATE devices SET org_id`) then claim → row `cancelled` with `reason='device_moved_org'`, nothing returned.
7. Two pending rows `refresh_inventory` + `reboot`: first claim returns only `refresh_inventory`; after marking it `completed`, the next claim returns `reboot`.
8. `dispatchDeviceCommand` with `reject` against an offline device → `device_offline`, `SELECT count(*)` unchanged.
9. Cancel endpoint via `app.request` → 200 then 409 on repeat.

- [ ] Run locally against the dev DB:

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceCommandOfflineQueue.integration.test.ts
```

- [ ] Commit: `git commit -m "test(commands): offline queue integration coverage (#5128 W1)"`

### Wave 1 verification (before opening the PR)

```bash
cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/command src/jobs/staleCommandReaper src/routes/devices src/services/scriptDispatch src/services/softwareDeployment
cd ../.. && pnpm lint
```

PR body: `Closes #<W1 sub-issue>`; note the flag is off; list the two fixed latent defects (software WS path created no row; software result reaper measured from dispatch). Merge on green.

---

## Wave 2 — Scripts + generic-command UX: admission `delivery`, device-page queued list, uniform copy

### Task 2.1: `ScriptTargetAdmission.delivery`

**Files:** `packages/shared/src/types/scriptAdmission.ts`; `apps/api/src/services/scriptExecution.ts` (where `targets.push({ requestedDeviceId, admission: 'admitted', executionId, commandId, batchId })` is built); `apps/api/src/services/scriptExecution.admission.test.ts`; `apps/api/src/openapi.scriptAdmission.test.ts` + the OpenAPI schema it checks.

- [ ] Test: an admitted target whose dispatch returned `delivered: false` carries `delivery: 'queued_offline'`; `delivered: true` → `'delivered'`.
- [ ] Type: `delivery?: 'delivered' | 'queued_offline';` on `ScriptTargetAdmission`.
- [ ] Impl: `delivery: dispatch.delivered ? 'delivered' : 'queued_offline'` at the push site; OpenAPI `ScriptAdmissionTarget.properties.delivery = { type: 'string', enum: ['delivered','queued_offline'] }`.
- [ ] Commit: `feat(scripts): report delivery state per admitted target (#5128 W2)`

### Task 2.2: Device page "Queued actions" section with Cancel

**Files:**
- Create: `apps/web/src/components/devices/DeviceQueuedActions.tsx`, `DeviceQueuedActions.test.tsx`
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx` (render above the activity feed for non-decommissioned devices); `apps/web/src/locales/en/devices.json` (+ every other locale file under `apps/web/src/locales/*/devices.json` gets the same keys with English fallback — the tr-TR parity test fails otherwise).

**Interfaces:** `GET /devices/:id/commands?status=pending&limit=50` (W1) → `{ data: Array<{ id, type, createdAt, deliverBy, createdBy }> }`; `POST /devices/:id/commands/:commandId/cancel`.

- [ ] Test (jsdom): renders one row per pending command with type label, requester, "expires {{date}}"; Cancel calls the endpoint through `runAction` and removes the row on success; hidden when the list is empty; 401 from the fetch is swallowed (auth redirect owns it).
- [ ] Impl: `fetchWithAuth` (auto-injects orgId) for the list; `runAction` wrapper for cancel (`apps/web/src/lib/runAction.ts`); `data-testid="device-queued-actions"`, `data-testid="queued-action-cancel"`. Keys: `devices.queuedActions.title` = "Queued actions", `.expires` = "Expires {{date}}", `.cancel` = "Cancel", `.cancelled` = "Queued action cancelled", `.empty` (unused, hidden).
- [ ] Register the new file in `apps/web/src/lib/runActionAllowlist.ts` only if it legitimately bypasses `runAction` (it should not).
- [ ] Commit: `feat(web): device page queued-actions list with cancel (#5128 W2)`

### Task 2.3: Uniform "queued — device offline" copy

**Files:** `apps/web/src/components/devices/DevicesPage.tsx` (~930 bulk toast; read `queuedOffline` from the W1 response); `apps/web/src/components/devices/DeviceActions.tsx` (single-command toast reads `delivery`/`deliverBy`); `apps/web/src/components/scripts/executionStatus.ts` (`queued` label → `status.queuedOffline` = "Queued — device offline"); `apps/web/src/components/scripts/ScriptExecutionModal.tsx` (the success path reads `targets[].delivery` and toasts "Runs when the device is online — expires {{date}}" when any target is `queued_offline`); `apps/web/src/components/software/DeploymentProgress.tsx` (~94, ~511: switch the "Queued — device offline" condition to the `delivery` value if the deployment-result API exposes it; otherwise keep the `deviceCommandId` inference and note it).

- [ ] Tests: one per component change — assert the exact string from the locale key.
- [ ] Commit: `feat(web): uniform queued-offline feedback across bulk, single, script and deployment flows (#5128 W2)`

### Wave 2 verification

```bash
cd apps/web && npx vitest run src/components/devices/DeviceQueuedActions src/components/devices/DevicesPage src/components/scripts src/components/software/DeploymentProgress && npx astro check
cd ../api && npx vitest run src/services/scriptExecution src/openapi.scriptAdmission.test.ts
```

---

## Wave 3 — Patches: `queued` results, non-terminal jobs, idempotent finalizer, `offlineBehavior`, supersession, suppression hold

### Task 3.1: Migration + schema + validator + export policy

**Files:** `apps/api/migrations/2026-10-13-100100-patch-offline-queue.sql`; `apps/api/src/db/schema/patches.ts` (`patchJobResultStatusEnum` + `patchJobs.devicesQueued`); `apps/api/src/db/schema/configurationPolicies.ts` (`configPolicyPatchSettings.offlineBehavior`); `packages/shared/src/validators/index.ts` (`patchInlineSettingsSchema` + `offlineBehavior: z.enum(['skip','queue']).default('queue')`, placed after `scheduleDayOfMonth`); `apps/api/src/services/tenantExportPolicyRegistry.ts` (`patch_jobs` entry gains `devices_queued` in `included`).

```sql
-- 2026-10-13-100100: patch installs queue for offline devices (#5128 W3).
-- 'queued' = install_patches command persisted with a deliver_by, waiting for
-- the device's next heartbeat. patch_jobs.devices_queued keeps the job
-- non-terminal while any device waits. config_policy_patch_settings has no
-- org_id/partner_id (tenancy transitive via feature_link_id) — no RLS change.
ALTER TYPE patch_job_result_status ADD VALUE IF NOT EXISTS 'queued';
ALTER TABLE patch_jobs ADD COLUMN IF NOT EXISTS devices_queued integer NOT NULL DEFAULT 0;
ALTER TABLE config_policy_patch_settings ADD COLUMN IF NOT EXISTS offline_behavior varchar(20) NOT NULL DEFAULT 'queue';
DO $$ BEGIN
  ALTER TABLE config_policy_patch_settings ADD CONSTRAINT config_policy_patch_settings_offline_behavior_chk
    CHECK (offline_behavior IN ('skip', 'queue'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

- [ ] Tests: validator accepts/defaults `offlineBehavior`; `tenant-export-policy.integration.test.ts` green locally; `autoMigrate.test.ts`; `db:check-drift`.
- [ ] Wire `offlineBehavior` through the config-policy patch-settings read/write path (grep `rebootAllowDeferral` in `apps/api/src/routes/configurationPolicies/` and `apps/api/src/services/featureConfigResolver.ts` and add the field beside it in every mapper).
- [ ] Commit: `feat(patches): queued result status, devices_queued, offline_behavior (#5128 W3)`

### Task 3.2: Idempotent patch-job finalizer registered as the `install_patches` result handler

**Files:** Create `apps/api/src/services/patchJobFinalizer.ts` + `.test.ts`; modify `apps/api/src/services/commandResultHandlers.ts` (`install_patches: handleInstallPatchesResult`), `apps/api/src/jobs/patchJobExecutor.ts` (`recordDeviceExecution` delegates to the finalizer), `apps/api/src/services/propagateTimedOutDeviceCommand*.ts` and the cancel propagator (patch branch → finalizer).

**Interfaces:**
```ts
export type PatchDeviceTerminal =
  | { kind: 'result'; commandResult: unknown }
  | { kind: 'expired'; message: string }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'superseded'; byJobId: string };
export async function finalizePatchJobDevice(input: { patchJobId: string; deviceId: string; commandId: string; terminal: PatchDeviceTerminal; completedAt: Date }): Promise<{ applied: boolean }>;
export const handleInstallPatchesResult: CommandResultHandler;   // reads payload.patchJobId, delegates
```
Idempotency key: the per-device `patch_job_results` rows for `(jobId, deviceId)` must all be non-terminal (`pending`|`running`|`queued`) for the finalizer to apply; a second call returns `{ applied: false }` without touching counters. Counters: `queued → completed/failed` decrements `devices_queued`; `pending/running → …` decrements `devices_pending` (existing behaviour, moved here). Reboot evaluation (existing block in `recordDeviceExecution`) runs only for `kind: 'result'`. After counters, call `checkAndFinalizeJob`, which now terminalises only when `devices_pending = 0 AND devices_queued = 0`.

- [ ] Tests: result twice → one counter write; expired → `failed` with the reconnect message; cancelled → `skipped`; superseded → `skipped` + `errorMessage='superseded_by_next_occurrence'`; job stays `running` while `devices_queued > 0`.
- [ ] `install_patches` payload must carry `patchJobId` — confirm in `prepareDeviceExecution` (~1053 `queueCommandForExecution(deviceId, 'install_patches', { patchIds, patches })`) and add it.
- [ ] Commit: `feat(patches): idempotent per-device finalizer shared by sync and deferred paths (#5128 W3)`

### Task 3.3: Executor queues offline devices; completion checker honours `queued`

**Files:** `apps/api/src/jobs/patchJobExecutor.ts` (`prepareDeviceExecution` ~1053–1070, `processExecuteDevice` ~758, `processCheckCompletion` ~692–723, `checkAndFinalizeJob` ~1383); `apps/api/src/jobs/patchJobExecutor.test.ts` (extend).

- [ ] In `prepareDeviceExecution`, replace the `queueCommandForExecution` call with `dispatchDeviceCommand({ deviceId, type: 'install_patches', payload: { patchJobId, patchIds, patches }, previouslyRejected: true, offlinePolicy: resolvePatchOfflinePolicy(settings, nextOccurrenceAt) })` where `resolvePatchOfflinePolicy` returns `{ kind: 'reject' }` for `offlineBehavior: 'skip'` and `{ kind: 'queue', deliverWithinMs: min(deliveryTtlMs('standard'), nextOccurrenceAt - now) }` otherwise (`nextOccurrenceAt` comes from `patchJobs.targets.scheduleNextOccurrenceAt`, which Task 3.4 stamps; manual jobs have none → standard TTL). If `res.delivery === 'queued_offline'`: update the device's `patch_job_results` to `queued`, `devices_pending - 1`, `devices_queued + 1`, and return `{ queued: true }` so `processExecuteDevice` skips the poll and `recordDeviceExecution`.
- [ ] `processCheckCompletion`: when `devicesPending === 0 && devicesQueued > 0` → leave `running`, do not force-fail; log `waiting for N queued devices`. Force-fail applies only to `devicesPending`.
- [ ] Tests: offline device → `queued`, counters, task completes without polling; completion checker leaves the job `running`.
- [ ] Commit: `feat(patches): queue install_patches for offline devices; job stays open while devices wait (#5128 W3)`

### Task 3.4: Scheduler supersession + claim-time suppression hold

**Files:** `apps/api/src/jobs/patchSchedulerWorker.ts` (`scanAndCreateJobs` ~469–640: stamp `targets.scheduleNextOccurrenceAt`; after creating a new occurrence job, cancel prior-job pending `install_patches` rows for the same devices via `finalizePatchJobDevice({ terminal: { kind: 'superseded', byJobId } })`); `apps/api/src/services/commandClaimEligibility.ts` registration in `apps/api/src/services/patchJobFinalizer.ts`:

```ts
typeHolds['install_patches'] = async (deviceId) => {
  const m = await checkDeviceMaintenanceWindow(deviceId);
  return m.active && m.suppressPatching;
};
```

- [ ] `getDueOccurrenceKey` has the schedule; add `getNextOccurrenceAt(settings, timezone, now): Date` beside it (same frequency/day/time arithmetic, next strictly-after `now`), unit-tested for daily/weekly/monthly incl. month rollover.
- [ ] Tests: supersession cancels only `pending` rows of the *previous* job for *overlapping* devices; hold returns true inside an active suppression window.
- [ ] Commit: `feat(patches): supersede queued installs on the next occurrence; hold delivery during suppression windows (#5128 W3)`

### Task 3.5: Config-policy patch settings UI radio

**Files:** locate with `grep -rln "rebootAllowDeferral" apps/web/src/components` (the patch settings form for configuration policies) and add a radio group `offlineBehavior` ("Queue for offline devices — runs on the next check-in, before the next scheduled run" / "Skip offline devices") beside the schedule fields; locale keys under `policies.patch.offlineBehavior.*`; test asserts both options render and the default is `queue`.

- [ ] Commit: `feat(web): patch policy offline-behaviour option (#5128 W3)`

### Wave 3 verification

```bash
cd apps/api && npx tsc --noEmit -p . && npx vitest run src/jobs/patchJobExecutor src/jobs/patchSchedulerWorker src/services/patchJobFinalizer src/services/commandResultHandlers
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```

Add an integration case to `deviceCommandOfflineQueue.integration.test.ts`: a scheduled job with one offline device leaves it `queued` and the job `running`; posting an `install_patches` result through `app.request` on the agent result route finalises the device and completes the job.

---

## Wave 4 — Automations: `whenOffline`, `queued` step state, remove the `requireOnline` alias

### Task 4.1: Validator + runtime

**Files:** `packages/shared/src/validators/index.ts` (`run_script` and `execute_command` variants gain `whenOffline: z.enum(['queue','skip']).default('queue')`; `deploy_software` inherits software's queueing and needs no field); `apps/api/src/services/automationRuntime.ts` (~1405–1417 and ~1503–1514: replace `requireOnline: true` with `offlinePolicy: action.whenOffline === 'skip' ? { kind: 'reject' } : { kind: 'queue', deliverWithinMs: deliveryTtlMs('standard') }`, gated by `previouslyRejected` semantics — pass `offlinePolicy` only when `isOfflineQueueEnabled()`; otherwise pass `{ kind: 'reject' }`); on `dispatch.ok && !dispatch.delivered` return outcome `{ status: 'queued', message: 'Queued — device offline' }` and write the `automation_action_results` row as `queued` (`services/automationActionResults.ts` — add `'queued'` to its status union if absent; the reaper's `applyAutomationActionTerminal` with `'expired'` from W1 closes it).
- [ ] Tests: validator default; runtime queued path writes `queued` and does not fail the run; `skip` reproduces today's failure message.
- [ ] Remove `requireOnline` from `DispatchScriptInput` and every caller (`grep -rn requireOnline apps/api/src`).
- [ ] Commit: `feat(automations): whenOffline action option; queued step state (#5128 W4)`

### Task 4.2: Automation form control

**Files:** the automation action editor (`grep -rln "runAs" apps/web/src/components/automations`), add a select "If the device is offline: Queue (default) / Skip"; locale keys `automations.actions.whenOffline.*`; test.
- [ ] Commit: `feat(web): automation action offline behaviour (#5128 W4)`

### Task 4.3: Flip the flag default

- [ ] `DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED` default becomes `true` in `commandOfflinePolicy.ts` (`!== 'false'`), `.env.example` files documented, release note drafted in the PR body. Commit: `feat(commands): enable offline queueing for patches and automations by default (#5128 W4)`

---

## Wave 5 — AI-tool text, docs sweep, flag removal

- [ ] `apps/api/src/services/aiToolsScripts.ts` and every `aiTools*.ts` with a `requireOnline`-style guard (`grep -rn "is not online" apps/api/src/services/aiTools*.ts`): the error text gains one sentence — "This tool needs a live connection; to run when the device reconnects use the Run Script / deployment tools instead." No behaviour change.
- [ ] Docs (one PR): `apps/docs/src/content/docs/features/{patch-management,scripts,deployments,fleet-hygiene,incident-response}.mdx` — replace every offline sentence with the single promise: queued on the device's next successful heartbeat, per-class expiry (7 days standard, 24 hours inventory/power-state), cancellable from the device page; patch jobs stay open while devices wait and the next scheduled run supersedes a still-waiting install. Use the `update-breeze-docs` skill.
- [ ] Remove the flag and `isOfflineQueueEnabled()`, the `previouslyRejected` option, and the `decryptClaimedCommandsForDelivery` alias; delete `SW_INSTALL_COMMAND_ID_REGEX` fallback if no in-flight frames can remain (one release after W1). Commit: `chore(commands): remove offline-queue flag and W1 compatibility aliases (#5128 W5)`

---

## Wave 6 — Principal rehydration at claim (starts only after #3985 merges)

Precondition: `apps/api/src/services/recoveryAuthorizationSubject.ts` exists on `main`. Re-read it first; its exported names on the #3985 branch are `RecoveryAuthorizationSubjectRow`, `CapturedRecoveryAuthorizationSubject`, `LiveUserAuthorization`, `RecoveryAuthorizationSubjectDependencies` and the capture/verify functions around line 535.

- [ ] Migration `…-device-commands-authorization-subject.sql`: `ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS authorization_subject jsonb;` (system-scoped table → no export-policy entry).
- [ ] `dispatchDeviceCommand` captures the subject for user-initiated commands (`userId` present) using the merged capture helper; `partitionClaimable` verifies it (live grant + org/site + `devices:execute` permission) and cancels with `reason: 'authorization_revoked'` on failure; rows with `authorization_subject IS NULL` (system/automation work) keep the W1 checks.
- [ ] Integration test: revoke the requester's `devices:execute` permission after enqueue → claim cancels the row.
- [ ] Commit: `feat(commands): rehydrate requester authorization at claim (#5128 W6)`

---

## Deliberately NOT in this plan

Backups/restores queueing; live-session routes; wake-on-LAN; maintenance windows by device filter (#4981 first half); coalescing beyond `ALREADY_PENDING`; agent-side start deadlines; partner-configurable TTL UI; fleet-wide "Pending work" page; notifications when deferred work runs; fixing `patchRebootHandler` `if_required` ignoring suppression windows (file as its own issue when W3 starts).

## Self-review notes

- Spec coverage: §A→1.2/1.3; §B→1.1; §C→1.5; §D→1.3/1.6/1.7 (call-site table: patches 3.3, automations 4.1, software 1.6, generic 1.7, scripts 1.7, DR/backups/AI tools unchanged = `reject` via `previouslyRejected` or explicit policy); §E→1.4 (predicates, barrier), OD-5 not in v1; §F scripts→2.1/2.3, software→1.6/2.3, patches→3.x, automations→4.1; §G→1.4/1.7; §H→2.2/2.3; §I→2.1; §J none; OD-1→1.2; OD-2→3.3/3.4; OD-3→1.4; OD-4→1.4 + W6; OD-6 dissolved (admission types already on main); OD-7→2.3; OD-8→1.6; OD-9→3.3.
- Names used consistently: `dispatchDeviceCommand`, `resolveOfflinePolicy`, `deliverByFor`, `deliveryTtlMs`, `partitionClaimable`, `typeHolds`, `deliveryRefreshers`, `prepareClaimedCommandsForDelivery`, `finalizePatchJobDevice`, `propagateTimedOutDeviceCommand({ kind })`, `propagateCancelledDeviceCommand`.
- Known judgement calls left to the executor, each bounded: exact `users` status column name (1.4 step 3 note); exact export names for `decryptCommandForDelivery`/`toAgentCommandFrame` (1.3 step 4 note); location of the patch-settings web form (3.5 grep).
