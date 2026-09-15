/**
 * #5505 W06 — the install-preview eligible-device COUNT against real Postgres,
 * through the breeze_app role and an org-scoped RLS context.
 *
 * Why this suite exists on top of the mocked unit tests
 * (services/softwarePolicyInstallPreview.test.ts): every SQL construct this
 * feature depends on is invisible to a mocked `db`. The unit tests prove the
 * COST BOUND (how many queries run, and with what grouping); they cannot prove
 * the queries are VALID or that they count the right rows. Specifically, only a
 * live database exercises:
 *   - `count(distinct ...)::int` returning a real aggregate rather than a
 *     capped `.length` (the bug at GET /violations this design replaces),
 *   - the `jsonb_array_elements` + `jsonb_typeof(...) = 'array'` guard over
 *     `software_compliance_status.violations`,
 *   - `= ANY(ARRAY[...]::text[])` actually binding as a Postgres array rather
 *     than the comma-tuple drizzle produces from a bare JS array (42809),
 *   - `resolveDeviceIdsForSoftwarePolicy`'s real config-policy traversal, and
 *   - `resolvePolicyInstallTarget`'s real cross-tenant catalog reachability
 *     guard, which is the multi-tenant boundary of this endpoint's count.
 *
 * Fixture: one partner, two sibling orgs A and B.
 *   org A: winA1, winA2 (windows), linA3 (linux) — all three carry a `missing`
 *          violation for catalog item C (org A-owned, windows install method).
 *          Expected count: 2 — linA3's (orgA, linux) group resolves no install
 *          target, so it never reaches a count query.
 *   org B: winB1 (windows), same `missing` violation shape, pointing at org A's
 *          catalog item C under org B's own policy. Expected count: 0 — the
 *          catalog item is not reachable from another tenant.
 */
import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
  organizations,
  partners,
  sites,
  softwareCatalog,
  softwareComplianceStatus,
  softwareInstallMethods,
  softwarePolicies,
  type SoftwarePolicyViolation,
} from '../../db/schema';
import { computeInstallPreviewEligibleDeviceCount } from '../../services/softwarePolicyInstallPreview';

type Fixture = {
  partnerId: string;
  orgAId: string;
  orgBId: string;
  siteAId: string;
  catalogId: string;
  policyAId: string;
  policyBId: string;
  winA1: string;
  winA2: string;
  linA3: string;
  winA4: string;
  winB1: string;
  /** Org A-owned, but with no install method and no version — never resolvable. */
  noTargetCatalogId: string;
};

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

const MISSING_VIOLATION = (catalogId: string): SoftwarePolicyViolation[] => [
  {
    type: 'missing',
    severity: 'high',
    detectedAt: new Date().toISOString(),
    rule: { name: 'Zoom', catalogId },
  },
];

async function seed(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 10);

    const [partner] = await db
      .insert(partners)
      .values({ name: `IP ${sfx}`, slug: `ip-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const partnerId = partner!.id;

    const [orgA, orgB] = await db
      .insert(organizations)
      .values([
        { currencyCode: 'USD', partnerId, name: `OrgA ${sfx}`, slug: `orga-${sfx}` },
        { currencyCode: 'USD', partnerId, name: `OrgB ${sfx}`, slug: `orgb-${sfx}` },
      ])
      .returning({ id: organizations.id });
    const orgAId = orgA!.id;
    const orgBId = orgB!.id;

    const [siteA, siteB] = await db
      .insert(sites)
      .values([
        { orgId: orgAId, name: `SiteA-${sfx}` },
        { orgId: orgBId, name: `SiteB-${sfx}` },
      ])
      .returning({ id: sites.id });

    const deviceBase = { osVersion: '1.0', architecture: 'x86_64', agentVersion: '1.0.0' };
    const insertedDevices = await db
      .insert(devices)
      .values([
        { ...deviceBase, orgId: orgAId, siteId: siteA!.id, osType: 'windows' as const, agentId: `wa1-${sfx}`, hostname: 'winA1', status: 'online' },
        { ...deviceBase, orgId: orgAId, siteId: siteA!.id, osType: 'windows' as const, agentId: `wa2-${sfx}`, hostname: 'winA2', status: 'online' },
        { ...deviceBase, orgId: orgAId, siteId: siteA!.id, osType: 'linux' as const, agentId: `la3-${sfx}`, hostname: 'linA3', status: 'online' },
        { ...deviceBase, orgId: orgAId, siteId: siteA!.id, osType: 'windows' as const, agentId: `wa4-${sfx}`, hostname: 'winA4', status: 'online' },
        { ...deviceBase, orgId: orgBId, siteId: siteB!.id, osType: 'windows' as const, agentId: `wb1-${sfx}`, hostname: 'winB1', status: 'online' },
      ])
      .returning({ id: devices.id, hostname: devices.hostname });
    const byHost = Object.fromEntries(insertedDevices.map((d) => [d.hostname!, d.id]));

    // Catalog item C is ORG A's. Org B must never be able to install it — that
    // is the cross-tenant boundary this count inherits from
    // resolvePolicyInstallTarget's readReachableCatalogItem.
    const [catalog] = await db
      .insert(softwareCatalog)
      .values({ orgId: orgAId, name: `Zoom ${sfx}`, vendor: 'Zoom' })
      .returning({ id: softwareCatalog.id });
    const catalogId = catalog!.id;

    await db.insert(softwareInstallMethods).values({
      catalogId,
      platform: 'windows',
      kind: 'winget',
      packageId: 'Zoom.Zoom',
      enabled: true,
    });

    // Same org, same tenant — but no install method and no software_versions
    // row, so resolvePolicyInstallTarget returns no_install_target_for_platform
    // for it on every platform. Used to prove the per-group eligible-catalogId
    // filter actually narrows the counting query.
    const [noTargetCatalog] = await db
      .insert(softwareCatalog)
      .values({ orgId: orgAId, name: `Slack ${sfx}`, vendor: 'Slack' })
      .returning({ id: softwareCatalog.id });
    const noTargetCatalogId = noTargetCatalog!.id;

    const rules = { software: [{ name: 'Zoom', catalogId }] };
    const [policyA, policyB] = await db
      .insert(softwarePolicies)
      .values([
        { orgId: orgAId, name: `Allowlist A ${sfx}`, mode: 'allowlist' as const, rules },
        { orgId: orgBId, name: `Allowlist B ${sfx}`, mode: 'allowlist' as const, rules },
      ])
      .returning({ id: softwarePolicies.id });

    // Config-policy wiring is what resolveDeviceIdsForSoftwarePolicy actually
    // traverses; a software policy with no active, assigned config policy
    // governs zero devices.
    const [cpA, cpB] = await db
      .insert(configurationPolicies)
      .values([
        { orgId: orgAId, name: `CP A ${sfx}`, status: 'active' as const },
        { orgId: orgBId, name: `CP B ${sfx}`, status: 'active' as const },
      ])
      .returning({ id: configurationPolicies.id });

    await db.insert(configPolicyFeatureLinks).values([
      { configPolicyId: cpA!.id, featureType: 'software_policy' as const, featurePolicyId: policyA!.id },
      { configPolicyId: cpB!.id, featureType: 'software_policy' as const, featurePolicyId: policyB!.id },
    ]);
    await db.insert(configPolicyAssignments).values([
      { configPolicyId: cpA!.id, level: 'organization' as const, targetId: orgAId },
      { configPolicyId: cpB!.id, level: 'organization' as const, targetId: orgBId },
    ]);

    const now = new Date();
    await db.insert(softwareComplianceStatus).values([
      { deviceId: byHost.winA1!, policyId: policyA!.id, status: 'violation', lastChecked: now, violations: MISSING_VIOLATION(catalogId) },
      { deviceId: byHost.winA2!, policyId: policyA!.id, status: 'violation', lastChecked: now, violations: MISSING_VIOLATION(catalogId) },
      { deviceId: byHost.linA3!, policyId: policyA!.id, status: 'violation', lastChecked: now, violations: MISSING_VIOLATION(catalogId) },
      { deviceId: byHost.winA4!, policyId: policyA!.id, status: 'violation', lastChecked: now, violations: MISSING_VIOLATION(noTargetCatalogId) },
      { deviceId: byHost.winB1!, policyId: policyB!.id, status: 'violation', lastChecked: now, violations: MISSING_VIOLATION(catalogId) },
    ]);

    const deviceIds = insertedDevices.map((d) => d.id);
    cleanup.push(async () => {
      await withSystemDbAccessContext(async () => {
        await db.delete(softwareComplianceStatus).where(inArray(softwareComplianceStatus.deviceId, deviceIds));
        await db.delete(configPolicyAssignments).where(inArray(configPolicyAssignments.configPolicyId, [cpA!.id, cpB!.id]));
        await db.delete(configPolicyFeatureLinks).where(inArray(configPolicyFeatureLinks.configPolicyId, [cpA!.id, cpB!.id]));
        await db.delete(configurationPolicies).where(inArray(configurationPolicies.id, [cpA!.id, cpB!.id]));
        await db.delete(softwarePolicies).where(inArray(softwarePolicies.id, [policyA!.id, policyB!.id]));
        await db.delete(softwareInstallMethods).where(eq(softwareInstallMethods.catalogId, catalogId));
        await db.delete(devices).where(inArray(devices.id, deviceIds));
        await db.delete(softwareCatalog).where(inArray(softwareCatalog.id, [catalogId, noTargetCatalogId]));
        await db.delete(sites).where(inArray(sites.id, [siteA!.id, siteB!.id]));
        await db.delete(organizations).where(inArray(organizations.id, [orgAId, orgBId]));
        await db.delete(partners).where(eq(partners.id, partnerId));
      });
    });

    return {
      partnerId,
      orgAId,
      orgBId,
      siteAId: siteA!.id,
      catalogId,
      policyAId: policyA!.id,
      policyBId: policyB!.id,
      winA1: byHost.winA1!,
      winA2: byHost.winA2!,
      linA3: byHost.linA3!,
      winA4: byHost.winA4!,
      winB1: byHost.winB1!,
      noTargetCatalogId,
    };
  });
}

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()!();
  }
});

describe('computeInstallPreviewEligibleDeviceCount — live Postgres', () => {
  it('counts only the devices whose (org, os) group resolves an install target', async () => {
    const f = await seed();
    const rules = { software: [{ name: 'Zoom', catalogId: f.catalogId }] };

    const count = await withDbAccessContext(orgContext(f.orgAId, f.partnerId), () =>
      computeInstallPreviewEligibleDeviceCount({ policyId: f.policyAId, rules }),
    );

    // winA1 + winA2. linA3 is linux: no windows install method applies and the
    // catalog item has no software_versions row, so its group is skipped before
    // any count query runs.
    expect(count).toBe(2);
  });

  it('never counts another tenant\'s devices — the catalog item is unreachable from org B', async () => {
    const f = await seed();
    // Org B's own policy names ORG A's catalog item. The device, the compliance
    // row and the `missing` violation all exist and all belong to org B, so the
    // only thing that can keep this at zero is the cross-tenant reachability
    // guard inside resolvePolicyInstallTarget.
    const rules = { software: [{ name: 'Zoom', catalogId: f.catalogId }] };

    const count = await withDbAccessContext(orgContext(f.orgBId, f.partnerId), () =>
      computeInstallPreviewEligibleDeviceCount({ policyId: f.policyBId, rules }),
    );

    expect(count).toBe(0);
  });

  it('narrows the count to a site-restricted caller\'s allowed devices', async () => {
    const f = await seed();
    const rules = { software: [{ name: 'Zoom', catalogId: f.catalogId }] };

    const count = await withDbAccessContext(orgContext(f.orgAId, f.partnerId), () =>
      computeInstallPreviewEligibleDeviceCount({
        policyId: f.policyAId,
        rules,
        siteAllowedDeviceIds: [f.winA1],
      }),
    );

    expect(count).toBe(1);
  });

  it('counts a device once even when several eligible rules match the same violation set', async () => {
    const f = await seed();
    // Two rules, both pointing at the same reachable catalog item. A naive
    // per-rule SUM would double-count winA1/winA2; count(distinct device_id)
    // must not.
    const rules = {
      software: [
        { name: 'Zoom', catalogId: f.catalogId },
        { name: 'Zoom (duplicate rule)', catalogId: f.catalogId },
      ],
    };

    const count = await withDbAccessContext(orgContext(f.orgAId, f.partnerId), () =>
      computeInstallPreviewEligibleDeviceCount({ policyId: f.policyAId, rules }),
    );

    expect(count).toBe(2);
  });

  it('returns 0 when no device carries a missing violation for an eligible catalog item', async () => {
    const f = await seed();
    await withSystemDbAccessContext(async () => {
      await db
        .update(softwareComplianceStatus)
        .set({
          violations: [
            {
              type: 'unauthorized',
              severity: 'high',
              detectedAt: new Date().toISOString(),
              software: { name: 'BitTorrent' },
            },
          ] satisfies SoftwarePolicyViolation[],
        })
        .where(eq(softwareComplianceStatus.policyId, f.policyAId));
    });
    const rules = { software: [{ name: 'Zoom', catalogId: f.catalogId }] };

    const count = await withDbAccessContext(orgContext(f.orgAId, f.partnerId), () =>
      computeInstallPreviewEligibleDeviceCount({ policyId: f.policyAId, rules }),
    );

    expect(count).toBe(0);
  });

  it('flags a 0 that means "never evaluated" rather than "nothing to install"', async () => {
    const f = await seed();
    // The compliance worker records violations asynchronously — policy
    // create/update only ENQUEUE a recheck — so a brand-new policy has no
    // software_compliance_status rows at all and previews as 0. Proven here
    // against real SQL because the `evaluated` tally that distinguishes it
    // rides in the same aggregate query as the count itself.
    await withSystemDbAccessContext(async () => {
      await db
        .delete(softwareComplianceStatus)
        .where(eq(softwareComplianceStatus.policyId, f.policyAId));
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rules = { software: [{ name: 'Zoom', catalogId: f.catalogId }] };

    const count = await withDbAccessContext(orgContext(f.orgAId, f.partnerId), () =>
      computeInstallPreviewEligibleDeviceCount({ policyId: f.policyAId, rules }),
    );

    expect(count).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('has not been evaluated yet'));
    warn.mockRestore();
  });

  it('counts only violations naming an ELIGIBLE catalog item within the same group', async () => {
    const f = await seed();
    // Both rules are in the SAME (org A, windows) group. Only the first
    // resolves an install target; winA4's sole violation names the second.
    // A group-wide "any rule resolved, so count every missing violation" bug
    // would count winA4 and return 3.
    const rules = {
      software: [
        { name: 'Zoom', catalogId: f.catalogId },
        { name: 'Slack', catalogId: f.noTargetCatalogId },
      ],
    };

    const count = await withDbAccessContext(orgContext(f.orgAId, f.partnerId), () =>
      computeInstallPreviewEligibleDeviceCount({ policyId: f.policyAId, rules }),
    );

    expect(count).toBe(2);
  });
});

/**
 * A PARTNER-WIDE policy is the case the (orgId, osType) group key exists for:
 * one policy legitimately resolves devices across several orgs, and catalog
 * reachability is per-ORG. Its own fixture, because a partner-level assignment
 * and an org-level one reaching the same device would fight over "closest
 * wins" and the org-level one would win.
 */
async function seedPartnerWide(): Promise<{
  partnerId: string;
  orgAId: string;
  orgBId: string;
  catalogId: string;
  policyId: string;
}> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 10);

    const [partner] = await db
      .insert(partners)
      .values({ name: `PW ${sfx}`, slug: `pw-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const partnerId = partner!.id;

    const [orgA, orgB] = await db
      .insert(organizations)
      .values([
        { currencyCode: 'USD', partnerId, name: `PWOrgA ${sfx}`, slug: `pworga-${sfx}` },
        { currencyCode: 'USD', partnerId, name: `PWOrgB ${sfx}`, slug: `pworgb-${sfx}` },
      ])
      .returning({ id: organizations.id });
    const orgAId = orgA!.id;
    const orgBId = orgB!.id;

    const [siteA, siteB] = await db
      .insert(sites)
      .values([
        { orgId: orgAId, name: `PWSiteA-${sfx}` },
        { orgId: orgBId, name: `PWSiteB-${sfx}` },
      ])
      .returning({ id: sites.id });

    const deviceBase = { osVersion: '1.0', architecture: 'x86_64', agentVersion: '1.0.0' };
    const insertedDevices = await db
      .insert(devices)
      .values([
        { ...deviceBase, orgId: orgAId, siteId: siteA!.id, osType: 'windows' as const, agentId: `pwa1-${sfx}`, hostname: 'pwA1', status: 'online' },
        { ...deviceBase, orgId: orgAId, siteId: siteA!.id, osType: 'windows' as const, agentId: `pwa2-${sfx}`, hostname: 'pwA2', status: 'online' },
        { ...deviceBase, orgId: orgBId, siteId: siteB!.id, osType: 'windows' as const, agentId: `pwb1-${sfx}`, hostname: 'pwB1', status: 'online' },
      ])
      .returning({ id: devices.id, hostname: devices.hostname });
    const byHost = Object.fromEntries(insertedDevices.map((d) => [d.hostname!, d.id]));

    // ORG A-owned catalog item. Org B is a sibling under the SAME partner, so
    // only the per-org reachability check keeps org B's device out of the count.
    const [catalog] = await db
      .insert(softwareCatalog)
      .values({ orgId: orgAId, name: `PWZoom ${sfx}`, vendor: 'Zoom' })
      .returning({ id: softwareCatalog.id });
    const catalogId = catalog!.id;
    await db.insert(softwareInstallMethods).values({
      catalogId, platform: 'windows', kind: 'winget', packageId: 'Zoom.Zoom', enabled: true,
    });

    const rules = { software: [{ name: 'Zoom', catalogId }] };
    const [policy] = await db
      .insert(softwarePolicies)
      .values({ partnerId, orgId: null, name: `PW Allowlist ${sfx}`, mode: 'allowlist' as const, rules })
      .returning({ id: softwarePolicies.id });

    const [cp] = await db
      .insert(configurationPolicies)
      .values({ partnerId, orgId: null, name: `PW CP ${sfx}`, status: 'active' as const })
      .returning({ id: configurationPolicies.id });
    await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: cp!.id, featureType: 'software_policy' as const, featurePolicyId: policy!.id,
    });
    await db.insert(configPolicyAssignments).values({
      configPolicyId: cp!.id, level: 'partner' as const, targetId: partnerId,
    });

    const now = new Date();
    await db.insert(softwareComplianceStatus).values(
      insertedDevices.map((d) => ({
        deviceId: d.id,
        policyId: policy!.id,
        status: 'violation',
        lastChecked: now,
        violations: MISSING_VIOLATION(catalogId),
      })),
    );

    const deviceIds = insertedDevices.map((d) => d.id);
    cleanup.push(async () => {
      await withSystemDbAccessContext(async () => {
        await db.delete(softwareComplianceStatus).where(inArray(softwareComplianceStatus.deviceId, deviceIds));
        await db.delete(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, cp!.id));
        await db.delete(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.configPolicyId, cp!.id));
        await db.delete(configurationPolicies).where(eq(configurationPolicies.id, cp!.id));
        await db.delete(softwarePolicies).where(eq(softwarePolicies.id, policy!.id));
        await db.delete(softwareInstallMethods).where(eq(softwareInstallMethods.catalogId, catalogId));
        await db.delete(devices).where(inArray(devices.id, deviceIds));
        await db.delete(softwareCatalog).where(eq(softwareCatalog.id, catalogId));
        await db.delete(sites).where(inArray(sites.id, [siteA!.id, siteB!.id]));
        await db.delete(organizations).where(inArray(organizations.id, [orgAId, orgBId]));
        await db.delete(partners).where(eq(partners.id, partnerId));
      });
    });

    return { partnerId, orgAId, orgBId, catalogId, policyId: policy!.id };
  });
}

describe('computeInstallPreviewEligibleDeviceCount — partner-wide policy across two orgs', () => {
  it('evaluates catalog reachability per org, not once for the whole policy', async () => {
    const f = await seedPartnerWide();
    const rules = { software: [{ name: 'Zoom', catalogId: f.catalogId }] };

    const count = await withDbAccessContext(
      {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: [f.orgAId, f.orgBId],
        accessiblePartnerIds: [f.partnerId],
        userId: null,
        currentPartnerId: f.partnerId,
      },
      () => computeInstallPreviewEligibleDeviceCount({ policyId: f.policyId, rules }),
    );

    // All THREE devices are resolved by the partner-level assignment and all
    // three carry the same missing violation. Only org A's two are eligible:
    // the catalog item belongs to org A, so org B's group resolves
    // catalog_item_not_reachable. Collapsing the group key to osType alone
    // would return 3 — a cross-tenant overcount on the exact policy shape this
    // warning is meant to bound.
    expect(count).toBe(2);
  });
});
