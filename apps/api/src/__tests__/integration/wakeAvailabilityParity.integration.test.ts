/**
 * Wake-on-LAN (`wake_on_lan`, #10838) resolution against real Postgres and RLS.
 *
 * The same answer three ways for every device in a mixed fleet:
 *   1. the batch resolver (`resolveWakeOnLanSettingsForDevices`, system scope),
 *   2. the per-device resolver reading for itself in the heartbeat's org-scoped
 *      context,
 *   3. the per-device resolver over the one-statement DevicePolicySet loaded in
 *      that context (`loadDeviceHierarchy` + `loadDevicePolicySet`).
 * The fleet covers device, group, site, org and partner assignments, an
 * inherited (child) link, role and OS filters, an inactive policy, an
 * unparseable stored blob, a partner-wide policy, a foreign partner, and a
 * device parked in its partner's holding org. Winners are asserted by assigned
 * policy id, not only by settings, so two policies with equal settings cannot
 * pass for each other.
 *
 * Then `resolveWakeAvailability` end to end: the decision follows the resolved
 * policy and the stored status row, a device RLS hides is absent, and a lookup
 * failure fails closed instead of throwing.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  configPolicyFeatureLinks,
  deviceGroupMemberships,
  deviceGroups,
  deviceWakeStatus,
  devices,
} from '../../db/schema';
import { loadDeviceHierarchy } from '../../services/deviceHierarchy';
import { loadDevicePolicySet, withPolicySet } from '../../services/devicePolicySet';
import {
  resolveWakeOnLanSettingsForDevice,
  resolveWakeOnLanSettingsForDevices,
  resolveWakeOnLanWinnersForDevices,
} from '../../services/featureConfigResolver';
import { WAKE_LOOKUP_FAILED_AVAILABILITY, resolveWakeAvailability } from '../../services/wakeAvailability';
import { createOrganization, createPartner, createSite } from './db-utils';
import { inOrg, seedDevice, seedPolicy, sys, type SeedAssignment } from './policySetFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const ALWAYS = { configureSettings: false, buttonMode: 'always' } as const;
const VERIFIED = { configureSettings: false, buttonMode: 'verified' } as const;

type Owner = { orgId: string | null; partnerId: string | null };

/** A policy carrying (or, with a null blob, inheriting rather than carrying) a wake_on_lan link. */
async function seedWakePolicy(input: {
  owner: Owner;
  settings: unknown | null;
  assignments?: SeedAssignment[];
  status?: 'active' | 'inactive';
  parentPolicyId?: string;
}): Promise<string> {
  const policyId = await seedPolicy({
    owner: input.owner,
    status: input.status,
    parentPolicyId: input.parentPolicyId,
    assignments: input.assignments,
  });
  if (input.settings !== null) {
    await sys(async () => {
      await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policyId,
        featureType: 'wake_on_lan',
        inlineSettings: input.settings as Record<string, unknown>,
      });
    });
  }
  return policyId;
}

async function seedFleet() {
  const partner = await createPartner();
  const otherPartner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const orgC = await createOrganization({ partnerId: otherPartner.id });
  const parkedOrg = await createOrganization({ partnerId: partner.id, type: 'unassigned_pool' });
  const siteA = await createSite({ orgId: orgA.id });
  const siteA2 = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const siteC = await createSite({ orgId: orgC.id });
  const siteP = await createSite({ orgId: parkedOrg.id });

  const dA = await seedDevice(orgA.id, siteA.id, 'a');
  const dA2 = await seedDevice(orgA.id, siteA2.id, 'a2');
  const dA3 = await seedDevice(orgA.id, siteA.id, 'a3');
  const dA4 = await seedDevice(orgA.id, siteA.id, 'a4');
  const dB = await seedDevice(orgB.id, siteB.id, 'b');
  const dBServer = await seedDevice(orgB.id, siteB.id, 'bserver');
  const dBLinux = await seedDevice(orgB.id, siteB.id, 'blinux', 'linux');
  const dBInactive = await seedDevice(orgB.id, siteB.id, 'binactive');
  const dBBad = await seedDevice(orgB.id, siteB.id, 'bbad');
  const dC = await seedDevice(orgC.id, siteC.id, 'c');
  const dParked = await seedDevice(parkedOrg.id, siteP.id, 'parked');

  let groupId = '';
  await sys(async () => {
    await db.update(devices).set({ deviceRole: 'server' }).where(eq(devices.id, dBServer));
    const [group] = await db.insert(deviceGroups).values({ orgId: orgA.id, name: 'wake parity group' }).returning();
    await db.insert(deviceGroupMemberships).values({ deviceId: dA3, groupId: group!.id, orgId: orgA.id });
    groupId = group!.id;
  });

  return {
    partner, otherPartner, orgA, orgB, orgC, parkedOrg,
    siteA, siteA2, siteB, groupId,
    dA, dA2, dA3, dA4, dB, dBServer, dBLinux, dBInactive, dBBad, dC, dParked,
  };
}
describe('wake_on_lan resolution on real Postgres (#10838)', () => {
  runDb('batch, per-device and policy-set paths agree on every device and pick the right winner', async () => {
    const f = await seedFleet();
    const A = f.orgA.id;
    const B = f.orgB.id;

    // Partner default: every device of the partner except the parked one.
    const partnerWide = await seedWakePolicy({
      owner: { orgId: null, partnerId: f.partner.id },
      settings: ALWAYS,
      assignments: [{ level: 'partner', targetId: f.partner.id }],
    });
    // Org A overrides to verified; closer levels beat it for other devices.
    const orgPolicy = await seedWakePolicy({
      owner: { orgId: A, partnerId: null }, settings: VERIFIED,
      assignments: [{ level: 'organization', targetId: A }],
    });
    const sitePolicy = await seedWakePolicy({
      owner: { orgId: A, partnerId: null }, settings: ALWAYS,
      assignments: [{ level: 'site', targetId: f.siteA2.id }],
    });
    const groupPolicy = await seedWakePolicy({
      owner: { orgId: A, partnerId: null }, settings: ALWAYS,
      assignments: [{ level: 'device_group', targetId: f.groupId }],
    });
    // A device-level child inheriting its parent's link (the child has none of its own).
    const parent = await seedWakePolicy({ owner: { orgId: A, partnerId: null }, settings: VERIFIED });
    const child = await seedWakePolicy({
      owner: { orgId: A, partnerId: null }, settings: null, parentPolicyId: parent,
      assignments: [{ level: 'device', targetId: f.dA4 }],
    });
    // Role and OS filters in org B.
    const serversOnly = await seedWakePolicy({
      owner: { orgId: B, partnerId: null }, settings: VERIFIED,
      assignments: [{ level: 'organization', targetId: B, roleFilter: ['server'] }],
    });
    const linuxOnly = await seedWakePolicy({
      owner: { orgId: B, partnerId: null }, settings: VERIFIED,
      assignments: [{ level: 'organization', targetId: B, osFilter: ['linux'] }],
    });
    // An inactive device-level policy is ignored.
    await seedWakePolicy({
      owner: { orgId: B, partnerId: null }, settings: VERIFIED, status: 'inactive',
      assignments: [{ level: 'device', targetId: f.dBInactive }],
    });
    // An unparseable stored blob resolves as the restrictive reading on every path.
    const badPolicy = await seedWakePolicy({
      owner: { orgId: B, partnerId: null }, settings: { configureSettings: true, buttonMode: 'always' },
      assignments: [{ level: 'device', targetId: f.dBBad }],
    });

    const fleet: Array<{ id: string; orgId: string; partnerId: string; label: string }> = [
      { id: f.dA, orgId: A, partnerId: f.partner.id, label: 'org policy beats partner' },
      { id: f.dA2, orgId: A, partnerId: f.partner.id, label: 'site beats org' },
      { id: f.dA3, orgId: A, partnerId: f.partner.id, label: 'group beats org' },
      { id: f.dA4, orgId: A, partnerId: f.partner.id, label: 'inherited child link' },
      { id: f.dB, orgId: B, partnerId: f.partner.id, label: 'partner default' },
      { id: f.dBServer, orgId: B, partnerId: f.partner.id, label: 'role filter' },
      { id: f.dBLinux, orgId: B, partnerId: f.partner.id, label: 'os filter' },
      { id: f.dBInactive, orgId: B, partnerId: f.partner.id, label: 'inactive ignored' },
      { id: f.dBBad, orgId: B, partnerId: f.partner.id, label: 'unparseable blob' },
      { id: f.dC, orgId: f.orgC.id, partnerId: f.otherPartner.id, label: 'foreign partner' },
      { id: f.dParked, orgId: f.parkedOrg.id, partnerId: f.partner.id, label: 'parked device' },
    ];

    const batchSettings = await sys(() => resolveWakeOnLanSettingsForDevices(fleet.map((d) => d.id)));
    const batchWinners = await sys(() => resolveWakeOnLanWinnersForDevices(fleet.map((d) => d.id)));

    for (const d of fleet) {
      const own = await inOrg(d.orgId, d.partnerId, () => resolveWakeOnLanSettingsForDevice(d.id));
      const viaSet = await inOrg(d.orgId, d.partnerId, async () => {
        const hierarchy = await loadDeviceHierarchy(d.id);
        expect(hierarchy, d.label).not.toBeNull();
        return resolveWakeOnLanSettingsForDevice(d.id, withPolicySet(await loadDevicePolicySet(hierarchy!), hierarchy));
      });
      expect(own, `${d.label}: own reads`).toEqual(batchSettings.get(d.id) ?? null);
      expect(viaSet, `${d.label}: policy set`).toEqual(batchSettings.get(d.id) ?? null);
    }

    const assignedTo = (id: string) => batchWinners.get(id)?.assignedPolicyId ?? null;
    expect(assignedTo(f.dA)).toBe(orgPolicy);
    expect(assignedTo(f.dA2)).toBe(sitePolicy);
    expect(assignedTo(f.dA3)).toBe(groupPolicy);
    expect(assignedTo(f.dA4)).toBe(child);
    expect(batchWinners.get(f.dA4)?.sourcePolicyId).toBe(parent);
    expect(assignedTo(f.dB)).toBe(partnerWide);
    expect(assignedTo(f.dBServer)).toBe(serversOnly);
    expect(assignedTo(f.dBLinux)).toBe(linuxOnly);
    expect(assignedTo(f.dBInactive)).toBe(partnerWide);
    expect(assignedTo(f.dBBad)).toBe(badPolicy);
    expect(batchSettings.get(f.dBBad)).toEqual(VERIFIED);
    // Not reached: another partner's device, and a device parked in the holding org.
    expect(assignedTo(f.dC)).toBeNull();
    expect(assignedTo(f.dParked)).toBeNull();
    expect(batchSettings.get(f.dParked)).toBeNull();
    // A device that does not exist maps to null rather than throwing.
    const missing = await sys(() => resolveWakeOnLanSettingsForDevices(['00000000-0000-4000-8000-000000000000']));
    expect(missing.get('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  runDb('resolveWakeAvailability follows the resolved policy and the stored status, and RLS hides foreign devices', async () => {
    const f = await seedFleet();
    const A = f.orgA.id;
    await seedWakePolicy({
      owner: { orgId: A, partnerId: null }, settings: VERIFIED,
      assignments: [{ level: 'organization', targetId: A }],
    });
    await seedWakePolicy({
      owner: { orgId: A, partnerId: null }, settings: ALWAYS,
      assignments: [{ level: 'site', targetId: f.siteA2.id }],
    });
    await sys(async () => {
      await db.insert(deviceWakeStatus).values({
        deviceId: f.dA, orgId: A, readinessState: 'ready', fingerprint: 'fp-a', consecutiveTimeouts: 0,
      });
    });

    const out = await inOrg(A, f.partner.id, () => resolveWakeAvailability([f.dA, f.dA2, f.dC]));
    expect(out.get(f.dA)).toMatchObject({ show: true, mode: 'verified', state: 'ready', flaggedTimeouts: false });
    // Policy says always; no status row and a 0.0.0 agent means the agent must update.
    expect(out.get(f.dA2)).toMatchObject({ show: true, mode: 'always', state: 'agent_update_required' });
    // RLS hides the foreign device: absent, so callers fail closed.
    expect(out.has(f.dC)).toBe(false);

    // Verified + ready flips to hidden once three wake attempts timed out.
    await sys(async () => {
      await db.update(deviceWakeStatus).set({ consecutiveTimeouts: 3 }).where(eq(deviceWakeStatus.deviceId, f.dA));
    });
    const flagged = await inOrg(A, f.partner.id, () => resolveWakeAvailability([f.dA]));
    expect(flagged.get(f.dA)).toMatchObject({ show: false, flaggedTimeouts: true });
  });

  runDb('a lookup failure fails closed for every id instead of throwing', async () => {
    const f = await seedFleet();
    // No database access context is held, so the transaction cannot start: a lookup failure.
    const out = await resolveWakeAvailability([f.dA, f.dB]);
    expect(out.size).toBe(2);
    expect(out.get(f.dA)).toEqual(WAKE_LOOKUP_FAILED_AVAILABILITY);
    expect(out.get(f.dB)).toEqual(WAKE_LOOKUP_FAILED_AVAILABILITY);
    expect(out.get(f.dA)).toMatchObject({ show: false, mode: 'unknown', state: 'lookup_failed' });
  });
});
