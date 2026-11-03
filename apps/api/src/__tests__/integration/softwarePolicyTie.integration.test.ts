/**
 * #9635 — Inventory Approve and Deny each create an org-level config policy at
 * priority 0. A device follows ONE software policy (closest level, then lowest
 * priority, then earliest assignment), so the second default list tied with
 * the first and silently governed zero devices.
 *
 * Option B (chosen on the issue): refuse the write that would create or feed a
 * dead policy, with a stable error code naming the winner, and report honest
 * per-policy coverage ("applies to 0 devices, overridden by X").
 *
 * Real Postgres through breeze_app + an org-scoped RLS context, because the
 * whole behaviour is the real resolver's ranking (resolveSoftwarePolicyForDevice)
 * over real assignment rows — a mocked db cannot show which policy wins.
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
import { approveInventorySoftware, denyInventorySoftware } from '../../services/softwareInventoryPolicy';
import { getSoftwarePolicyCoverage, SOFTWARE_POLICY_WOULD_NOT_APPLY } from '../../services/softwarePolicyCoverage';

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
}): Promise<{ softwarePolicyId: string; configPolicyId: string }> {
  return withSystemDbAccessContext(async () => {
    const [sp] = await db
      .insert(softwarePolicies)
      .values({ orgId: opts.orgId, partnerId: opts.partnerId, name: opts.name, mode: opts.mode, rules: { software: [{ name: 'Seeded' }] } })
      .returning({ id: softwarePolicies.id });
    const [cp] = await db
      .insert(configurationPolicies)
      .values({ orgId: opts.orgId, partnerId: opts.partnerId, name: `${opts.name} Config`, status: 'active' })
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

describe('#9635 software policy tie — live Postgres', () => {
  it('approve then deny in the same org: deny is refused with a stable code naming the winner, and writes nothing', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);

    const approved = await withDbAccessContext(ctx, () => approveInventorySoftware(writeParams(f.orgId, 'Zoom')));
    expect(approved.status).toBe(201);

    const denied = await withDbAccessContext(ctx, () => denyInventorySoftware(writeParams(f.orgId, 'TeamViewer')));
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe(SOFTWARE_POLICY_WOULD_NOT_APPLY);
    expect(denied.body.winners).toEqual([
      expect.objectContaining({ name: 'Default Allowlist', mode: 'allowlist', partnerWide: false, deviceCount: 2 }),
    ]);
    expect(denied.body.sameMode).toBe(false);
    expect(String(denied.body.error)).toContain('Default Allowlist');

    // No dead blocklist and no dead config policy were created.
    expect(await defaultPolicy(f, 'Default Blocklist')).toBeNull();
    const cfg = await withSystemDbAccessContext(() =>
      db.select({ id: configurationPolicies.id }).from(configurationPolicies)
        .where(and(eq(configurationPolicies.orgId, f.orgId), eq(configurationPolicies.name, 'Default Blocklist Config'))));
    expect(cfg).toHaveLength(0);

    // The allowlist really governs both devices.
    const coverage = await withDbAccessContext(ctx, () => getSoftwarePolicyCoverage(approved.body.policyId as string));
    expect(coverage).toMatchObject({ assignedDeviceCount: 2, appliesToDeviceCount: 2, overriddenBy: [] });
  });

  it('deny alone (no competing policy) still works and the blocklist covers the org', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);
    const denied = await withDbAccessContext(ctx, () => denyInventorySoftware(writeParams(f.orgId, 'TeamViewer')));
    expect(denied.status).toBe(201);
    expect(denied.body.overrides).toBeUndefined();
    const coverage = await withDbAccessContext(ctx, () => getSoftwarePolicyCoverage(denied.body.policyId as string));
    expect(coverage.appliesToDeviceCount).toBe(2);
  });

  it('an already-dead default list (pre-fix tie) reports 0 devices + overridden by, and further denies are refused', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);
    const winner = await seedLinkedPolicy({ orgId: f.orgId, partnerId: null, name: 'Default Allowlist', mode: 'allowlist', level: 'organization', targetId: f.orgId });
    // The pre-fix state: the blocklist and its config policy were created
    // second, at the same level and priority.
    const loser = await seedLinkedPolicy({ orgId: f.orgId, partnerId: null, name: 'Default Blocklist', mode: 'blocklist', level: 'organization', targetId: f.orgId });

    const coverage = await withDbAccessContext(ctx, () => getSoftwarePolicyCoverage(loser.softwarePolicyId));
    expect(coverage.assignedDeviceCount).toBe(2);
    expect(coverage.appliesToDeviceCount).toBe(0);
    expect(coverage.overriddenBy).toEqual([
      expect.objectContaining({ policyId: winner.softwarePolicyId, name: 'Default Allowlist', deviceCount: 2 }),
    ]);

    const denied = await withDbAccessContext(ctx, () => denyInventorySoftware(writeParams(f.orgId, 'TeamViewer')));
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe(SOFTWARE_POLICY_WOULD_NOT_APPLY);
    const rules = (await defaultPolicy(f, 'Default Blocklist'))!.rules as { software: Array<{ name: string }> };
    expect(rules.software.map((r) => r.name)).toEqual(['Seeded']);
  });

  it('an org with no devices yet: the org-level tie is still refused (it would bite once devices enroll)', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => db.update(devices).set({ isEphemeral: true }).where(inArray(devices.id, f.deviceIds)));
    const ctx = orgContext(f.orgId, f.partnerId);

    const approved = await withDbAccessContext(ctx, () => approveInventorySoftware(writeParams(f.orgId, 'Zoom')));
    expect(approved.status).toBe(201);

    const denied = await withDbAccessContext(ctx, () => denyInventorySoftware(writeParams(f.orgId, 'TeamViewer')));
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe(SOFTWARE_POLICY_WOULD_NOT_APPLY);
    expect(denied.body.deviceCount).toBe(0);
    expect(denied.body.winners).toEqual([expect.objectContaining({ name: 'Default Allowlist' })]);
    expect(await defaultPolicy(f, 'Default Blocklist')).toBeNull();

    // A second approve into the established allowlist is not refused.
    const again = await withDbAccessContext(ctx, () => approveInventorySoftware(writeParams(f.orgId, 'Slack')));
    expect(again.status).toBe(200);
  });

  it('the default config policy also assigned at a closer level still counts as ours', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);
    const approved = await withDbAccessContext(ctx, () => approveInventorySoftware(writeParams(f.orgId, 'Zoom')));
    expect(approved.status).toBe(201);
    // Hand-assign "Default Allowlist Config" at site level too, then point its
    // link somewhere foreign: the next approve repoints it back, so it is ours.
    await withSystemDbAccessContext(async () => {
      const [cfg] = await db.select({ id: configurationPolicies.id }).from(configurationPolicies)
        .where(and(eq(configurationPolicies.orgId, f.orgId), eq(configurationPolicies.name, 'Default Allowlist Config')));
      const [device] = await db.select({ siteId: devices.siteId }).from(devices).where(eq(devices.id, f.deviceIds[0]!));
      await db.insert(configPolicyAssignments).values({ configPolicyId: cfg!.id, level: 'site', targetId: device!.siteId, priority: 0 });
      const [other] = await db.insert(softwarePolicies)
        .values({ orgId: f.orgId, name: 'Stray', mode: 'blocklist', rules: { software: [] } })
        .returning({ id: softwarePolicies.id });
      await db.update(configPolicyFeatureLinks).set({ featurePolicyId: other!.id })
        .where(eq(configPolicyFeatureLinks.configPolicyId, cfg!.id));
    });

    const again = await withDbAccessContext(ctx, () => approveInventorySoftware(writeParams(f.orgId, 'Slack')));
    expect(again.status).toBe(200);
  });

  it('a same-mode winner is named so the technician can add the title there instead', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);
    await seedLinkedPolicy({ orgId: f.orgId, partnerId: null, name: 'Approved Apps', mode: 'allowlist', level: 'organization', targetId: f.orgId });

    const approved = await withDbAccessContext(ctx, () => approveInventorySoftware(writeParams(f.orgId, 'Zoom')));
    expect(approved.status).toBe(409);
    expect(approved.body.code).toBe(SOFTWARE_POLICY_WOULD_NOT_APPLY);
    expect(approved.body.sameMode).toBe(true);
    expect(approved.body.winners).toEqual([expect.objectContaining({ name: 'Approved Apps', mode: 'allowlist' })]);
    expect(await defaultPolicy(f, 'Default Allowlist')).toBeNull();
  });

  it('a lower-priority org assignment does not block: the new default outranks it, and the response says what it overrides', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);
    await seedLinkedPolicy({ orgId: f.orgId, partnerId: null, name: 'Fallback Blocklist', mode: 'blocklist', level: 'organization', targetId: f.orgId, priority: 5 });

    const approved = await withDbAccessContext(ctx, () => approveInventorySoftware(writeParams(f.orgId, 'Zoom')));
    expect(approved.status).toBe(201);
    expect(approved.body.overrides).toEqual([
      expect.objectContaining({ name: 'Fallback Blocklist', partnerWide: false, deviceCount: 2 }),
    ]);
  });

  it('partner-wide: an org default list overrides the partner-wide policy on the org (reported), and the partner-wide policy then shows 0 devices there', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgId, f.partnerId);
    const partnerWide = await seedLinkedPolicy({ orgId: null, partnerId: f.partnerId, name: 'MSP Blocklist', mode: 'blocklist', level: 'partner', targetId: f.partnerId });

    const before = await withDbAccessContext(ctx, () => getSoftwarePolicyCoverage(partnerWide.softwarePolicyId));
    expect(before.appliesToDeviceCount).toBe(2);

    const approved = await withDbAccessContext(ctx, () => approveInventorySoftware(writeParams(f.orgId, 'Zoom')));
    expect(approved.status).toBe(201);
    expect(approved.body.overrides).toEqual([
      expect.objectContaining({ policyId: partnerWide.softwarePolicyId, name: 'MSP Blocklist', partnerWide: true, deviceCount: 2 }),
    ]);

    const after = await withDbAccessContext(ctx, () => getSoftwarePolicyCoverage(partnerWide.softwarePolicyId));
    expect(after.appliesToDeviceCount).toBe(0);
    expect(after.overriddenBy).toEqual([expect.objectContaining({ name: 'Default Allowlist', deviceCount: 2 })]);

    // A second approve on an established default list is not re-reported.
    const again = await withDbAccessContext(ctx, () => approveInventorySoftware(writeParams(f.orgId, 'Slack')));
    expect(again.status).toBe(200);
    expect(again.body.overrides).toBeUndefined();
  });
});
