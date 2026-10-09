/**
 * Integration test — AI restore tools stay inside one org and honour
 * backup:cross_site_restore, like the HTTP restore routes.
 *
 * Runs the real tool handlers against real Postgres, inside a partner-scope
 * RLS context, with the caller's permission set resolved by the real
 * getUserPermissions from partner_users + role_permissions. Only the agent
 * command dispatch and the provider-config decrypt are stubbed: every refusal
 * under test happens before either.
 *
 *  1. Cross-org: a partner tech who can reach org A and org B cannot restore an
 *     org-A snapshot onto an org-B device (restore_snapshot, restore_as_vm,
 *     instant_boot_vm, restore_hyperv_vm, restore_mssql_database), and cannot
 *     put an org-B device into an org-A DR plan group.
 *  2. Cross-site: the same tech without backup:cross_site_restore cannot
 *     restore a site-A snapshot onto a site-B device of the same org; with the
 *     permission, or onto a same-site device, the restore is dispatched.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

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

import { withDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  devices,
  drPlanGroups,
  drPlans,
} from '../../db/schema';
import { aiQueueCommandForExecution } from '../../services/aiDispatch';
import { registerBackupTools } from '../../services/aiToolsBackup';
import { registerBackupVmTools } from '../../services/aiToolsBackupVm';
import { registerHypervTools } from '../../services/aiToolsHyperv';
import { registerMssqlTools } from '../../services/aiToolsMssql';
import { registerDRTools } from '../../services/aiToolsDR';
import { clearPermissionCache } from '../../services/permissions';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import {
  assignUserToPartner,
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

function tools(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerBackupTools(reg);
  registerBackupVmTools(reg);
  registerHypervTools(reg);
  registerMssqlTools(reg);
  registerDRTools(reg);
  return reg;
}

interface Fixture {
  partnerId: string;
  orgA: string;
  orgB: string;
  userId: string;
  roleId: string;
  /** org A, site 1 (the backup source) */
  sourceA1: string;
  /** org A, site 1 (same-site target) */
  targetA1: string;
  /** org A, site 2 (cross-site target) */
  targetA2: string;
  /** org B (cross-org target) */
  targetB: string;
  fileSnapshot: string;
  hypervSnapshot: string;
  mssqlSnapshot: string;
}

async function seedDevice(orgId: string, siteId: string, osType: 'windows' | 'linux' = 'windows') {
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `restore-scope-${randomUUID()}`,
    hostname: `restore-scope-${randomUUID().slice(0, 8)}`,
    osType,
    osVersion: 'test',
    architecture: 'x86_64',
    agentVersion: 'test',
    status: 'online',
    // A helper that checks restores against snapshot attestations.
    backupIntegrityProtocolVersion: 2,
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedFixture(extraPermissions: Array<{ resource: string; action: string }> = []): Promise<Fixture> {
  const testDb = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA1 = await createSite({ orgId: orgA.id, name: 'Restore scope A1' });
  const siteA2 = await createSite({ orgId: orgA.id, name: 'Restore scope A2' });
  const siteB = await createSite({ orgId: orgB.id, name: 'Restore scope B' });

  const user = await createUser({ partnerId: partner.id, email: `restore-scope-${randomUUID()}@example.com` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, [
    { resource: 'devices', action: 'read' },
    { resource: 'devices', action: 'write' },
    { resource: 'devices', action: 'execute' },
    { resource: 'backup', action: 'read' },
    ...extraPermissions,
  ]);
  await assignUserToPartner(user.id, partner.id, role.id, 'all');

  const sourceA1 = await seedDevice(orgA.id, siteA1.id);
  const targetA1 = await seedDevice(orgA.id, siteA1.id);
  const targetA2 = await seedDevice(orgA.id, siteA2.id);
  const targetB = await seedDevice(orgB.id, siteB.id);

  const [config] = await testDb.insert(backupConfigs).values({
    orgId: orgA.id,
    name: 'Restore scope config',
    type: 'file',
    provider: 'local',
    providerConfig: {},
  }).returning({ id: backupConfigs.id });
  const [job] = await testDb.insert(backupJobs).values({
    orgId: orgA.id, configId: config!.id, deviceId: sourceA1, status: 'completed',
  }).returning({ id: backupJobs.id });

  const snapshot = async (metadata: Record<string, unknown>) => {
    const [row] = await testDb.insert(backupSnapshots).values({
      orgId: orgA.id,
      jobId: job!.id,
      deviceId: sourceA1,
      configId: config!.id,
      snapshotId: `restore-scope-${randomUUID()}`,
      storageIdentity: `local::/restore-scope/${randomUUID()}`,
      metadata,
    }).returning({ id: backupSnapshots.id });
    // AI agents restore attested snapshots only.
    await attestSnapshotForTest(row!.id);
    return row!.id;
  };

  return {
    partnerId: partner.id,
    orgA: orgA.id,
    orgB: orgB.id,
    userId: user.id,
    roleId: role.id,
    sourceA1,
    targetA1,
    targetA2,
    targetB,
    fileSnapshot: await snapshot({}),
    hypervSnapshot: await snapshot({ backupKind: 'hyperv_export' }),
    mssqlSnapshot: await snapshot({ backupKind: 'mssql_database', backupFileName: 'db.bak', instance: 'MSSQLSERVER' }),
  };
}

function partnerAuth(fx: Fixture): AuthContext {
  const orgIds = [fx.orgA, fx.orgB];
  return {
    principal: { kind: 'user_session' },
    user: { id: fx.userId, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: fx.partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: orgIds,
    orgCondition: (col: PgColumn) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'restore-scope' },
  } as unknown as AuthContext;
}

async function run(fx: Fixture, tool: string, input: Record<string, unknown>) {
  const handler = tools().get(tool)!.handler;
  const raw = await withDbAccessContext(
    {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [fx.orgA, fx.orgB],
      accessiblePartnerIds: [fx.partnerId],
      userId: fx.userId,
    },
    () => handler(input, partnerAuth(fx)),
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

type RestoreCase = {
  tool: string;
  input: (fx: Fixture, targetDeviceId: string) => Record<string, unknown>;
};

const RESTORE_CASES: RestoreCase[] = [
  {
    tool: 'restore_snapshot',
    input: (fx, target) => ({ snapshotId: fx.fileSnapshot, deviceId: target }),
  },
  {
    tool: 'restore_as_vm',
    input: (fx, target) => ({ snapshotId: fx.fileSnapshot, targetDeviceId: target, hypervisor: 'hyperv', vmName: 'restored' }),
  },
  {
    tool: 'instant_boot_vm',
    input: (fx, target) => ({ snapshotId: fx.fileSnapshot, targetDeviceId: target, vmName: 'booted' }),
  },
  {
    tool: 'restore_hyperv_vm',
    input: (fx, target) => ({ snapshotId: fx.hypervSnapshot, deviceId: target }),
  },
  {
    tool: 'restore_mssql_database',
    input: (fx, target) => ({ snapshotId: fx.mssqlSnapshot, deviceId: target, targetDatabase: 'RestoredDb' }),
  },
];

describe('AI restore tools — org binding and cross-site permission', () => {
  beforeEach(async () => {
    vi.mocked(aiQueueCommandForExecution).mockClear();
    await clearPermissionCache();
  });

  describe.each(RESTORE_CASES)('$tool', ({ tool, input }) => {
    runDb('refuses restoring an org-A snapshot onto an org-B device', async () => {
      const fx = await seedFixture([{ resource: 'backup', action: 'cross_site_restore' }]);
      const result = await run(fx, tool, input(fx, fx.targetB));

      expect(result.success).toBeUndefined();
      expect(result.error).toBe('Snapshot and target device must belong to the same organization');
      expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
    });

    runDb('refuses a cross-site restore without backup:cross_site_restore', async () => {
      const fx = await seedFixture();
      const result = await run(fx, tool, input(fx, fx.targetA2));

      expect(result.success).toBeUndefined();
      expect(String(result.error)).toMatch(/^site_access_denied/);
      expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
    });

    runDb('dispatches a cross-site restore with backup:cross_site_restore', async () => {
      const fx = await seedFixture([{ resource: 'backup', action: 'cross_site_restore' }]);
      const result = await run(fx, tool, input(fx, fx.targetA2));

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(aiQueueCommandForExecution).toHaveBeenCalledTimes(1);
    });

    runDb('dispatches a same-site restore without backup:cross_site_restore', async () => {
      const fx = await seedFixture();
      const result = await run(fx, tool, input(fx, fx.targetA1));

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(aiQueueCommandForExecution).toHaveBeenCalledTimes(1);
    });
  });

  runDb('restore_as_vm (rebuild engine) refuses a cross-site rebuild host without backup:cross_site_restore', async () => {
    const fx = await seedFixture();
    const [siteA2] = await getTestDb().select({ siteId: devices.siteId }).from(devices).where(eq(devices.id, fx.targetA2));
    const linuxHost = await seedDevice(fx.orgA, siteA2!.siteId, 'linux');
    const result = await run(fx, 'restore_as_vm', {
      engine: 'rebuild', snapshotId: fx.fileSnapshot, rebuildHostDeviceId: linuxHost, outputPath: '/srv/out.vhdx',
    });

    expect(result.success).toBeUndefined();
    expect(String(result.error)).toMatch(/^site_access_denied/);
  });
});

describe('manage_dr_plan groups stay in the plan org', () => {
  async function seedPlan(fx: Fixture, orgId: string) {
    const [plan] = await getTestDb().insert(drPlans).values({
      orgId, name: `restore-scope-plan-${randomUUID().slice(0, 8)}`, status: 'draft',
    }).returning({ id: drPlans.id });
    return plan!.id;
  }

  runDb('add_group refuses a device from another org the caller can also reach', async () => {
    const fx = await seedFixture();
    const planId = await seedPlan(fx, fx.orgA);

    const result = await run(fx, 'manage_dr_plan', {
      action: 'add_group', planId, name: 'cross-org group', devices: [fx.targetA1, fx.targetB],
    });

    expect(result.success).toBeUndefined();
    expect(result.error).toBe('One or more devices do not belong to this organization');
    const groups = await getTestDb().select({ id: drPlanGroups.id }).from(drPlanGroups).where(eq(drPlanGroups.planId, planId));
    expect(groups).toHaveLength(0);
  });

  runDb('update_group refuses a device from another org and a dependsOnGroupId from another plan', async () => {
    const fx = await seedFixture();
    const planId = await seedPlan(fx, fx.orgA);
    const otherPlanId = await seedPlan(fx, fx.orgA);
    const [group] = await getTestDb().insert(drPlanGroups).values({
      planId, orgId: fx.orgA, name: 'g', devices: [fx.targetA1],
    }).returning({ id: drPlanGroups.id });
    const [foreignGroup] = await getTestDb().insert(drPlanGroups).values({
      planId: otherPlanId, orgId: fx.orgA, name: 'other', devices: [],
    }).returning({ id: drPlanGroups.id });

    const crossOrg = await run(fx, 'manage_dr_plan', {
      action: 'update_group', planId, groupId: group!.id, devices: [fx.targetB],
    });
    expect(crossOrg.error).toBe('One or more devices do not belong to this organization');

    const crossPlan = await run(fx, 'manage_dr_plan', {
      action: 'update_group', planId, groupId: group!.id, dependsOnGroupId: foreignGroup!.id,
    });
    expect(crossPlan.error).toBe('dependsOnGroupId must reference another group in the same DR plan');

    const [stored] = await getTestDb().select().from(drPlanGroups).where(eq(drPlanGroups.id, group!.id));
    expect(stored!.devices).toEqual([fx.targetA1]);
    expect(stored!.dependsOnGroupId).toBeNull();
  });
});
