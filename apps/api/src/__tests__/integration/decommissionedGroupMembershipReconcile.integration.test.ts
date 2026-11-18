/**
 * #9933 — the one-time reconcile of devices that were removed BEFORE dynamic
 * groups started leaving decommissioned devices out. Those devices kept their
 * non-pinned dynamic rows, and nothing re-evaluates a group just because time
 * passed. The boot reconcile finds them and runs the normal device.created
 * re-evaluation for each, so the rule logic stays in groupMembership.ts.
 *
 * Real Postgres + RLS + filter engine: the re-evaluation is driven through
 * `runDeviceGroupReevaluationJob`, exactly what the BullMQ worker runs.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { deviceGroupMemberships, deviceGroups, devices } from '../../db/schema';
import { runDeviceGroupReevaluationJob, type DeviceGroupReevaluationRequest } from '../../jobs/deviceGroupJobs';
import { reconcileDecommissionedDynamicMemberships } from '../../jobs/decommissionedGroupMembershipReconcile';
import { setupTestEnvironment } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SERVER_FILTER = {
  operator: 'AND' as const,
  conditions: [{ field: 'hostname', operator: 'startsWith', value: 'srv-' }],
};

async function seedDevice(orgId: string, siteId: string, hostname: string, decommissioned: boolean): Promise<string> {
  const [row] = await db.insert(devices).values({
    orgId, siteId, agentId: `agent-${randomUUID()}`, hostname,
    osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0',
    status: decommissioned ? 'decommissioned' : 'online',
    decommissionedAt: decommissioned ? new Date() : null,
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedGroup(orgId: string, type: 'dynamic' | 'static'): Promise<string> {
  const [row] = await db.insert(deviceGroups).values({
    orgId, name: `${type} ${randomUUID().slice(0, 8)}`, type,
    filterConditions: type === 'dynamic' ? SERVER_FILTER : null,
    filterFieldsUsed: type === 'dynamic' ? ['hostname'] : [],
  }).returning({ id: deviceGroups.id });
  return row!.id;
}

/** Run each request straight through the worker body instead of Redis. */
function runInline(processed: DeviceGroupReevaluationRequest[]) {
  return async (request: DeviceGroupReevaluationRequest) => {
    processed.push(request);
    return runDeviceGroupReevaluationJob({
      type: 'group-reevaluation', deviceId: request.deviceId, orgId: request.orgId,
      eventType: request.eventType, changedFields: request.changedFields ?? [],
      reason: request.reason, queuedAt: new Date().toISOString(),
    });
  };
}

describe('reconcileDecommissionedDynamicMemberships (#9933)', () => {
  runDb('drops stale non-pinned dynamic rows of already-removed devices and keeps pinned and static rows', async () => {
    const env = await setupTestEnvironment();
    const orgId = env.organization.id;

    const seeded = await withSystemDbAccessContext(async () => {
      const removed = await seedDevice(orgId, env.site.id, 'srv-removed', true);
      const live = await seedDevice(orgId, env.site.id, 'srv-live', false);
      const dynamicA = await seedGroup(orgId, 'dynamic');
      const dynamicB = await seedGroup(orgId, 'dynamic');
      const staticGroup = await seedGroup(orgId, 'static');
      // The pre-deploy state: the removed device still has the rows it had
      // while it was live, written before decommissioned devices were excluded.
      await db.insert(deviceGroupMemberships).values([
        { groupId: dynamicA, deviceId: removed, orgId, addedBy: 'dynamic_rule', isPinned: false },
        { groupId: dynamicB, deviceId: removed, orgId, addedBy: 'manual', isPinned: true },
        { groupId: staticGroup, deviceId: removed, orgId, addedBy: 'manual', isPinned: false },
        { groupId: dynamicA, deviceId: live, orgId, addedBy: 'dynamic_rule', isPinned: false },
      ]);
      return { removed, live, dynamicA, dynamicB, staticGroup };
    });

    const processed: DeviceGroupReevaluationRequest[] = [];
    const result = await reconcileDecommissionedDynamicMemberships(runInline(processed));

    // Other suites' leftovers may also be reconciled; ours must be among them,
    // and the live device must never be.
    expect(processed.map((r) => r.deviceId)).toContain(seeded.removed);
    expect(processed.map((r) => r.deviceId)).not.toContain(seeded.live);
    expect(processed.find((r) => r.deviceId === seeded.removed)).toMatchObject({
      orgId, eventType: 'device.created',
    });
    expect(result.failed).toBe(0);

    const rows = await withSystemDbAccessContext(() => db
      .select({ groupId: deviceGroupMemberships.groupId, deviceId: deviceGroupMemberships.deviceId,
        isPinned: deviceGroupMemberships.isPinned })
      .from(deviceGroupMemberships)
      .where(inArray(deviceGroupMemberships.deviceId, [seeded.removed, seeded.live])));
    const has = (groupId: string, deviceId: string) =>
      rows.some((r) => r.groupId === groupId && r.deviceId === deviceId);

    expect(has(seeded.dynamicA, seeded.removed)).toBe(false); // non-pinned dynamic: gone
    expect(rows.find((r) => r.groupId === seeded.dynamicB && r.deviceId === seeded.removed)?.isPinned).toBe(true); // pinned: kept
    expect(has(seeded.staticGroup, seeded.removed)).toBe(true); // static: kept
    expect(has(seeded.dynamicA, seeded.live)).toBe(true); // live device untouched

    // Idempotent: a second boot finds nothing left for this device.
    const again: DeviceGroupReevaluationRequest[] = [];
    await reconcileDecommissionedDynamicMemberships(runInline(again));
    expect(again.map((r) => r.deviceId)).not.toContain(seeded.removed);
  });

  runDb('a removed device with only a pinned dynamic row is not enqueued', async () => {
    const env = await setupTestEnvironment();
    const orgId = env.organization.id;
    const removed = await withSystemDbAccessContext(async () => {
      const id = await seedDevice(orgId, env.site.id, 'srv-pinned-only', true);
      const group = await seedGroup(orgId, 'dynamic');
      await db.insert(deviceGroupMemberships).values({ groupId: group, deviceId: id, orgId, addedBy: 'manual', isPinned: true });
      return id;
    });

    const processed: DeviceGroupReevaluationRequest[] = [];
    await reconcileDecommissionedDynamicMemberships(runInline(processed));

    expect(processed.map((r) => r.deviceId)).not.toContain(removed);
    const [row] = await withSystemDbAccessContext(() => db.select({ isPinned: deviceGroupMemberships.isPinned })
      .from(deviceGroupMemberships).where(and(eq(deviceGroupMemberships.deviceId, removed))));
    expect(row?.isPinned).toBe(true);
  });
});
