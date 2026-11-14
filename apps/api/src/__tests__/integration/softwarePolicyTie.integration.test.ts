/**
 * Additive software policy regression coverage against real Postgres and RLS.
 * Inventory's org allowlist/blocklist and partner configuration links must all
 * reach the same devices, independent of assignment age, level, or priority.
 */
import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
  organizations,
  partners,
  sites,
  softwarePolicies,
  softwarePolicyAudit,
} from '../../db/schema';
import { approveInventorySoftware, denyInventorySoftware, clearInventorySoftware } from '../../services/softwareInventoryPolicy';
import { getSoftwarePolicyCoverage } from '../../services/softwarePolicyCoverage';

import { resolveSoftwarePoliciesForDevice, createSystemAuthContext } from '../../services/featureConfigResolver';
import { resolveEffectiveConfig } from '../../services/configurationPolicy';

type Fixture = { partnerId: string; orgId: string; deviceIds: string[] };

const cleanup: Array<() => Promise<void>> = [];

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

async function seed(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 10);
    const [partner] = await db
      .insert(partners)
      .values({ name: `Tie ${sfx}`, slug: `tie-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const partnerId = partner!.id;
    const [org] = await db
      .insert(organizations)
      .values({ currencyCode: 'USD', partnerId, name: `TieOrg ${sfx}`, slug: `tieorg-${sfx}` })
      .returning({ id: organizations.id });
    const orgId = org!.id;
    const [site] = await db.insert(sites).values({ orgId, name: `TieSite-${sfx}` }).returning({ id: sites.id });
    const base = { osVersion: '1.0', architecture: 'x86_64', agentVersion: '1.0.0', orgId, siteId: site!.id, osType: 'windows' as const, status: 'online' as const };
    const inserted = await db
      .insert(devices)
      .values([
        { ...base, agentId: `t1-${sfx}`, hostname: 'tie1' },
        { ...base, agentId: `t2-${sfx}`, hostname: 'tie2' },
      ])
      .returning({ id: devices.id });
    const deviceIds = inserted.map((d) => d.id);

    cleanup.push(async () => {
      await withSystemDbAccessContext(async () => {
        const ownedConfig = or(eq(configurationPolicies.orgId, orgId), and(isNull(configurationPolicies.orgId), eq(configurationPolicies.partnerId, partnerId)))!;
        const cfgIds = (await db.select({ id: configurationPolicies.id }).from(configurationPolicies).where(ownedConfig)).map((r) => r.id);
        if (cfgIds.length > 0) {
          await db.delete(configPolicyAssignments).where(inArray(configPolicyAssignments.configPolicyId, cfgIds));
          await db.delete(configPolicyFeatureLinks).where(inArray(configPolicyFeatureLinks.configPolicyId, cfgIds));
          await db.delete(configurationPolicies).where(inArray(configurationPolicies.id, cfgIds));
        }
        const ownedSoftware = or(eq(softwarePolicies.orgId, orgId), and(isNull(softwarePolicies.orgId), eq(softwarePolicies.partnerId, partnerId)))!;
        const spIds = (await db.select({ id: softwarePolicies.id }).from(softwarePolicies).where(ownedSoftware)).map((r) => r.id);
        if (spIds.length > 0) {
          await db.delete(softwarePolicyAudit).where(inArray(softwarePolicyAudit.policyId, spIds));
          await db.delete(softwarePolicies).where(inArray(softwarePolicies.id, spIds));
        }
        await db.delete(devices).where(inArray(devices.id, deviceIds));
        await db.delete(sites).where(eq(sites.id, site!.id));
        await db.delete(organizations).where(eq(organizations.id, orgId));
        await db.delete(partners).where(eq(partners.id, partnerId));
      });
    });

    return { partnerId, orgId, deviceIds };
  });
}

/** A software policy wired to its own config policy, assigned at `level`. */
async function seedLinkedPolicy(opts: {
  orgId: string | null;
  partnerId: string | null;
  name: string;
  mode: 'allowlist' | 'blocklist';
  level: 'organization' | 'partner';
  targetId: string;
  priority?: number;
  parentPolicyId?: string;
}): Promise<{ softwarePolicyId: string; configPolicyId: string }> {
  return withSystemDbAccessContext(async () => {
    const [sp] = await db
      .insert(softwarePolicies)
      .values({ orgId: opts.orgId, partnerId: opts.partnerId, name: opts.name, mode: opts.mode, rules: { software: [{ name: 'Seeded' }] } })
      .returning({ id: softwarePolicies.id });
    const [cp] = await db
      .insert(configurationPolicies)
      .values({ orgId: opts.orgId, partnerId: opts.partnerId, name: `${opts.name} Config`, status: 'active', parentPolicyId: opts.parentPolicyId })
      .returning({ id: configurationPolicies.id });
    await db.insert(configPolicyFeatureLinks).values({ configPolicyId: cp!.id, featureType: 'software_policy', featurePolicyId: sp!.id });
    await db.insert(configPolicyAssignments).values({ configPolicyId: cp!.id, level: opts.level, targetId: opts.targetId, priority: opts.priority ?? 0 });
    return { softwarePolicyId: sp!.id, configPolicyId: cp!.id };
  });
}

function writeParams(orgId: string, softwareName: string) {
  return { auth: { scope: 'organization', orgId } as any, orgId, softwareName, actorUserId: null, audit: vi.fn() };
}

async function defaultPolicy(f: Fixture, name: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ id: softwarePolicies.id, rules: softwarePolicies.rules })
      .from(softwarePolicies)
      .where(and(eq(softwarePolicies.orgId, f.orgId), eq(softwarePolicies.name, name)));
    return row ?? null;
  });
}

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

describe('additive software policies — live Postgres', () => {
  async function expectCoverage(ctx: DbAccessContext, policyId: string, count = 2) {
    const coverage = await withDbAccessContext(ctx, () => getSoftwarePolicyCoverage(policyId));
    expect(coverage).toEqual({ assignedDeviceCount: count, appliesToDeviceCount: count, overriddenBy: [] });
  }

  it.each(['approve-first', 'deny-first'] as const)('%s: both org defaults apply and inventory Clear preserves policy coverage', async (order) => {
    const f = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);
    const approve = () => withDbAccessContext(ctx, () => approveInventorySoftware(writeParams(f.orgId, 'Zoom')));
    const deny = () => withDbAccessContext(ctx, () => denyInventorySoftware(writeParams(f.orgId, 'TeamViewer')));
    const [approved, denied] = order === 'approve-first' ? [await approve(), await deny()] : await (async () => {
      const denied = await deny();
      return [await approve(), denied];
    })();
    expect(approved.status).toBe(201);
    expect(denied.status).toBe(201);
    expect(approved.body.overrides).toBeUndefined();
    expect(denied.body.overrides).toBeUndefined();
    const ids = [approved.body.policyId as string, denied.body.policyId as string];
    for (const id of ids) await expectCoverage(ctx, id);
    for (const deviceId of f.deviceIds) {
      const resolved = await withDbAccessContext(ctx, () => resolveSoftwarePoliciesForDevice(deviceId));
      expect(new Set(resolved)).toEqual(new Set(ids));
    }
    const cleared = await withDbAccessContext(ctx, () => clearInventorySoftware(writeParams(f.orgId, 'TeamViewer')));
    expect(cleared.status).toBe(200);
    const rules = (await defaultPolicy(f, 'Default Blocklist'))!.rules as { software: Array<{ name: string }> };
    expect(rules.software.some((r) => r.name === 'TeamViewer')).toBe(false);
    for (const id of ids) await expectCoverage(ctx, id);
  });

  it('existing same-level allowlist and blocklist links both apply without any migration of their assignments', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);
    const allow = await seedLinkedPolicy({ orgId: f.orgId, partnerId: null, name: 'Default Allowlist', mode: 'allowlist', level: 'organization', targetId: f.orgId });
    const block = await seedLinkedPolicy({ orgId: f.orgId, partnerId: null, name: 'Default Blocklist', mode: 'blocklist', level: 'organization', targetId: f.orgId });
    for (const id of [allow.softwarePolicyId, block.softwarePolicyId]) await expectCoverage(ctx, id);
    const denied = await withDbAccessContext(ctx, () => denyInventorySoftware(writeParams(f.orgId, 'TeamViewer')));
    expect(denied.status).toBe(200);
    const rules = (await defaultPolicy(f, 'Default Blocklist'))!.rules as { software: Array<{ name: string }> };
    expect(rules.software.map((r) => r.name)).toEqual(['Seeded', 'TeamViewer']);
  });

  it('an org with no managed devices can prepare both default lists for future enrollment', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => db.update(devices).set({ isEphemeral: true }).where(inArray(devices.id, f.deviceIds)));
    const ctx = orgContext(f.orgId, f.partnerId);
    const approved = await withDbAccessContext(ctx, () => approveInventorySoftware(writeParams(f.orgId, 'Zoom')));
    const denied = await withDbAccessContext(ctx, () => denyInventorySoftware(writeParams(f.orgId, 'TeamViewer')));
    expect(approved.status).toBe(201);
    expect(denied.status).toBe(201);
    for (const id of [approved.body.policyId, denied.body.policyId]) await expectCoverage(ctx, id as string, 0);
    await withSystemDbAccessContext(() => db.update(devices).set({ isEphemeral: false }).where(inArray(devices.id, f.deviceIds)));
    for (const id of [approved.body.policyId, denied.body.policyId]) await expectCoverage(ctx, id as string);
  });

  it('same-mode and lower-priority existing policies remain applying when Inventory adds a default list', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);
    const existing = await seedLinkedPolicy({ orgId: f.orgId, partnerId: null, name: 'Approved Apps', mode: 'allowlist', level: 'organization', targetId: f.orgId, priority: 5 });
    const approved = await withDbAccessContext(ctx, () => approveInventorySoftware(writeParams(f.orgId, 'Zoom')));
    expect(approved.status).toBe(201);
    expect(approved.body.overrides).toBeUndefined();
    for (const id of [existing.softwarePolicyId, approved.body.policyId as string]) await expectCoverage(ctx, id);
  });

  it('partner-wide required apps and Inventory Deny both reach the org and Effective Configuration names both', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);
    const partnerWide = await seedLinkedPolicy({ orgId: null, partnerId: f.partnerId, name: 'Install Standard Software', mode: 'allowlist', level: 'partner', targetId: f.partnerId });
    const denied = await withDbAccessContext(ctx, () => denyInventorySoftware(writeParams(f.orgId, 'TeamViewer')));
    expect(denied.status).toBe(201);
    expect(denied.body.overrides).toBeUndefined();
    for (const id of [partnerWide.softwarePolicyId, denied.body.policyId as string]) await expectCoverage(ctx, id);
    const effective = await withDbAccessContext(ctx, () => resolveEffectiveConfig(f.deviceIds[0]!, createSystemAuthContext()));
    expect(effective?.softwarePolicies.map((policy) => policy.featurePolicyName).sort()).toEqual(['Default Blocklist', 'Install Standard Software']);
  });

  it('multiple links on one child policy include its inherited allowlist and its own blocklist', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);
    const parent = await seedLinkedPolicy({ orgId: f.orgId, partnerId: null, name: 'Inherited Required Apps', mode: 'allowlist', level: 'organization', targetId: f.orgId });
    const block = await seedLinkedPolicy({ orgId: f.orgId, partnerId: null, name: 'Local Blocklist', mode: 'blocklist', level: 'organization', targetId: f.orgId, parentPolicyId: parent.configPolicyId });
    await withSystemDbAccessContext(async () => {
      await db.delete(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, parent.configPolicyId));
    });
    const inherited = await withDbAccessContext(ctx, () => resolveSoftwarePoliciesForDevice(f.deviceIds[0]!));
    expect(new Set(inherited)).toEqual(new Set([parent.softwarePolicyId, block.softwarePolicyId]));
    // A second authored software link is allowed too, even when the same
    // policy is also inherited. Resolution must deduplicate the software ID.
    await withSystemDbAccessContext(() => db.insert(configPolicyFeatureLinks).values({ configPolicyId: block.configPolicyId, featureType: 'software_policy', featurePolicyId: parent.softwarePolicyId }));
    const resolved = await withDbAccessContext(ctx, () => resolveSoftwarePoliciesForDevice(f.deviceIds[0]!));
    expect(new Set(resolved)).toEqual(new Set([parent.softwarePolicyId, block.softwarePolicyId]));
    expect(resolved).toHaveLength(2);
    for (const id of resolved) await expectCoverage(ctx, id);
  });

  it('explicit targetIds combine with linked policies while another partner remains invisible', async () => {
    const f = await seed();
    const other = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);
    const partnerWide = await seedLinkedPolicy({ orgId: null, partnerId: f.partnerId, name: 'Required Apps', mode: 'allowlist', level: 'partner', targetId: f.partnerId });
    const foreign = await seedLinkedPolicy({ orgId: null, partnerId: other.partnerId, name: 'Foreign Partner Policy', mode: 'blocklist', level: 'partner', targetId: other.partnerId });
    const directId = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(softwarePolicies).values({ orgId: f.orgId, name: 'Explicit Blocklist', mode: 'blocklist', rules: { software: [{ name: 'TeamViewer' }] }, targetType: 'organization', targetIds: [f.orgId] }).returning({ id: softwarePolicies.id });
      return row!.id;
    });
    const resolved = await withDbAccessContext(ctx, () => resolveSoftwarePoliciesForDevice(f.deviceIds[0]!));
    expect(new Set(resolved)).toEqual(new Set([partnerWide.softwarePolicyId, directId]));
    await expectCoverage(ctx, directId);
    await expectCoverage(ctx, foreign.softwarePolicyId, 0);
    const foreignDevice = await withDbAccessContext(ctx, () => resolveSoftwarePoliciesForDevice(other.deviceIds[0]!));
    expect(foreignDevice).toEqual([]);
  });
});
