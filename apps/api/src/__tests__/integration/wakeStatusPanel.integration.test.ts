/**
 * Wake-on-LAN status panel under RLS on real Postgres (#10838 W02 Task 11).
 *
 * A partner-wide wake_on_lan policy governs every org of its partner. The panel
 * walks the policy's partner assignment to candidate devices; the caller's RLS
 * context must still bound what comes back: an org-scoped caller never sees, and
 * can never "allow wake again" for, another org's device. The system-scope read
 * is the positive control proving the policy really governs both orgs' devices,
 * so the org-scoped narrowing is RLS and not an empty fixture.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { db } from '../../db';
import { deviceWakeStatus } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { allowWakeAgain, listWakeStatusForPolicy } from '../../services/wakeStatusPanel';
import { createOrganization, createPartner, createSite } from './db-utils';
import { inOrg, seedDevice, seedPolicy, sys } from './policySetFixtures';
import { configPolicyFeatureLinks } from '../../db/schema';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('wake status panel on real Postgres (#10838)', () => {
  runDb('an org-scoped caller never sees another org\'s devices under a partner-wide policy', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const dA = await seedDevice(orgA.id, siteA.id, 'wsp-a');
    const dB = await seedDevice(orgB.id, siteB.id, 'wsp-b');

    const policyId = await seedPolicy({
      owner: { orgId: null, partnerId: partner.id },
      assignments: [{ level: 'partner', targetId: partner.id }],
    });
    await sys(async () => {
      await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policyId,
        featureType: 'wake_on_lan',
        inlineSettings: { configureSettings: false, buttonMode: 'always' },
      });
      await db.insert(deviceWakeStatus).values([
        { deviceId: dA, orgId: orgA.id, readinessState: 'ready', consecutiveTimeouts: 3 },
        { deviceId: dB, orgId: orgB.id, readinessState: 'ready', consecutiveTimeouts: 3 },
      ]);
    });

    const input = { policyId, allowedSiteIds: undefined, page: 1, limit: 50 };

    // Positive control: system scope sees both orgs' devices as governed by this policy.
    const all = await sys(() => listWakeStatusForPolicy(input));
    expect(all.data.map((r) => r.deviceId).sort()).toEqual([dA, dB].sort());

    // Org A's caller sees only org A's device, and the counts agree.
    const asA = await inOrg(orgA.id, partner.id, () => listWakeStatusForPolicy(input));
    expect(asA.data.map((r) => r.deviceId)).toEqual([dA]);
    expect(asA.counts).toEqual({ ready: 1 });
    expect(asA.total).toBe(1);

    // Allow-again on another org's device: refused, and the row is untouched.
    const refused = await inOrg(orgA.id, partner.id, () =>
      allowWakeAgain({ policyId, deviceId: dB, allowedSiteIds: undefined }));
    expect(refused).toBeNull();
    const [untouched] = await sys(() =>
      db.select({ n: deviceWakeStatus.consecutiveTimeouts }).from(deviceWakeStatus).where(eq(deviceWakeStatus.deviceId, dB)));
    expect(untouched!.n).toBe(3);

    // Its own device: cleared.
    const allowed = await inOrg(orgA.id, partner.id, () =>
      allowWakeAgain({ policyId, deviceId: dA, allowedSiteIds: undefined }));
    expect(allowed).not.toBeNull();
    const [cleared] = await sys(() =>
      db.select({ n: deviceWakeStatus.consecutiveTimeouts }).from(deviceWakeStatus).where(eq(deviceWakeStatus.deviceId, dA)));
    expect(cleared!.n).toBe(0);
  });

  runDb('a site-restricted caller sees only the allowed site', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site1 = await createSite({ orgId: org.id });
    const site2 = await createSite({ orgId: org.id });
    const d1 = await seedDevice(org.id, site1.id, 'wsp-s1');
    await seedDevice(org.id, site2.id, 'wsp-s2');
    const policyId = await seedPolicy({
      owner: { orgId: org.id, partnerId: null },
      assignments: [{ level: 'organization', targetId: org.id }],
    });
    await sys(async () => {
      await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policyId,
        featureType: 'wake_on_lan',
        inlineSettings: { configureSettings: false, buttonMode: 'always' },
      });
    });
    const res = await inOrg(org.id, partner.id, () =>
      listWakeStatusForPolicy({ policyId, allowedSiteIds: [site1.id], page: 1, limit: 50 }));
    expect(res.data.map((r) => r.deviceId)).toEqual([d1]);
  });
});
