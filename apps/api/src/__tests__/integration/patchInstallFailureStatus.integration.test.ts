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
import { devices, patches, devicePatches, patchJobs, patchJobResults, deviceCommands } from '../../db/schema';
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
async function seedDevice(
  orgId: string,
  siteId: string,
  hostname: string,
  opts: { pendingReboot?: boolean } = {},
): Promise<string> {
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
      pendingReboot: opts.pendingReboot ?? false,
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
  rebootRequired?: boolean;
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
    rebootRequired: opts.rebootRequired ?? false,
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
    const failedAt = new Date('2026-08-29T18:14:10.000Z');
    await seedDevicePatch(orgId, deviceId, patchId, 'pending');
    await seedResult({ orgId, deviceId, patchId, status: 'failed', errorMessage: BATTERY_ERROR, createdAt: failedAt });

    const row = await listRow(patchId);
    expect(row.installFailure).not.toBeNull();
    expect(row.installFailure?.deviceCount).toBe(1);
    expect(row.installFailure?.error).toBe(BATTERY_ERROR);
    // Round-trips exactly (UTC), whatever the session TimeZone is.
    expect(row.installFailure?.failedAt).toBe(failedAt.toISOString());
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

/**
 * #7680 — the device Patches tab's per-patch Install button queues a bare
 * `install_patches` device command (no `patchJobId`), so its outcome never
 * reached `patch_job_results`. The install-failure overlay read only that
 * table, so an OLDER scheduled-job failure ("Server-side timeout: no response
 * from agent after 120 minutes") kept rendering as "Install failed" after a
 * newer per-device install had completed. And a Windows update that installed
 * but needs a restart to finish stays `IsInstalled=0` to WUA, so the next scan
 * re-reported it as pending with nothing saying the install had actually run.
 */
const OLD_TIMEOUT_ERROR = 'Server-side timeout: no response from agent after 120 minutes';
const WUA_FAILURE = 'WUA install: install failed with result code 4: 0x80240022';

async function seedDeviceInstallCommand(opts: {
  deviceId: string;
  patchIds: string[];
  status: 'pending' | 'sent' | 'completed' | 'failed' | 'timeout' | 'cancelled';
  at: Date;
  results?: Array<Record<string, unknown>>;
  envelopeError?: string;
}): Promise<void> {
  const terminal = opts.status === 'completed' || opts.status === 'failed' || opts.status === 'timeout';
  const summary = opts.results
    ? {
        success: !opts.results.some((r) => r.status === 'failed'),
        installedCount: opts.results.filter((r) => r.status === 'installed').length,
        failedCount: opts.results.filter((r) => r.status === 'failed').length,
        rebootRequired: opts.results.some((r) => r.rebootRequired === true),
        results: opts.results,
      }
    : null;
  await getTestDb().insert(deviceCommands).values({
    deviceId: opts.deviceId,
    type: 'install_patches',
    // Exactly what POST /devices/:id/patches/install enqueues: no patchJobId.
    payload: {
      patchIds: opts.patchIds,
      patches: opts.patchIds.map((id) => ({ id, source: 'microsoft', externalId: 'KB5126052', packageId: null, title: 'KB5126052' })),
    },
    status: opts.status,
    createdAt: new Date(opts.at.getTime() - 108_000),
    executedAt: opts.status === 'pending' ? null : new Date(opts.at.getTime() - 108_000),
    completedAt: terminal ? opts.at : null,
    // The stored envelope: the handler's payload is a JSON STRING in stdout.
    result: terminal
      ? {
          status: opts.status,
          exitCode: opts.status === 'completed' ? 0 : 1,
          ...(summary ? { stdout: JSON.stringify(summary) } : {}),
          ...(opts.envelopeError ? { error: opts.envelopeError } : {}),
          durationMs: 108_000,
        }
      : null,
  });
}

type DeviceTabRow = {
  id: string;
  installFailure: { deviceCount: number; error: string | null; failedAt: string } | null;
  awaitingRestart?: { installedAt: string } | null;
};

describe('#7680 — per-device installs on the patch status overlay', () => {
  let client: IntegrationTestClient;
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    client = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    orgId = client.env.organization.id;
    siteId = client.env.site.id;
  });

  async function deviceTabRow(deviceId: string, patchId: string): Promise<DeviceTabRow> {
    const res = await client.get(`/devices/${deviceId}/patches`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data.pending.find((p: DeviceTabRow) => p.id === patchId);
    expect(row).toBeDefined();
    return row;
  }

  async function listRow(patchId: string): Promise<ListRow> {
    const res = await client.get(`/patches?orgId=${orgId}&limit=200`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data.find((p: ListRow) => p.id === patchId);
    expect(row).toBeDefined();
    return row;
  }

  it('a newer per-device install that needs a restart supersedes an older job failure and reads as awaiting restart', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'win11-reporter', { pendingReboot: true });
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, deviceId, patchId, 'pending');
    await seedResult({
      orgId, deviceId, patchId, status: 'failed', errorMessage: OLD_TIMEOUT_ERROR,
      createdAt: new Date(Date.now() - 3 * 24 * 3600_000),
    });
    const installedAt = new Date(Date.now() - 10 * 60_000);
    await seedDeviceInstallCommand({
      deviceId, patchIds: [patchId], status: 'completed', at: installedAt,
      results: [{ id: patchId, status: 'installed', rebootRequired: true, message: 'installed but not verified — reboot may be required' }],
    });

    const row = await deviceTabRow(deviceId, patchId);
    expect(row.installFailure).toBeNull();
    expect(row.awaitingRestart).toEqual({ installedAt: installedAt.toISOString() });

    const fleet = await listRow(patchId);
    expect(fleet.installFailure).toBeNull();
  });

  it('reports a newer failed per-device install with its own reason, not the older job error', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'win11-wua-fail');
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, deviceId, patchId, 'pending');
    await seedResult({
      orgId, deviceId, patchId, status: 'failed', errorMessage: OLD_TIMEOUT_ERROR,
      createdAt: new Date(Date.now() - 3 * 24 * 3600_000),
    });
    const failedAt = new Date(Date.now() - 5 * 60_000);
    await seedDeviceInstallCommand({
      deviceId, patchIds: [patchId], status: 'failed', at: failedAt,
      results: [{ id: patchId, status: 'failed', error: WUA_FAILURE }],
      envelopeError: '1 patch operations failed',
    });

    const row = await deviceTabRow(deviceId, patchId);
    expect(row.installFailure).toEqual({ deviceCount: 1, error: WUA_FAILURE, failedAt: failedAt.toISOString() });
    expect(row.awaitingRestart ?? null).toBeNull();

    const fleet = await listRow(patchId);
    expect(fleet.installFailure).toEqual({ deviceCount: 1, error: WUA_FAILURE, failedAt: failedAt.toISOString() });
  });

  it('reports a timed-out per-device install with the reaper reason', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'win11-timeout');
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, deviceId, patchId, 'pending');
    const timedOutAt = new Date(Date.now() - 5 * 60_000);
    await seedDeviceInstallCommand({
      deviceId, patchIds: [patchId], status: 'timeout', at: timedOutAt, envelopeError: OLD_TIMEOUT_ERROR,
    });

    const row = await deviceTabRow(deviceId, patchId);
    expect(row.installFailure).toEqual({ deviceCount: 1, error: OLD_TIMEOUT_ERROR, failedAt: timedOutAt.toISOString() });
  });

  it('an older per-device install does not hide a newer job failure', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'win11-newer-job-fail');
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, deviceId, patchId, 'pending');
    await seedDeviceInstallCommand({
      deviceId, patchIds: [patchId], status: 'completed', at: new Date(Date.now() - 2 * 3600_000),
      results: [{ id: patchId, status: 'installed', rebootRequired: false }],
    });
    const failedAt = new Date(Date.now() - 60_000);
    await seedResult({ orgId, deviceId, patchId, status: 'failed', errorMessage: BATTERY_ERROR, createdAt: failedAt });

    const row = await deviceTabRow(deviceId, patchId);
    expect(row.installFailure).toEqual({ deviceCount: 1, error: BATTERY_ERROR, failedAt: failedAt.toISOString() });
  });

  it('a queued per-device retry supersedes an older failure', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'win11-queued-retry');
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, deviceId, patchId, 'pending');
    await seedResult({
      orgId, deviceId, patchId, status: 'failed', errorMessage: OLD_TIMEOUT_ERROR,
      createdAt: new Date(Date.now() - 3600_000),
    });
    await seedDeviceInstallCommand({ deviceId, patchIds: [patchId], status: 'sent', at: new Date() });

    const row = await deviceTabRow(deviceId, patchId);
    expect(row.installFailure).toBeNull();
  });

  it('a cancelled per-device install is not an attempt and leaves the failure visible', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'win11-cancelled');
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, deviceId, patchId, 'pending');
    const failedAt = new Date(Date.now() - 3600_000);
    await seedResult({ orgId, deviceId, patchId, status: 'failed', errorMessage: OLD_TIMEOUT_ERROR, createdAt: failedAt });
    await seedDeviceInstallCommand({ deviceId, patchIds: [patchId], status: 'cancelled', at: new Date() });

    const row = await deviceTabRow(deviceId, patchId);
    expect(row.installFailure).toEqual({ deviceCount: 1, error: OLD_TIMEOUT_ERROR, failedAt: failedAt.toISOString() });
  });

  it('a per-device install of a DIFFERENT patch does not touch this patch', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'win11-other-patch', { pendingReboot: true });
    const failedPatch = await seedPatch();
    const otherPatch = await seedPatch();
    await seedDevicePatch(orgId, deviceId, failedPatch, 'pending');
    await seedDevicePatch(orgId, deviceId, otherPatch, 'pending');
    const failedAt = new Date(Date.now() - 3600_000);
    await seedResult({ orgId, deviceId, patchId: failedPatch, status: 'failed', errorMessage: OLD_TIMEOUT_ERROR, createdAt: failedAt });
    await seedDeviceInstallCommand({
      deviceId, patchIds: [otherPatch], status: 'completed', at: new Date(),
      results: [{ id: otherPatch, status: 'installed', rebootRequired: true }],
    });

    const failed = await deviceTabRow(deviceId, failedPatch);
    expect(failed.installFailure).toEqual({ deviceCount: 1, error: OLD_TIMEOUT_ERROR, failedAt: failedAt.toISOString() });
    expect(failed.awaitingRestart ?? null).toBeNull();
    const other = await deviceTabRow(deviceId, otherPatch);
    expect(other.awaitingRestart).not.toBeNull();
  });

  it('does not read as awaiting restart once the device has restarted', async () => {
    // pendingReboot self-clears on the first post-reboot heartbeat; a patch the
    // scan still offers after that did not finish installing.
    const deviceId = await seedDevice(orgId, siteId, 'win11-rebooted', { pendingReboot: false });
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, deviceId, patchId, 'pending');
    await seedDeviceInstallCommand({
      deviceId, patchIds: [patchId], status: 'completed', at: new Date(Date.now() - 3600_000),
      results: [{ id: patchId, status: 'installed', rebootRequired: true }],
    });

    const row = await deviceTabRow(deviceId, patchId);
    expect(row.installFailure).toBeNull();
    expect(row.awaitingRestart ?? null).toBeNull();
  });

  it('a skipped per-device install supersedes the failure without claiming an install', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'win11-skipped', { pendingReboot: true });
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, deviceId, patchId, 'pending');
    await seedResult({
      orgId, deviceId, patchId, status: 'failed', errorMessage: OLD_TIMEOUT_ERROR,
      createdAt: new Date(Date.now() - 3600_000),
    });
    await seedDeviceInstallCommand({
      deviceId, patchIds: [patchId], status: 'completed', at: new Date(),
      results: [{ id: patchId, status: 'skipped', skipReason: 'not_offered', rebootRequired: false }],
    });

    const row = await deviceTabRow(deviceId, patchId);
    expect(row.installFailure).toBeNull();
    expect(row.awaitingRestart ?? null).toBeNull();
  });

  it('a scheduled-job install that reported reboot required reads as awaiting restart', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'win11-job-reboot', { pendingReboot: true });
    const patchId = await seedPatch();
    await seedDevicePatch(orgId, deviceId, patchId, 'pending');
    const installedAt = new Date(Date.now() - 20 * 60_000);
    await seedResult({ orgId, deviceId, patchId, status: 'completed', rebootRequired: true, createdAt: installedAt });

    const row = await deviceTabRow(deviceId, patchId);
    expect(row.installFailure).toBeNull();
    expect(row.awaitingRestart).toEqual({ installedAt: installedAt.toISOString() });
  });
});
