import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { DelayedError, Job, UnrecoverableError } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({
  mediaBuild: vi.fn(),
  bootBuild: vi.fn(),
  queueCommand: vi.fn(),
  scheduledProviderConfig: vi.fn(),
}));

vi.mock('../../services/recoveryMediaService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/recoveryMediaService')>();
  return { ...actual, buildRecoveryMediaArtifact: effects.mediaBuild };
});

vi.mock('../../services/recoveryBootMediaService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/recoveryBootMediaService')>();
  return { ...actual, buildRecoveryBootMediaArtifact: effects.bootBuild };
});

vi.mock('../../services/commandQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/commandQueue')>();
  return { ...actual, queueCommandForExecution: effects.queueCommand };
});

import { withSystemDbAccessContext } from '../../db';
import {
  aiAgentRuns,
  aiAgents,
  apiKeys,
  backupConfigs,
  backupJobs,
  backupSnapshots,
  backupVerifications,
  c2cBackupConfigs,
  c2cBackupItems,
  c2cBackupJobs,
  c2cConnections,
  devices,
  drExecutions,
  drPlanGroups,
  drPlans,
  oauthClients,
  oauthGrants,
  organizationUsers,
  recoveryBootMediaArtifacts,
  recoveryMediaArtifacts,
  recoveryTokens,
  servicePrincipals,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { processC2cQueuedJob } from '../../jobs/c2cBackupWorker';
import { processDrExecutionReconcileJob } from '../../jobs/drExecutionWorker';
import { processRecoveryBootMediaBuildJob } from '../../jobs/recoveryBootMediaWorker';
import { processRecoveryMediaBuildJob } from '../../jobs/recoveryMediaWorker';
import type {
  DrExecutionQueueJobData,
  RecoveryBootMediaQueueJobData,
  RecoveryMediaQueueJobData,
} from '../../jobs/queueSchemas';
import { runScheduledBackupVerification } from '../../routes/backup/verificationService';
import {
  captureRecoveryAuthorizationSubject,
  type CapturedRecoveryAuthorizationSubject,
  type RecoveryAuthorizationIntent,
  type RecoveryAuthorizationOperation,
} from '../../services/recoveryAuthorizationSubject';
import { clearPermissionCache } from '../../services/permissions';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

type TestDb = ReturnType<typeof getTestDb>;

type World = {
  partnerId: string;
  orgId: string;
  foreignOrgId: string;
  siteA1: string;
  siteA2: string;
  operator: Awaited<ReturnType<typeof createUser>>;
  sourceDeviceId: string;
  targetDeviceId: string;
  mismatchDeviceId: string;
  foreignDeviceId: string;
  backupConfigId: string;
  backupJobId: string;
  snapshotId: string;
  providerSnapshotId: string;
  recoveryTokenId: string;
  c2cConfigId: string;
  c2cItemId: string;
};

type EffectCounts = {
  deviceCommands: number;
  backupVerifications: number;
  mediaArtifacts: number;
  bootArtifacts: number;
  drExecutions: number;
  c2cJobs: number;
};

const previousAiEnabled = process.env.BREEZE_AI_AGENTS_ENABLED;

function authContext(
  world: World,
  principal: AuthContext['principal'],
  user = world.operator,
): AuthContext {
  return {
    principal,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isPlatformAdmin: false,
    },
    token: null,
    partnerId: world.partnerId,
    orgId: world.orgId,
    scope: 'organization',
    accessibleOrgIds: [world.orgId],
    orgCondition: () => undefined,
    canAccessOrg: (orgId) => orgId === world.orgId,
  } as AuthContext;
}

async function seedDevice(
  db: TestDb,
  input: { orgId: string; siteId: string; label: string },
): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [device] = await db.insert(devices).values({
    orgId: input.orgId,
    siteId: input.siteId,
    agentId: `worker-auth-${input.label}-${suffix}`,
    hostname: `worker-auth-${input.label}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: 'test',
    status: 'online',
  }).returning({ id: devices.id });
  if (!device) throw new Error(`device fixture ${input.label} failed`);
  return device.id;
}

async function seedWorld(): Promise<World> {
  const db = getTestDb();
  const partner = await createPartner({ name: 'Queued recovery partner A' });
  const org = await createOrganization({ partnerId: partner.id, name: 'Queued recovery org A' });
  const siteA1 = await createSite({ orgId: org.id, name: 'Queued recovery site A1' });
  const siteA2 = await createSite({ orgId: org.id, name: 'Queued recovery site A2' });
  const foreignPartner = await createPartner({ name: 'Queued recovery partner B' });
  const foreignOrg = await createOrganization({
    partnerId: foreignPartner.id,
    name: 'Queued recovery org B',
  });
  const foreignSite = await createSite({ orgId: foreignOrg.id, name: 'Queued recovery site B1' });

  const operator = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    name: 'Queued Recovery Operator',
    status: 'active',
  });
  const role = await createRole({
    scope: 'organization',
    partnerId: partner.id,
    orgId: org.id,
    name: 'Queued Recovery Operator Role',
  });
  await grantRolePermissions(role.id, [
    { resource: 'backup', action: 'write' },
    { resource: 'devices', action: 'execute' },
    { resource: 'organizations', action: 'write' },
  ]);
  const membership = await assignUserToOrganization(operator.id, org.id, role.id);
  await db.update(organizationUsers)
    .set({ siteIds: [siteA1.id] })
    .where(eq(organizationUsers.id, membership.id));
  await clearPermissionCache(operator.id);

  const sourceDeviceId = await seedDevice(db, { orgId: org.id, siteId: siteA1.id, label: 'source' });
  const targetDeviceId = await seedDevice(db, { orgId: org.id, siteId: siteA1.id, label: 'target' });
  const mismatchDeviceId = await seedDevice(db, { orgId: org.id, siteId: siteA1.id, label: 'mismatch' });
  const foreignDeviceId = await seedDevice(db, {
    orgId: foreignOrg.id,
    siteId: foreignSite.id,
    label: 'foreign',
  });

  const [backupConfig] = await db.insert(backupConfigs).values({
    orgId: org.id,
    name: 'Queued recovery destination',
    type: 'file',
    provider: 'local',
    providerConfig: { path: '/integration/queued-recovery' },
  }).returning({ id: backupConfigs.id });
  if (!backupConfig) throw new Error('backup config fixture failed');

  const providerSnapshotId = `provider-${randomUUID()}`;
  const [backupJob] = await db.insert(backupJobs).values({
    orgId: org.id,
    configId: backupConfig.id,
    deviceId: sourceDeviceId,
    status: 'completed',
    snapshotId: providerSnapshotId,
  }).returning({ id: backupJobs.id });
  if (!backupJob) throw new Error('backup job fixture failed');
  const [snapshot] = await db.insert(backupSnapshots).values({
    orgId: org.id,
    jobId: backupJob.id,
    deviceId: sourceDeviceId,
    configId: backupConfig.id,
    snapshotId: providerSnapshotId,
  }).returning({ id: backupSnapshots.id });
  if (!snapshot) throw new Error('snapshot fixture failed');

  const [token] = await db.insert(recoveryTokens).values({
    orgId: org.id,
    deviceId: targetDeviceId,
    snapshotId: snapshot.id,
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    restoreType: 'full',
    status: 'active',
    createdBy: operator.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  }).returning({ id: recoveryTokens.id });
  if (!token) throw new Error('recovery token fixture failed');

  const [c2cConnection] = await db.insert(c2cConnections).values({
    orgId: org.id,
    provider: 'microsoft_365',
    displayName: 'Queued recovery source',
    status: 'active',
  }).returning({ id: c2cConnections.id });
  if (!c2cConnection) throw new Error('C2C connection fixture failed');
  const [c2cConfig] = await db.insert(c2cBackupConfigs).values({
    orgId: org.id,
    connectionId: c2cConnection.id,
    name: 'Queued recovery C2C config',
    backupScope: 'all_users',
    storageConfigId: backupConfig.id,
    isActive: true,
  }).returning({ id: c2cBackupConfigs.id });
  if (!c2cConfig) throw new Error('C2C config fixture failed');
  const [c2cItem] = await db.insert(c2cBackupItems).values({
    orgId: org.id,
    configId: c2cConfig.id,
    itemType: 'mail',
    externalId: `item-${randomUUID()}`,
  }).returning({ id: c2cBackupItems.id });
  if (!c2cItem) throw new Error('C2C item fixture failed');

  // Known-valid foreign sentinels prove the topology is genuinely cross-tenant.
  const [foreignConfig] = await db.insert(backupConfigs).values({
    orgId: foreignOrg.id,
    name: 'Foreign recovery destination',
    type: 'file',
    provider: 'local',
    providerConfig: { path: '/integration/foreign' },
  }).returning({ id: backupConfigs.id });
  if (!foreignConfig) throw new Error('foreign backup config fixture failed');
  const [foreignJob] = await db.insert(backupJobs).values({
    orgId: foreignOrg.id,
    configId: foreignConfig.id,
    deviceId: foreignDeviceId,
    status: 'completed',
    snapshotId: `foreign-provider-${randomUUID()}`,
  }).returning({ id: backupJobs.id, snapshotId: backupJobs.snapshotId });
  if (!foreignJob) throw new Error('foreign backup job fixture failed');
  await db.insert(backupSnapshots).values({
    orgId: foreignOrg.id,
    jobId: foreignJob.id,
    deviceId: foreignDeviceId,
    configId: foreignConfig.id,
    snapshotId: foreignJob.snapshotId!,
  });

  return {
    partnerId: partner.id,
    orgId: org.id,
    foreignOrgId: foreignOrg.id,
    siteA1: siteA1.id,
    siteA2: siteA2.id,
    operator,
    sourceDeviceId,
    targetDeviceId,
    mismatchDeviceId,
    foreignDeviceId,
    backupConfigId: backupConfig.id,
    backupJobId: backupJob.id,
    snapshotId: snapshot.id,
    providerSnapshotId,
    recoveryTokenId: token.id,
    c2cConfigId: c2cConfig.id,
    c2cItemId: c2cItem.id,
  };
}

async function capture(
  world: World,
  auth: AuthContext,
  operation: RecoveryAuthorizationOperation | RecoveryAuthorizationIntent,
): Promise<CapturedRecoveryAuthorizationSubject> {
  return captureRecoveryAuthorizationSubject(auth, world.orgId, operation);
}

async function insertMediaArtifact(
  world: World,
  subject?: CapturedRecoveryAuthorizationSubject,
): Promise<string> {
  const [row] = await getTestDb().insert(recoveryMediaArtifacts).values({
    orgId: world.orgId,
    tokenId: world.recoveryTokenId,
    snapshotId: world.snapshotId,
    platform: 'windows',
    architecture: 'x86_64',
    status: 'pending',
    createdBy: world.operator.id,
    ...(subject ?? {}),
  }).returning({ id: recoveryMediaArtifacts.id });
  if (!row) throw new Error('media artifact fixture failed');
  return row.id;
}

async function insertBootArtifact(
  world: World,
  subject: CapturedRecoveryAuthorizationSubject,
  existingBundleArtifactId?: string,
): Promise<string> {
  const bundleArtifactId = existingBundleArtifactId ?? await insertMediaArtifact(world);
  const [row] = await getTestDb().insert(recoveryBootMediaArtifacts).values({
    orgId: world.orgId,
    tokenId: world.recoveryTokenId,
    snapshotId: world.snapshotId,
    bundleArtifactId,
    platform: 'windows',
    architecture: 'x86_64',
    mediaType: 'iso',
    status: 'pending',
    createdBy: world.operator.id,
    ...subject,
  }).returning({ id: recoveryBootMediaArtifacts.id });
  if (!row) throw new Error('boot artifact fixture failed');
  return row.id;
}

async function insertDrExecution(
  world: World,
  subject: CapturedRecoveryAuthorizationSubject,
): Promise<string> {
  const db = getTestDb();
  const [plan] = await db.insert(drPlans).values({
    orgId: world.orgId,
    name: `Queued recovery DR ${randomUUID()}`,
  }).returning({ id: drPlans.id });
  if (!plan) throw new Error('DR plan fixture failed');
  await db.insert(drPlanGroups).values({
    planId: plan.id,
    orgId: world.orgId,
    name: 'Restore group',
    sequence: 0,
    devices: [world.targetDeviceId],
    restoreConfig: {
      commandType: 'vm_restore_from_backup',
      payload: { snapshotId: world.providerSnapshotId },
    },
  });
  const [execution] = await db.insert(drExecutions).values({
    planId: plan.id,
    orgId: world.orgId,
    executionType: 'rehearsal',
    status: 'pending',
    startedAt: new Date(),
    initiatedBy: world.operator.id,
    results: {},
    ...subject,
  }).returning({ id: drExecutions.id });
  if (!execution) throw new Error('DR execution fixture failed');
  return execution.id;
}

async function insertC2cRestore(
  world: World,
  subject: CapturedRecoveryAuthorizationSubject,
): Promise<string> {
  const [row] = await getTestDb().insert(c2cBackupJobs).values({
    orgId: world.orgId,
    configId: world.c2cConfigId,
    operationKind: 'restore',
    status: 'pending',
    ...subject,
  }).returning({ id: c2cBackupJobs.id });
  if (!row) throw new Error('C2C restore fixture failed');
  return row.id;
}

function mediaJob(artifactId: string): Job<RecoveryMediaQueueJobData> {
  return {
    id: `recovery-media-${artifactId}`,
    name: 'build-media',
    data: { type: 'build-media', artifactId },
  } as Job<RecoveryMediaQueueJobData>;
}

function bootJob(artifactId: string): Job<RecoveryBootMediaQueueJobData> {
  return {
    id: `recovery-boot-media-${artifactId}`,
    name: 'build-boot-media',
    data: { type: 'build-boot-media', artifactId },
  } as Job<RecoveryBootMediaQueueJobData>;
}

function drJob(executionId: string) {
  const moveToDelayed = vi.fn().mockResolvedValue(undefined);
  return {
    job: {
      id: `dr-execution-${executionId}`,
      name: 'reconcile-execution',
      token: 'queued-recovery-integration-token',
      data: { type: 'reconcile-execution', executionId },
      moveToDelayed,
    } as unknown as Job<DrExecutionQueueJobData>,
    moveToDelayed,
  };
}

async function readEffectCounts(): Promise<EffectCounts> {
  const db = getTestDb();
  const rows = await db.execute(sql`
    select
      (select count(*)::int from device_commands) as device_commands,
      (select count(*)::int from backup_verifications) as backup_verifications,
      (select count(*)::int from recovery_media_artifacts) as media_artifacts,
      (select count(*)::int from recovery_boot_media_artifacts) as boot_artifacts,
      (select count(*)::int from dr_executions) as dr_executions,
      (select count(*)::int from c2c_backup_jobs) as c2c_jobs
  `);
  const row = rows[0] as Record<string, number | string>;
  return {
    deviceCommands: Number(row.device_commands),
    backupVerifications: Number(row.backup_verifications),
    mediaArtifacts: Number(row.media_artifacts),
    bootArtifacts: Number(row.boot_artifacts),
    drExecutions: Number(row.dr_executions),
    c2cJobs: Number(row.c2c_jobs),
  };
}

async function expectNoEffects(before: EffectCounts, moveToDelayed?: ReturnType<typeof vi.fn>) {
  expect(effects.mediaBuild).not.toHaveBeenCalled();
  expect(effects.bootBuild).not.toHaveBeenCalled();
  expect(effects.queueCommand).not.toHaveBeenCalled();
  expect(effects.scheduledProviderConfig).not.toHaveBeenCalled();
  if (moveToDelayed) expect(moveToDelayed).not.toHaveBeenCalled();
  expect(await readEffectCounts()).toEqual(before);
}

async function readMedia(id: string) {
  const [row] = await getTestDb().select().from(recoveryMediaArtifacts)
    .where(eq(recoveryMediaArtifacts.id, id));
  return row!;
}

async function readBoot(id: string) {
  const [row] = await getTestDb().select().from(recoveryBootMediaArtifacts)
    .where(eq(recoveryBootMediaArtifacts.id, id));
  return row!;
}

async function readDr(id: string) {
  const [row] = await getTestDb().select().from(drExecutions).where(eq(drExecutions.id, id));
  return row!;
}

async function readC2c(id: string) {
  const [row] = await getTestDb().select().from(c2cBackupJobs).where(eq(c2cBackupJobs.id, id));
  return row!;
}

beforeEach(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
  vi.clearAllMocks();
  effects.mediaBuild.mockResolvedValue(undefined);
  effects.bootBuild.mockResolvedValue(undefined);
  effects.queueCommand.mockImplementation(async () => ({
    command: { id: randomUUID(), status: 'pending' },
    error: null,
  }));
  effects.scheduledProviderConfig.mockResolvedValue({
    provider: 'local',
    providerConfig: { path: '/integration/queued-recovery' },
  });
});

afterAll(() => {
  if (previousAiEnabled === undefined) delete process.env.BREEZE_AI_AGENTS_ENABLED;
  else process.env.BREEZE_AI_AGENTS_ENABLED = previousAiEnabled;
});

describe('queued recovery authorization against real PostgreSQL', () => {
  it('authorized controls reach all five worker-family boundaries', async () => {
    const world = await seedWorld();
    const userAuth = authContext(world, { kind: 'user_session' });

    const mediaId = await insertMediaArtifact(world, await capture(world, userAuth, 'media'));
    await processRecoveryMediaBuildJob(mediaJob(mediaId));
    expect(effects.mediaBuild).toHaveBeenCalledTimes(1);
    expect(await readMedia(mediaId)).toMatchObject({
      status: 'building',
      authorizationState: 'authorized',
      authorizationDenialCode: null,
    });

    vi.clearAllMocks();
    effects.bootBuild.mockResolvedValue(undefined);
    const bootId = await insertBootArtifact(
      world,
      await capture(world, userAuth, 'media'),
      mediaId,
    );
    await processRecoveryBootMediaBuildJob(bootJob(bootId));
    expect(effects.bootBuild).toHaveBeenCalledTimes(1);
    expect(await readBoot(bootId)).toMatchObject({
      status: 'building',
      authorizationState: 'authorized',
      authorizationDenialCode: null,
    });

    vi.clearAllMocks();
    effects.queueCommand.mockImplementation(async () => ({
      command: { id: randomUUID(), status: 'pending' },
      error: null,
    }));
    const drId = await insertDrExecution(
      world,
      await capture(world, userAuth, {
        operation: 'restore',
        requiredPermission: { resource: 'devices', action: 'execute' },
        requiredDelegatedScopesAny: ['ai:execute', 'devices:execute'],
        requiredAiTool: 'execute_dr_plan',
      }),
    );
    const activeDrJob = drJob(drId);
    await expect(processDrExecutionReconcileJob(activeDrJob.job)).rejects.toBeInstanceOf(DelayedError);
    expect(effects.queueCommand).toHaveBeenCalledTimes(1);
    expect(activeDrJob.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(await readDr(drId)).toMatchObject({ status: 'running', authorizationState: 'authorized' });

    vi.clearAllMocks();
    const c2cId = await insertC2cRestore(world, await capture(world, userAuth, 'c2c_restore'));
    await withSystemDbAccessContext(() => processC2cQueuedJob({
      type: 'process-restore',
      restoreJobId: c2cId,
      orgId: world.orgId,
      itemIds: [world.c2cItemId],
      targetConnectionId: null,
    }));
    expect(await readC2c(c2cId)).toMatchObject({
      status: 'failed',
      authorizationState: 'authorized',
      errorLog: 'c2c_restore_not_implemented',
      itemsProcessed: 1,
      startedAt: null,
    });

    vi.clearAllMocks();
    effects.queueCommand.mockImplementation(async () => ({
      command: { id: randomUUID(), status: 'pending' },
      error: null,
    }));
    effects.scheduledProviderConfig.mockResolvedValue({
      provider: 'local',
      providerConfig: { path: '/integration/queued-recovery' },
    });
    await runScheduledBackupVerification({
      orgId: world.orgId,
      deviceId: world.sourceDeviceId,
      verificationType: 'integrity',
      backupJobId: world.backupJobId,
      source: 'post-backup-integrity-check',
    }, {
      resolveProviderConfig: effects.scheduledProviderConfig,
      queueCommand: effects.queueCommand,
    });
    expect(effects.scheduledProviderConfig).toHaveBeenCalledTimes(1);
    expect(effects.queueCommand).toHaveBeenCalledTimes(1);
    const verificationRows = await getTestDb().select().from(backupVerifications)
      .where(eq(backupVerifications.backupJobId, world.backupJobId));
    expect(verificationRows).toHaveLength(1);
  });

  it('denies user-session media after the source moves outside the captured site', async () => {
    const world = await seedWorld();
    const subject = await capture(world, authContext(world, { kind: 'user_session' }), 'media');
    const artifactId = await insertMediaArtifact(world, subject);
    await getTestDb().update(devices).set({ siteId: world.siteA2 })
      .where(eq(devices.id, world.sourceDeviceId));
    await clearPermissionCache(world.operator.id);
    const before = await readEffectCounts();

    await expect(processRecoveryMediaBuildJob(mediaJob(artifactId))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(await readMedia(artifactId)).toMatchObject({
      status: 'pending',
      storageKey: null,
      completedAt: null,
      authorizationState: 'denied',
      authorizationDenialCode: 'site_access_denied',
    });
    await expectNoEffects(before);
  });

  it('denies boot-media after a human API key is revoked', async () => {
    const world = await seedWorld();
    const [key] = await getTestDb().insert(apiKeys).values({
      orgId: world.orgId,
      name: `human-recovery-${randomUUID()}`,
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      keyPrefix: `brz_${randomUUID().replaceAll('-', '').slice(0, 8)}`,
      scopes: ['devices:execute'],
      createdBy: world.operator.id,
      status: 'active',
      principalType: 'human',
    }).returning({ id: apiKeys.id });
    if (!key) throw new Error('human API key fixture failed');
    const subject = await capture(
      world,
      authContext(world, { kind: 'api_key', apiKeyId: key.id }),
      'media',
    );
    const artifactId = await insertBootArtifact(world, subject);
    await getTestDb().update(apiKeys).set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(apiKeys.id, key.id));
    const before = await readEffectCounts();

    await expect(processRecoveryBootMediaBuildJob(bootJob(artifactId)))
      .rejects.toBeInstanceOf(UnrecoverableError);

    expect(await readBoot(artifactId)).toMatchObject({
      status: 'pending',
      storageKey: null,
      completedAt: null,
      authorizationState: 'denied',
      authorizationDenialCode: 'principal_inactive',
    });
    await expectNoEffects(before);
  });

  it('denies DR after a service-principal API key is disabled', async () => {
    const world = await seedWorld();
    const [principal] = await getTestDb().insert(servicePrincipals).values({
      orgId: world.orgId,
      name: `service-recovery-${randomUUID()}`,
      status: 'active',
      scopes: ['devices:execute'],
      createdBy: world.operator.id,
    }).returning({ id: servicePrincipals.id });
    if (!principal) throw new Error('service principal fixture failed');
    const [key] = await getTestDb().insert(apiKeys).values({
      orgId: world.orgId,
      name: `service-key-${randomUUID()}`,
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      keyPrefix: `brz_${randomUUID().replaceAll('-', '').slice(0, 8)}`,
      scopes: ['devices:execute'],
      createdBy: world.operator.id,
      status: 'active',
      principalType: 'service',
      principalId: principal.id,
    }).returning({ id: apiKeys.id });
    if (!key) throw new Error('service API key fixture failed');
    const subject = await capture(
      world,
      authContext(world, { kind: 'api_key', apiKeyId: key.id }),
      {
        operation: 'restore',
        requiredPermission: { resource: 'devices', action: 'execute' },
        requiredDelegatedScopesAny: ['ai:execute', 'devices:execute'],
        requiredAiTool: 'execute_dr_plan',
      },
    );
    const executionId = await insertDrExecution(world, subject);
    await getTestDb().update(servicePrincipals).set({ status: 'disabled', updatedAt: new Date() })
      .where(eq(servicePrincipals.id, principal.id));
    const activeDrJob = drJob(executionId);
    const before = await readEffectCounts();

    await processDrExecutionReconcileJob(activeDrJob.job);

    const execution = await readDr(executionId);
    expect(execution).toMatchObject({
      status: 'failed',
      authorizationState: 'denied',
      authorizationDenialCode: 'principal_disabled',
    });
    expect((execution.results as { queuedCommands?: unknown[] }).queuedCommands ?? []).toEqual([]);
    await expectNoEffects(before, activeDrJob.moveToDelayed);
  });

  it('denies C2C restore after its OAuth grant is revoked', async () => {
    const world = await seedWorld();
    const clientId = `queued-recovery-client-${randomUUID()}`;
    await getTestDb().insert(oauthClients).values({
      id: clientId,
      partnerId: world.partnerId,
      metadata: { client_name: 'Queued recovery integration' },
    });
    const grantId = `queued-recovery-grant-${randomUUID()}`;
    await getTestDb().insert(oauthGrants).values({
      id: grantId,
      accountId: world.operator.id,
      clientId,
      partnerId: world.partnerId,
      orgId: world.orgId,
      payload: { openid: { scope: 'openid mcp:write' } },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const subject = await capture(
      world,
      authContext(world, { kind: 'oauth_grant', grantId }),
      'c2c_restore',
    );
    const restoreJobId = await insertC2cRestore(world, subject);
    await getTestDb().update(oauthGrants).set({ revokedAt: new Date() })
      .where(eq(oauthGrants.id, grantId));
    const before = await readEffectCounts();

    await withSystemDbAccessContext(() => processC2cQueuedJob({
      type: 'process-restore',
      restoreJobId,
      orgId: world.orgId,
      itemIds: [world.c2cItemId],
      targetConnectionId: null,
    }));

    expect(await readC2c(restoreJobId)).toMatchObject({
      status: 'pending',
      startedAt: null,
      completedAt: null,
      itemsProcessed: 0,
      itemsNew: 0,
      itemsUpdated: 0,
      itemsDeleted: 0,
      bytesTransferred: 0,
      deltaToken: null,
      errorLog: null,
      authorizationState: 'denied',
      authorizationDenialCode: 'principal_disabled',
    });
    await expectNoEffects(before);
  });

  it('denies DR after the effective AI policy loses execute_dr_plan', async () => {
    const world = await seedWorld();
    const [partnerAgent] = await getTestDb().insert(aiAgents).values({
      orgId: null,
      partnerId: world.partnerId,
      kind: 'triage',
      name: 'Queued recovery partner AI',
      enabled: true,
      mode: 'act',
      toolAllowlist: ['execute_dr_plan'],
      createdBy: world.operator.id,
    }).returning({ id: aiAgents.id });
    const [orgAgent] = await getTestDb().insert(aiAgents).values({
      orgId: world.orgId,
      partnerId: null,
      kind: 'triage',
      name: 'Queued recovery org AI',
      enabled: true,
      mode: 'act',
      toolAllowlist: ['execute_dr_plan'],
      createdBy: world.operator.id,
    }).returning({ id: aiAgents.id });
    if (!partnerAgent || !orgAgent) throw new Error('AI agent fixtures failed');
    const [run] = await getTestDb().insert(aiAgentRuns).values({
      agentId: orgAgent.id,
      orgId: world.orgId,
      deviceId: world.targetDeviceId,
      triggerKind: 'alert',
      dedupeKey: `queued-recovery-${randomUUID()}`,
      modeAtStart: 'act',
      policySnapshot: { schemaVersion: 1 } as never,
      status: 'running',
    }).returning({ id: aiAgentRuns.id });
    if (!run) throw new Error('AI run fixture failed');
    const subject = await capture(
      world,
      authContext(world, { kind: 'ai_agent', agentId: orgAgent.id, runId: run.id }),
      {
        operation: 'restore',
        requiredPermission: { resource: 'devices', action: 'execute' },
        requiredDelegatedScopesAny: ['ai:execute', 'devices:execute'],
        requiredAiTool: 'execute_dr_plan',
      },
    );
    const executionId = await insertDrExecution(world, subject);
    await getTestDb().update(aiAgents).set({ toolAllowlist: [], updatedAt: new Date() })
      .where(eq(aiAgents.id, orgAgent.id));
    const activeDrJob = drJob(executionId);
    const before = await readEffectCounts();

    await processDrExecutionReconcileJob(activeDrJob.job);

    const execution = await readDr(executionId);
    expect(execution).toMatchObject({
      status: 'failed',
      authorizationState: 'denied',
      authorizationDenialCode: 'delegation_scope_denied',
    });
    expect((execution.results as { queuedCommands?: unknown[] }).queuedCommands ?? []).toEqual([]);
    await expectNoEffects(before, activeDrJob.moveToDelayed);
  });

  it('denies scheduled system verification after live snapshot/device lineage diverges', async () => {
    const world = await seedWorld();
    await getTestDb().update(backupSnapshots).set({ deviceId: world.mismatchDeviceId })
      .where(and(
        eq(backupSnapshots.id, world.snapshotId),
        eq(backupSnapshots.jobId, world.backupJobId),
      ));
    const before = await readEffectCounts();

    await expect(runScheduledBackupVerification({
      orgId: world.orgId,
      deviceId: world.sourceDeviceId,
      verificationType: 'integrity',
      backupJobId: world.backupJobId,
      source: 'post-backup-integrity-check',
    }, {
      resolveProviderConfig: effects.scheduledProviderConfig,
      queueCommand: effects.queueCommand,
    })).rejects.toThrow('Backup job snapshot does not match requested device');

    await expectNoEffects(before);
  });

  it('quarantines legacy unknown media provenance without building anything', async () => {
    const world = await seedWorld();
    const artifactId = await insertMediaArtifact(world);
    const before = await readEffectCounts();

    await expect(processRecoveryMediaBuildJob(mediaJob(artifactId))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(await readMedia(artifactId)).toMatchObject({
      status: 'pending',
      storageKey: null,
      completedAt: null,
      authorizationPrincipalKind: 'unknown',
      authorizationState: 'quarantined_authorization_unknown',
      authorizationDenialCode: 'authorization_subject_unknown',
    });
    expect((await readMedia(artifactId)).authorizationCheckedAt).toBeInstanceOf(Date);
    await expectNoEffects(before);
  });
});
