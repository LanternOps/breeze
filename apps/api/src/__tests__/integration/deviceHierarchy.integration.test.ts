/**
 * loadDeviceHierarchy (#8053 W1a-1) against real PostgreSQL: the one
 * statement returns what the resolvers' three separate reads returned, in
 * system scope (where the heartbeat runs it) and in the device's own org scope.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { deviceGroupMemberships, deviceGroups, devices } from '../../db/schema';
import { loadDeviceHierarchy } from '../../services/deviceHierarchy';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};

function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [],
    userId: null, currentPartnerId: partnerId,
  };
}

async function seed(groupCount: number) {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const unique = randomUUID().slice(0, 8);
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `dh-agent-${unique}`, hostname: `dh-${unique}`,
      osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '0.0.0-test',
      status: 'online', deviceRole: 'workstation',
    }).returning();
    const groupIds: string[] = [];
    for (let i = 0; i < groupCount; i += 1) {
      const [group] = await db.insert(deviceGroups).values({ orgId: org.id, name: `dh group ${i} ${unique}` }).returning();
      await db.insert(deviceGroupMemberships).values({ deviceId: device!.id, groupId: group!.id, orgId: org.id });
      groupIds.push(group!.id);
    }
    return { partner, org, site, device: device!, groupIds };
  });
}

describe('loadDeviceHierarchy (#8053 W1a-1) — real PostgreSQL', () => {
  runDb('returns the device, its org partner and type, its site and every group id in one statement', async () => {
    const f = await seed(2);
    const hierarchy = await withDbAccessContext(SYSTEM_CTX, () => loadDeviceHierarchy(f.device.id));
    expect(hierarchy).toMatchObject({
      deviceId: f.device.id,
      orgId: f.org.id,
      siteId: f.site.id,
      deviceRole: 'workstation',
      osType: 'windows',
      org: { partnerId: f.partner.id, type: 'customer' },
      site: { id: f.site.id, name: f.site.name, timezone: f.site.timezone },
    });
    expect([...hierarchy!.groupIds].sort()).toEqual([...f.groupIds].sort());
    expect(Object.isFrozen(hierarchy)).toBe(true);
  });

  runDb('reads the same hierarchy in the device\'s own org scope as in system scope', async () => {
    const f = await seed(2);
    const system = await withDbAccessContext(SYSTEM_CTX, () => loadDeviceHierarchy(f.device.id));
    const scoped = await withDbAccessContext(orgCtx(f.org.id, f.partner.id), () => loadDeviceHierarchy(f.device.id));
    expect({ ...scoped, groupIds: [...scoped!.groupIds].sort() }).toEqual({ ...system, groupIds: [...system!.groupIds].sort() });
  });

  runDb('a device with no memberships has an empty groupIds list, not null', async () => {
    const f = await seed(0);
    const hierarchy = await withDbAccessContext(SYSTEM_CTX, () => loadDeviceHierarchy(f.device.id));
    expect(hierarchy!.groupIds).toEqual([]);
  });

  runDb('an unknown device id is null', async () => {
    const hierarchy = await withDbAccessContext(SYSTEM_CTX, () => loadDeviceHierarchy(randomUUID()));
    expect(hierarchy).toBeNull();
  });

  runDb('another org\'s context cannot see the device (RLS still applies)', async () => {
    const f = await seed(1);
    const other = await seed(0);
    const hierarchy = await withDbAccessContext(orgCtx(other.org.id, other.partner.id), () => loadDeviceHierarchy(f.device.id));
    expect(hierarchy).toBeNull();
  });
});
