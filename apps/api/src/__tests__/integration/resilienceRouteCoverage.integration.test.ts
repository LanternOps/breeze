import './setup';

import { Hono } from 'hono';
import { and, count, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';
import {
  backupChains,
  backupConfigs,
  backupJobs,
  backupSnapshots,
  deviceCommands,
  devices,
  hypervVms,
  recoveryBootMediaArtifacts,
  recoveryMediaArtifacts,
  recoveryTokens,
  restoreJobs,
  sqlInstances,
} from '../../db/schema';
import { withSystemDbAccessContext } from '../../db';

const executeCommandMock = vi.hoisted(() => vi.fn());
const queueCommandMock = vi.hoisted(() => vi.fn());
const queueStopMock = vi.hoisted(() => vi.fn());
const enqueueMediaMock = vi.hoisted(() => vi.fn());
const enqueueBootMediaMock = vi.hoisted(() => vi.fn());

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const pass = () => async (_c: unknown, next: () => Promise<void>) => next();
  return {
    ...actual,
    requireScope: pass,
    requirePermission: pass,
    requireMfa: pass,
  };
});

vi.mock('../../services/commandQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/commandQueue')>();
  return {
    ...actual,
    executeCommand: executeCommandMock,
    queueCommandForExecution: queueCommandMock,
    queueBackupStopCommand: queueStopMock,
  };
});

vi.mock('../../jobs/recoveryMediaWorker', () => ({
  enqueueRecoveryMediaBuild: enqueueMediaMock,
}));

vi.mock('../../jobs/recoveryBootMediaWorker', () => ({
  enqueueRecoveryBootMediaBuild: enqueueBootMediaMock,
}));

import { restoreRoutes } from '../../routes/backup/restore';
import { vmRestoreRoutes } from '../../routes/backup/vmrestore';
import { hypervRoutes } from '../../routes/backup/hyperv';
import { mssqlRoutes } from '../../routes/backup/mssql';
import { snapshotsRoutes } from '../../routes/backup/snapshots';
import { bmrRoutes } from '../../routes/backup/bmr';

const runDb = it.runIf(!!process.env.DATABASE_URL);

type Fixture = {
  orgId: string;
  siteA: string;
  siteB: string;
  sourceA: string;
  sourceB: string;
  targetA: string;
  targetB: string;
  snapshotA: string;
  snapshotB: string;
  vmA: string;
  vmB: string;
  safeRestore: string;
  deniedRestore: string;
  tokenA: string;
  tokenB: string;
  mediaA: string;
  mediaB: string;
  bootMediaA: string;
  bootMediaB: string;
};

type MountedRouteCase = {
  name: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
};

let allowedSiteIds: string[] = [];
let allowCrossSiteRestore = false;

function makeApp(f: Fixture): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const permissions = allowCrossSiteRestore
      ? [{ resource: 'backup', action: 'cross_site_restore' }]
      : [];
    c.set('auth', {
      principal: { kind: 'user_session' },
      user: { id: crypto.randomUUID(), email: 'route-coverage@example.com', name: 'Route Coverage', isPlatformAdmin: false },
      scope: 'organization',
      orgId: f.orgId,
      partnerId: null,
      accessibleOrgIds: [f.orgId],
      allowedSiteIds,
      canAccessOrg: (candidateOrgId: string) => candidateOrgId === f.orgId,
      orgCondition: () => undefined,
      token: { sub: 'route-coverage', scope: 'organization', mfa: true },
    } as never);
    c.set('permissions', {
      permissions,
      partnerId: null,
      orgId: f.orgId,
      roleId: crypto.randomUUID(),
      scope: 'organization',
      allowedSiteIds,
    });
    await next();
  });
  app.route('/', restoreRoutes);
  app.route('/', vmRestoreRoutes);
  app.route('/hyperv', hypervRoutes);
  app.route('/', mssqlRoutes);
  app.route('/', snapshotsRoutes);
  app.route('/', bmrRoutes);
  return app;
}

async function request(app: Hono, testCase: MountedRouteCase): Promise<Response> {
  return withSystemDbAccessContext(async () => app.request(testCase.path, {
    method: testCase.method,
    headers: testCase.body ? { 'Content-Type': 'application/json' } : undefined,
    body: testCase.body ? JSON.stringify(testCase.body) : undefined,
  }));
}

async function seedFixture(): Promise<Fixture> {
  const testDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: org.id, name: 'Route Coverage Site A' });
  const siteB = await createSite({ orgId: org.id, name: 'Route Coverage Site B' });
  const suffix = crypto.randomUUID().slice(0, 8);

  const insertedDevices = await testDb.insert(devices).values([
    { orgId: org.id, siteId: siteA.id, agentId: `route-source-a-${suffix}`, hostname: 'route-source-a', osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: 'test', status: 'offline' },
    { orgId: org.id, siteId: siteB.id, agentId: `route-source-b-${suffix}`, hostname: 'route-source-b', osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: 'test', status: 'offline' },
    { orgId: org.id, siteId: siteA.id, agentId: `route-target-a-${suffix}`, hostname: 'route-target-a', osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: 'test', status: 'offline' },
    { orgId: org.id, siteId: siteB.id, agentId: `route-target-b-${suffix}`, hostname: 'route-target-b', osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: 'test', status: 'offline' },
  ]).returning({ id: devices.id });
  const [sourceA, sourceB, targetA, targetB] = insertedDevices;
  if (!sourceA || !sourceB || !targetA || !targetB) throw new Error('device fixture insert failed');

  const [config] = await testDb.insert(backupConfigs).values({
    orgId: org.id,
    name: `Route coverage ${suffix}`,
    type: 'file',
    provider: 'local',
    providerConfig: {},
  }).returning({ id: backupConfigs.id });
  if (!config) throw new Error('config fixture insert failed');

  const insertedJobs = await testDb.insert(backupJobs).values([
    { orgId: org.id, configId: config.id, deviceId: sourceA.id, status: 'completed' },
    { orgId: org.id, configId: config.id, deviceId: sourceB.id, status: 'completed' },
  ]).returning({ id: backupJobs.id });
  const [jobA, jobB] = insertedJobs;
  if (!jobA || !jobB) throw new Error('backup job fixture insert failed');

  const insertedSnapshots = await testDb.insert(backupSnapshots).values([
    { orgId: org.id, configId: config.id, jobId: jobA.id, deviceId: sourceA.id, snapshotId: `route-provider-a-${suffix}`, metadata: { platform: 'windows' } },
    { orgId: org.id, configId: config.id, jobId: jobB.id, deviceId: sourceB.id, snapshotId: `route-provider-b-${suffix}`, metadata: { platform: 'windows' } },
  ]).returning({ id: backupSnapshots.id });
  const [snapshotA, snapshotB] = insertedSnapshots;
  if (!snapshotA || !snapshotB) throw new Error('snapshot fixture insert failed');

  const insertedVms = await testDb.insert(hypervVms).values([
    { orgId: org.id, deviceId: sourceA.id, vmId: `vm-a-${suffix}`, vmName: 'VM A' },
    { orgId: org.id, deviceId: sourceB.id, vmId: `vm-b-${suffix}`, vmName: 'VM B' },
  ]).returning({ id: hypervVms.id });
  const [vmA, vmB] = insertedVms;
  if (!vmA || !vmB) throw new Error('VM fixture insert failed');

  await testDb.insert(sqlInstances).values([
    { orgId: org.id, deviceId: sourceA.id, instanceName: `SQL-A-${suffix}` },
    { orgId: org.id, deviceId: sourceB.id, instanceName: `SQL-B-${suffix}` },
  ]);
  await testDb.insert(backupChains).values([
    { orgId: org.id, deviceId: sourceA.id, configId: config.id, chainType: 'full', targetName: `chain-a-${suffix}` },
    { orgId: org.id, deviceId: sourceB.id, configId: config.id, chainType: 'full', targetName: `chain-b-${suffix}` },
  ]);

  const insertedRestores = await testDb.insert(restoreJobs).values([
    { orgId: org.id, snapshotId: snapshotA.id, deviceId: targetA.id, restoreType: 'full', status: 'completed', targetConfig: { mode: 'instant_boot' } },
    { orgId: org.id, snapshotId: snapshotB.id, deviceId: targetA.id, restoreType: 'full', status: 'running', targetConfig: { mode: 'instant_boot' } },
    { orgId: org.id, snapshotId: snapshotA.id, deviceId: targetB.id, restoreType: 'full', status: 'running', targetConfig: { mode: 'instant_boot' } },
  ]).returning({ id: restoreJobs.id });
  const [safeRestore, deniedRestore] = insertedRestores;
  if (!safeRestore || !deniedRestore) throw new Error('restore fixture insert failed');

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const insertedTokens = await testDb.insert(recoveryTokens).values([
    { orgId: org.id, deviceId: targetA.id, snapshotId: snapshotA.id, tokenHash: 'a'.repeat(64), restoreType: 'bare_metal', expiresAt },
    { orgId: org.id, deviceId: targetA.id, snapshotId: snapshotB.id, tokenHash: 'b'.repeat(64), restoreType: 'bare_metal', expiresAt },
    { orgId: org.id, deviceId: targetB.id, snapshotId: snapshotA.id, tokenHash: 'c'.repeat(64), restoreType: 'bare_metal', expiresAt },
  ]).returning({ id: recoveryTokens.id });
  const [tokenA, tokenB, tokenTargetB] = insertedTokens;
  if (!tokenA || !tokenB || !tokenTargetB) throw new Error('token fixture insert failed');

  const insertedMedia = await testDb.insert(recoveryMediaArtifacts).values([
    { orgId: org.id, tokenId: tokenA.id, snapshotId: snapshotA.id, platform: 'linux', architecture: 'amd64', status: 'ready_signed' },
    { orgId: org.id, tokenId: tokenB.id, snapshotId: snapshotB.id, platform: 'linux', architecture: 'amd64', status: 'ready_signed' },
    { orgId: org.id, tokenId: tokenTargetB.id, snapshotId: snapshotA.id, platform: 'linux', architecture: 'amd64', status: 'ready_signed' },
  ]).returning({ id: recoveryMediaArtifacts.id });
  const [mediaA, mediaB, mediaTargetB] = insertedMedia;
  if (!mediaA || !mediaB || !mediaTargetB) throw new Error('media fixture insert failed');

  const insertedBootMedia = await testDb.insert(recoveryBootMediaArtifacts).values([
    { orgId: org.id, tokenId: tokenA.id, snapshotId: snapshotA.id, bundleArtifactId: mediaA.id, platform: 'linux', architecture: 'amd64', mediaType: 'iso', status: 'ready_signed' },
    { orgId: org.id, tokenId: tokenB.id, snapshotId: snapshotB.id, bundleArtifactId: mediaB.id, platform: 'linux', architecture: 'amd64', mediaType: 'iso', status: 'ready_signed' },
    { orgId: org.id, tokenId: tokenTargetB.id, snapshotId: snapshotA.id, bundleArtifactId: mediaTargetB.id, platform: 'linux', architecture: 'amd64', mediaType: 'iso', status: 'ready_signed' },
  ]).returning({ id: recoveryBootMediaArtifacts.id });
  const [bootMediaA, bootMediaB] = insertedBootMedia;
  if (!bootMediaA || !bootMediaB) throw new Error('boot media fixture insert failed');

  return {
    orgId: org.id,
    siteA: siteA.id,
    siteB: siteB.id,
    sourceA: sourceA.id,
    sourceB: sourceB.id,
    targetA: targetA.id,
    targetB: targetB.id,
    snapshotA: snapshotA.id,
    snapshotB: snapshotB.id,
    vmA: vmA.id,
    vmB: vmB.id,
    safeRestore: safeRestore.id,
    deniedRestore: deniedRestore.id,
    tokenA: tokenA.id,
    tokenB: tokenB.id,
    mediaA: mediaA.id,
    mediaB: mediaB.id,
    bootMediaA: bootMediaA.id,
    bootMediaB: bootMediaB.id,
  };
}

async function sideEffectSnapshot(orgId: string) {
  const testDb = getTestDb();
  const [restoreCount] = await testDb.select({ value: count() }).from(restoreJobs).where(eq(restoreJobs.orgId, orgId));
  const [backupCount] = await testDb.select({ value: count() }).from(backupJobs).where(eq(backupJobs.orgId, orgId));
  const [commandCount] = await testDb.select({ value: count() }).from(deviceCommands);
  const [tokenCount] = await testDb.select({ value: count() }).from(recoveryTokens).where(eq(recoveryTokens.orgId, orgId));
  const [mediaCount] = await testDb.select({ value: count() }).from(recoveryMediaArtifacts).where(eq(recoveryMediaArtifacts.orgId, orgId));
  const [bootCount] = await testDb.select({ value: count() }).from(recoveryBootMediaArtifacts).where(eq(recoveryBootMediaArtifacts.orgId, orgId));
  const snapshotState = await testDb
    .select({ id: backupSnapshots.id, legalHold: backupSnapshots.legalHold, isImmutable: backupSnapshots.isImmutable })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.orgId, orgId));
  return { restoreCount, backupCount, commandCount, tokenCount, mediaCount, bootCount, snapshotState };
}

function deniedRouteCases(f: Fixture): MountedRouteCase[] {
  return [
    { name: 'restore list explicit target filter', method: 'GET', path: `/restore?deviceId=${f.sourceB}` },
    { name: 'restore by ID', method: 'GET', path: `/restore/${f.deniedRestore}` },
    { name: 'restore create source', method: 'POST', path: '/restore', body: { snapshotId: f.snapshotB, deviceId: f.targetA, restoreType: 'full' } },
    { name: 'restore cancel source lineage', method: 'POST', path: `/restore/${f.deniedRestore}/cancel` },
    { name: 'restore as VM source', method: 'POST', path: '/backup/restore/as-vm', body: { snapshotId: f.snapshotB, targetDeviceId: f.targetA, hypervisor: 'hyperv', vmName: 'Denied VM' } },
    { name: 'instant boot source', method: 'POST', path: '/backup/restore/instant-boot', body: { snapshotId: f.snapshotB, targetDeviceId: f.targetA, vmName: 'Denied Instant VM' } },
    { name: 'VM estimate source', method: 'GET', path: `/backup/restore/as-vm/estimate/${f.snapshotB}` },
    { name: 'Hyper-V list explicit source filter', method: 'GET', path: `/hyperv/vms?deviceId=${f.sourceB}` },
    { name: 'Hyper-V host by ID', method: 'GET', path: `/hyperv/vms/${f.sourceB}` },
    { name: 'Hyper-V discovery target', method: 'POST', path: `/hyperv/discover/${f.sourceB}` },
    { name: 'Hyper-V backup source', method: 'POST', path: '/hyperv/backup', body: { deviceId: f.sourceB, vmName: 'VM B' } },
    { name: 'Hyper-V restore source', method: 'POST', path: '/hyperv/restore', body: { deviceId: f.targetA, snapshotId: f.snapshotB } },
    { name: 'Hyper-V checkpoint source VM', method: 'POST', path: `/hyperv/checkpoints/${f.targetA}/${f.vmB}`, body: { action: 'create', checkpointName: 'denied' } },
    { name: 'Hyper-V power source VM', method: 'POST', path: `/hyperv/vm-state/${f.targetA}/${f.vmB}`, body: { state: 'start' } },
    { name: 'MSSQL host by ID', method: 'GET', path: `/mssql/instances/${f.sourceB}` },
    { name: 'MSSQL discovery target', method: 'POST', path: `/mssql/discover/${f.sourceB}` },
    { name: 'MSSQL backup source', method: 'POST', path: '/mssql/backup', body: { deviceId: f.sourceB, instance: 'MSSQLSERVER', database: 'DeniedDb', backupType: 'full' } },
    { name: 'MSSQL restore source', method: 'POST', path: '/mssql/restore', body: { deviceId: f.targetA, snapshotId: f.snapshotB, targetDatabase: 'DeniedDb' } },
    { name: 'MSSQL verify source', method: 'POST', path: `/mssql/verify/${f.snapshotB}` },
    { name: 'snapshot list explicit source filter', method: 'GET', path: `/snapshots?deviceId=${f.sourceB}` },
    { name: 'snapshot by ID', method: 'GET', path: `/snapshots/${f.snapshotB}` },
    { name: 'snapshot browse', method: 'GET', path: `/snapshots/${f.snapshotB}/browse` },
    { name: 'snapshot legal hold apply', method: 'POST', path: `/snapshots/${f.snapshotB}/legal-hold`, body: { reason: 'denied route coverage' } },
    { name: 'snapshot legal hold release', method: 'POST', path: `/snapshots/${f.snapshotB}/legal-hold/release`, body: { reason: 'denied route coverage' } },
    { name: 'snapshot legal hold legacy release', method: 'DELETE', path: `/snapshots/${f.snapshotB}/legal-hold`, body: { reason: 'denied route coverage' } },
    { name: 'snapshot immutability apply', method: 'POST', path: `/snapshots/${f.snapshotB}/immutability`, body: { reason: 'denied route coverage', immutableDays: 7 } },
    { name: 'snapshot immutability release', method: 'POST', path: `/snapshots/${f.snapshotB}/immutability/release`, body: { reason: 'denied route coverage' } },
    { name: 'BMR token list explicit target filter', method: 'GET', path: `/bmr/tokens?deviceId=${f.sourceB}` },
    { name: 'BMR token create source', method: 'POST', path: '/bmr/tokens', body: { snapshotId: f.snapshotB, restoreType: 'bare_metal', expiresInHours: 1 } },
    { name: 'BMR token by ID', method: 'GET', path: `/bmr/tokens/${f.tokenB}` },
    { name: 'BMR token revoke', method: 'DELETE', path: `/bmr/tokens/${f.tokenB}` },
    { name: 'BMR media create', method: 'POST', path: '/bmr/media', body: { tokenId: f.tokenB, platform: 'linux', architecture: 'amd64' } },
    { name: 'BMR media by ID', method: 'GET', path: `/bmr/media/${f.mediaB}` },
    { name: 'BMR media download', method: 'GET', path: `/bmr/media/${f.mediaB}/download` },
    { name: 'BMR media signature', method: 'GET', path: `/bmr/media/${f.mediaB}/signature` },
    { name: 'BMR boot media create', method: 'POST', path: '/bmr/boot-media', body: { tokenId: f.tokenB } },
    { name: 'BMR boot media by ID', method: 'GET', path: `/bmr/boot-media/${f.bootMediaB}` },
    { name: 'BMR boot media download', method: 'GET', path: `/bmr/boot-media/${f.bootMediaB}/download` },
    { name: 'BMR boot media signature', method: 'GET', path: `/bmr/boot-media/${f.bootMediaB}/signature` },
  ];
}

describe('mounted recovery route site authorization against real PostgreSQL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowCrossSiteRestore = false;
  });

  runDb('denies every direct by-ID/create/restore/verify/revoke/download route before side effects', async () => {
    const f = await seedFixture();
    allowedSiteIds = [f.siteA];
    const app = makeApp(f);

    for (const testCase of deniedRouteCases(f)) {
      const before = await sideEffectSnapshot(f.orgId);
      const response = await request(app, testCase);
      expect(response.status, testCase.name).toBe(403);
      await expect(response.json(), testCase.name).resolves.toEqual({ error: 'site_access_denied' });
      expect(await sideEffectSnapshot(f.orgId), testCase.name).toEqual(before);
      expect(executeCommandMock, testCase.name).not.toHaveBeenCalled();
      expect(queueCommandMock, testCase.name).not.toHaveBeenCalled();
      expect(queueStopMock, testCase.name).not.toHaveBeenCalled();
      expect(enqueueMediaMock, testCase.name).not.toHaveBeenCalled();
      expect(enqueueBootMediaMock, testCase.name).not.toHaveBeenCalled();
    }
  });

  runDb('filters every mixed or list lineage without leaking denied rows or counts', async () => {
    const f = await seedFixture();
    allowedSiteIds = [f.siteA];
    const app = makeApp(f);

    const listCases: Array<MountedRouteCase & { extractIds: (body: any) => string[]; allowedIds: string[] }> = [
      { name: 'restore jobs', method: 'GET', path: '/restore', extractIds: (body) => body.data.map((row: any) => row.snapshotId), allowedIds: [f.snapshotA] },
      { name: 'instant boot jobs', method: 'GET', path: '/backup/restore/instant-boot/active', extractIds: (body) => body.map((row: any) => row.snapshotId), allowedIds: [] },
      { name: 'Hyper-V VMs', method: 'GET', path: '/hyperv/vms', extractIds: (body) => body.vms.map((row: any) => row.id), allowedIds: [f.vmA] },
      { name: 'MSSQL instances', method: 'GET', path: '/mssql/instances', extractIds: (body) => body.data.map((row: any) => row.deviceId), allowedIds: [f.sourceA] },
      { name: 'MSSQL chains', method: 'GET', path: '/mssql/chains', extractIds: (body) => body.data.map((row: any) => row.deviceId), allowedIds: [f.sourceA] },
      { name: 'snapshots', method: 'GET', path: '/snapshots', extractIds: (body) => body.data.map((row: any) => row.id), allowedIds: [f.snapshotA] },
      { name: 'BMR tokens', method: 'GET', path: '/bmr/tokens', extractIds: (body) => body.data.map((row: any) => row.id), allowedIds: [f.tokenA] },
      { name: 'BMR media', method: 'GET', path: '/bmr/media', extractIds: (body) => body.data.map((row: any) => row.id), allowedIds: [f.mediaA] },
      { name: 'BMR boot media', method: 'GET', path: '/bmr/boot-media', extractIds: (body) => body.data.map((row: any) => row.id), allowedIds: [f.bootMediaA] },
    ];

    for (const testCase of listCases) {
      const response = await request(app, testCase);
      expect(response.status, testCase.name).toBe(200);
      expect(testCase.extractIds(await response.json()).sort(), testCase.name).toEqual(testCase.allowedIds.sort());
    }

    for (const path of ['/hyperv/discovery-targets', '/mssql/discovery-targets']) {
      const response = await request(app, { name: path, method: 'GET', path });
      expect(response.status, path).toBe(200);
      const body = await response.json() as { data: Array<{ id: string }> };
      expect(body.data.every((row) => row.id !== f.sourceB && row.id !== f.targetB), path).toBe(true);
    }
  });

  runDb('allows same-site controls, requires an explicit cross-site grant, and fixes cancel device/site resolution', async () => {
    const f = await seedFixture();
    const app = makeApp(f);
    allowedSiteIds = [f.siteA];

    const snapshotResponse = await request(app, { name: 'same-site snapshot', method: 'GET', path: `/snapshots/${f.snapshotA}` });
    expect(snapshotResponse.status).toBe(200);

    const sameSiteRestore = await request(app, {
      name: 'same-site restore', method: 'POST', path: '/restore',
      body: { snapshotId: f.snapshotA, deviceId: f.targetA, restoreType: 'full' },
    });
    expect(sameSiteRestore.status).toBe(409);

    allowedSiteIds = [f.siteA, f.siteB];
    const deniedCrossSite = await request(app, {
      name: 'cross-site restore without grant', method: 'POST', path: '/restore',
      body: { snapshotId: f.snapshotA, deviceId: f.targetB, restoreType: 'full' },
    });
    expect(deniedCrossSite.status).toBe(403);
    await expect(deniedCrossSite.json()).resolves.toEqual({ error: 'site_access_denied' });

    allowCrossSiteRestore = true;
    const allowedCrossSite = await request(app, {
      name: 'cross-site restore with grant', method: 'POST', path: '/restore',
      body: { snapshotId: f.snapshotA, deviceId: f.targetB, restoreType: 'full' },
    });
    expect(allowedCrossSite.status).toBe(409);

    allowedSiteIds = [f.siteA];
    allowCrossSiteRestore = false;
    const before = await getTestDb().select({ status: restoreJobs.status }).from(restoreJobs).where(and(
      eq(restoreJobs.id, f.safeRestore),
      eq(restoreJobs.orgId, f.orgId),
    ));
    const cancel = await request(app, { name: 'cancel device/site regression', method: 'POST', path: `/restore/${f.safeRestore}/cancel` });
    expect(cancel.status).toBe(409);
    const after = await getTestDb().select({ status: restoreJobs.status }).from(restoreJobs).where(and(
      eq(restoreJobs.id, f.safeRestore),
      eq(restoreJobs.orgId, f.orgId),
    ));
    expect(after).toEqual(before);
  });
});
