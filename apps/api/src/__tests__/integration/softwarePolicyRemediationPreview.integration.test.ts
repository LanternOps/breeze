/**
 * #3616 — the Remediate preview's target-set SQL against real Postgres,
 * through the breeze_app role and an org-scoped RLS context.
 *
 * The route and unit tests mock `db`, so they cannot prove the queries this
 * preview depends on are valid or select the right rows. Only a live database
 * exercises:
 *   - the `violations @> '[{"type":"unauthorized"}]'::jsonb` containment
 *     predicate (a `missing`-only row must NOT be a target; a row mixing
 *     `missing` and `unauthorized` must be),
 *   - `count(distinct device_id)::int` as the uncapped total,
 *   - `ORDER BY hostname` + the site-ceiling `inArray` narrowing, and
 *   - RLS + the tenant condition keeping another org's device out even when
 *     its compliance row names this org's policy.
 *
 * Fixture: one partner, orgs A and B. Policy P is org A's.
 *   alpha   (org A, site 1): unauthorized Zoom 5 (twice) + Steam, plus a missing → target, 2 uninstalls
 *   bravo   (org A, site 1): missing only                                       → NOT a target
 *   charlie (org A, site 2): unauthorized Zoom 6                                → target, 1 uninstall
 *   delta   (org B):         unauthorized Zoom 5 under P                        → never visible to org A
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  devices,
  organizations,
  partners,
  sites,
  softwareComplianceStatus,
  softwarePolicies,
  type SoftwarePolicyViolation,
} from '../../db/schema';
import { queryRemediationPreview } from '../../services/softwarePolicyRemediationPreview';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()!();
  }
});

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

const at = () => new Date().toISOString();
const unauthorized = (name: string, version?: string): SoftwarePolicyViolation => ({
  type: 'unauthorized',
  severity: 'medium',
  detectedAt: at(),
  software: { name, version: version ?? null },
});
const missing = (name: string): SoftwarePolicyViolation => ({
  type: 'missing',
  severity: 'high',
  detectedAt: at(),
  rule: { name },
});

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 10);
    const [partner] = await db
      .insert(partners)
      .values({ name: `RP ${sfx}`, slug: `rp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const partnerId = partner!.id;

    const [orgA, orgB] = await db
      .insert(organizations)
      .values([
        { currencyCode: 'USD', partnerId, name: `RA ${sfx}`, slug: `ra-${sfx}` },
        { currencyCode: 'USD', partnerId, name: `RB ${sfx}`, slug: `rb-${sfx}` },
      ])
      .returning({ id: organizations.id });
    const orgAId = orgA!.id;
    const orgBId = orgB!.id;

    const [site1, site2, siteB] = await db
      .insert(sites)
      .values([
        { orgId: orgAId, name: `S1-${sfx}` },
        { orgId: orgAId, name: `S2-${sfx}` },
        { orgId: orgBId, name: `SB-${sfx}` },
      ])
      .returning({ id: sites.id });

    const base = { osVersion: '1.0', architecture: 'x86_64', agentVersion: '1.0.0', osType: 'windows' as const, status: 'online' as const };
    const inserted = await db
      .insert(devices)
      .values([
        { ...base, orgId: orgAId, siteId: site1!.id, agentId: `ra-${sfx}`, hostname: `alpha-${sfx}` },
        { ...base, orgId: orgAId, siteId: site1!.id, agentId: `rb-${sfx}`, hostname: `bravo-${sfx}` },
        { ...base, orgId: orgAId, siteId: site2!.id, agentId: `rc-${sfx}`, hostname: `charlie-${sfx}` },
        { ...base, orgId: orgBId, siteId: siteB!.id, agentId: `rd-${sfx}`, hostname: `delta-${sfx}` },
      ])
      .returning({ id: devices.id, hostname: devices.hostname });
    const id = (prefix: string) => inserted.find((d) => d.hostname!.startsWith(prefix))!.id;

    const [policy] = await db
      .insert(softwarePolicies)
      .values({ orgId: orgAId, name: `Allowlist ${sfx}`, mode: 'allowlist' as const, rules: { software: [{ name: 'Chrome' }] } })
      .returning({ id: softwarePolicies.id });
    const policyId = policy!.id;

    const now = new Date();
    await db.insert(softwareComplianceStatus).values([
      {
        deviceId: id('alpha'), policyId, status: 'violation', lastChecked: now,
        violations: [missing('Chrome'), unauthorized('Zoom', '5'), unauthorized('zoom', '5'), unauthorized('Steam')],
      },
      { deviceId: id('bravo'), policyId, status: 'violation', lastChecked: now, violations: [missing('Chrome')] },
      { deviceId: id('charlie'), policyId, status: 'violation', lastChecked: now, violations: [unauthorized('Zoom', '6')] },
      { deviceId: id('delta'), policyId, status: 'violation', lastChecked: now, violations: [unauthorized('Zoom', '5')] },
    ]);

    const deviceIds = inserted.map((d) => d.id);
    cleanup.push(async () => {
      await withSystemDbAccessContext(async () => {
        await db.delete(softwareComplianceStatus).where(inArray(softwareComplianceStatus.deviceId, deviceIds));
        await db.delete(softwarePolicies).where(eq(softwarePolicies.id, policyId));
        await db.delete(devices).where(inArray(devices.id, deviceIds));
        await db.delete(sites).where(inArray(sites.id, [site1!.id, site2!.id, siteB!.id]));
        await db.delete(organizations).where(inArray(organizations.id, [orgAId, orgBId]));
        await db.delete(partners).where(eq(partners.id, partnerId));
      });
    });

    return {
      partnerId, orgAId, policyId,
      alpha: id('alpha'), bravo: id('bravo'), charlie: id('charlie'), delta: id('delta'),
    };
  });
}

describe('queryRemediationPreview — live Postgres (#3616)', () => {
  it('targets only devices with an unauthorized violation, in hostname order, within the caller org', async () => {
    const f = await seed();

    const preview = await withDbAccessContext(orgContext(f.orgAId, f.partnerId), () =>
      queryRemediationPreview({
        policyId: f.policyId,
        orgCondition: eq(devices.orgId, f.orgAId),
        siteAllowedDeviceIds: null,
      }),
    );

    // bravo is missing-only; delta is org B's.
    expect(preview.deviceIds).toEqual([f.alpha, f.charlie]);
    expect(preview.deviceCount).toBe(2);
    expect(preview.totalTargetDevices).toBe(2);
    expect(preview.capped).toBe(false);
    // alpha: Zoom 5 (deduped case-insensitively) + Steam; charlie: Zoom 6.
    expect(preview.uninstallCount).toBe(3);
    expect(preview.software).toEqual([
      { name: 'Zoom', deviceCount: 2 },
      { name: 'Steam', deviceCount: 1 },
    ]);
  });

  it('keeps another org\'s device out through RLS alone, even without the tenant condition', async () => {
    const f = await seed();

    const preview = await withDbAccessContext(orgContext(f.orgAId, f.partnerId), () =>
      queryRemediationPreview({ policyId: f.policyId, orgCondition: undefined, siteAllowedDeviceIds: null }),
    );

    expect(preview.deviceIds).not.toContain(f.delta);
    expect(preview.totalTargetDevices).toBe(2);
  });

  it('narrows to the site ceiling', async () => {
    const f = await seed();

    const preview = await withDbAccessContext(orgContext(f.orgAId, f.partnerId), () =>
      queryRemediationPreview({
        policyId: f.policyId,
        orgCondition: eq(devices.orgId, f.orgAId),
        // Site 1 only: alpha (target) and bravo (missing-only).
        siteAllowedDeviceIds: [f.alpha, f.bravo],
      }),
    );

    expect(preview.deviceIds).toEqual([f.alpha]);
    expect(preview.totalTargetDevices).toBe(1);
  });

  it('returns an empty preview for an empty site ceiling', async () => {
    const f = await seed();

    const preview = await withDbAccessContext(orgContext(f.orgAId, f.partnerId), () =>
      queryRemediationPreview({ policyId: f.policyId, orgCondition: undefined, siteAllowedDeviceIds: [] }),
    );

    expect(preview.deviceIds).toEqual([]);
    expect(preview.totalTargetDevices).toBe(0);
  });
});
