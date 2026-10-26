/**
 * Integration test — W03 (#6757) DR plan and Hyper-V/VM restore write tools
 * honour the site axis and the org axis, against real Postgres as the
 * unprivileged `breeze_app` role (org-axis RLS genuinely enforced; the site
 * axis is applied app-layer).
 *
 * Tools: manage_dr_plan, execute_dr_plan, manage_hyperv_vm,
 * manage_hyperv_checkpoints, trigger_hyperv_backup, restore_hyperv_vm,
 * instant_boot_vm, restore_as_vm.
 *
 * Fixture: one org with two sites (A = the restricted caller's allowed site,
 * B = forbidden), an online device, a Hyper-V VM record and attested
 * snapshots sourced from each, plus a second org with its own device/VM/plan.
 * For every tool:
 *   (i)   out-of-site caller          -> refused / "not found", nothing written
 *   (ii)  in-site caller              -> succeeds (non-vacuous)
 *   (iii) caller from a second org    -> "not found"
 *   (iv)  unrestricted caller         -> reaches the site-B resources
 *
 * Plus W03-D10: while a DR plan has a pending or running execution, every plan
 * and group write returns `dr_plan_execution_in_progress` and changes nothing;
 * a successful group write bumps `dr_plans.updated_at`.
 *
 * Only the device command dispatch, the BullMQ reconcile enqueue, the
 * provider-config decrypt and the policy -> backup config resolver are stubbed;
 * every refusal under test happens before them.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { enqueueReconcileMock, resolvedBackupConfig } = vi.hoisted(() => ({
  enqueueReconcileMock: vi.fn(async (..._args: unknown[]) => undefined),
  // Set per fixture: the config `resolveBackupConfigForDevice` hands back.
  resolvedBackupConfig: { configId: null as string | null },
}));

vi.mock('../../services/aiDispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiDispatch')>();
  return {
    ...actual,
    // A real device_commands row (restore_jobs.command_id is an FK), without
    // the dispatch side effects.
    aiQueueCommandForExecution: vi.fn(async (_auth: unknown, _tool: string, deviceId: string, type: string) => {
      const { getTestDb: testDb } = await import('./setup');
      const { deviceCommands } = await import('../../db/schema');
      const [command] = await testDb().insert(deviceCommands)
        .values({ deviceId, type, payload: {}, status: 'pending' })
        .returning({ id: deviceCommands.id, status: deviceCommands.status });
      return { command };
    }),
  };
});
vi.mock('../../services/backupProviderConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/backupProviderConfig')>();
  return {
    ...actual,
    resolveBackupProviderConfig: vi.fn(async () => ({ provider: 'local', providerConfig: {} })),
  };
});
vi.mock('../../jobs/drExecutionWorker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/drExecutionWorker')>();
  return { ...actual, enqueueDrExecutionReconcile: enqueueReconcileMock };
});
vi.mock('../../services/featureConfigResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/featureConfigResolver')>();
  return {
    ...actual,
    resolveBackupConfigForDevice: vi.fn(async () => (
      resolvedBackupConfig.configId
        ? { configId: resolvedBackupConfig.configId, featureLinkId: null }
        : null
    )),
  };
});

import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  deviceCommands,
  devices,
  drExecutions,
  drPlanGroups,
  drPlans,
  hypervVms,
  restoreJobs,
} from '../../db/schema';
import { registerBackupVmTools } from '../../services/aiToolsBackupVm';
import { registerDRTools } from '../../services/aiToolsDR';
import { registerHypervTools } from '../../services/aiToolsHyperv';
import { clearPermissionCache } from '../../services/permissions';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { attestSnapshotForTest } from './restoreIntegrityFixture';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function registry(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerBackupVmTools(reg);
  registerDRTools(reg);
  registerHypervTools(reg);
  return reg;
}

async function seedDevice(orgId: string, siteId: string) {
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `dr-hyperv-${randomUUID()}`,
    hostname: `dh-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: 'test',
    architecture: 'x86_64',
    agentVersion: 'test',
    status: 'online',
    // A helper that checks restores against snapshot attestations.
    backupIntegrityProtocolVersion: 2,
  }).returning({ id: devices.id });
  return row!.id;
}

interface Fixture {
  partnerId: string;
  orgA: string;
  orgB: string;
  userId: string;
  siteA: string;
  siteB: string;
  devA: string;
  devB: string;
  devOther: string;
  vmA: string;
  vmB: string;
  vmOther: string;
  fileSnapA: string;
  fileSnapB: string;
  hypervSnapA: string;
  hypervSnapB: string;
  planOther: string;
  restricted: AuthContext;
  unrestricted: AuthContext;
  otherOrg: AuthContext;
}

function makeAuth(opts: {
  userId: string;
  partnerId: string;
  orgId: string;
  allowedSiteIds?: string[];
}): AuthContext {
  const { allowedSiteIds } = opts;
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: opts.partnerId,
    orgId: opts.orgId,
    scope: 'organization',
    accessibleOrgIds: [opts.orgId],
    orgCondition: (col: any) => eq(col, opts.orgId),
    canAccessOrg: (id: string) => id === opts.orgId,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) =>
      !allowedSiteIds ? true : !!s && allowedSiteIds.includes(s),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'dr-hyperv-scope' },
  } as unknown as AuthContext;
}

function orgCtx(orgId: string, f: { partnerId: string; userId: string }): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: f.userId,
    currentPartnerId: f.partnerId,
  };
}

async function seedFixture(): Promise<Fixture> {
  const testDb = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'DR hyperv A' });
  const siteB = await createSite({ orgId: orgA.id, name: 'DR hyperv B' });
  const siteOther = await createSite({ orgId: orgB.id, name: 'DR hyperv other' });

  // A real org member whose role is resolved by the real getUserPermissions.
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `dh-${randomUUID()}@example.com` });
  const role = await createRole({ scope: 'organization', orgId: orgA.id });
  await grantRolePermissions(role.id, [
    { resource: 'devices', action: 'read' },
    { resource: 'devices', action: 'write' },
    { resource: 'devices', action: 'execute' },
    { resource: 'backup', action: 'read' },
    { resource: 'backup', action: 'write' },
  ]);
  await assignUserToOrganization(user.id, orgA.id, role.id);

  const devA = await seedDevice(orgA.id, siteA.id);
  const devB = await seedDevice(orgA.id, siteB.id);
  const devOther = await seedDevice(orgB.id, siteOther.id);

  const vm = async (orgId: string, deviceId: string, name: string) => {
    const [row] = await testDb.insert(hypervVms).values({
      orgId, deviceId, vmId: randomUUID(), vmName: name,
    }).returning({ id: hypervVms.id });
    return row!.id;
  };

  const [config] = await testDb.insert(backupConfigs).values({
    orgId: orgA.id, name: 'DR hyperv config', type: 'file', provider: 'local', providerConfig: {},
  }).returning({ id: backupConfigs.id });
  resolvedBackupConfig.configId = config!.id;
  const jobFor = async (deviceId: string) => {
    const [job] = await testDb.insert(backupJobs).values({
      orgId: orgA.id, configId: config!.id, deviceId, status: 'completed',
    }).returning({ id: backupJobs.id });
    return job!.id;
  };
  const jobA = await jobFor(devA);
  const jobB = await jobFor(devB);
  const snapshot = async (jobId: string, deviceId: string, metadata: Record<string, unknown>) => {
    const [row] = await testDb.insert(backupSnapshots).values({
      orgId: orgA.id,
      jobId,
      deviceId,
      configId: config!.id,
      snapshotId: `dh-${randomUUID()}`,
      storageIdentity: `local::/dh/${randomUUID()}`,
      metadata,
    }).returning({ id: backupSnapshots.id });
    // AI agents restore attested snapshots only.
    await attestSnapshotForTest(row!.id);
    return row!.id;
  };

  const [planOther] = await testDb.insert(drPlans).values({
    orgId: orgB.id, name: 'Other org plan', status: 'draft',
  }).returning({ id: drPlans.id });

  const base = { userId: user.id, partnerId: partner.id };
  return {
    partnerId: partner.id,
    orgA: orgA.id,
    orgB: orgB.id,
    userId: user.id,
    siteA: siteA.id,
    siteB: siteB.id,
    devA,
    devB,
    devOther,
    vmA: await vm(orgA.id, devA, 'vm-a'),
    vmB: await vm(orgA.id, devB, 'vm-b'),
    vmOther: await vm(orgB.id, devOther, 'vm-other'),
    fileSnapA: await snapshot(jobA, devA, {}),
    fileSnapB: await snapshot(jobB, devB, {}),
    hypervSnapA: await snapshot(jobA, devA, { backupKind: 'hyperv_export' }),
    hypervSnapB: await snapshot(jobB, devB, { backupKind: 'hyperv_export' }),
    planOther: planOther!.id,
    restricted: makeAuth({ ...base, orgId: orgA.id, allowedSiteIds: [siteA.id] }),
    unrestricted: makeAuth({ ...base, orgId: orgA.id }),
    otherOrg: makeAuth({ ...base, orgId: orgB.id }),
  };
}

type Who = 'restricted' | 'unrestricted' | 'otherOrg';

async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>) {
  const handler = registry().get(tool)!.handler;
  const orgId = who === 'otherOrg' ? f.orgB : f.orgA;
  const raw = await withDbAccessContext(orgCtx(orgId, f), () => handler(input, f[who]));
  return JSON.parse(raw) as Record<string, any>;
}

const VM_DENIED = 'VM not found or access denied';
const DEVICE_DENIED = 'Device not found or access denied';
const TARGET_DENIED = 'Target device not found or access denied';
const SNAPSHOT_DENIED = 'Snapshot not found or access denied';
const PLAN_DENIED = 'Plan not found or access denied';
const GROUP_DENIED = 'Group not found or access denied';

async function commandCount(): Promise<number> {
  return (await getTestDb().select({ id: deviceCommands.id }).from(deviceCommands)).length;
}

describe('W03 Hyper-V and VM restore tools — site axis + org axis (real Postgres, breeze_app)', () => {
  let f: Fixture;
  beforeEach(async () => {
    await clearPermissionCache();
    enqueueReconcileMock.mockClear();
    f = await seedFixture();
  });

  describe('manage_hyperv_vm', () => {
    runDb('a VM on an out-of-site host is not found and nothing is queued; in-site dispatches', async () => {
      const before = await commandCount();
      expect(await run(f, 'restricted', 'manage_hyperv_vm', { vmId: f.vmB, action: 'start' })).toEqual({ error: VM_DENIED });
      expect(await commandCount()).toBe(before);

      const ok = await run(f, 'restricted', 'manage_hyperv_vm', { vmId: f.vmA, action: 'start' });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect(ok.deviceId).toBe(f.devA);
      expect(await commandCount()).toBe(before + 1);
    });

    runDb('cross-org caller gets not found; unrestricted caller reaches the site-B VM', async () => {
      expect(await run(f, 'otherOrg', 'manage_hyperv_vm', { vmId: f.vmA, action: 'stop' })).toEqual({ error: VM_DENIED });
      const wide = await run(f, 'unrestricted', 'manage_hyperv_vm', { vmId: f.vmB, action: 'stop' });
      expect(wide.error).toBeUndefined();
      expect(wide.deviceId).toBe(f.devB);
    });
  });

  describe('manage_hyperv_checkpoints', () => {
    runDb('a VM on an out-of-site host is not found and nothing is queued; in-site dispatches', async () => {
      const before = await commandCount();
      expect(await run(f, 'restricted', 'manage_hyperv_checkpoints', { vmId: f.vmB, action: 'create', checkpointName: 'cp' })).toEqual({ error: VM_DENIED });
      expect(await commandCount()).toBe(before);

      const ok = await run(f, 'restricted', 'manage_hyperv_checkpoints', { vmId: f.vmA, action: 'create', checkpointName: 'cp' });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
    });

    runDb('cross-org caller gets not found; unrestricted caller reaches the site-B VM', async () => {
      expect(await run(f, 'otherOrg', 'manage_hyperv_checkpoints', { vmId: f.vmA, action: 'delete', checkpointName: 'cp' })).toEqual({ error: VM_DENIED });
      const wide = await run(f, 'unrestricted', 'manage_hyperv_checkpoints', { vmId: f.vmB, action: 'delete', checkpointName: 'cp' });
      expect(wide.error).toBeUndefined();
      expect(wide.deviceId).toBe(f.devB);
    });
  });

  describe('trigger_hyperv_backup', () => {
    runDb('a VM on an out-of-site host is not found and no job is created; in-site dispatches', async () => {
      expect(await run(f, 'restricted', 'trigger_hyperv_backup', { vmId: f.vmB })).toEqual({ error: VM_DENIED });
      const onB = await getTestDb().select({ id: backupJobs.id }).from(backupJobs).where(eq(backupJobs.deviceId, f.devB));
      expect(onB).toHaveLength(1); // the seeded fixture job only

      const ok = await run(f, 'restricted', 'trigger_hyperv_backup', { vmId: f.vmA });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect(ok.backupJobId).toBeTruthy();
    });

    runDb('cross-org caller gets not found; unrestricted caller reaches the site-B VM', async () => {
      expect(await run(f, 'otherOrg', 'trigger_hyperv_backup', { vmId: f.vmA })).toEqual({ error: VM_DENIED });
      const wide = await run(f, 'unrestricted', 'trigger_hyperv_backup', { vmId: f.vmB });
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
    });
  });

  describe('restore_hyperv_vm', () => {
    runDb('refuses a host in another site', async () => {
      expect(await run(f, 'restricted', 'restore_hyperv_vm', { snapshotId: f.hypervSnapA, deviceId: f.devB })).toEqual({ error: DEVICE_DENIED });
    });

    runDb('refuses a snapshot whose source device is in another site, even onto an in-site host', async () => {
      expect(await run(f, 'restricted', 'restore_hyperv_vm', { snapshotId: f.hypervSnapB, deviceId: f.devA })).toEqual({ error: SNAPSHOT_DENIED });
    });

    runDb('in-site restore dispatches; cross-org caller gets not found; unrestricted caller restores site-B to site-B', async () => {
      const ok = await run(f, 'restricted', 'restore_hyperv_vm', { snapshotId: f.hypervSnapA, deviceId: f.devA });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);

      expect(await run(f, 'otherOrg', 'restore_hyperv_vm', { snapshotId: f.hypervSnapA, deviceId: f.devA })).toEqual({ error: DEVICE_DENIED });

      const wide = await run(f, 'unrestricted', 'restore_hyperv_vm', { snapshotId: f.hypervSnapB, deviceId: f.devB });
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
    });
  });

  describe.each([
    {
      tool: 'instant_boot_vm',
      input: (snapshotId: string, targetDeviceId: string) => ({ snapshotId, targetDeviceId, vmName: 'booted' }),
    },
    {
      tool: 'restore_as_vm',
      input: (snapshotId: string, targetDeviceId: string) => ({ snapshotId, targetDeviceId, hypervisor: 'hyperv', vmName: 'restored' }),
    },
  ])('$tool', ({ tool, input }) => {
    runDb('refuses a target host in another site and writes no restore job', async () => {
      expect(await run(f, 'restricted', tool, input(f.fileSnapA, f.devB))).toEqual({ error: TARGET_DENIED });
      expect(await getTestDb().select({ id: restoreJobs.id }).from(restoreJobs)).toHaveLength(0);
    });

    runDb('refuses a snapshot whose source device is in another site, even onto an in-site host', async () => {
      expect(await run(f, 'restricted', tool, input(f.fileSnapB, f.devA))).toEqual({ error: SNAPSHOT_DENIED });
      expect(await getTestDb().select({ id: restoreJobs.id }).from(restoreJobs)).toHaveLength(0);
    });

    runDb('in-site restore dispatches; cross-org caller gets not found; unrestricted caller restores site-B to site-B', async () => {
      const ok = await run(f, 'restricted', tool, input(f.fileSnapA, f.devA));
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect(await getTestDb().select({ id: restoreJobs.id }).from(restoreJobs)).toHaveLength(1);

      expect(await run(f, 'otherOrg', tool, input(f.fileSnapA, f.devA))).toEqual({ error: SNAPSHOT_DENIED });

      const wide = await run(f, 'unrestricted', tool, input(f.fileSnapB, f.devB));
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
    });
  });
});

describe('W03 DR plan tools — site axis, org axis and W03-D10 (real Postgres, breeze_app)', () => {
  let f: Fixture;
  beforeEach(async () => {
    await clearPermissionCache();
    enqueueReconcileMock.mockClear();
    f = await seedFixture();
  });

  async function seedPlan(orgId: string, status = 'draft') {
    const [plan] = await getTestDb().insert(drPlans).values({
      orgId, name: `dr-scope-${randomUUID().slice(0, 8)}`, status,
    }).returning({ id: drPlans.id });
    return plan!.id;
  }

  async function seedGroup(planId: string, devices: string[], restoreConfig: Record<string, unknown> = {}) {
    const [group] = await getTestDb().insert(drPlanGroups).values({
      planId, orgId: f.orgA, name: `g-${randomUUID().slice(0, 6)}`, devices, restoreConfig,
    }).returning({ id: drPlanGroups.id });
    return group!.id;
  }

  async function groupsOf(planId: string) {
    return getTestDb().select().from(drPlanGroups).where(eq(drPlanGroups.planId, planId));
  }

  async function loadPlan(planId: string) {
    const [row] = await getTestDb().select().from(drPlans).where(eq(drPlans.id, planId));
    return row!;
  }

  async function seedExecution(planId: string, status: string) {
    const [row] = await getTestDb().insert(drExecutions).values({
      planId, orgId: f.orgA, executionType: 'rehearsal', status,
    }).returning({ id: drExecutions.id });
    return row!.id;
  }

  describe('manage_dr_plan add_group', () => {
    runDb('an out-of-site device in `devices` is refused and no group is written; in-site succeeds', async () => {
      const planId = await seedPlan(f.orgA);
      const denied = await run(f, 'restricted', 'manage_dr_plan', { action: 'add_group', planId, name: 'g', devices: [f.devA, f.devB] });
      expect(denied).toEqual({ error: 'site_access_denied' });
      expect(await groupsOf(planId)).toHaveLength(0);

      const ok = await run(f, 'restricted', 'manage_dr_plan', { action: 'add_group', planId, name: 'g', devices: [f.devA] });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect((await groupsOf(planId))[0]!.devices).toEqual([f.devA]);
    });

    runDb('a plan in another org is not found; unrestricted caller adds the site-B device', async () => {
      expect(await run(f, 'otherOrg', 'manage_dr_plan', { action: 'add_group', planId: await seedPlan(f.orgA), name: 'g', devices: [f.devA] })).toEqual({ error: PLAN_DENIED });
      expect(await run(f, 'restricted', 'manage_dr_plan', { action: 'add_group', planId: f.planOther, name: 'g', devices: [f.devA] })).toEqual({ error: PLAN_DENIED });
      expect(await groupsOf(f.planOther)).toHaveLength(0);

      const planId = await seedPlan(f.orgA);
      const wide = await run(f, 'unrestricted', 'manage_dr_plan', { action: 'add_group', planId, name: 'g', devices: [f.devB] });
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
    });
  });

  describe('manage_dr_plan stored-membership gates', () => {
    runDb('a restricted caller cannot update or delete a group that stores an out-of-site device, nor update the plan', async () => {
      const planId = await seedPlan(f.orgA);
      const groupId = await seedGroup(planId, [f.devA, f.devB]);

      expect(await run(f, 'restricted', 'manage_dr_plan', { action: 'update_group', planId, groupId, devices: [f.devA] })).toEqual({ error: GROUP_DENIED });
      expect(await run(f, 'restricted', 'manage_dr_plan', { action: 'delete_group', planId, groupId })).toEqual({ error: GROUP_DENIED });
      expect(await run(f, 'restricted', 'manage_dr_plan', { action: 'update_plan', planId, name: 'renamed' })).toEqual({ error: PLAN_DENIED });
      expect((await groupsOf(planId))[0]!.devices).toEqual([f.devA, f.devB]);

      const wide = await run(f, 'unrestricted', 'manage_dr_plan', { action: 'update_plan', planId, name: 'renamed' });
      expect(wide.error).toBeUndefined();
      expect((await loadPlan(planId)).name).toBe('renamed');
    });

    runDb('in-site group edits succeed for a restricted caller; a cross-org plan update is not found', async () => {
      const planId = await seedPlan(f.orgA);
      const groupId = await seedGroup(planId, [f.devA]);

      const ok = await run(f, 'restricted', 'manage_dr_plan', { action: 'update_group', planId, groupId, name: 'renamed-group' });
      expect(ok.error).toBeUndefined();
      expect((await groupsOf(planId))[0]!.name).toBe('renamed-group');

      expect(await run(f, 'otherOrg', 'manage_dr_plan', { action: 'update_plan', planId, name: 'x' })).toEqual({ error: PLAN_DENIED });
      expect(await run(f, 'otherOrg', 'manage_dr_plan', { action: 'update_group', planId, groupId, name: 'x' })).toEqual({ error: GROUP_DENIED });
      expect(await run(f, 'otherOrg', 'manage_dr_plan', { action: 'delete_group', planId, groupId })).toEqual({ error: GROUP_DENIED });
      expect(await groupsOf(planId)).toHaveLength(1);
    });
  });

  describe('W03-D10: no plan or group write while an execution is pending or running', () => {
    const IN_PROGRESS = { error: 'dr_plan_execution_in_progress' };

    it.runIf(!!process.env.DATABASE_URL).each(['running', 'pending'])(
      'a %s execution blocks update_plan, add_group, update_group and delete_group and changes nothing',
      async (status) => {
        const planId = await seedPlan(f.orgA);
        const groupId = await seedGroup(planId, [f.devA]);
        const before = await loadPlan(planId);
        await seedExecution(planId, status);

        expect(await run(f, 'unrestricted', 'manage_dr_plan', { action: 'update_plan', planId, name: 'mid-run' })).toEqual(IN_PROGRESS);
        expect(await run(f, 'unrestricted', 'manage_dr_plan', { action: 'add_group', planId, name: 'mid-run', devices: [f.devA] })).toEqual(IN_PROGRESS);
        expect(await run(f, 'unrestricted', 'manage_dr_plan', { action: 'update_group', planId, groupId, name: 'mid-run' })).toEqual(IN_PROGRESS);
        expect(await run(f, 'unrestricted', 'manage_dr_plan', { action: 'delete_group', planId, groupId })).toEqual(IN_PROGRESS);

        const after = await loadPlan(planId);
        expect(after.name).toBe(before.name);
        expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
        const groups = await groupsOf(planId);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.name).not.toBe('mid-run');
      },
    );

    runDb('a terminal execution does not block, and a successful group write bumps dr_plans.updated_at', async () => {
      const planId = await seedPlan(f.orgA);
      const groupId = await seedGroup(planId, [f.devA]);
      await seedExecution(planId, 'completed');
      const old = new Date('2020-01-01T00:00:00Z');
      await getTestDb().update(drPlans).set({ updatedAt: old }).where(eq(drPlans.id, planId));

      const added = await run(f, 'unrestricted', 'manage_dr_plan', { action: 'add_group', planId, name: 'second', devices: [f.devA] });
      expect(added.success).toBe(true);
      const afterAdd = (await loadPlan(planId)).updatedAt;
      expect(afterAdd.getTime()).toBeGreaterThan(old.getTime());

      await getTestDb().update(drPlans).set({ updatedAt: old }).where(eq(drPlans.id, planId));
      expect((await run(f, 'unrestricted', 'manage_dr_plan', { action: 'update_group', planId, groupId, name: 'renamed' })).success).toBe(true);
      expect((await loadPlan(planId)).updatedAt.getTime()).toBeGreaterThan(old.getTime());

      await getTestDb().update(drPlans).set({ updatedAt: old }).where(eq(drPlans.id, planId));
      expect((await run(f, 'unrestricted', 'manage_dr_plan', { action: 'delete_group', planId, groupId: added.group.id })).success).toBe(true);
      expect((await loadPlan(planId)).updatedAt.getTime()).toBeGreaterThan(old.getTime());
    });
  });

  describe('execute_dr_plan', () => {
    runDb('a plan in another org is not found and no execution is created', async () => {
      const planId = await seedPlan(f.orgA);
      await seedGroup(planId, [f.devA], { sourceSnapshotId: f.fileSnapA });
      expect(await run(f, 'otherOrg', 'execute_dr_plan', { planId, executionType: 'rehearsal' })).toEqual({ error: PLAN_DENIED });
      expect(await getTestDb().select({ id: drExecutions.id }).from(drExecutions)).toHaveLength(0);
      expect(enqueueReconcileMock).not.toHaveBeenCalled();
    });

    runDb('a plan storing an out-of-site device is denied to a restricted caller and creates no execution', async () => {
      const planId = await seedPlan(f.orgA);
      await seedGroup(planId, [f.devA, f.devB], { sourceSnapshotId: f.fileSnapA });
      expect(await run(f, 'restricted', 'execute_dr_plan', { planId, executionType: 'rehearsal' })).toEqual({ error: PLAN_DENIED });
      expect(await getTestDb().select({ id: drExecutions.id }).from(drExecutions)).toHaveLength(0);
      expect(enqueueReconcileMock).not.toHaveBeenCalled();
    });

    runDb('an in-site plan executes for the restricted caller; the unrestricted caller executes the site-B plan', async () => {
      const inSite = await seedPlan(f.orgA);
      await seedGroup(inSite, [f.devA], { sourceSnapshotId: f.fileSnapA });
      const ok = await run(f, 'restricted', 'execute_dr_plan', { planId: inSite, executionType: 'rehearsal' });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect(enqueueReconcileMock).toHaveBeenCalledTimes(1);

      const siteBPlan = await seedPlan(f.orgA);
      await seedGroup(siteBPlan, [f.devB], { sourceSnapshotId: f.fileSnapB });
      expect(await run(f, 'restricted', 'execute_dr_plan', { planId: siteBPlan, executionType: 'rehearsal' })).toEqual({ error: PLAN_DENIED });
      const wide = await run(f, 'unrestricted', 'execute_dr_plan', { planId: siteBPlan, executionType: 'rehearsal' });
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
    });
  });
});
