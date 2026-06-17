/**
 * Patch-compliance `pendingReboot` must reflect the device's LIVE OS reboot
 * signal (devices.pending_reboot), not a never-clearing patch-history
 * derivation.
 *
 * Reproduces #1472: a Windows device installs a reboot-requiring update, the
 * dashboard shows "reboot required", the device is rebooted — and the flag
 * stays set forever. Root cause: the compliance endpoint derived the flag as
 *   bool_or(patches.requiresReboot AND status='installed' AND installedAt IS NOT NULL)
 * which stays true for the life of the installed device_patches row, regardless
 * of whether the machine actually rebooted. Meanwhile the agent already reports
 * an accurate, self-clearing OS signal on every heartbeat, persisted to
 * devices.pending_reboot (heartbeat.ts) — and the devices list already reads it.
 * The fix points the compliance query at that same live column.
 *
 * Asserted against a real DB so the SQL aggregation itself is exercised (a
 * Drizzle mock would return whatever rows we fabricate and never run the
 * aggregate).
 *
 * Prerequisites (test:integration lives in apps/api; the compose file is at the
 * repo root — `test:docker` wraps up + run + down from apps/api):
 *   cd apps/api && pnpm test:docker:up
 * Run (from apps/api):
 *   cd apps/api && pnpm test:integration -- src/__tests__/integration/patchComplianceRebootFlag.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { getTestDb } from './setup';
import { authMiddleware } from '../../middleware/auth';
import { patchRoutes } from '../../routes/patches';
import { devices, patches, devicePatches } from '../../db/schema';
import { createIntegrationTestClient, type IntegrationTestClient } from './db-utils';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/patches', patchRoutes);
  return app;
}

let agentSeq = 0;
async function seedDevice(orgId: string, siteId: string, hostname: string, pendingReboot: boolean): Promise<string> {
  const tdb = getTestDb();
  agentSeq++;
  const [row] = await tdb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-rebootflag-${agentSeq}-${Date.now()}`,
      hostname,
      displayName: hostname,
      osType: 'windows',
      osVersion: '10.0.19045',
      osBuild: '19045',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      pendingReboot,
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: no row returned');
  return row.id;
}

let patchSeq = 0;
async function seedDevicePatch(opts: {
  orgId: string;
  deviceId: string;
  status: 'pending' | 'installed';
  requiresReboot: boolean;
}): Promise<void> {
  const tdb = getTestDb();
  patchSeq++;
  // `patches` is a GLOBAL catalog table — cleanupDatabase() only truncates
  // tenant tables, so externalId must be globally unique.
  const [patch] = await tdb
    .insert(patches)
    .values({
      source: 'microsoft',
      externalId: `microsoft:${randomUUID()}`,
      title: `Test patch ${patchSeq}`,
      severity: 'important',
      requiresReboot: opts.requiresReboot,
    })
    .returning({ id: patches.id });
  if (!patch) throw new Error('seedDevicePatch: no patch row');
  await tdb.insert(devicePatches).values({
    deviceId: opts.deviceId,
    orgId: opts.orgId,
    patchId: patch.id,
    status: opts.status,
    installedAt: opts.status === 'installed' ? new Date() : null,
    lastCheckedAt: new Date(),
  });
}

describe('GET /patches/compliance — pendingReboot reflects the live OS signal (#1472)', () => {
  let client: IntegrationTestClient;
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    const app = buildApp();
    client = await createIntegrationTestClient(app, { scope: 'organization' });
    orgId = client.env.organization.id;
    siteId = client.env.site.id;
  });

  it('reports pendingReboot=false for a rebooted device even though it installed a reboot-requiring patch', async () => {
    // The #1472 shape: a reboot-requiring patch was installed, the machine has
    // since rebooted (devices.pending_reboot cleared), but the device still has
    // an outstanding patch so it appears in the compliance list. The old
    // patch-history derivation would report `true` forever.
    const deviceId = await seedDevice(orgId, siteId, 'rebooted-host', /* pendingReboot */ false);
    await seedDevicePatch({ orgId, deviceId, status: 'installed', requiresReboot: true });
    await seedDevicePatch({ orgId, deviceId, status: 'pending', requiresReboot: false });

    const res = await client.get(`/patches/compliance?orgId=${orgId}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const listed = body.data.devicesNeedingPatches.find((d: { id: string }) => d.id === deviceId);
    expect(listed).toBeDefined();
    // Live column says no reboot pending → flag must be false.
    expect(listed.pendingReboot).toBe(false);
  });

  it('reports pendingReboot=true from the live column even with no installed reboot-requiring patch', async () => {
    // The OS reports a pending reboot for a non-patch reason (CBS, pending file
    // renames). Only `pending` patches exist, so the old patch-history
    // derivation would report `false` and miss it.
    const deviceId = await seedDevice(orgId, siteId, 'os-reboot-host', /* pendingReboot */ true);
    await seedDevicePatch({ orgId, deviceId, status: 'pending', requiresReboot: false });

    const res = await client.get(`/patches/compliance?orgId=${orgId}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const listed = body.data.devicesNeedingPatches.find((d: { id: string }) => d.id === deviceId);
    expect(listed).toBeDefined();
    expect(listed.pendingReboot).toBe(true);
  });

  it('keeps each device\'s flag independent — bool_or must not bleed across devices', async () => {
    // Guards the GROUP BY: the query groups on devicePatches.deviceId, so each
    // device's bool_or(devices.pendingReboot) must reflect only that device. A
    // refactor that dropped the device from the grouping (or joined wrong)
    // would aggregate one device's `true` onto the other.
    const rebootDeviceId = await seedDevice(orgId, siteId, 'mixed-reboot-true', /* pendingReboot */ true);
    await seedDevicePatch({ orgId, deviceId: rebootDeviceId, status: 'pending', requiresReboot: false });

    const cleanDeviceId = await seedDevice(orgId, siteId, 'mixed-reboot-false', /* pendingReboot */ false);
    await seedDevicePatch({ orgId, deviceId: cleanDeviceId, status: 'pending', requiresReboot: false });

    const res = await client.get(`/patches/compliance?orgId=${orgId}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const rebootListed = body.data.devicesNeedingPatches.find((d: { id: string }) => d.id === rebootDeviceId);
    const cleanListed = body.data.devicesNeedingPatches.find((d: { id: string }) => d.id === cleanDeviceId);
    expect(rebootListed).toBeDefined();
    expect(cleanListed).toBeDefined();
    expect(rebootListed.pendingReboot).toBe(true);
    expect(cleanListed.pendingReboot).toBe(false);
  });
});
