/**
 * Vendor updates (`oem_updates`, #11070) resolution against real Postgres and
 * RLS: partner-wide fan-out by the device org's partner, closest wins whole,
 * inheritance through the effective-links view, inactive policies ignored,
 * role/OS filters, and the batch form agreeing with the per-device walk.
 *
 * Same seeding pattern as featureConfigResolverPartnerWide.integration.test.ts:
 * rows are written under system scope, then read through the resolver under an
 * org-scoped context carrying the org's partner (`currentPartnerId`), the field
 * the SELECT-only `*_partner_wide_select` policies read.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { configurationPolicies, configPolicyFeatureLinks, configPolicyAssignments, devices } from '../../db/schema';
import { resolveOemUpdatesLinkForDevice, resolveOemUpdatesLinksForDevices } from '../../services/oemUpdates/resolver';
import { createPartner, createOrganization, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

const createdPolicies: string[] = [];
const createdDevices: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    // Policies first: their assignments (device-level ones included) go with them.
    for (const id of createdPolicies) await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    for (const id of createdDevices) await db.delete(devices).where(eq(devices.id, id));
  });
  createdDevices.length = 0;
  createdPolicies.length = 0;
});

const SCHEDULE = { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 };
const settings = (categories: Record<string, boolean>, over: Record<string, unknown> = {}) => ({
  version: 1, enabled: true, schedule: SCHEDULE, catchUpNights: 7, reboot: 'overnight',
  vendors: { dell: { enabled: true, categories, blockedUpdateIds: [] } },
  ...over,
});

type Owner = { orgId: string | null; partnerId: string | null };

async function seedDevice(orgId: string, siteId: string, deviceRole = 'workstation') {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [d] = await db.insert(devices).values({
      orgId,
      siteId,
      agentId: `agent-${randomUUID()}`,
      hostname: `host-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '1.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
      deviceRole,
    }).returning();
    createdDevices.push(d!.id);
    return d!;
  });
}

async function seedPolicy(
  owner: Owner,
  inlineSettings: Record<string, unknown> | null,
  opts: { status?: 'active' | 'inactive'; parentPolicyId?: string } = {},
): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: owner.orgId,
      partnerId: owner.partnerId,
      name: `vendor updates ${randomUUID()}`,
      status: opts.status ?? 'active',
      ...(opts.parentPolicyId ? { parentPolicyId: opts.parentPolicyId } : {}),
    }).returning();
    // Children first so the afterEach delete never trips the parent FK.
    if (opts.parentPolicyId) createdPolicies.unshift(policy!.id);
    else createdPolicies.push(policy!.id);
    if (inlineSettings) {
      await db.insert(configPolicyFeatureLinks).values({ configPolicyId: policy!.id, featureType: 'oem_updates', inlineSettings });
    }
    return policy!.id;
  });
}

async function assign(
  configPolicyId: string,
  level: 'partner' | 'organization' | 'device',
  targetId: string,
  extra: { roleFilter?: string[] } = {},
) {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.insert(configPolicyAssignments).values({ configPolicyId, level, targetId, priority: 0, ...extra });
  });
}

async function fleet() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const otherPartner = await createPartner();
  const orgC = await createOrganization({ partnerId: otherPartner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const siteC = await createSite({ orgId: orgC.id });
  return {
    partner, otherPartner, orgA, orgB, orgC,
    deviceA: await seedDevice(orgA.id, siteA.id),
    deviceB: await seedDevice(orgB.id, siteB.id),
    deviceC: await seedDevice(orgC.id, siteC.id),
  };
}

describe('resolveOemUpdatesLinkForDevice on real Postgres (#11070)', () => {
  it('a partner-wide policy reaches a device in each of two orgs of that partner and neither org of another partner', async () => {
    const f = await fleet();
    const policyId = await seedPolicy({ orgId: null, partnerId: f.partner.id }, settings({ driver: true }));
    await assign(policyId, 'partner', f.partner.id);

    const a = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () => resolveOemUpdatesLinkForDevice(f.deviceA.id));
    const b = await withDbAccessContext(orgContext(f.orgB.id, f.partner.id), () => resolveOemUpdatesLinkForDevice(f.deviceB.id));
    const c = await withDbAccessContext(orgContext(f.orgC.id, f.otherPartner.id), () => resolveOemUpdatesLinkForDevice(f.deviceC.id));

    expect(a).toMatchObject({ configPolicyId: policyId, assignedPolicyId: policyId, invalidStoredSettings: false });
    expect(a!.settings.vendors.dell!.categories).toEqual({ driver: true });
    expect(b).toMatchObject({ configPolicyId: policyId });
    expect(c).toBeNull();

    // Even under system scope a foreign partner's policy never applies.
    const cSystem = await withDbAccessContext(SYSTEM_CTX, () => resolveOemUpdatesLinkForDevice(f.deviceC.id));
    expect(cSystem).toBeNull();
  });

  it('an org override wins over the partner default and replaces it whole', async () => {
    const f = await fleet();
    const partnerWide = await seedPolicy({ orgId: null, partnerId: f.partner.id }, settings({ driver: true, application: true }, { catchUpNights: 14 }));
    await assign(partnerWide, 'partner', f.partner.id);
    const orgOff = await seedPolicy({ orgId: f.orgA.id, partnerId: null }, settings({}, { enabled: false }));
    await assign(orgOff, 'organization', f.orgA.id);

    const a = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () => resolveOemUpdatesLinkForDevice(f.deviceA.id));
    expect(a).toMatchObject({ configPolicyId: orgOff });
    expect(a!.settings.enabled).toBe(false);
    expect(a!.settings.catchUpNights).toBe(7);
    expect(a!.settings.vendors.dell!.categories).toEqual({});

    // The other org keeps the partner default.
    const b = await withDbAccessContext(orgContext(f.orgB.id, f.partner.id), () => resolveOemUpdatesLinkForDevice(f.deviceB.id));
    expect(b).toMatchObject({ configPolicyId: partnerWide });
  });

  it('a child inherits its parent link through the effective view, and its own link replaces it', async () => {
    const f = await fleet();
    const parent = await seedPolicy({ orgId: f.orgA.id, partnerId: null }, settings({ driver: true }));
    const child = await seedPolicy({ orgId: f.orgA.id, partnerId: null }, null, { parentPolicyId: parent });
    await assign(child, 'device', f.deviceA.id);

    const inherited = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () => resolveOemUpdatesLinkForDevice(f.deviceA.id));
    expect(inherited).toMatchObject({ configPolicyId: parent, assignedPolicyId: child });

    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.insert(configPolicyFeatureLinks).values({ configPolicyId: child, featureType: 'oem_updates', inlineSettings: settings({}, { enabled: false }) });
    });
    const own = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () => resolveOemUpdatesLinkForDevice(f.deviceA.id));
    expect(own).toMatchObject({ configPolicyId: child, assignedPolicyId: child });
    expect(own!.settings.enabled).toBe(false);
  });

  it('an inactive policy is ignored, and a role filter that excludes the device is ignored', async () => {
    const f = await fleet();
    const inactive = await seedPolicy({ orgId: f.orgA.id, partnerId: null }, settings({ driver: true }), { status: 'inactive' });
    await assign(inactive, 'organization', f.orgA.id);
    const serversOnly = await seedPolicy({ orgId: f.orgA.id, partnerId: null }, settings({ driver: true }));
    await assign(serversOnly, 'organization', f.orgA.id, { roleFilter: ['server'] });

    const a = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () => resolveOemUpdatesLinkForDevice(f.deviceA.id));
    expect(a).toBeNull();
  });

  it('unparseable stored settings resolve as disabled', async () => {
    const f = await fleet();
    const bad = await seedPolicy({ orgId: f.orgA.id, partnerId: null }, { ...settings({ driver: true }), catchUpNights: 99 });
    await assign(bad, 'organization', f.orgA.id);
    const a = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () => resolveOemUpdatesLinkForDevice(f.deviceA.id));
    expect(a).toMatchObject({ configPolicyId: bad, invalidStoredSettings: true });
    expect(a!.settings.enabled).toBe(false);
  });

  it('the batch form agrees with the per-device walk', async () => {
    const f = await fleet();
    const partnerWide = await seedPolicy({ orgId: null, partnerId: f.partner.id }, settings({ driver: true }));
    await assign(partnerWide, 'partner', f.partner.id);
    const orgOff = await seedPolicy({ orgId: f.orgB.id, partnerId: null }, settings({}, { enabled: false }));
    await assign(orgOff, 'organization', f.orgB.id);

    const batch = await withDbAccessContext(SYSTEM_CTX, () =>
      resolveOemUpdatesLinksForDevices([f.deviceA.id, f.deviceB.id, f.deviceC.id]));
    expect(batch.get(f.deviceA.id)).toMatchObject({ configPolicyId: partnerWide });
    expect(batch.get(f.deviceB.id)).toMatchObject({ configPolicyId: orgOff });
    expect(batch.has(f.deviceC.id)).toBe(false);

    for (const [device, orgId, partnerId] of [
      [f.deviceA, f.orgA.id, f.partner.id],
      [f.deviceB, f.orgB.id, f.partner.id],
    ] as const) {
      const single = await withDbAccessContext(orgContext(orgId, partnerId), () => resolveOemUpdatesLinkForDevice(device.id));
      expect(batch.get(device.id)?.linkId).toBe(single?.linkId);
    }
  });
});
