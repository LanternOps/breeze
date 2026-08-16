/**
 * Real-DB integration tests for the recidivist-endpoint abuse detector
 * (services/abuseSignals/recidivistEndpoint.ts): `syncEndpointFingerprints`
 * (the corpus-refresh write path, hand-written raw SQL), `loadRecidivistMatches`
 * (the cross-partner correlation join, also raw SQL), and the RLS boundary on
 * `abuse_endpoint_fingerprints`.
 *
 * The scorer itself (`computeRecidivistSignals`) is pure and already
 * unit-tested in recidivistEndpoint.test.ts against hand-built RecidivistMatch
 * arrays. What ISN'T covered there is whether the SQL actually produces those
 * matches from real device/software_inventory rows, and whether the table's
 * forced system-only RLS policy actually holds against `breeze_app` — both
 * proven here, mirroring abuseSignalsAggregates.integration.test.ts and the
 * abuse_script_hosts RLS lockout block in rls-coverage.integration.test.ts.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { partners, devices, softwareInventory, abuseEndpointFingerprints } from '../../db/schema';
import {
  syncEndpointFingerprints,
  loadRecidivistMatches,
  computeRecidivistSignals,
} from '../../services/abuseSignals/recidivistEndpoint';
import { loadSignalConfig } from '../../services/abuseSignals/config';
import { createPartner, createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';

// No manual afterEach cleanup: `partners` is TRUNCATE ... CASCADE'd by
// setup.ts's global beforeEach (cleanupDatabase), which transitively
// truncates every table with a FK back to partners (organizations, devices,
// software_inventory, abuse_endpoint_fingerprints, ...) — same isolation
// mechanism every other integration test in this directory relies on.

async function seedDevice(opts: {
  orgId: string;
  siteId: string;
  hostname: string;
  enrollmentIp: string;
  lastSeenIp?: string | null;
}) {
  const testDb = getTestDb();
  const [device] = await testDb
    .insert(devices)
    .values({
      orgId: opts.orgId,
      siteId: opts.siteId,
      agentId: randomUUID(),
      hostname: opts.hostname,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
      enrollmentIp: opts.enrollmentIp,
      lastSeenIp: opts.lastSeenIp,
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('seedDevice: no row returned');
  return device;
}

async function seedScreenConnectSoftware(opts: { orgId: string; deviceId: string; guid: string }) {
  const testDb = getTestDb();
  await testDb.insert(softwareInventory).values({
    deviceId: opts.deviceId,
    orgId: opts.orgId,
    name: `ScreenConnect Client (${opts.guid})`,
  });
}

async function seedPartnerOrgDeviceSite(status: 'active' | 'pending' | 'suspended') {
  const partner = await createPartner({ status });
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return { partner, org, site };
}

/** Runs the full detector pipeline (sync -> load -> score) under a system DB context. */
async function runDetector(now: Date) {
  return withSystemDbAccessContext(async () => {
    await syncEndpointFingerprints(now);
    const { matches } = await loadRecidivistMatches();
    return computeRecidivistSignals(matches, loadSignalConfig());
  });
}

describe('recidivist-endpoint detector (real DB)', () => {
  it('scenario 1: same ScreenConnect GUID on a suspended partner and an active partner fires exactly one signal, on the active partner, at fingerprint score', async () => {
    const guid = 'aabbccdd11223344';
    const suspended = await seedPartnerOrgDeviceSite('suspended');
    const active = await seedPartnerOrgDeviceSite('active');

    const suspendedDevice = await seedDevice({
      orgId: suspended.org.id,
      siteId: suspended.site.id,
      hostname: `DESKTOP-SUS${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      enrollmentIp: '10.1.0.1',
      lastSeenIp: '10.1.0.1',
    });
    const activeDevice = await seedDevice({
      orgId: active.org.id,
      siteId: active.site.id,
      hostname: `DESKTOP-ACT${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      enrollmentIp: '10.2.0.1',
      lastSeenIp: '10.2.0.1',
    });

    await seedScreenConnectSoftware({ orgId: suspended.org.id, deviceId: suspendedDevice.id, guid });
    await seedScreenConnectSoftware({ orgId: active.org.id, deviceId: activeDevice.id, guid });

    const signals = await runDetector(new Date());

    expect(signals).toHaveLength(1);
    expect(signals[0]!.partnerId).toBe(active.partner.id);
    expect(signals[0]!.signalKey).toBe('rmm.recidivist_endpoint');
    expect(signals[0]!.score).toBe(100);
    expect(signals[0]!.severity).toBe('alert');
  });

  it('scenario 2: both partners active — no direction, no signal (backtest-replay assertion)', async () => {
    const guid = 'aabbccdd11223344';
    const a = await seedPartnerOrgDeviceSite('active');
    const b = await seedPartnerOrgDeviceSite('active');

    const deviceA = await seedDevice({
      orgId: a.org.id,
      siteId: a.site.id,
      hostname: `DESKTOP-AAA${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      enrollmentIp: '10.3.0.1',
      lastSeenIp: '10.3.0.1',
    });
    const deviceB = await seedDevice({
      orgId: b.org.id,
      siteId: b.site.id,
      hostname: `DESKTOP-BBB${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      enrollmentIp: '10.4.0.1',
      lastSeenIp: '10.4.0.1',
    });

    await seedScreenConnectSoftware({ orgId: a.org.id, deviceId: deviceA.id, guid });
    await seedScreenConnectSoftware({ orgId: b.org.id, deviceId: deviceB.id, guid });

    const signals = await runDetector(new Date());

    expect(signals).toEqual([]);
  });

  it('scenario 3: both partners suspended — no signal', async () => {
    const guid = 'aabbccdd11223344';
    const a = await seedPartnerOrgDeviceSite('suspended');
    const b = await seedPartnerOrgDeviceSite('suspended');

    const deviceA = await seedDevice({
      orgId: a.org.id,
      siteId: a.site.id,
      hostname: `DESKTOP-CCC${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      enrollmentIp: '10.5.0.1',
      lastSeenIp: '10.5.0.1',
    });
    const deviceB = await seedDevice({
      orgId: b.org.id,
      siteId: b.site.id,
      hostname: `DESKTOP-DDD${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      enrollmentIp: '10.6.0.1',
      lastSeenIp: '10.6.0.1',
    });

    await seedScreenConnectSoftware({ orgId: a.org.id, deviceId: deviceA.id, guid });
    await seedScreenConnectSoftware({ orgId: b.org.id, deviceId: deviceB.id, guid });

    const signals = await runDetector(new Date());

    expect(signals).toEqual([]);
  });

  it('scenario 4: hostname-only reuse scores 60 (watch); adding same-counterpart egress_ip evidence upgrades it to 90', async () => {
    const sharedHostname = 'DESKTOP-ZZ9XY7Q';
    const active = await seedPartnerOrgDeviceSite('active');
    const suspended = await seedPartnerOrgDeviceSite('suspended');

    const activeDevice = await seedDevice({
      orgId: active.org.id,
      siteId: active.site.id,
      hostname: sharedHostname,
      enrollmentIp: '10.7.0.1',
      lastSeenIp: '10.7.0.1',
    });
    const suspendedDevice = await seedDevice({
      orgId: suspended.org.id,
      siteId: suspended.site.id,
      hostname: sharedHostname,
      enrollmentIp: '10.8.0.1',
      lastSeenIp: '10.8.0.1', // distinct IP — no ip corroboration yet
    });

    const firstRun = await runDetector(new Date());
    // Total-count assertion: only the active partner may ever be scored (the
    // suspended partner sits on the non-active side of the SQL join and must
    // never produce a signal of its own), so this proves no unexpected
    // second signal — on the suspended partner or otherwise — sneaks through
    // unproven by the filtered assertion below.
    expect(firstRun).toHaveLength(1);
    const firstForActive = firstRun.filter((s) => s.partnerId === active.partner.id);
    expect(firstForActive).toHaveLength(1);
    expect(firstForActive[0]!.score).toBe(60);
    expect(firstForActive[0]!.severity).toBe('watch');
    // No egress_ip corroboration yet — evidence axes must not claim hostname_ip.
    expect(firstForActive[0]!.evidence.axes).toEqual(['hostname']);

    // Now give both devices the SAME egress IP (same counterpart pair) and
    // re-run the full pipeline — the corpus is a full re-derive every sweep
    // (no high-water mark), so a fresh syncEndpointFingerprints call picks up
    // the updated device state.
    const sharedIp = '203.0.113.77';
    const testDb = getTestDb();
    await testDb.update(devices).set({ lastSeenIp: sharedIp }).where(eq(devices.id, activeDevice.id));
    await testDb.update(devices).set({ lastSeenIp: sharedIp }).where(eq(devices.id, suspendedDevice.id));

    const secondRun = await runDetector(new Date());
    const secondForActive = secondRun.filter((s) => s.partnerId === active.partner.id);
    expect(secondForActive).toHaveLength(1);
    expect(secondForActive[0]!.score).toBe(90);
    expect(secondForActive[0]!.severity).toBe('alert');
    expect(secondForActive[0]!.evidence.axes).toEqual(['hostname_ip']);
  });
});

/**
 * RLS lockout — mirrors the abuse_script_hosts and partner_abuse_signals
 * blocks in rls-coverage.integration.test.ts. Forges as `breeze_app` the
 * specific threat abuse_endpoint_fingerprints exists to prevent: a partner
 * reading (or writing) the cross-partner endpoint-fingerprint corpus, which
 * would reveal what the operator correlates on. All legitimate access goes
 * through withSystemDbAccessContext.
 *
 * Unlike the rls-coverage.integration.test.ts version of this block (which
 * runs under vitest.config.rls-coverage.ts, deliberately WITHOUT setup.ts's
 * per-test truncate), this file runs under vitest.integration.config.ts,
 * which truncates core tenant tables in a global `beforeEach`. So fixtures
 * are seeded fresh INSIDE each `it` rather than once via a module-level
 * `ensureFixtures` cache — a cached partner id from an earlier test would be
 * dangling by the time the next test runs.
 */
describe('abuse_endpoint_fingerprints RLS — system-only enforcement', () => {
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  async function seedPartner(): Promise<string> {
    return withSystemDbAccessContext(async () => {
      const [partner] = await db
        .insert(partners)
        .values({
          name: `RLS Endpoint Fingerprints Partner ${runSuffix}`,
          slug: `rls-endpoint-fp-partner-${runSuffix}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'msp',
          plan: 'pro',
          status: 'active',
        })
        .returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for abuse-endpoint-fingerprints RLS forge test');
      return partner.id;
    });
  }

  function partnerContext(accessiblePartnerId: string) {
    return {
      scope: 'partner' as const,
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [accessiblePartnerId],
      userId: null,
    };
  }

  it.runIf(!!process.env.DATABASE_URL)(
    'INSERT as breeze_app under a tenant (partner-scoped) context is rejected by RLS',
    async () => {
      const partnerId = await seedPartner();

      let caught: unknown;
      try {
        await withDbAccessContext(partnerContext(partnerId), async () =>
          db.insert(abuseEndpointFingerprints).values({
            partnerId,
            kind: 'hostname',
            value: `rls-forge-deny-${runSuffix}`,
          }),
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(/row-level security|permission denied/i);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "SELECT under a partner context matching the row's own partner_id returns zero rows",
    async () => {
      const partnerId = await seedPartner();

      const seeded = await withSystemDbAccessContext(async () => {
        return db
          .insert(abuseEndpointFingerprints)
          .values({ partnerId, kind: 'hostname', value: `rls-forge-seed-${runSuffix}` })
          .returning({ id: abuseEndpointFingerprints.id });
      });
      expect(seeded).toHaveLength(1);

      let rows: unknown[] = [];
      let err: unknown = null;
      try {
        rows = await withDbAccessContext(partnerContext(partnerId), async () =>
          db
            .select({ id: abuseEndpointFingerprints.id })
            .from(abuseEndpointFingerprints)
            .where(eq(abuseEndpointFingerprints.partnerId, partnerId)),
        );
      } catch (e) {
        err = e;
      }

      if (err) {
        const cause = err as { cause?: { message?: string }; message?: string };
        const message = cause?.cause?.message ?? cause?.message ?? '';
        expect(message).toMatch(/permission denied|row-level security/i);
      } else {
        expect(rows).toEqual([]);
      }
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    'withSystemDbAccessContext INSERT + SELECT round-trips successfully',
    async () => {
      const partnerId = await seedPartner();

      const value = `rls-forge-system-${runSuffix}`;
      const result = await withSystemDbAccessContext(async () => {
        return db
          .insert(abuseEndpointFingerprints)
          .values({ partnerId, kind: 'egress_ip', value })
          .returning({ id: abuseEndpointFingerprints.id, value: abuseEndpointFingerprints.value });
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.value).toBe(value);

      const readBack = await withSystemDbAccessContext(async () => {
        return db
          .select({ id: abuseEndpointFingerprints.id })
          .from(abuseEndpointFingerprints)
          .where(eq(abuseEndpointFingerprints.id, result[0]!.id));
      });
      expect(readBack).toHaveLength(1);
    },
  );
});
