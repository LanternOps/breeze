import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { partners, organizations, sites, devices } from '../db/schema';
import {
  getManagementPostureSummary,
  getPostureDetections,
  getPostureCoverage,
  getPostureDevices,
} from './managementPostureReport';

/**
 * Real-Postgres integration test for the fleet posture report (#3244).
 *
 * THE MIXED FIXTURE IS THE TEST. One org contains all four populations at
 * once — never-scanned, scanned-stale, scanned-clean (empty array AND absent
 * key), scanned-with-a-detection. Any single-population fixture passes
 * against the collapsed one-query LEFT JOIN LATERAL form this design had to
 * correct (which makes a never-scanned device read as verified-clean), so
 * only this fixture actually guards the two-query split.
 *
 * Seeded per test — the shared integration setup TRUNCATEs on beforeEach.
 */

const hasDb = !!process.env.DATABASE_URL;

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function posture(collectedAt: string, categories: Record<string, unknown[]>) {
  return {
    collectedAt,
    scanDurationMs: 100,
    categories,
    identity: {
      joinType: 'none', azureAdJoined: false, domainJoined: false,
      workplaceJoined: false, source: 'test',
    },
  };
}

/** Two partners, two orgs; org 1 carries the mixed fixture, org 2 (a different
 *  partner) exists to prove scoping. Returns the org ids. */
async function seedMixedFixture(): Promise<{ org1: string; org2: string }> {
  const sfx = Math.random().toString(36).slice(2, 8);

  return withSystemDbAccessContext(async () => {
    const [p1] = await db.insert(partners)
      .values({ name: `PostureP1 ${sfx}`, slug: `posture-p1-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [p2] = await db.insert(partners)
      .values({ name: `PostureP2 ${sfx}`, slug: `posture-p2-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o1] = await db.insert(organizations)
      .values({ partnerId: p1!.id, name: 'Posture Org 1', slug: `posture-o1-${sfx}` })
      .returning({ id: organizations.id });
    const [o2] = await db.insert(organizations)
      .values({ partnerId: p2!.id, name: 'Posture Org 2', slug: `posture-o2-${sfx}` })
      .returning({ id: organizations.id });
    const [s1] = await db.insert(sites)
      .values({ orgId: o1!.id, name: 'HQ' })
      .returning({ id: sites.id });
    const [s2] = await db.insert(sites)
      .values({ orgId: o2!.id, name: 'HQ' })
      .returning({ id: sites.id });

    const base = (host: string, orgId: string, siteId: string) => ({
      orgId,
      siteId,
      agentId: `posture-${sfx}-${host}`,
      hostname: host,
      osType: 'windows' as const,
      osVersion: '10.0',
      architecture: 'x64',
      agentVersion: '1.0.0',
    });

    await db.insert(devices).values([
      // A — NEVER SCANNED: management_posture IS NULL. Must land in
      // neverScanned, never in scannedNoneDetected ("clean").
      { ...base('pst-a-never', o1!.id, s1!.id) },
      // B — STALE scan (40d old) that still carries a detection.
      { ...base('pst-b-stale', o1!.id, s1!.id),
        managementPosture: posture(daysAgo(40), { rmm: [{ name: 'Datto RMM', status: 'active' }] }) },
      // C — fresh scan, rmm key present but EMPTY ARRAY => scanned, none
      // detected. (Also carries a remoteAccess detection to prove category
      // isolation.)
      { ...base('pst-c-empty', o1!.id, s1!.id),
        managementPosture: posture(daysAgo(1), { rmm: [], remoteAccess: [{ name: 'ScreenConnect', status: 'active' }] }) },
      // D — fresh scan, rmm key ABSENT entirely => scanned, none detected.
      { ...base('pst-d-absent', o1!.id, s1!.id),
        managementPosture: posture(daysAgo(1), {}) },
      // E — fresh scan with detections: active Datto + unknown NinjaOne.
      { ...base('pst-e-detected', o1!.id, s1!.id),
        managementPosture: posture(daysAgo(1), { rmm: [
          { name: 'Datto RMM', status: 'active' },
          { name: 'NinjaOne', status: 'unknown' },
        ] }) },
      // F — fresh scan listing the SAME product/status twice (two services).
      // Must count the device ONCE.
      { ...base('pst-f-dupe', o1!.id, s1!.id),
        managementPosture: posture(daysAgo(1), { rmm: [
          { name: 'NinjaOne', status: 'installed', serviceName: 'svc-1' },
          { name: 'NinjaOne', status: 'installed', serviceName: 'svc-2' },
        ] }) },
      // H — decommissioned device with a detection: excluded from the fleet.
      { ...base('pst-h-decom', o1!.id, s1!.id), status: 'decommissioned' as const,
        managementPosture: posture(daysAgo(1), { rmm: [{ name: 'Datto RMM', status: 'active' }] }) },
      // Org 2 (different partner) — must never leak into an org-1 scope.
      { ...base('pst-g-other-org', o2!.id, s2!.id),
        managementPosture: posture(daysAgo(1), { rmm: [{ name: 'Atera', status: 'active' }] }) },
    ]);

    return { org1: o1!.id, org2: o2!.id };
  });
}

const opts = (org1: string) => ({
  category: 'rmm' as const,
  stalenessDays: 7,
  scope: eq(devices.orgId, org1),
});

describe('management posture report — mixed fixture against real Postgres', () => {
  it.runIf(hasDb)('partitions the fleet: neverScanned + stale + freshClean + freshDetected == total', async () => {
    const { org1 } = await seedMixedFixture();
    const summary = await withSystemDbAccessContext(() => getManagementPostureSummary(opts(org1)));

    expect(summary.orgs).toHaveLength(1);
    const org = summary.orgs[0]!;
    expect(org.orgId).toBe(org1);

    // 6 live devices (decommissioned H excluded).
    expect(org.totalDevices).toBe(6);
    // A only — the never-scanned device is reported as UNKNOWN, not clean.
    expect(org.neverScanned).toBe(1);
    // B only — scanned but outside the 7-day window.
    expect(org.stale).toBe(1);
    // C (empty array) and D (absent key) BOTH land in scannedNoneDetected,
    // NOT in neverScanned.
    expect(org.scannedNoneDetected).toBe(2);
    // B, E and F carry detections; only E and F are fresh.
    expect(org.detectedDevices).toBe(3);
    expect(org.freshDetectedDevices).toBe(2);

    // The partition the plan requires: never + stale + fresh-clean +
    // fresh-detected == total, nothing double-counted or dropped.
    // (B is the stale device; C and D are the fresh-clean ones.)
    expect(
      org.neverScanned + org.stale + org.scannedNoneDetected + org.freshDetectedDevices
    ).toBe(org.totalDevices);
  });

  it.runIf(hasDb)('reports per-product/status rows with distinct-device counts and freshness', async () => {
    const { org1 } = await seedMixedFixture();
    const rows = await withSystemDbAccessContext(() => getPostureDetections(opts(org1)));

    const byKey = new Map(rows.map((r) => [`${r.product}|${r.status}`, r]));

    // Datto RMM active: devices B (stale) + E (fresh) => count 2, fresh 1.
    expect(byKey.get('Datto RMM|active')).toMatchObject({ deviceCount: 2, freshDeviceCount: 1 });
    // NinjaOne installed: device F lists it twice => counted ONCE.
    expect(byKey.get('NinjaOne|installed')).toMatchObject({ deviceCount: 1, freshDeviceCount: 1 });
    // 'unknown' status is neither dropped nor merged.
    expect(byKey.get('NinjaOne|unknown')).toMatchObject({ deviceCount: 1, freshDeviceCount: 1 });
    // active vs installed reported separately — no merged NinjaOne row.
    expect(byKey.has('NinjaOne|active')).toBe(false);
    // Decommissioned H contributes nothing beyond B+E, and org-2's Atera
    // never appears in an org-1 scope.
    expect(byKey.has('Atera|active')).toBe(false);

    // Staleness boundary invariant.
    for (const r of rows) {
      expect(r.freshDeviceCount).toBeLessThanOrEqual(r.deviceCount);
    }
  });

  it.runIf(hasDb)('category isolation: the remoteAccess report sees ScreenConnect, the rmm report does not', async () => {
    const { org1 } = await seedMixedFixture();
    const ra = await withSystemDbAccessContext(() =>
      getPostureDetections({ ...opts(org1), category: 'remoteAccess' })
    );
    expect(ra).toHaveLength(1);
    expect(ra[0]).toMatchObject({ product: 'ScreenConnect', status: 'active', deviceCount: 1 });

    // In the remoteAccess report device C is DETECTED, and the coverage
    // denominators reflect that category, not rmm's.
    const cov = await withSystemDbAccessContext(() =>
      getPostureCoverage({ ...opts(org1), category: 'remoteAccess' })
    );
    expect(cov[0]).toMatchObject({ totalDevices: 6, neverScanned: 1, detectedDevices: 1 });
  });

  it.runIf(hasDb)('org scoping: an org-1 scope never includes org-2 devices, and vice versa', async () => {
    const { org1, org2 } = await seedMixedFixture();

    const summary2 = await withSystemDbAccessContext(() =>
      getManagementPostureSummary({ category: 'rmm', stalenessDays: 7, scope: eq(devices.orgId, org2) })
    );
    expect(summary2.orgs).toHaveLength(1);
    expect(summary2.orgs[0]!.orgId).toBe(org2);
    expect(summary2.orgs[0]!.totalDevices).toBe(1);
    expect(summary2.orgs[0]!.products).toEqual([
      { product: 'Atera', status: 'active', deviceCount: 1, freshDeviceCount: 1 },
    ]);

    // A partner-style roll-up over partner 1's accessible orgs must not
    // include the other partner's org.
    const rollup = await withSystemDbAccessContext(() =>
      getManagementPostureSummary({ category: 'rmm', stalenessDays: 7, scope: inArray(devices.orgId, [org1]) })
    );
    expect(rollup.orgs.map((o) => o.orgId)).toEqual([org1]);
    expect(rollup.orgs[0]!.products.some((p) => p.product === 'Atera')).toBe(false);
  });

  it.runIf(hasDb)('drill-down lists the devices behind a count, honoring the status filter', async () => {
    const { org1 } = await seedMixedFixture();

    const all = await withSystemDbAccessContext(() =>
      getPostureDevices({ ...opts(org1), product: 'NinjaOne', limit: 50, offset: 0 })
    );
    expect(all.total).toBe(2); // E (unknown) + F (installed)
    expect(all.devices.map((d) => d.hostname).sort()).toEqual(['pst-e-detected', 'pst-f-dupe']);
    // F lists the product twice but appears once.
    expect(all.devices.filter((d) => d.hostname === 'pst-f-dupe')).toHaveLength(1);

    const installedOnly = await withSystemDbAccessContext(() =>
      getPostureDevices({ ...opts(org1), product: 'NinjaOne', detectionStatus: 'installed', limit: 50, offset: 0 })
    );
    expect(installedOnly.total).toBe(1);
    expect(installedOnly.devices[0]).toMatchObject({
      hostname: 'pst-f-dupe',
      detectionStatus: 'installed',
    });
    expect(installedOnly.devices[0]!.collectedAt).toBeTruthy();
  });

  it.runIf(hasDb)('a widened staleness window moves the stale device into fresh counts', async () => {
    const { org1 } = await seedMixedFixture();

    const wide = await withSystemDbAccessContext(() =>
      getManagementPostureSummary({ ...opts(org1), stalenessDays: 90 })
    );
    const org = wide.orgs[0]!;
    expect(org.stale).toBe(0);
    expect(org.freshDetectedDevices).toBe(3); // B joins E and F
    const datto = org.products.find((p) => p.product === 'Datto RMM' && p.status === 'active')!;
    expect(datto).toMatchObject({ deviceCount: 2, freshDeviceCount: 2 });
  });
});
