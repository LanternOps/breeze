/**
 * #6960 W01 — `security_agents` resolution and `managed_by_link_id` lifecycle
 * against real Postgres.
 *
 * Only a live database exercises the pieces this depends on: the
 * `config_policy_effective_feature_links` view (an inherited row keeps the
 * PARENT link id), the hierarchy walk's closest-wins ordering, and the
 * `managed_by_link_id ... ON DELETE CASCADE` / `software_deployments
 * .software_policy_id ... ON DELETE SET NULL` pair.
 *
 * Fixture: one partner, one org, sites S1 and S2.
 *   S1: d1, d2. S2: d3.
 *   CP_SA  — security_agents link L1, assigned to site S1. Managed policy MSP
 *            hangs off L1.
 *   CP_OPT — security_agents link L2 with agents: [], assigned to device d2
 *            (closer than the site): d2 opts out.
 *   CP_CHILD — child of CP_SA with no own security_agents link (inherits L1),
 *            assigned to device d3, which no other security_agents link reaches.
 *   CP_SW  — customer software_policy link to CSP, assigned to the org.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
  organizations,
  partners,
  sites,
  softwareCatalog,
  softwareDeployments,
  softwareInstallMethods,
  softwarePolicies,
} from '../../db/schema';
import {
  resolveDeviceIdsForSoftwarePolicy,
  resolveSecurityAgentsLinkForDevice,
  resolveSecurityAgentsLinksForDevices,
} from '../../services/featureConfigResolver';
import { resolveEffectiveConfig } from '../../services/configurationPolicy';
import type { AuthContext } from '../../middleware/auth';

function orgAuth(orgId: string, partnerId: string): AuthContext {
  return {
    scope: 'organization',
    orgId,
    partnerId,
    accessibleOrgIds: [orgId],
    user: { id: null },
    orgCondition: (col?: unknown) => eq(col as typeof devices.orgId, orgId),
    canAccessOrg: (o: string) => o === orgId,
  } as unknown as AuthContext;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

const HUNTRESS_DISABLED = { version: 1, agents: [{ vendor: 'huntress', enabled: false }] };

async function seedBase(sfx: string) {
  const [partner] = await db
    .insert(partners)
    .values({ name: `SA ${sfx}`, slug: `sa-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  const [org] = await db
    .insert(organizations)
    .values({ currencyCode: 'USD', partnerId: partner!.id, name: `SA Org ${sfx}`, slug: `sa-org-${sfx}` })
    .returning({ id: organizations.id });
  const [s1, s2] = await db
    .insert(sites)
    .values([{ orgId: org!.id, name: `S1-${sfx}` }, { orgId: org!.id, name: `S2-${sfx}` }])
    .returning({ id: sites.id });
  return { partnerId: partner!.id, orgId: org!.id, s1Id: s1!.id, s2Id: s2!.id };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 10);
    const { partnerId, orgId, s1Id, s2Id } = await seedBase(sfx);

    const deviceBase = { orgId, osVersion: '1.0', architecture: 'x86_64', agentVersion: '1.0.0', osType: 'windows' as const, status: 'online' as const };
    const inserted = await db
      .insert(devices)
      .values([
        { ...deviceBase, siteId: s1Id, agentId: `sa-d1-${sfx}`, hostname: 'd1' },
        { ...deviceBase, siteId: s1Id, agentId: `sa-d2-${sfx}`, hostname: 'd2' },
        { ...deviceBase, siteId: s2Id, agentId: `sa-d3-${sfx}`, hostname: 'd3' },
      ])
      .returning({ id: devices.id, hostname: devices.hostname });
    const d = Object.fromEntries(inserted.map((r) => [r.hostname!, r.id])) as Record<'d1' | 'd2' | 'd3', string>;

    const [cpSa, cpOpt, cpSw] = await db
      .insert(configurationPolicies)
      .values([
        { orgId, name: `CP_SA ${sfx}`, status: 'active' as const },
        { orgId, name: `CP_OPT ${sfx}`, status: 'active' as const },
        { orgId, name: `CP_SW ${sfx}`, status: 'active' as const },
      ])
      .returning({ id: configurationPolicies.id });
    const [cpChild] = await db
      .insert(configurationPolicies)
      .values({ orgId, name: `CP_CHILD ${sfx}`, status: 'active' as const, parentPolicyId: cpSa!.id })
      .returning({ id: configurationPolicies.id });

    const [csp] = await db
      .insert(softwarePolicies)
      .values({ orgId, name: `CSP ${sfx}`, mode: 'allowlist' as const, rules: { software: [] } })
      .returning({ id: softwarePolicies.id });

    const [l1, l2] = await db
      .insert(configPolicyFeatureLinks)
      .values([
        { configPolicyId: cpSa!.id, featureType: 'security_agents' as const, inlineSettings: HUNTRESS_DISABLED },
        { configPolicyId: cpOpt!.id, featureType: 'security_agents' as const, inlineSettings: { version: 1, agents: [] } },
        { configPolicyId: cpSw!.id, featureType: 'software_policy' as const, featurePolicyId: csp!.id },
      ])
      .returning({ id: configPolicyFeatureLinks.id });

    const [msp] = await db
      .insert(softwarePolicies)
      .values({ orgId, name: `MSP ${sfx}`, mode: 'allowlist' as const, rules: { software: [], allowUnknown: true }, managedByLinkId: l1!.id })
      .returning({ id: softwarePolicies.id });

    await db.insert(configPolicyAssignments).values([
      { configPolicyId: cpSa!.id, level: 'site' as const, targetId: s1Id },
      { configPolicyId: cpOpt!.id, level: 'device' as const, targetId: d.d2 },
      { configPolicyId: cpChild!.id, level: 'device' as const, targetId: d.d3 },
      { configPolicyId: cpSw!.id, level: 'organization' as const, targetId: orgId },
    ]);

    const cpIds = [cpChild!.id, cpSa!.id, cpOpt!.id, cpSw!.id];
    cleanup.push(async () => {
      await withSystemDbAccessContext(async () => {
        await db.delete(configPolicyAssignments).where(inArray(configPolicyAssignments.configPolicyId, cpIds));
        await db.delete(configPolicyFeatureLinks).where(inArray(configPolicyFeatureLinks.configPolicyId, cpIds));
        await db.delete(softwarePolicies).where(inArray(softwarePolicies.id, [msp!.id, csp!.id]));
        for (const id of cpIds) await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
        await db.delete(devices).where(inArray(devices.id, Object.values(d)));
        await db.delete(sites).where(inArray(sites.id, [s1Id, s2Id]));
        await db.delete(organizations).where(eq(organizations.id, orgId));
        await db.delete(partners).where(eq(partners.id, partnerId));
      });
    });

    return { d, orgId, partnerId, cpSaId: cpSa!.id, l1Id: l1!.id, l2Id: l2!.id, mspId: msp!.id, cspId: csp!.id };
  });
}

describe('security_agents resolution — live Postgres (#6960)', () => {
  it('resolveSecurityAgentsLinkForDevice: closest wins, inherited links keep the parent link id', async () => {
    const f = await seed();
    await withSystemDbAccessContext(async () => {
      const r1 = await resolveSecurityAgentsLinkForDevice(f.d.d1);
      expect(r1).toMatchObject({ linkId: f.l1Id, configPolicyId: f.cpSaId });
      expect(r1!.inlineSettings).toEqual(HUNTRESS_DISABLED);

      const r2 = await resolveSecurityAgentsLinkForDevice(f.d.d2);
      expect(r2).toMatchObject({ linkId: f.l2Id });
      expect(r2!.inlineSettings.agents).toEqual([]);

      // d3 is reached only through CP_CHILD, which inherits L1 from CP_SA.
      const r3 = await resolveSecurityAgentsLinkForDevice(f.d.d3);
      expect(r3).toMatchObject({ linkId: f.l1Id, configPolicyId: f.cpSaId });
    });
  });

  it('the batched resolver (W02) picks the same winner as the per-device walk: site, closer device opt-out, inherited child', async () => {
    const f = await seed();
    await withSystemDbAccessContext(async () => {
      const batched = await resolveSecurityAgentsLinksForDevices([f.d.d1, f.d.d2, f.d.d3]);
      expect(Object.fromEntries(batched)).toEqual({ [f.d.d1]: f.l1Id, [f.d.d2]: f.l2Id, [f.d.d3]: f.l1Id });
      for (const deviceId of [f.d.d1, f.d.d2, f.d.d3]) {
        expect(batched.get(deviceId)).toBe((await resolveSecurityAgentsLinkForDevice(deviceId))?.linkId ?? null);
      }
    });
  });

  it('(a,c,d) the managed policy covers its link\'s effective assignments, minus devices a closer link wins', async () => {
    const f = await seed();
    const ids = await withSystemDbAccessContext(() => resolveDeviceIdsForSoftwarePolicy(f.mspId));
    // d1: site assignment of L1 (and also has the customer software_policy link).
    // d2: excluded — the closer opt-out link L2 wins within security_agents.
    // d3: reached through CP_CHILD's inherited L1.
    expect([...ids].sort()).toEqual([f.d.d1, f.d.d3].sort());
  });

  it('effective config surfaces the winning link id and its generated software policy id', async () => {
    const f = await seed();
    const auth = orgAuth(f.orgId, f.partnerId);
    const forD1 = await withSystemDbAccessContext(() => resolveEffectiveConfig(f.d.d1, auth));
    expect(forD1!.features.security_agents).toMatchObject({
      featureLinkId: f.l1Id,
      managedSoftwarePolicyId: f.mspId,
      inlineSettings: HUNTRESS_DISABLED,
    });
    // d2's opt-out link has no generated policy.
    const forD2 = await withSystemDbAccessContext(() => resolveEffectiveConfig(f.d.d2, auth));
    expect(forD2!.features.security_agents).toMatchObject({ featureLinkId: f.l2Id, managedSoftwarePolicyId: null });
    // Other features carry neither field.
    expect(forD1!.features.software_policy).not.toHaveProperty('managedSoftwarePolicyId');
  });

  it('the database refuses a security_agents link that carries a featurePolicyId', async () => {
    const f = await seed();
    await expect(
      withSystemDbAccessContext(() =>
        db.update(configPolicyFeatureLinks)
          .set({ featurePolicyId: f.cspId })
          .where(eq(configPolicyFeatureLinks.id, f.l1Id)),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });
  });

  it('(b,e) the customer software policy is not shadowed and resolves exactly as before', async () => {
    const f = await seed();
    const ids = await withSystemDbAccessContext(() => resolveDeviceIdsForSoftwarePolicy(f.cspId));
    expect([...ids].sort()).toEqual([f.d.d1, f.d.d2, f.d.d3].sort());
  });
});

describe('managed_by_link_id lifecycle — live Postgres (#6960)', () => {
  it('deleting only the security_agents link removes the generated policy, not the config policy', async () => {
    const f = await seed();
    await withSystemDbAccessContext(async () => {
      await db.delete(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, f.l1Id));
      expect(await db.select({ id: softwarePolicies.id }).from(softwarePolicies).where(eq(softwarePolicies.id, f.mspId))).toEqual([]);
      expect(await db.select({ id: configurationPolicies.id }).from(configurationPolicies).where(eq(configurationPolicies.id, f.cpSaId)))
        .toEqual([{ id: f.cpSaId }]);
      // The customer policy is untouched.
      expect(await db.select({ id: softwarePolicies.id }).from(softwarePolicies).where(eq(softwarePolicies.id, f.cspId)))
        .toEqual([{ id: f.cspId }]);
    });
  });

  it('deleting the owning config policy removes the generated policy and detaches its deployments', async () => {
    const { mspId, deploymentId, cpId, cleanupIds } = await withSystemDbAccessContext(async () => {
      const sfx = Math.random().toString(36).slice(2, 10);
      const { partnerId, orgId, s1Id, s2Id } = await seedBase(sfx);
      const [cp] = await db
        .insert(configurationPolicies)
        .values({ orgId, name: `CP_DEL ${sfx}`, status: 'active' as const })
        .returning({ id: configurationPolicies.id });
      const [link] = await db
        .insert(configPolicyFeatureLinks)
        .values({ configPolicyId: cp!.id, featureType: 'security_agents' as const, inlineSettings: HUNTRESS_DISABLED })
        .returning({ id: configPolicyFeatureLinks.id });
      const [policy] = await db
        .insert(softwarePolicies)
        .values({ orgId, name: `MSP_DEL ${sfx}`, mode: 'allowlist' as const, rules: { software: [] }, managedByLinkId: link!.id })
        .returning({ id: softwarePolicies.id });
      const [catalog] = await db
        .insert(softwareCatalog)
        .values({ orgId, name: `Agent ${sfx}`, vendor: 'Vendor' })
        .returning({ id: softwareCatalog.id });
      const [method] = await db
        .insert(softwareInstallMethods)
        .values({ catalogId: catalog!.id, platform: 'windows', kind: 'winget', packageId: 'Vendor.Agent', enabled: true })
        .returning({ id: softwareInstallMethods.id });
      const [deployment] = await db
        .insert(softwareDeployments)
        .values({
          orgId,
          name: `Policy install ${sfx}`,
          installMethodId: method!.id,
          deploymentType: 'install',
          targetType: 'devices',
          scheduleType: 'immediate',
          softwarePolicyId: policy!.id,
        })
        .returning({ id: softwareDeployments.id });
      return {
        mspId: policy!.id,
        deploymentId: deployment!.id,
        cpId: cp!.id,
        cleanupIds: { partnerId, orgId, siteIds: [s1Id, s2Id], catalogId: catalog!.id, methodId: method!.id },
      };
    });
    cleanup.push(async () => {
      await withSystemDbAccessContext(async () => {
        await db.delete(softwareDeployments).where(eq(softwareDeployments.id, deploymentId));
        await db.delete(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.configPolicyId, cpId));
        await db.delete(softwarePolicies).where(eq(softwarePolicies.id, mspId));
        await db.delete(configurationPolicies).where(eq(configurationPolicies.id, cpId));
        await db.delete(softwareInstallMethods).where(eq(softwareInstallMethods.id, cleanupIds.methodId));
        await db.delete(softwareCatalog).where(eq(softwareCatalog.id, cleanupIds.catalogId));
        await db.delete(sites).where(inArray(sites.id, cleanupIds.siteIds));
        await db.delete(organizations).where(eq(organizations.id, cleanupIds.orgId));
        await db.delete(partners).where(eq(partners.id, cleanupIds.partnerId));
      });
    });

    await withSystemDbAccessContext(async () => {
      // No FK failure: config policy -> links (cascade) -> generated policy (cascade)
      // -> deployment.software_policy_id (set null).
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, cpId));

      const remainingPolicy = await db.select({ id: softwarePolicies.id }).from(softwarePolicies).where(eq(softwarePolicies.id, mspId));
      expect(remainingPolicy).toEqual([]);
      const [dep] = await db
        .select({ id: softwareDeployments.id, softwarePolicyId: softwareDeployments.softwarePolicyId })
        .from(softwareDeployments)
        .where(eq(softwareDeployments.id, deploymentId));
      expect(dep).toEqual({ id: deploymentId, softwarePolicyId: null });
    });
  });
});
