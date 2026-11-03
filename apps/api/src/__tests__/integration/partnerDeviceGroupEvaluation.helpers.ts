import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { SoftwareInventoryObservationV2 } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceGroups, deviceGroupMemberships, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { deviceGroupReevaluationJobId, getDeviceGroupReevaluationQueue } from '../../jobs/deviceGroupJobs';
import type { FilterConditionGroup } from '../../services/filterEngine';
import { getTestDb } from './setup';

export const hostnameFilter: FilterConditionGroup = {
  operator: 'AND', conditions: [{ field: 'hostname', operator: 'startsWith', value: 'srv-' }],
};
export const softwareName = 'PowerChute Business Edition Agent';
export const softwareFilter: FilterConditionGroup = {
  operator: 'AND', conditions: [{ field: 'software.installed', operator: 'equals', value: softwareName }],
};
export function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Fail promptly if a transaction finishes before reaching its synchronization point. */
export async function waitForStart(started: Promise<void>, operation: Promise<unknown>): Promise<void> {
  await Promise.race([started, operation.then((result) => {
    throw new Error(`operation finished before its synchronization point: ${JSON.stringify(result)}`);
  })]);
}

export async function seedDevice(orgId: string, siteId: string, holding = false) {
  return withSystemDbAccessContext(async () => {
    if (holding) await db.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
    const [row] = await db.insert(devices).values({
      orgId, siteId, agentId: randomUUID(), hostname: 'srv-partner',
      osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1.0.0',
    }).returning();
    if (!row) throw new Error('missing device');
    return row.id;
  });
}
export async function seedOrg(partnerId: string, type: 'customer' | 'quick_support' | 'unassigned_pool' = 'customer') {
  const org = await createOrganization({ partnerId, type });
  const site = await createSite({ orgId: org.id });
  const deviceId = await seedDevice(org.id, site.id, type === 'unassigned_pool');
  return { orgId: org.id, siteId: site.id, deviceId };
}
export async function seedGroup(partnerId: string, filter: FilterConditionGroup = hostnameFilter) {
  return withSystemDbAccessContext(async () => {
    const [inserted] = await db.execute<{ id: string }>(sql`
      INSERT INTO device_groups (org_id, partner_id, name, type, filter_conditions)
      VALUES (NULL, ${partnerId}, 'Partner evaluation', 'dynamic', ${JSON.stringify(filter)}::jsonb) RETURNING id`);
    if (!inserted) throw new Error('missing inserted group');
    const [group] = await db.select().from(deviceGroups).where(eq(deviceGroups.id, inserted.id));
    if (!group) throw new Error('missing group');
    return group;
  });
}
export async function fixture(filter: FilterConditionGroup = hostnameFilter) {
  const partner = await createPartner();
  const a = await seedOrg(partner.id);
  const b = await seedOrg(partner.id);
  const group = await seedGroup(partner.id, filter);
  return { partnerId: partner.id, group, a, b };
}
export const members = (groupId: string) => withSystemDbAccessContext(() => db.select().from(deviceGroupMemberships)
  .where(eq(deviceGroupMemberships.groupId, groupId)));

export async function backendPid() {
  const [row] = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
  if (!row) throw new Error('missing backend pid');
  return row.pid;
}
export async function waitForBlock(waiter: number, blocker: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await getTestDb().execute<{ blocked: boolean }>(sql`
      SELECT ${blocker}::integer = ANY(pg_blocking_pids(${waiter}::integer)) AS blocked`);
    if (row?.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`backend ${waiter} did not block on ${blocker}`);
}

export async function awaitQueuedJob(deviceId: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = await getDeviceGroupReevaluationQueue().getJob(deviceGroupReevaluationJobId(deviceId));
    if (job) return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`no device-group job for ${deviceId}`);
}

export function inventoryReport(): SoftwareInventoryObservationV2 {
  return { schemaVersion: 2, observationId: randomUUID(), collectorVersion: '1.0.0',
    observedAt: '2026-08-24T12:00:00.000Z', completeness: 'complete',
    expectedSources: ['linux:dpkg'], succeededSources: ['linux:dpkg'], failedSources: [],
    truncated: false, itemCount: 1, items: [{ name: softwareName }] };
}

export async function seedPartnerPolicy(partnerId: string, groupId: string) {
  return withSystemDbAccessContext(async () => {
    const [ring] = await db.execute<{ id: string }>(sql`INSERT INTO patch_policies (partner_id, kind, name)
      VALUES (${partnerId}, 'ring', 'Partner evaluation ring') RETURNING id`);
    if (!ring) throw new Error('missing ring');
    const [policy] = await db.execute<{ id: string }>(sql`INSERT INTO configuration_policies (org_id, partner_id, name, status)
      VALUES (NULL, ${partnerId}, 'Partner evaluation policy', 'active') RETURNING id`);
    if (!policy) throw new Error('missing policy');
    const [link] = await db.execute<{ id: string }>(sql`INSERT INTO config_policy_feature_links
      (config_policy_id, feature_type, feature_policy_id, inline_settings)
      VALUES (${policy.id}, 'patch', ${ring.id}, '{}'::jsonb) RETURNING id`);
    if (!link) throw new Error('missing link');
    await db.execute(sql`INSERT INTO config_policy_patch_settings (feature_link_id, sources, schedule_frequency, schedule_time)
      VALUES (${link.id}, ARRAY['os']::text[], 'daily', '04:41')`);
    await db.execute(sql`INSERT INTO config_policy_assignments (config_policy_id, level, target_id, priority)
      VALUES (${policy.id}, 'device_group', ${groupId}, 0)`);
    return policy.id;
  });
}
