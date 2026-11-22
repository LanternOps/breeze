/**
 * #11225, the two rows found while building #11240: a device's patch job and its
 * Patches tab each catch a query failure inside a held transaction. Both tests
 * force the statement to fail in Postgres and check what the catch promises: the
 * skipped result row committed, and the rest of the tab rendered.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { devicePatches, devices, patchApprovals, patches, patchJobResults, patchJobs } from '../../db/schema';
import { __testOnly as executor } from '../../jobs/patchJobExecutor';
import { authMiddleware } from '../../middleware/auth';
import { patchesRoutes } from '../../routes/devices/patches';
import { clearStatementFaults, failStatementsOn } from './caughtQueryFaults';
import { createIntegrationTestClient } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

afterEach(clearStatementFaults);

async function seed(orgId: string, siteId: string, osType: 'windows' | 'linux' = 'linux') {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `caught-patch-${randomUUID()}`,
    hostname: `caught-patch-${randomUUID()}`,
    osType,
    osVersion: 'test',
    architecture: 'amd64',
    agentVersion: '1.0.0-test',
    status: 'online',
    lastSeenAt: new Date(),
    enrolledAt: new Date(),
  }).returning({ id: devices.id });
  const [patch] = await getTestDb().insert(patches).values({
    source: 'microsoft',
    externalId: `microsoft:${randomUUID()}`,
    title: `caught-${randomUUID().slice(0, 8)}`,
    severity: 'important',
    osTypes: [osType],
  }).returning({ id: patches.id });
  await getTestDb().insert(devicePatches).values({
    deviceId: device!.id, orgId, patchId: patch!.id, status: 'pending', lastCheckedAt: new Date(),
  });
  return { deviceId: device!.id, patchId: patch!.id };
}

describe('GET /devices/:id/patches: a failed ring-aware evaluation degrades the tab', () => {
  runDb('answers 200 with available: false and the patch list', async () => {
    const client = await createIntegrationTestClient(
      new Hono().use('*', authMiddleware).route('/devices', patchesRoutes),
      { scope: 'organization' },
    );
    const { deviceId, patchId } = await seed(client.env.organization.id, client.env.site.id);
    // Read only by the evaluation; the list and approvals around it do not touch it.
    await failStatementsOn('config_policy_assignments');

    const res = await client.get(`/devices/${deviceId}/patches`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('"available":false');
    expect(JSON.stringify(body)).toContain(patchId);
  });
});

describe('patch job device execution: a failed resolution records the device', () => {
  async function runningJob(orgId: string, deviceId: string) {
    const [job] = await getTestDb().insert(patchJobs).values({
      orgId,
      name: 'caught-query job',
      status: 'running',
      startedAt: new Date(),
      patches: { autoApprove: {} },
      targets: { deviceIds: [deviceId], deployment: { rebootPolicy: 'never', offlineBehavior: 'queue' } },
      devicesTotal: 1,
      devicesPending: 1,
    }).returning({ id: patchJobs.id });
    return job!.id;
  }
  const execute = (patchJobId: string, deviceId: string, orgId: string) =>
    executor.processExecuteDevice({ type: 'execute-patch-job-device', patchJobId, deviceId, orgId });
  const skipReasons = async (jobId: string) =>
    (await getTestDb().select().from(patchJobResults).where(eq(patchJobResults.jobId, jobId))).map((r) => r.errorMessage);

  runDb('approved-patch resolution', async () => {
    const client = await createIntegrationTestClient(new Hono(), { scope: 'organization' });
    const orgId = client.env.organization.id;
    const { deviceId } = await seed(orgId, client.env.site.id);
    const jobId = await runningJob(orgId, deviceId);
    await failStatementsOn('device_patches');

    await expect(execute(jobId, deviceId, orgId)).resolves.toMatchObject({ kind: 'error', error: 'Failed to resolve patches' });
    await clearStatementFaults();

    expect(await skipReasons(jobId)).toEqual(['error_resolving_patches']);
  });

  runDb('System Restore checkpoint policy resolution', async () => {
    const client = await createIntegrationTestClient(new Hono(), { scope: 'organization' });
    const orgId = client.env.organization.id;
    const { deviceId, patchId } = await seed(orgId, client.env.site.id, 'windows');
    await getTestDb().insert(patchApprovals).values({
      partnerId: client.env.partner.id, patchId, status: 'approved', approvedAt: new Date(),
    });
    const jobId = await runningJob(orgId, deviceId);
    await failStatementsOn('config_policy_assignments');

    // Control, not a fix: this read runs on its own connection, so it passes on
    // the unfixed code too. It pins that the skip still lands after the catch.
    await expect(execute(jobId, deviceId, orgId)).resolves.toMatchObject({
      kind: 'error',
      error: 'Failed to resolve the System Restore checkpoint policy',
    });
    await clearStatementFaults();

    expect(await skipReasons(jobId)).toEqual(['error_resolving_restore_point']);
  });
});
