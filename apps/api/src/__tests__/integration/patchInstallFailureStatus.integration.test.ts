/**
 * #4223 — a patch whose last install attempt failed (e.g. the Windows agent's
 * battery preflight: `preflight check "battery" failed: running on battery
 * power`) must surface that failure and its reason on BOTH the org Patches
 * list (GET /patches) and the device Patches tab (GET /devices/:id/patches).
 *
 * Before the fix both views derived their status column solely from
 * `patch_approvals`, so a ring auto-approved patch whose scheduled job failed
 * preflight rendered as "Pending approval" and the reason was only reachable
 * via `patch_job_results.error_message` in psql.
 *
 * Real Postgres on purpose: the overlay is a DISTINCT ON "latest attempt per
 * (device, patch)" read, and a Drizzle mock would return whatever rows we
 * fabricate without ever running that ordering.
 *
 * Run:
 *   pnpm test-stack up
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/patchInstallFailureStatus.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { getTestDb } from './setup';
import { authMiddleware } from '../../middleware/auth';
import { patchRoutes } from '../../routes/patches';
import { patchesRoutes as devicePatchesRoutes } from '../../routes/devices/patches';
import { devices, patches, devicePatches, patchJobs, patchJobResults } from '../../db/schema';
import { createIntegrationTestClient, type IntegrationTestClient } from './db-utils';

const BATTERY_ERROR = 'preflight check "battery" failed: running on battery power (battery: 76%)';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/patches', patchRoutes);
  app.route('/devices', devicePatchesRoutes);
  return app;
}

let agentSeq = 0;
async function seedDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  agentSeq++;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-4223-${agentSeq}-${Date.now()}`,
      hostname,
      displayName: hostname,
      osType: 'windows',
      osVersion: '11',
      osBuild: '22631',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: no row returned');
  return row.id;
}

async function seedPatch(): Promise<string> {
  // `patches` is a global catalog; externalId must be globally unique.
  const [row] = await getTestDb()
    .insert(patches)
    .values({
      source: 'microsoft',
      externalId: `microsoft:${randomUUID()}`,
      title: `KB-4223-${randomUUID().slice(0, 8)}`,
      severity: 'important',
      osTypes: ['windows'],
    })
    .returning({ id: patches.id });
  if (!row) throw new Error('seedPatch: no row returned');
  return row.id;
}

async function seedDevicePatch(orgId: string, deviceId: string, patchId: string, status: 'pending' | 'installed') {
  await getTestDb().insert(devicePatches).values({
    deviceId,
    orgId,
    patchId,
    status,
    lastCheckedAt: new Date(),
  });
}

async function seedResult(opts: {
  orgId: string;
  deviceId: string;
  patchId: string;
  status: 'failed' | 'completed' | 'running';
  errorMessage?: string | null;
  createdAt: Date;
}) {
  const tdb = getTestDb();
  const [job] = await tdb
    .insert(patchJobs)
    .values({ orgId: opts.orgId, name: 'Scheduled patch job', status: 'failed', devicesTotal: 1 })
    .returning({ id: patchJobs.id });
  if (!job) throw new Error('seedResult: no job row');
  await tdb.insert(patchJobResults).values({
    jobId: job.id,
    deviceId: opts.deviceId,
    patchId: opts.patchId,
    status: opts.status,
    errorMessage: opts.errorMessage ?? null,
    startedAt: opts.createdAt,
    completedAt: opts.status === 'running' ? null : opts.createdAt,
    createdAt: opts.createdAt,
  });
}

type ListRow = {
  id: string;
  approvalStatus: string;
  installFailure: { deviceCount: number; error: string | null; failedAt: string } | null;
};

describe('#4223 — last install failure surfaces on patch list + device patches', () => {
  let client: IntegrationTestClient;
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    client = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    orgId = client.env.organization.id;
    siteId = client.env.site.id;
  });

  async function listRow(patchId: string): Promise<ListRow> {
    const res = await client.get(`/patches?orgId=${orgId}&limit=200`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data.find((p: ListRow) => p.id === patchId);
    expect(row).toBeDefined();
    return row;
  }

  it('reports a battery-preflight failure with its reason on the org patch list', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'laptop-on-battery');
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, deviceId, patchId, 'pending');
    await seedResult({ orgId, deviceId, patchId, status: 'failed', errorMessage: BATTERY_ERROR, createdAt: new Date() });

    const row = await listRow(patchId);
    expect(row.installFailure).not.toBeNull();
    expect(row.installFailure?.deviceCount).toBe(1);
    expect(row.installFailure?.error).toBe(BATTERY_ERROR);
    expect(typeof row.installFailure?.failedAt).toBe('string');
  });

  it('counts failing devices and reports the most recent reason', async () => {
    const d1 = await seedDevice(orgId, siteId, 'laptop-a');
    const d2 = await seedDevice(orgId, siteId, 'laptop-b');
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, d1, patchId, 'pending');
    await seedDevicePatch(orgId, d2, patchId, 'pending');
    await seedResult({ orgId, deviceId: d1, patchId, status: 'failed', errorMessage: 'older: disk space', createdAt: new Date(Date.now() - 60_000) });
    await seedResult({ orgId, deviceId: d2, patchId, status: 'failed', errorMessage: BATTERY_ERROR, createdAt: new Date() });

    const row = await listRow(patchId);
    expect(row.installFailure?.deviceCount).toBe(2);
    expect(row.installFailure?.error).toBe(BATTERY_ERROR);
  });

  it('does not report a failure that a later attempt on the same device superseded', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'laptop-retry');
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, deviceId, patchId, 'pending');
    await seedResult({ orgId, deviceId, patchId, status: 'failed', errorMessage: BATTERY_ERROR, createdAt: new Date(Date.now() - 60_000) });
    await seedResult({ orgId, deviceId, patchId, status: 'running', createdAt: new Date() });

    const row = await listRow(patchId);
    expect(row.installFailure).toBeNull();
  });

  it('does not report a failure once the device has the patch installed', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'laptop-installed');
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, deviceId, patchId, 'installed');
    await seedResult({ orgId, deviceId, patchId, status: 'failed', errorMessage: BATTERY_ERROR, createdAt: new Date() });

    const row = await listRow(patchId);
    expect(row.installFailure).toBeNull();
  });

  it('reports the failure and reason on the device patches tab payload', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'laptop-device-tab');
    const failedPatch = await seedPatch();
    const cleanPatch = await seedPatch();
    await seedDevicePatch(orgId, deviceId, failedPatch, 'pending');
    await seedDevicePatch(orgId, deviceId, cleanPatch, 'pending');
    await seedResult({ orgId, deviceId, patchId: failedPatch, status: 'failed', errorMessage: BATTERY_ERROR, createdAt: new Date() });

    const res = await client.get(`/devices/${deviceId}/patches`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const failed = body.data.pending.find((p: { id: string }) => p.id === failedPatch);
    const clean = body.data.pending.find((p: { id: string }) => p.id === cleanPatch);
    expect(failed.installFailure).toMatchObject({ deviceCount: 1, error: BATTERY_ERROR });
    expect(clean.installFailure).toBeNull();
  });
});
