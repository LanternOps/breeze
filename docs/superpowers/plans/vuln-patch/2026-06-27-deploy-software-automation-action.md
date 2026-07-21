# Software Deployment Automation Action — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `deploy_software` automation action that installs the latest catalog version of a chosen app on targeted devices, reusing Breeze's existing software-deployment subsystem.

**Architecture:** A fifth automation action type referencing a `softwareCatalog` entry. The deployment create+dispatch logic currently inline in `POST /deployments` is extracted into a reusable `createSoftwareDeployment()` service that both the route and the automation executor call. Because a software deployment is one-to-many (one deployment, many devices) while the existing action loop is per-device, `deploy_software` runs as a **batched pass** over the run's devices — one `softwareDeployments` row per action — rather than inside the per-device action loop. Idempotency: skip devices whose installed version is already ≥ the catalog's latest (`software_inventory`); unknown/unparseable installed version → deploy (safe default).

**Tech Stack:** Hono + TypeScript API, Drizzle ORM (PostgreSQL), BullMQ workers, Vitest, Zod (shared validators), React/Astro web.

## Global Constraints

- **Tenancy:** `automation_runs.config_policy_id` MUST be the resolved **policy** id (`configurationPolicies.id`), never the feature-link id (#1855 contract). `softwareDeployments.orgId` = the run's org. The automation worker runs under `withSystemDbAccessContext`.
- **No new tables.** Reuse `softwareCatalog`, `softwareVersions`, `softwareDeployments`, `deploymentResults`, `software_inventory`.
- **TDD:** every task writes the failing test first, watches it fail, then implements. Co-locate tests beside source (`foo.ts` → `foo.test.ts`).
- **Version semantics:** always "latest of catalog entry," resolved from `softwareVersions.isLatest` at run time. No version pinning, no force-reinstall in this scope.
- **Run API tests:** `cd apps/api && npx vitest run <path>`.

---

### Task 1: Extract `createSoftwareDeployment()` service from the deploy route

**Files:**
- Create: `apps/api/src/services/softwareDeployment.ts`
- Create (test): `apps/api/src/services/softwareDeployment.test.ts`
- Modify: `apps/api/src/routes/software.ts` (the `POST /deployments` handler, ~lines 1021–1189) to call the new service

**Interfaces:**
- Produces:
  ```ts
  export interface CreateSoftwareDeploymentInput {
    orgId: string;
    softwareVersionId: string;
    deploymentType: 'install' | 'update' | 'uninstall';
    deviceIds: string[];
    scheduleType: 'immediate' | 'scheduled' | 'maintenance';
    createdBy: string | null;
    name?: string;
    scheduledAt?: Date | null;
    options?: Record<string, unknown>;
  }
  export interface CreateSoftwareDeploymentResult {
    deploymentId: string;
    status: 'pending' | 'failed';
    message?: string;
    dispatchedDeviceIds: string[];
  }
  export async function createSoftwareDeployment(
    input: CreateSoftwareDeploymentInput,
  ): Promise<CreateSoftwareDeploymentResult>;
  ```
- Consumes: existing helpers already imported by `routes/software.ts` — `getPresignedUrl`, `isS3Configured`, `isS3NotFound`, `resolveEdrInstaller`, `sendCommandToAgent`, the `AgentCommand` type, and the `softwareVersions`/`softwareCatalog`/`softwareDeployments`/`deploymentResults`/`devices` Drizzle tables.

- [ ] **Step 1: Read the current route handler.** Read `apps/api/src/routes/software.ts:1021-1189`. Identify the exact block that: looks up `versionRecord` + `catalogItem`, inserts the `softwareDeployments` row, inserts `deploymentResults` rows (status `pending`), and (for `scheduleType:'immediate' && deploymentType:'install'`) runs the S3 presign → EDR resolve → fallback → `sendCommandToAgent` dispatch (lines 1094–1175). This whole block becomes the service body.

- [ ] **Step 2: Write the failing test.**

`apps/api/src/services/softwareDeployment.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendCommandMock } = vi.hoisted(() => ({ sendCommandMock: vi.fn() }));
vi.mock('../services/agentCommands', () => ({ sendCommandToAgent: sendCommandMock }));
// Mock S3 + EDR helpers as no-ops/passthroughs so the dispatch path is exercised
// without external calls. (Match the real import paths used by routes/software.ts.)
vi.mock('../services/s3', () => ({
  getPresignedUrl: vi.fn(async () => 'https://signed.example/pkg.exe'),
  isS3Configured: () => true,
  isS3NotFound: () => false,
}));

// Drizzle db mock: capture inserts, return a deployment id, and serve a version row.
// Follow the existing db-mock pattern used in other services/*.test.ts in this repo.
// (See apps/api/src/services/*.test.ts for the canonical chainable-mock shape.)

import { createSoftwareDeployment } from './softwareDeployment';

describe('createSoftwareDeployment', () => {
  beforeEach(() => { sendCommandMock.mockReset(); });

  it('creates a deployment + per-device results and dispatches software_install for immediate install', async () => {
    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      softwareVersionId: 'ver-1',
      deploymentType: 'install',
      deviceIds: ['dev-1', 'dev-2'],
      scheduleType: 'immediate',
      createdBy: 'system:automation',
    });

    expect(result.status).toBe('pending');
    expect(result.dispatchedDeviceIds).toEqual(['dev-1', 'dev-2']);
    expect(sendCommandMock).toHaveBeenCalledTimes(2);
    expect(sendCommandMock.mock.calls[0][1].type).toBe('software_install');
  });

  it('returns status "failed" with a message when no installer URL is available', async () => {
    // Arrange the version mock to have null s3Key AND null downloadUrl.
    const result = await createSoftwareDeployment({
      orgId: 'org-1', softwareVersionId: 'ver-no-url', deploymentType: 'install',
      deviceIds: ['dev-1'], scheduleType: 'immediate', createdBy: null,
    });
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/No installer available/i);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
});
```

> Note: match the exact mock import paths to whatever `routes/software.ts` imports (e.g. the S3 helper module, the EDR resolver module, the agent-command sender). Read the import block at the top of `routes/software.ts` and mirror those specifiers.

- [ ] **Step 3: Run test to verify it fails.**

Run: `cd apps/api && npx vitest run src/services/softwareDeployment.test.ts`
Expected: FAIL — `createSoftwareDeployment is not a function` / module not found.

- [ ] **Step 4: Implement the service.** Move the identified block from the route into `softwareDeployment.ts`, parameterized by `CreateSoftwareDeploymentInput`. Preserve behavior exactly:
  - Look up `versionRecord` (softwareVersions) + `catalogItem` (softwareCatalog) by `softwareVersionId`.
  - Insert one `softwareDeployments` row (`orgId`, `softwareVersionId`, `deploymentType`, `targetType:'devices'`, `targetIds: deviceIds`, `scheduleType`, `scheduledAt`, `createdBy`, `name`, `options`).
  - Insert `deploymentResults` (one per device, status `pending`).
  - If `scheduleType==='immediate' && deploymentType==='install'`: run the S3 presign → EDR resolve (`huntress`/`sentinelone`) → fallback URL logic exactly as in the route; on no-URL or EDR error, mark results `failed` and return `{ status:'failed', message, dispatchedDeviceIds: [] }`; otherwise look up `agentId` per device and `sendCommandToAgent` the `software_install` command (same payload shape as `routes/software.ts:1156-1171`), and return `{ status:'pending', dispatchedDeviceIds }`.
  - For non-immediate or non-install: return `{ status:'pending', dispatchedDeviceIds: [] }`.

- [ ] **Step 5: Rewire the route to call the service.** In `routes/software.ts`, replace the moved block so the handler resolves `targetDeviceIds` (existing `resolveSoftwareTargetDeviceIds`), then calls `createSoftwareDeployment({...})` and maps its result to the existing `c.json({ data: { id, status, message } }, 200)` response. Keep `writeRouteAudit` and validation in the route.

- [ ] **Step 6: Run tests.**

Run: `cd apps/api && npx vitest run src/services/softwareDeployment.test.ts src/routes/software`
Expected: PASS. Then `npx tsc --noEmit -p tsconfig.json` shows no new errors in `software.ts`/`softwareDeployment.ts`.

- [ ] **Step 7: Commit.**
```bash
git add apps/api/src/services/softwareDeployment.ts apps/api/src/services/softwareDeployment.test.ts apps/api/src/routes/software.ts
git commit -m "refactor(software): extract createSoftwareDeployment() service from deploy route (#1981)"
```

---

### Task 2: Add the `deploy_software` action type + Zod validator

**Files:**
- Modify: `apps/api/src/services/automationRuntime.ts` (the `AutomationAction` union, ~lines 51–82)
- Modify: `packages/shared/src/validators/index.ts` (automation action validator)
- Test: `packages/shared/src/validators/automationActions.test.ts` (create if absent; otherwise add cases to the existing automation validator test)

**Interfaces:**
- Produces:
  ```ts
  export type DeploySoftwareAction = {
    type: 'deploy_software';
    catalogId: string;
  };
  // AutomationAction union now includes | DeploySoftwareAction
  ```

- [ ] **Step 1: Find the existing automation action validator.** Search `packages/shared/src/validators/index.ts` for the discriminated union of automation actions (look for `'run_script'`, `'execute_command'`). Note its exact name (e.g. `automationActionSchema`).

- [ ] **Step 2: Write the failing test.**

`packages/shared/src/validators/automationActions.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { automationActionSchema } from './index'; // adjust to the real export name

describe('automationActionSchema — deploy_software', () => {
  it('accepts a valid deploy_software action', () => {
    const parsed = automationActionSchema.safeParse({
      type: 'deploy_software',
      catalogId: '11111111-1111-1111-1111-111111111111',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects deploy_software without a uuid catalogId', () => {
    const parsed = automationActionSchema.safeParse({ type: 'deploy_software', catalogId: 'not-a-uuid' });
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails.**

Run: `cd packages/shared && npx vitest run src/validators/automationActions.test.ts`
Expected: FAIL — the union rejects `type:'deploy_software'`.

- [ ] **Step 4: Implement.**
  - In `packages/shared/src/validators/index.ts`, add a member to the automation action discriminated union:
    ```ts
    z.object({
      type: z.literal('deploy_software'),
      catalogId: z.string().uuid(),
    }),
    ```
    (Use `.guid()` instead of `.uuid()` only if this repo's Zod is v4 — check neighboring members; match what they use.)
  - In `automationRuntime.ts`, add `export type DeploySoftwareAction = { type: 'deploy_software'; catalogId: string };` and add `| DeploySoftwareAction` to the `AutomationAction` union.

- [ ] **Step 5: Run tests.**

Run: `cd packages/shared && npx vitest run src/validators/automationActions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**
```bash
git add packages/shared/src/validators/index.ts packages/shared/src/validators/automationActions.test.ts apps/api/src/services/automationRuntime.ts
git commit -m "feat(automations): add deploy_software action type + validator (#1981)"
```

---

### Task 3: Version-currency helpers (latest-version pre-fetch + skip-if-current)

**Files:**
- Create: `apps/api/src/services/softwareCurrency.ts`
- Create (test): `apps/api/src/services/softwareCurrency.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // Best-effort dotted-numeric comparison: returns -1 | 0 | 1, or null if either is unparseable.
  export function compareVersions(a: string, b: string): -1 | 0 | 1 | null;

  // Latest isLatest=true softwareVersions row + catalog name, keyed by catalogId.
  export interface LatestVersionInfo {
    version: typeof import('../db/schema').softwareVersions.$inferSelect;
    catalogName: string;
  }
  export async function resolveLatestVersionsByCatalogId(
    catalogIds: string[],
  ): Promise<Map<string, LatestVersionInfo>>;

  // True if the device already has this catalog app at >= latestVersion. Unknown/unparseable → false.
  export async function isDeviceSoftwareCurrent(
    deviceId: string,
    catalogId: string,
    latestVersion: string,
  ): Promise<boolean>;
  ```

- [ ] **Step 1: Check for an existing comparator.** Run `grep -rn "compareVersions\|semver" apps/api/src packages/shared/src`. If a suitable dotted-version comparator already exists, import and reuse it instead of adding `compareVersions` — adjust the test to target that export. Otherwise proceed.

- [ ] **Step 2: Write the failing test.**

`apps/api/src/services/softwareCurrency.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { compareVersions } from './softwareCurrency';

describe('compareVersions', () => {
  it('orders dotted-numeric versions', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('126.0.1', '126.0.0')).toBe(1);
  });
  it('treats missing trailing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.3', '1.2.9')).toBe(1);
  });
  it('returns null when a version is unparseable', () => {
    expect(compareVersions('latest', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', '')).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails.**

Run: `cd apps/api && npx vitest run src/services/softwareCurrency.test.ts`
Expected: FAIL — module/function not defined.

- [ ] **Step 4: Implement `compareVersions`.**
```ts
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (v: string): number[] | null => {
    if (!v || !/^\d+(\.\d+)*$/.test(v.trim())) return null;
    return v.trim().split('.').map((n) => Number(n));
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}
```

- [ ] **Step 5: Run the comparator test.**

Run: `cd apps/api && npx vitest run src/services/softwareCurrency.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the DB helpers + their failing tests.** Add to the same test file:
```ts
import { resolveLatestVersionsByCatalogId, isDeviceSoftwareCurrent } from './softwareCurrency';

describe('isDeviceSoftwareCurrent', () => {
  // Mock the db so software_inventory returns a row with a given version.
  it('is true when an installed version is >= latest', async () => {
    // inventory row version '126.0.1', latest '126.0.0' → current
    expect(await isDeviceSoftwareCurrent('dev-1', 'cat-1', '126.0.0')).toBe(true);
  });
  it('is false when installed is older than latest', async () => {
    expect(await isDeviceSoftwareCurrent('dev-1', 'cat-1', '127.0.0')).toBe(false);
  });
  it('is false when no inventory row exists (deploy is the safe default)', async () => {
    expect(await isDeviceSoftwareCurrent('dev-2', 'cat-1', '1.0.0')).toBe(false);
  });
  it('is false when the installed version is unparseable', async () => {
    expect(await isDeviceSoftwareCurrent('dev-3', 'cat-1', '1.0.0')).toBe(false);
  });
});
```
Use the repo's standard Drizzle db-mock (see existing `apps/api/src/services/*.test.ts`). Drive each case by what the mocked `software_inventory` select returns.

- [ ] **Step 7: Implement the DB helpers.**
```ts
import { db } from '../db';
import { softwareVersions, softwareCatalog, softwareInventory } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';

export async function resolveLatestVersionsByCatalogId(catalogIds: string[]) {
  const map = new Map<string, LatestVersionInfo>();
  if (catalogIds.length === 0) return map;
  const rows = await db
    .select({ version: softwareVersions, catalogName: softwareCatalog.name })
    .from(softwareVersions)
    .innerJoin(softwareCatalog, eq(softwareVersions.catalogId, softwareCatalog.id))
    .where(and(inArray(softwareVersions.catalogId, catalogIds), eq(softwareVersions.isLatest, true)));
  for (const r of rows) map.set(r.version.catalogId, { version: r.version, catalogName: r.catalogName });
  return map;
}

export async function isDeviceSoftwareCurrent(deviceId: string, catalogId: string, latestVersion: string) {
  const rows = await db
    .select({ version: softwareInventory.version })
    .from(softwareInventory)
    .where(and(eq(softwareInventory.deviceId, deviceId), eq(softwareInventory.catalogId, catalogId)));
  for (const r of rows) {
    if (!r.version) continue;
    const cmp = compareVersions(r.version, latestVersion);
    if (cmp === 0 || cmp === 1) return true; // installed >= latest
  }
  return false; // absent or unparseable → not current → deploy
}
```

- [ ] **Step 8: Run tests + commit.**

Run: `cd apps/api && npx vitest run src/services/softwareCurrency.test.ts`
Expected: PASS.
```bash
git add apps/api/src/services/softwareCurrency.ts apps/api/src/services/softwareCurrency.test.ts
git commit -m "feat(software): version-currency helpers for deploy_software idempotency (#1981)"
```

---

### Task 4: Batched `deploy_software` execution in the automation runner

**Files:**
- Modify: `apps/api/src/services/automationRuntime.ts` — add `executeDeploySoftwareActions()` batched pass and call it from BOTH run executors (the standalone path near lines 1280–1340 and the config-policy path near lines 1738–1829)
- Test: `apps/api/src/services/automationRuntime.deploySoftware.test.ts` (create)

**Interfaces:**
- Consumes: `createSoftwareDeployment` (Task 1), `resolveLatestVersionsByCatalogId` + `isDeviceSoftwareCurrent` (Task 3), `DeploySoftwareAction` (Task 2).
- Produces:
  ```ts
  // Runs once per automation run, AFTER the per-device action loop. For each
  // deploy_software action, filters eligible devices (OS-supported + not current),
  // creates ONE softwareDeployments via createSoftwareDeployment, appends per-device
  // log entries, and returns aggregate counts to fold into the run.
  async function executeDeploySoftwareActions(args: {
    actions: AutomationAction[];
    devices: Array<{ id: string; osType: 'windows'|'macos'|'linux' }>;
    orgId: string;
    createdBy: string | null;
    runId: string;
  }): Promise<{ logs: AutomationLogEntry[]; deployedDeviceIds: Set<string>; failed: boolean }>;
  ```

- [ ] **Step 1: Write the failing test.**

`apps/api/src/services/automationRuntime.deploySoftware.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createDeploymentMock, latestMapMock, isCurrentMock } = vi.hoisted(() => ({
  createDeploymentMock: vi.fn(),
  latestMapMock: vi.fn(),
  isCurrentMock: vi.fn(),
}));
vi.mock('./softwareDeployment', () => ({ createSoftwareDeployment: createDeploymentMock }));
vi.mock('./softwareCurrency', () => ({
  resolveLatestVersionsByCatalogId: latestMapMock,
  isDeviceSoftwareCurrent: isCurrentMock,
}));

import { executeDeploySoftwareActions } from './automationRuntime';

const WIN = { id: 'd-win', osType: 'windows' as const };
const MAC = { id: 'd-mac', osType: 'macos' as const };

beforeEach(() => {
  createDeploymentMock.mockReset().mockResolvedValue({ deploymentId: 'dep-1', status: 'pending', dispatchedDeviceIds: ['d-win'] });
  isCurrentMock.mockReset().mockResolvedValue(false);
  latestMapMock.mockReset().mockResolvedValue(new Map([['cat-1', {
    version: { id: 'ver-1', catalogId: 'cat-1', version: '126.0.0', supportedOs: ['windows'] },
    catalogName: 'Chrome',
  }]]));
});

describe('executeDeploySoftwareActions', () => {
  it('deploys to an eligible Windows device and records a deployed log', async () => {
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN], orgId: 'org-1', createdBy: null, runId: 'run-1',
    });
    expect(createDeploymentMock).toHaveBeenCalledTimes(1);
    expect(createDeploymentMock.mock.calls[0][0].deviceIds).toEqual(['d-win']);
    expect(res.deployedDeviceIds.has('d-win')).toBe(true);
    expect(res.failed).toBe(false);
  });

  it('skips a device whose OS is unsupported and does not create a deployment', async () => {
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [MAC], orgId: 'org-1', createdBy: null, runId: 'run-1',
    });
    expect(createDeploymentMock).not.toHaveBeenCalled();
    expect(res.logs.some(l => /unsupported OS/i.test(l.message))).toBe(true);
  });

  it('skips a device that is already current', async () => {
    isCurrentMock.mockResolvedValue(true);
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN], orgId: 'org-1', createdBy: null, runId: 'run-1',
    });
    expect(createDeploymentMock).not.toHaveBeenCalled();
    expect(res.logs.some(l => /already current/i.test(l.message))).toBe(true);
  });

  it('marks failed when the catalog has no latest version', async () => {
    latestMapMock.mockResolvedValue(new Map());
    const res = await executeDeploySoftwareActions({
      actions: [{ type: 'deploy_software', catalogId: 'cat-1' }],
      devices: [WIN], orgId: 'org-1', createdBy: null, runId: 'run-1',
    });
    expect(res.failed).toBe(true);
    expect(res.logs.some(l => /no latest version/i.test(l.message))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd apps/api && npx vitest run src/services/automationRuntime.deploySoftware.test.ts`
Expected: FAIL — `executeDeploySoftwareActions` not exported.

- [ ] **Step 3: Implement `executeDeploySoftwareActions`** (export it for testability). Use the existing `logEntry(...)` helper for log entries:
```ts
export async function executeDeploySoftwareActions(args: {
  actions: AutomationAction[];
  devices: Array<{ id: string; osType: 'windows' | 'macos' | 'linux' }>;
  orgId: string;
  createdBy: string | null;
  runId: string;
}): Promise<{ logs: AutomationLogEntry[]; deployedDeviceIds: Set<string>; failed: boolean }> {
  const deployActions = args.actions.filter(
    (a): a is DeploySoftwareAction => a.type === 'deploy_software',
  );
  const logs: AutomationLogEntry[] = [];
  const deployedDeviceIds = new Set<string>();
  let failed = false;
  if (deployActions.length === 0) return { logs, deployedDeviceIds, failed };

  const latest = await resolveLatestVersionsByCatalogId(
    [...new Set(deployActions.map((a) => a.catalogId))],
  );

  for (const [actionIndex, action] of deployActions.entries()) {
    const info = latest.get(action.catalogId);
    if (!info) {
      failed = true;
      logs.push(logEntry('deploy_software has no latest version for catalog', 'error', {
        actionType: action.type, actionIndex, details: { catalogId: action.catalogId },
      }));
      continue;
    }
    const supportedOs: string[] = Array.isArray(info.version.supportedOs) ? info.version.supportedOs : [];
    const eligible: string[] = [];
    for (const device of args.devices) {
      if (!supportedOs.includes(device.osType)) {
        logs.push(logEntry(`Skipped ${info.catalogName}: unsupported OS`, 'info', {
          actionType: action.type, actionIndex, deviceId: device.id,
          details: { deviceOsType: device.osType, supportedOs },
        }));
        continue;
      }
      if (await isDeviceSoftwareCurrent(device.id, action.catalogId, info.version.version)) {
        logs.push(logEntry(`Skipped ${info.catalogName}: already current`, 'info', {
          actionType: action.type, actionIndex, deviceId: device.id,
          details: { version: info.version.version },
        }));
        continue;
      }
      eligible.push(device.id);
    }
    if (eligible.length === 0) continue;

    const result = await createSoftwareDeployment({
      orgId: args.orgId,
      softwareVersionId: info.version.id,
      deploymentType: 'install',
      deviceIds: eligible,
      scheduleType: 'immediate',
      createdBy: args.createdBy,
      name: `Automation: deploy ${info.catalogName}`,
    });
    if (result.status === 'failed') {
      failed = true;
      logs.push(logEntry(`deploy_software failed: ${result.message ?? 'unknown error'}`, 'error', {
        actionType: action.type, actionIndex, details: { catalogId: action.catalogId, deploymentId: result.deploymentId },
      }));
      continue;
    }
    for (const id of result.dispatchedDeviceIds) deployedDeviceIds.add(id);
    logs.push(logEntry(`Deploying ${info.catalogName} ${info.version.version} to ${eligible.length} device(s)`, 'info', {
      actionType: action.type, actionIndex, details: { deploymentId: result.deploymentId, deviceIds: eligible },
    }));
  }
  return { logs, deployedDeviceIds, failed };
}
```

- [ ] **Step 4: Run the handler test.**

Run: `cd apps/api && npx vitest run src/services/automationRuntime.deploySoftware.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into both run executors.** In `automationRuntime.ts`, after the existing per-device action loop completes in EACH executor (standalone run near ~1280–1340; config-policy run near ~1738–1829), call:
```ts
const deployOutcome = await executeDeploySoftwareActions({
  actions,
  devices: deviceRows.map((d) => ({ id: d.id, osType: d.osType })),
  orgId,                 // the run's org
  createdBy: automation.createdBy ?? null,
  runId,
});
// append deployOutcome.logs into the run's logs array;
// fold deployOutcome.deployedDeviceIds into devicesSucceeded;
// if deployOutcome.failed and onFailure === 'stop', mark the run 'failed'/'partial' per existing logic.
```
Important: in the `run_script`-style per-device dispatch, **exclude** `deploy_software` actions (they are handled by the batched pass) — add `if (action.type === 'deploy_software') continue;` in the per-device action loop, or filter them out of `actions` before that loop. Confirm `executeAction`'s switch does NOT also try to handle `deploy_software` (leave it out of `executeAction`).

- [ ] **Step 6: Run the full affected suites.**

Run: `cd apps/api && npx vitest run src/services/automationRuntime src/services/softwareDeployment src/services/softwareCurrency`
Expected: PASS. Then `npx tsc --noEmit -p tsconfig.json` — no new errors.

- [ ] **Step 7: Commit.**
```bash
git add apps/api/src/services/automationRuntime.ts apps/api/src/services/automationRuntime.deploySoftware.test.ts
git commit -m "feat(automations): execute deploy_software as a batched, idempotent deployment pass (#1981)"
```

---

### Task 5: Frontend — "Deploy Software" action in the automation editor

**Files:**
- Modify: the automation action editor used by the config-policy automation feature tab and the standalone automation editor. Locate via: `grep -rn "run_script\|execute_command" apps/web/src` — the file rendering the action-type dropdown + per-type fields.
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/types.ts` only if an action-type list/enum lives there.
- Test: co-located component test if the editor already has one; otherwise a focused render/validation test for the new action type.

**Interfaces:**
- Consumes: existing software catalog list endpoint. Find it via `grep -rn "softwareCatalog\|/software/catalog\|software-catalog" apps/web/src apps/api/src/routes/software.ts` — reuse the same fetch the Software Catalog page uses.

- [ ] **Step 1: Locate the action editor + catalog fetch.** Run the greps above. Identify (a) where action types are listed for the dropdown, (b) the per-action field renderer (switch on `action.type`), and (c) the catalog list hook/endpoint.

- [ ] **Step 2: Write the failing test.** Add a test asserting that selecting the "Deploy Software" action renders a catalog picker and produces an action object `{ type: 'deploy_software', catalogId }`. Follow the editor's existing test patterns (`apps/web/src/.../*.test.tsx`). If the editor has no test harness, write a minimal one rendering the editor with the new type selected and asserting the emitted action shape.

- [ ] **Step 3: Run test to verify it fails.**

Run: `cd apps/web && npx vitest run <path-to-new-test>`
Expected: FAIL — "Deploy Software" option / catalog picker not present.

- [ ] **Step 4: Implement.**
  - Add `'deploy_software'` (label "Deploy Software") to the action-type options list.
  - In the per-action field renderer, add a branch for `deploy_software` that renders a catalog `<select>` populated from the catalog list endpoint, bound to `action.catalogId`, plus helper text: `Installs the latest version of the selected software; skips devices that already have it.`
  - Ensure the editor emits `{ type: 'deploy_software', catalogId }` with no extra fields.

- [ ] **Step 5: Run test.**

Run: `cd apps/web && npx vitest run <path-to-new-test>`
Expected: PASS.

- [ ] **Step 6: Commit.**
```bash
git add apps/web/src
git commit -m "feat(web): Deploy Software automation action editor with catalog picker (#1981)"
```

---

## Self-Review

**Spec coverage:**
- Action shape (`deploy_software`, `catalogId`, no new tables) → Task 2. ✓
- Latest-of-catalog at run time → Task 3 (`resolveLatestVersionsByCatalogId` on `isLatest`). ✓
- Real deployment records + UI status → Task 1 (`createSoftwareDeployment` creates `softwareDeployments`+`deploymentResults`). ✓
- Skip-if-current (unknown → deploy) → Task 3 (`isDeviceSoftwareCurrent`) + Task 4 (applied per device). ✓
- OS gate → Task 4. ✓
- One deployment row per action (batched pass) → Task 4. ✓
- Targeted refactor of `POST /deployments` → Task 1. ✓
- Tenancy (#1855 policy-id, system context, run org) → Global Constraints + Task 4 wiring (uses the run executors' existing run-recording, which already resolves the policy id post-#1855). ✓
- Validation + frontend → Task 2 (Zod) + Task 5 (UI). ✓
- Tests for handler/validator/comparator/currency → Tasks 2–4. ✓
- Out-of-scope items (uninstall, pinned, force, pkg-manager) → not implemented, by design. ✓

**Placeholder scan:** Concrete code/commands in every code step. The two intentional "locate via grep" steps (Tasks 1 mock paths, Task 5 editor location) are discovery instructions for repo-specific paths, each paired with the exact grep and the concrete change to make — not deferred work.

**Type consistency:** `createSoftwareDeployment` input/result, `DeploySoftwareAction`, `LatestVersionInfo`, `compareVersions`, `isDeviceSoftwareCurrent`, and `executeDeploySoftwareActions` signatures are referenced consistently across Tasks 1→4. `dispatchedDeviceIds` (Task 1) is the field consumed in Task 4.

**Note for executor:** Task 4's run-recording must not regress the #1855 tenant-key fix — verify `automation_runs.config_policy_id` is still the resolved policy id after wiring the deploy pass in. Add/keep a test asserting it if the config-policy executor's existing test doesn't already cover it.
