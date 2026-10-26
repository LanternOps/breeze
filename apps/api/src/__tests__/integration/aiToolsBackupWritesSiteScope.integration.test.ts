/**
 * Integration test — W03 (#6757) backup write tools honour the site axis and
 * the org axis, against real Postgres as the unprivileged `breeze_app` role
 * (org-axis RLS genuinely enforced; the site axis is applied app-layer).
 *
 * Tools: trigger_backup, restore_snapshot, configure_vault (create + update),
 * trigger_vault_sync, trigger_mssql_backup, verify_mssql_backup,
 * restore_mssql_database.
 *
 * Fixture: one org with two sites (A = the restricted caller's allowed site,
 * B = forbidden), an online device and an attested snapshot sourced from each,
 * a vault on each device, plus a second org with its own device. For every
 * tool:
 *   (i)   out-of-site caller          -> refused / "not found", nothing written
 *   (ii)  in-site caller              -> succeeds (non-vacuous)
 *   (iii) caller from a second org    -> "not found"
 *   (iv)  unrestricted caller         -> reaches the site-B resources
 *
 * Only the device command dispatch, the BullMQ enqueue, the provider-config
 * decrypt and the policy -> backup config resolver are stubbed; every refusal
 * under test happens before them.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { enqueueBackupDispatchMock, resolvedBackupConfig } = vi.hoisted(() => ({
  enqueueBackupDispatchMock: vi.fn(async (..._args: unknown[]) => undefined),
  // Set per fixture: the config `resolveBackupConfigForDevice` hands back.
  resolvedBackupConfig: { configId: null as string | null },
}));

vi.mock('../../services/aiDispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiDispatch')>();
  return {
    ...actual,
    // restore_snapshot gets a real device_commands row (restore_jobs.command_id
    // is an FK); every other tool gets a stand-in id. configure_vault holds a
    // FOR UPDATE lock on the device row (updateVaultWithinCurrentSite) while
    // it dispatches, so a row inserted over the separate test connection would
    // wait on that lock forever.
    aiQueueCommandForExecution: vi.fn(async (_auth: unknown, tool: string, deviceId: string, type: string) => {
      if (tool !== 'restore_snapshot') return { command: { id: crypto.randomUUID(), status: 'pending' } };
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
vi.mock('../../jobs/backupEnqueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/backupEnqueue')>();
  return { ...actual, enqueueBackupDispatch: enqueueBackupDispatchMock };
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
  devices,
  deviceCommands,
  localVaults,
  restoreJobs,
} from '../../db/schema';
import { registerBackupTools } from '../../services/aiToolsBackup';
import { registerMssqlTools } from '../../services/aiToolsMssql';
import { registerVaultTools } from '../../services/aiToolsVault';
import { updateVaultWithinCurrentSite } from '../../services/localVaultUpdate';
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
  registerBackupTools(reg);
  registerMssqlTools(reg);
  registerVaultTools(reg);
  return reg;
}

async function seedDevice(orgId: string, siteId: string) {
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `backup-writes-${randomUUID()}`,
    hostname: `bw-${randomUUID().slice(0, 8)}`,
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
  configA: string;
  fileSnapA: string;
  fileSnapB: string;
  mssqlSnapA: string;
  mssqlSnapB: string;
  vaultA: string;
  vaultB: string;
  vaultOther: string;
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
    aiOrigin: { kind: 'ai_assistant', sessionId: 'backup-writes-scope' },
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
  const siteA = await createSite({ orgId: orgA.id, name: 'Backup writes A' });
  const siteB = await createSite({ orgId: orgA.id, name: 'Backup writes B' });
  const siteOther = await createSite({ orgId: orgB.id, name: 'Backup writes other' });

  // A real org member whose role is resolved by the real getUserPermissions.
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `bw-${randomUUID()}@example.com` });
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

  const [config] = await testDb.insert(backupConfigs).values({
    orgId: orgA.id, name: 'Backup writes config', type: 'file', provider: 'local', providerConfig: {},
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
      snapshotId: `bw-${randomUUID()}`,
      storageIdentity: `local::/bw/${randomUUID()}`,
      metadata,
    }).returning({ id: backupSnapshots.id });
    // AI agents restore attested snapshots only.
    await attestSnapshotForTest(row!.id);
    return row!.id;
  };
  const mssqlMeta = { backupKind: 'mssql_database', backupFileName: 'db.bak', instance: 'MSSQLSERVER' };

  const vault = async (orgId: string, deviceId: string, vaultPath: string) => {
    const [row] = await testDb.insert(localVaults).values({ orgId, deviceId, vaultPath }).returning({ id: localVaults.id });
    return row!.id;
  };

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
    configA: config!.id,
    fileSnapA: await snapshot(jobA, devA, {}),
    fileSnapB: await snapshot(jobB, devB, {}),
    mssqlSnapA: await snapshot(jobA, devA, mssqlMeta),
    mssqlSnapB: await snapshot(jobB, devB, mssqlMeta),
    vaultA: await vault(orgA.id, devA, '/vault/a'),
    vaultB: await vault(orgA.id, devB, '/vault/b'),
    vaultOther: await vault(orgB.id, devOther, '/vault/other'),
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

const DEVICE_DENIED = 'Device not found or access denied';
const VAULT_DENIED = 'Vault not found or access denied';
const SNAPSHOT_DENIED = 'Snapshot not found or access denied';

async function loadVault(id: string) {
  const [row] = await getTestDb().select().from(localVaults).where(eq(localVaults.id, id));
  return row!;
}

describe('W03 backup write tools — site axis + org axis (real Postgres, breeze_app)', () => {
  let f: Fixture;
  beforeEach(async () => {
    await clearPermissionCache();
    enqueueBackupDispatchMock.mockClear();
    f = await seedFixture();
  });

  describe('trigger_backup', () => {
    runDb('out-of-site device is not found and no job is created; in-site succeeds', async () => {
      const denied = await run(f, 'restricted', 'trigger_backup', { deviceId: f.devB, configId: f.configA });
      expect(denied).toEqual({ error: DEVICE_DENIED });
      const manualOnB = await getTestDb().select({ id: backupJobs.id }).from(backupJobs)
        .where(eq(backupJobs.deviceId, f.devB));
      // only the seeded 'completed' fixture job, nothing new
      expect(manualOnB).toHaveLength(1);
      expect(enqueueBackupDispatchMock).not.toHaveBeenCalled();

      const ok = await run(f, 'restricted', 'trigger_backup', { deviceId: f.devA, configId: f.configA });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect(ok.created).toBe(true);
      expect(enqueueBackupDispatchMock).toHaveBeenCalledTimes(1);
    });

    runDb('cross-org caller gets not found; unrestricted caller reaches the site-B device', async () => {
      expect(await run(f, 'otherOrg', 'trigger_backup', { deviceId: f.devA, configId: f.configA })).toEqual({ error: DEVICE_DENIED });

      const wide = await run(f, 'unrestricted', 'trigger_backup', { deviceId: f.devB, configId: f.configA });
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
    });
  });

  describe('restore_snapshot', () => {
    runDb('refuses a target device in another site and writes no restore job', async () => {
      const result = await run(f, 'restricted', 'restore_snapshot', { snapshotId: f.fileSnapA, deviceId: f.devB });
      expect(result).toEqual({ error: DEVICE_DENIED });
      expect(await getTestDb().select({ id: restoreJobs.id }).from(restoreJobs)).toHaveLength(0);
    });

    runDb('refuses a snapshot whose source device is in another site, even onto an in-site target', async () => {
      const result = await run(f, 'restricted', 'restore_snapshot', { snapshotId: f.fileSnapB, deviceId: f.devA });
      expect(result).toEqual({ error: SNAPSHOT_DENIED });
      expect(await getTestDb().select({ id: restoreJobs.id }).from(restoreJobs)).toHaveLength(0);
    });

    runDb('in-site restore dispatches; cross-org caller gets not found; unrestricted caller restores site-B to site-B', async () => {
      const ok = await run(f, 'restricted', 'restore_snapshot', { snapshotId: f.fileSnapA, deviceId: f.devA });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);

      expect(await run(f, 'otherOrg', 'restore_snapshot', { snapshotId: f.fileSnapA, deviceId: f.devA })).toEqual({ error: DEVICE_DENIED });

      const wide = await run(f, 'unrestricted', 'restore_snapshot', { snapshotId: f.fileSnapB, deviceId: f.devB });
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
    });
  });

  describe('configure_vault create', () => {
    runDb('out-of-site device is refused and no vault is inserted; in-site succeeds', async () => {
      const denied = await run(f, 'restricted', 'configure_vault', { action: 'create', deviceId: f.devB, vaultPath: '/new/b' });
      expect(denied).toEqual({ error: DEVICE_DENIED });
      const onB = await getTestDb().select({ id: localVaults.id }).from(localVaults).where(eq(localVaults.deviceId, f.devB));
      expect(onB).toHaveLength(1); // the seeded vault only

      const ok = await run(f, 'restricted', 'configure_vault', { action: 'create', deviceId: f.devA, vaultPath: '/new/a' });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect((await loadVault(ok.vault.id)).vaultPath).toBe('/new/a');
    });

    runDb('cross-org caller gets not found; unrestricted caller creates on the site-B device', async () => {
      expect(await run(f, 'otherOrg', 'configure_vault', { action: 'create', deviceId: f.devA, vaultPath: '/x' })).toEqual({ error: DEVICE_DENIED });

      const wide = await run(f, 'unrestricted', 'configure_vault', { action: 'create', deviceId: f.devB, vaultPath: '/wide/b' });
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
    });
  });

  describe('configure_vault update (via updateVaultWithinCurrentSite)', () => {
    runDb('a site-restricted caller cannot update a vault whose device is in another site', async () => {
      const denied = await run(f, 'restricted', 'configure_vault', { action: 'update', vaultId: f.vaultB, vaultPath: '/hijacked' });
      expect(denied).toEqual({ error: VAULT_DENIED });
      expect((await loadVault(f.vaultB)).vaultPath).toBe('/vault/b');
    });

    runDb('in-site update lands; cross-org vault is not found; unrestricted caller updates the site-B vault', async () => {
      const ok = await run(f, 'restricted', 'configure_vault', { action: 'update', vaultId: f.vaultA, vaultPath: '/renamed/a', retentionCount: 7 });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      const stored = await loadVault(f.vaultA);
      expect(stored.vaultPath).toBe('/renamed/a');
      expect(stored.retentionCount).toBe(7);

      expect(await run(f, 'otherOrg', 'configure_vault', { action: 'update', vaultId: f.vaultA, vaultPath: '/x' })).toEqual({ error: VAULT_DENIED });
      expect((await loadVault(f.vaultA)).vaultPath).toBe('/renamed/a');

      const wide = await run(f, 'unrestricted', 'configure_vault', { action: 'update', vaultId: f.vaultB, vaultPath: '/wide/b' });
      expect(wide.error).toBeUndefined();
      expect((await loadVault(f.vaultB)).vaultPath).toBe('/wide/b');
    });

    runDb('updateVaultWithinCurrentSite writes only inside the allowed sites (the locked write path)', async () => {
      const inSite = (sites: readonly string[] | undefined) => withDbAccessContext(
        orgCtx(f.orgA, f),
        () => updateVaultWithinCurrentSite(f.orgA, f.vaultB, { vaultPath: '/locked/b' }, sites),
      );

      // vault B's device is in site B: allowlists that exclude B write nothing
      expect(await inSite([f.siteA])).toBeUndefined();
      expect(await inSite([])).toBeUndefined();
      expect((await loadVault(f.vaultB)).vaultPath).toBe('/vault/b');

      // an allowlist that includes B writes
      const row = await inSite([f.siteB]);
      expect(row?.vaultPath).toBe('/locked/b');
      expect((await loadVault(f.vaultB)).vaultPath).toBe('/locked/b');
    });
  });

  describe('trigger_vault_sync', () => {
    runDb('out-of-site vault is not found and its sync state is untouched; in-site dispatches', async () => {
      const denied = await run(f, 'restricted', 'trigger_vault_sync', { vaultId: f.vaultB, snapshotId: 'snap-1' });
      expect(denied).toEqual({ error: VAULT_DENIED });
      expect((await loadVault(f.vaultB)).lastSyncStatus).toBeNull();

      const ok = await run(f, 'restricted', 'trigger_vault_sync', { vaultId: f.vaultA, snapshotId: 'snap-1' });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect((await loadVault(f.vaultA)).lastSyncStatus).toBe('pending');
    });

    runDb('cross-org caller gets not found; unrestricted caller syncs the site-B vault', async () => {
      expect(await run(f, 'otherOrg', 'trigger_vault_sync', { vaultId: f.vaultA, snapshotId: 'snap-1' })).toEqual({ error: VAULT_DENIED });

      const wide = await run(f, 'unrestricted', 'trigger_vault_sync', { vaultId: f.vaultB, snapshotId: 'snap-1' });
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
    });
  });

  describe('trigger_mssql_backup', () => {
    const input = (deviceId: string) => ({ deviceId, instance: 'MSSQLSERVER', database: 'AppDb' });

    runDb('out-of-site device is not found and no job is created; in-site dispatches', async () => {
      const denied = await run(f, 'restricted', 'trigger_mssql_backup', input(f.devB));
      expect(denied).toEqual({ error: DEVICE_DENIED });
      const manualOnB = await getTestDb().select({ id: backupJobs.id }).from(backupJobs).where(eq(backupJobs.deviceId, f.devB));
      expect(manualOnB).toHaveLength(1); // the seeded fixture job only

      const ok = await run(f, 'restricted', 'trigger_mssql_backup', input(f.devA));
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect(ok.backupJobId).toBeTruthy();
    });

    runDb('cross-org caller gets not found; unrestricted caller reaches the site-B device', async () => {
      expect(await run(f, 'otherOrg', 'trigger_mssql_backup', input(f.devA))).toEqual({ error: DEVICE_DENIED });

      const wide = await run(f, 'unrestricted', 'trigger_mssql_backup', input(f.devB));
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
    });
  });

  describe('verify_mssql_backup', () => {
    runDb('a snapshot from an out-of-site device is not found and nothing is queued; in-site dispatches', async () => {
      const before = (await getTestDb().select({ id: deviceCommands.id }).from(deviceCommands)).length;
      const denied = await run(f, 'restricted', 'verify_mssql_backup', { snapshotId: f.mssqlSnapB });
      expect(denied).toEqual({ error: SNAPSHOT_DENIED });
      expect((await getTestDb().select({ id: deviceCommands.id }).from(deviceCommands)).length).toBe(before);

      const ok = await run(f, 'restricted', 'verify_mssql_backup', { snapshotId: f.mssqlSnapA });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect(ok.deviceId).toBe(f.devA);
    });

    runDb('cross-org caller gets not found; unrestricted caller verifies the site-B snapshot', async () => {
      expect(await run(f, 'otherOrg', 'verify_mssql_backup', { snapshotId: f.mssqlSnapA })).toEqual({ error: SNAPSHOT_DENIED });

      const wide = await run(f, 'unrestricted', 'verify_mssql_backup', { snapshotId: f.mssqlSnapB });
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
    });
  });

  describe('restore_mssql_database', () => {
    const input = (snapshotId: string, deviceId: string) => ({ snapshotId, deviceId, targetDatabase: 'RestoredDb' });

    runDb('refuses a target device in another site', async () => {
      expect(await run(f, 'restricted', 'restore_mssql_database', input(f.mssqlSnapA, f.devB))).toEqual({ error: DEVICE_DENIED });
    });

    runDb('refuses a snapshot whose source device is in another site, even onto an in-site target', async () => {
      expect(await run(f, 'restricted', 'restore_mssql_database', input(f.mssqlSnapB, f.devA))).toEqual({ error: SNAPSHOT_DENIED });
    });

    runDb('in-site restore dispatches; cross-org caller gets not found; unrestricted caller restores site-B to site-B', async () => {
      const ok = await run(f, 'restricted', 'restore_mssql_database', input(f.mssqlSnapA, f.devA));
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);

      expect(await run(f, 'otherOrg', 'restore_mssql_database', input(f.mssqlSnapA, f.devA))).toEqual({ error: DEVICE_DENIED });

      const wide = await run(f, 'unrestricted', 'restore_mssql_database', input(f.mssqlSnapB, f.devB));
      expect(wide.error).toBeUndefined();
      expect(wide.success).toBe(true);
    });
  });
});
