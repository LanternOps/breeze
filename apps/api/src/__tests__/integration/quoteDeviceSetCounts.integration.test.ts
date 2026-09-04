/**
 * #3205 W05: quote device-set estimates use the real contract snapshot helpers.
 * Real Postgres, real breeze_app RLS context, no mocked counts.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  deviceGroupMemberships,
  deviceGroups,
  devices,
  organizations,
  organizationUsers,
  partners,
  roles,
  sites,
  users,
} from '../../db/schema';
import { countContractSeats } from '../../services/contractQuantities';
import {
  countQuoteDeviceSetLines,
  type QuoteDeviceSetLine,
} from '../../services/quoteDeviceSet';

interface Fixture {
  orgId: string;
  partnerId: string;
  siteAId: string;
  siteBId: string;
  groupId: string;
  groupName: string;
}

const quoteLine = (
  values: Partial<QuoteDeviceSetLine> & Pick<QuoteDeviceSetLine, 'id' | 'contractLineType'>,
): QuoteDeviceSetLine => ({
  description: values.id,
  deviceRoles: null,
  deviceGroupId: null,
  deviceGroupName: null,
  siteId: null,
  siteName: null,
  includedQuantity: null,
  overageMode: null,
  overageUnitPrice: null,
  ...values,
});

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 10);
    const [partner] = await db.insert(partners).values({
      name: `Quote Set ${sfx}`,
      slug: `quote-set-${sfx}`,
      type: 'msp',
      plan: 'pro',
      status: 'active',
    }).returning({ id: partners.id });
    const [org] = await db.insert(organizations).values({
      partnerId: partner!.id,
      name: `Quote Org ${sfx}`,
      slug: `quote-org-${sfx}`,
      currencyCode: 'USD',
    }).returning({ id: organizations.id });
    const [siteA, siteB] = await db.insert(sites).values([
      { orgId: org!.id, name: `A ${sfx}` },
      { orgId: org!.id, name: `B ${sfx}` },
    ]).returning({ id: sites.id });

    const device = (
      agent: string,
      siteId: string,
      role: 'server' | 'workstation',
      extra: Partial<typeof devices.$inferInsert> = {},
    ) => ({
      orgId: org!.id,
      siteId,
      agentId: `${agent}-${sfx}`,
      hostname: agent,
      status: 'online' as const,
      deviceRole: role,
      osType: 'linux' as const,
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '1.0.0',
      ...extra,
    });
    const [serverA, workstationA, serverB, decommissioned, ephemeral] = await db.insert(devices).values([
      device('server-a', siteA!.id, 'server'),
      device('workstation-a', siteA!.id, 'workstation'),
      device('server-b', siteB!.id, 'server'),
      device('decommissioned', siteB!.id, 'server', { status: 'decommissioned' }),
      device('ephemeral', siteB!.id, 'server', { isEphemeral: true }),
    ]).returning({ id: devices.id });

    const [group] = await db.insert(deviceGroups).values({
      orgId: org!.id,
      name: `Static ${sfx}`,
      type: 'static',
    }).returning({ id: deviceGroups.id, name: deviceGroups.name });
    await db.insert(deviceGroupMemberships).values([
      { groupId: group!.id, deviceId: serverA!.id, orgId: org!.id },
      { groupId: group!.id, deviceId: workstationA!.id, orgId: org!.id },
      { groupId: group!.id, deviceId: decommissioned!.id, orgId: org!.id },
      { groupId: group!.id, deviceId: ephemeral!.id, orgId: org!.id },
    ]);

    const [role] = await db.insert(roles).values({
      name: `Quote Role ${sfx}`,
      scope: 'organization',
      partnerId: partner!.id,
      orgId: org!.id,
    }).returning({ id: roles.id });
    const [activeA, activeB, disabled] = await db.insert(users).values([
      { partnerId: partner!.id, orgId: org!.id, email: `active-a-${sfx}@example.test`, name: 'Active A', status: 'active' },
      { partnerId: partner!.id, orgId: org!.id, email: `active-b-${sfx}@example.test`, name: 'Active B', status: 'active' },
      { partnerId: partner!.id, orgId: org!.id, email: `disabled-${sfx}@example.test`, name: 'Disabled', status: 'disabled' },
    ]).returning({ id: users.id });
    await db.insert(organizationUsers).values([
      { orgId: org!.id, userId: activeA!.id, roleId: role!.id },
      { orgId: org!.id, userId: activeB!.id, roleId: role!.id },
      { orgId: org!.id, userId: disabled!.id, roleId: role!.id },
    ]);

    return {
      orgId: org!.id,
      partnerId: partner!.id,
      siteAId: siteA!.id,
      siteBId: siteB!.id,
      groupId: group!.id,
      groupName: group!.name,
    };
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('quote device-set counts (breeze_app, real DB)', () => {
  runDb('counts every selector from one billable snapshot and keeps seats independent', async () => {
    const f = await seedFixture();
    const counts = await withSystemDbAccessContext(() => countQuoteDeviceSetLines(f.orgId, [
      quoteLine({ id: 'all', contractLineType: 'per_device' }),
      quoteLine({ id: 'site', contractLineType: 'per_device', siteId: f.siteAId, siteName: 'A' }),
      quoteLine({ id: 'role', contractLineType: 'per_device_role', deviceRoles: ['server'] }),
      quoteLine({
        id: 'group', contractLineType: 'per_device_group',
        deviceGroupId: f.groupId, deviceGroupName: f.groupName,
      }),
      quoteLine({ id: 'seats', contractLineType: 'per_seat' }),
    ]));
    const expectedSeats = await withSystemDbAccessContext(() => countContractSeats(f.orgId));

    expect(counts.map((count) => [count.lineId, count.counted, count.billed])).toEqual([
      ['all', 3, 3],
      ['site', 2, 2],
      ['role', 2, 2],
      ['group', 2, 2],
      ['seats', expectedSeats, expectedSeats],
    ]);
    expect(expectedSeats).toBe(2);

    await withSystemDbAccessContext(() => db.insert(devices).values({
      orgId: f.orgId,
      siteId: f.siteBId,
      agentId: `post-count-${Math.random().toString(36).slice(2, 10)}`,
      hostname: 'post-count',
      status: 'online',
      deviceRole: 'server',
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '1.0.0',
    }));
    const [seatsAfter] = await withSystemDbAccessContext(() => countQuoteDeviceSetLines(f.orgId, [
      quoteLine({ id: 'seats-after', contractLineType: 'per_seat' }),
    ]));
    expect(seatsAfter!.counted).toBe(expectedSeats);
  });

  runDb('treats a group from another org as deleted instead of counting across tenants', async () => {
    const f = await seedFixture();
    const foreignGroup = await withSystemDbAccessContext(async () => {
      const sfx = Math.random().toString(36).slice(2, 10);
      const [otherOrg] = await db.insert(organizations).values({
        partnerId: f.partnerId,
        name: `Foreign ${sfx}`,
        slug: `foreign-${sfx}`,
        currencyCode: 'USD',
      }).returning({ id: organizations.id });
      const [group] = await db.insert(deviceGroups).values({
        orgId: otherOrg!.id,
        name: `Foreign group ${sfx}`,
        type: 'static',
      }).returning({ id: deviceGroups.id, name: deviceGroups.name });
      return group!;
    });

    const [count] = await withSystemDbAccessContext(() => countQuoteDeviceSetLines(f.orgId, [
      quoteLine({
        id: 'foreign', contractLineType: 'per_device_group',
        deviceGroupId: foreignGroup.id, deviceGroupName: foreignGroup.name,
      }),
    ]));
    expect(count).toEqual({
      lineId: 'foreign', counted: 0, billed: 0, included: null,
      overage: 0, overageMode: null, error: 'GROUP_DELETED',
    });
  });

  runDb.each([
    [0, 25, 0],
    [24, 25, 0],
    [25, 25, 0],
    [26, 25, 1],
  ])('bills the fixed allowance at real device count %i', async (deviceCount, billed, overage) => {
    const f = await seedFixture();
    await withSystemDbAccessContext(async () => {
      await db.update(devices).set({ status: 'decommissioned' }).where(eq(devices.orgId, f.orgId));
      if (deviceCount > 0) {
        await db.insert(devices).values(Array.from({ length: deviceCount }, (_, index) => ({
          orgId: f.orgId,
          siteId: f.siteAId,
          agentId: `allowance-${deviceCount}-${index}-${Math.random().toString(36).slice(2, 8)}`,
          hostname: `allowance-${index}`,
          status: 'online' as const,
          deviceRole: 'server',
          osType: 'linux' as const,
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '1.0.0',
        })));
      }
    });

    const [count] = await withSystemDbAccessContext(() => countQuoteDeviceSetLines(f.orgId, [
      quoteLine({
        id: 'allowance', contractLineType: 'per_device', includedQuantity: '25.00',
        overageMode: 'bill', overageUnitPrice: '12.00',
      }),
    ]));
    expect(count).toMatchObject({ counted: deviceCount, billed, included: 25, overage, overageMode: 'bill' });
  });
});
