import './setup';

import { describe, expect, it } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  devices,
  restoreJobs,
  sqlInstances,
} from '../../db/schema';
import { withSystemDbAccessContext } from '../../db';
import {
  authorizeResilienceResources,
  type AuthorizationPrincipal,
  type ResilienceResourceRef,
} from '../../services/resilienceSiteAuthorization';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  orgId: string;
  otherOrgId: string;
  siteA: string;
  siteB: string;
  sourceA: string;
  sourceB: string;
  targetA: string;
  targetB: string;
  snapshotA: string;
  snapshotB: string;
  restoreJob: string;
  brokenSqlInstance: string;
}

function principal(
  orgId: string,
  allowedSiteIds: string[] | undefined,
  crossSite = false,
): AuthorizationPrincipal {
  return {
    kind: 'user_session',
    permissions: {
      permissions: crossSite
        ? [{ resource: 'backup', action: 'cross_site_restore' }]
        : [],
      partnerId: null,
      orgId,
      roleId: crypto.randomUUID(),
      scope: 'organization',
      allowedSiteIds,
    },
  };
}

async function seedFixture(): Promise<Fixture> {
  const testDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: org.id, name: 'Resilience Site A' });
  const siteB = await createSite({ orgId: org.id, name: 'Resilience Site B' });
  const otherSite = await createSite({ orgId: otherOrg.id, name: 'Foreign Device Site' });
  const suffix = crypto.randomUUID().slice(0, 8);

  const insertedDevices = await testDb.insert(devices).values([
    {
      orgId: org.id, siteId: siteA.id, agentId: `res-source-a-${suffix}`,
      hostname: 'res-source-a', osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: 'test', status: 'offline',
    },
    {
      orgId: org.id, siteId: siteB.id, agentId: `res-source-b-${suffix}`,
      hostname: 'res-source-b', osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: 'test', status: 'offline',
    },
    {
      orgId: org.id, siteId: siteA.id, agentId: `res-target-a-${suffix}`,
      hostname: 'res-target-a', osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: 'test', status: 'offline',
    },
    {
      orgId: org.id, siteId: siteB.id, agentId: `res-target-b-${suffix}`,
      hostname: 'res-target-b', osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: 'test', status: 'offline',
    },
    {
      orgId: otherOrg.id, siteId: otherSite.id, agentId: `res-foreign-${suffix}`,
      hostname: 'res-foreign', osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: 'test', status: 'offline',
    },
  ]).returning({ id: devices.id });

  const [sourceA, sourceB, targetA, targetB, foreignDevice] = insertedDevices;
  if (!sourceA || !sourceB || !targetA || !targetB || !foreignDevice) {
    throw new Error('device fixture insert failed');
  }

  const [config] = await testDb.insert(backupConfigs).values({
    orgId: org.id,
    name: 'Resilience auth test config',
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
    {
      orgId: org.id, jobId: jobA.id, deviceId: sourceA.id,
      snapshotId: `provider-a-${suffix}`,
    },
    {
      orgId: org.id, jobId: jobB.id, deviceId: sourceB.id,
      snapshotId: `provider-b-${suffix}`,
    },
  ]).returning({ id: backupSnapshots.id });
  const [snapshotA, snapshotB] = insertedSnapshots;
  if (!snapshotA || !snapshotB) throw new Error('snapshot fixture insert failed');

  const [restoreJob] = await testDb.insert(restoreJobs).values({
    orgId: org.id,
    snapshotId: snapshotA.id,
    deviceId: targetA.id,
    restoreType: 'full',
    status: 'running',
  }).returning({ id: restoreJobs.id });
  if (!restoreJob) throw new Error('restore fixture insert failed');

  // A known org-A resource with a device from org B is malformed lineage.
  // The resolver must retain the known resource row, resolve its site to null,
  // and fail closed before any metadata loader can run.
  const [brokenSqlInstance] = await testDb.insert(sqlInstances).values({
    orgId: org.id,
    deviceId: foreignDevice.id,
    instanceName: `MALFORMED-${suffix}`,
  }).returning({ id: sqlInstances.id });
  if (!brokenSqlInstance) throw new Error('broken lineage fixture insert failed');

  return {
    orgId: org.id,
    otherOrgId: otherOrg.id,
    siteA: siteA.id,
    siteB: siteB.id,
    sourceA: sourceA.id,
    sourceB: sourceB.id,
    targetA: targetA.id,
    targetB: targetB.id,
    snapshotA: snapshotA.id,
    snapshotB: snapshotB.id,
    restoreJob: restoreJob.id,
    brokenSqlInstance: brokenSqlInstance.id,
  };
}

function ref(kind: ResilienceResourceRef['kind'], id: string, role: ResilienceResourceRef['role']): ResilienceResourceRef {
  return { kind, id, role };
}

async function authorize(input: Parameters<typeof authorizeResilienceResources>[0]) {
  return withSystemDbAccessContext(() => authorizeResilienceResources(input));
}

describe('resilience source/target authorization against real PostgreSQL', () => {
  runDb('enforces the full same-site, source, target, lineage, cross-site, cancel, and foreign-org matrix', async () => {
    const f = await seedFixture();
    const sameSite = [ref('snapshot', f.snapshotA, 'source'), ref('device', f.targetA, 'target')];
    const crossSite = [ref('snapshot', f.snapshotA, 'source'), ref('device', f.targetB, 'target')];

    await expect(authorize({
      orgId: f.orgId,
      principal: principal(f.orgId, [f.siteA]),
      refs: sameSite,
      operation: 'restore',
    })).resolves.toMatchObject({
      resources: [
        { deviceId: f.sourceA, siteId: f.siteA },
        { deviceId: f.targetA, siteId: f.siteA },
      ],
    });

    await expect(authorize({
      orgId: f.orgId,
      principal: principal(f.orgId, [f.siteA]),
      refs: [ref('snapshot', f.snapshotB, 'source'), ref('device', f.targetA, 'target')],
      operation: 'restore',
    })).rejects.toMatchObject({ status: 403, code: 'site_access_denied' });

    await expect(authorize({
      orgId: f.orgId,
      principal: principal(f.orgId, [f.siteA]),
      refs: crossSite,
      operation: 'restore',
    })).rejects.toMatchObject({ status: 403, code: 'site_access_denied' });

    await expect(authorize({
      orgId: f.orgId,
      principal: principal(f.orgId, undefined),
      refs: [ref('sql_instance', f.brokenSqlInstance, 'source')],
      operation: 'read',
    })).rejects.toMatchObject({ status: 403, code: 'site_access_denied' });

    await expect(authorize({
      orgId: f.orgId,
      principal: principal(f.orgId, [f.siteA, f.siteB]),
      refs: crossSite,
      operation: 'restore',
    })).rejects.toMatchObject({ status: 403, code: 'site_access_denied' });

    await expect(authorize({
      orgId: f.orgId,
      principal: principal(f.orgId, [f.siteA, f.siteB], true),
      refs: crossSite,
      operation: 'restore',
    })).resolves.toMatchObject({
      resources: [
        { role: 'source', siteId: f.siteA },
        { role: 'target', siteId: f.siteB },
      ],
    });

    // Confirmed cancel regression: old code passed restoreJobs.deviceId to a
    // site-ID helper. The shared resolver must load targetA -> siteA first.
    await expect(authorize({
      orgId: f.orgId,
      principal: principal(f.orgId, [f.siteA]),
      refs: [ref('restore_job', f.restoreJob, 'target')],
      operation: 'revoke',
    })).resolves.toMatchObject({
      resources: [{ deviceId: f.targetA, siteId: f.siteA }],
    });

    // An existing snapshot in another org and a random ID are both the same
    // metadata-free 404 under org A.
    for (const id of [f.snapshotA, crypto.randomUUID()]) {
      await expect(authorize({
        orgId: f.otherOrgId,
        principal: principal(f.otherOrgId, [f.siteA]),
        refs: [ref('snapshot', id, 'source')],
        operation: 'read',
      })).rejects.toMatchObject({ status: 404, code: 'resource_not_found' });
    }
  });
});
