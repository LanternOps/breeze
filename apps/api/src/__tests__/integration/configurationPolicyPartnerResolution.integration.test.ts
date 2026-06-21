/**
 * Partner-wide configuration policy RESOLUTION (#1724).
 *
 * The RLS forge test (configurationPoliciesPartnerRls) proves VISIBILITY. This
 * test proves the core acceptance criterion: a partner-OWNED policy (org_id
 * NULL, partner_id set) actually resolves as the effective config for devices
 * across MULTIPLE organizations of the same partner — plus filter gating
 * (role/os) and closest-wins override precedence.
 *
 * Resolution runs under a system-scope AuthContext so the device-access gate is
 * a no-op and we exercise the policy-ownership + assignment-matching logic
 * directly (the same query the agent-facing path runs).
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  devices,
} from '../../db/schema';
import { resolveEffectiveConfig } from '../../services/configurationPolicy';
import type { AuthContext } from '../../middleware/auth';
import { createPartner, createOrganization, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdPolicies: string[] = [];

afterEach(async () => {
  if (createdPolicies.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdPolicies) {
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    }
  });
  createdPolicies.length = 0;
});

// System-scope AuthContext: orgCondition returns undefined so the resolver's
// device-access filter is a no-op (we're testing ownership/assignment matching).
function systemAuth(): AuthContext {
  return {
    user: { id: randomUUID(), email: 'sys@example.com', name: 'Sys', isPlatformAdmin: false },
    token: {} as never,
    partnerId: null,
    orgId: null,
    scope: 'system',
    accessibleOrgIds: null,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as unknown as AuthContext;
}

async function seedDevice(orgId: string, siteId: string, osType: 'windows' | 'macos' | 'linux', deviceRole: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [d] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType,
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        deviceRole,
      })
      .returning();
    return d!;
  });
}

async function seedPartnerPolicyWithFeature(partnerId: string): Promise<{ policyId: string; featureLinkId: string }> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId, name: 'Partner-wide security', status: 'active' })
      .returning();
    createdPolicies.push(policy!.id);
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'security', inlineSettings: { tag: 'partner-wide' } })
      .returning();
    return { policyId: policy!.id, featureLinkId: link!.id };
  });
}

async function assign(
  policyId: string,
  level: 'partner' | 'organization' | 'device',
  targetId: string,
  opts: { roleFilter?: string[]; osFilter?: string[] } = {},
) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policyId,
      level,
      targetId,
      priority: 0,
      roleFilter: opts.roleFilter ?? null,
      osFilter: opts.osFilter ?? null,
    });
  });
}

describe('partner-wide configuration policy resolution (#1724)', () => {
  it('resolves a partner-owned policy for devices in DIFFERENT orgs of the same partner', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA!.id });
    const siteB = await createSite({ orgId: orgB!.id });
    const deviceA = await seedDevice(orgA!.id, siteA!.id, 'windows', 'server');
    const deviceB = await seedDevice(orgB!.id, siteB!.id, 'linux', 'workstation');

    const { policyId } = await seedPartnerPolicyWithFeature(partner.id);
    await assign(policyId, 'partner', partner.id);

    const resolvedA = await withSystemDbAccessContext(() => resolveEffectiveConfig(deviceA.id, systemAuth()));
    const resolvedB = await withSystemDbAccessContext(() => resolveEffectiveConfig(deviceB.id, systemAuth()));

    // Both devices, in two distinct orgs, resolve the SAME partner-owned policy.
    expect(resolvedA?.features.security?.sourcePolicyId).toBe(policyId);
    expect(resolvedB?.features.security?.sourcePolicyId).toBe(policyId);
    expect(resolvedA?.features.security?.sourceLevel).toBe('partner');
  });

  it('applies the role/os filter as a gate during resolution', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const serverDevice = await seedDevice(org!.id, site!.id, 'windows', 'server');
    const workstationDevice = await seedDevice(org!.id, site!.id, 'windows', 'workstation');

    const { policyId } = await seedPartnerPolicyWithFeature(partner.id);
    // Partner-wide, but only for server-role devices.
    await assign(policyId, 'partner', partner.id, { roleFilter: ['server'] });

    const onServer = await withSystemDbAccessContext(() => resolveEffectiveConfig(serverDevice.id, systemAuth()));
    const onWorkstation = await withSystemDbAccessContext(() => resolveEffectiveConfig(workstationDevice.id, systemAuth()));

    expect(onServer?.features.security?.sourcePolicyId).toBe(policyId);
    // The workstation is gated out by the role filter — no security feature.
    expect(onWorkstation?.features.security).toBeUndefined();
  });

  it('lets an org-level assignment override a partner-wide one (closest wins)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const device = await seedDevice(org!.id, site!.id, 'windows', 'server');

    // Partner-wide policy assigned partner-wide.
    const partnerWide = await seedPartnerPolicyWithFeature(partner.id);
    await assign(partnerWide.policyId, 'partner', partner.id);

    // Org-owned policy with the same feature, assigned at org level.
    const orgPolicyId = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [p] = await db
        .insert(configurationPolicies)
        .values({ orgId: org!.id, partnerId: null, name: 'Org override', status: 'active' })
        .returning();
      createdPolicies.push(p!.id);
      await db
        .insert(configPolicyFeatureLinks)
        .values({ configPolicyId: p!.id, featureType: 'security', inlineSettings: { tag: 'org-override' } });
      return p!.id;
    });
    await assign(orgPolicyId, 'organization', org!.id);

    const resolved = await withSystemDbAccessContext(() => resolveEffectiveConfig(device.id, systemAuth()));

    // Org level (priority 2) beats partner level (priority 1): the org policy wins.
    expect(resolved?.features.security?.sourcePolicyId).toBe(orgPolicyId);
    expect(resolved?.features.security?.sourceLevel).toBe('organization');
  });
});
