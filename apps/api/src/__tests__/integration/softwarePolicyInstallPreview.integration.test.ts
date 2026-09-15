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
import { afterEach, describe, expect, it } from 'vitest';
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
  winB1: string;
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
        await db.delete(softwareCatalog).where(eq(softwareCatalog.id, catalogId));
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
      winB1: byHost.winB1!,
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
});
