import './setup';

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { deviceReliability, deviceReliabilityHistory, devices, organizations } from '../../db/schema';
import { computeAndPersistDeviceReliability } from '../../services/reliabilityScoring';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

// #event-loop-hardening (reliabilityScoring.ts:getHistoryForDevice): the
// 90-day scoring read now projects 7 columns and drops the ~2KB/row rawMetrics
// JSONB, which the scorer never consumes. This test proves that projection is
// lossless end-to-end against REAL Postgres: a high-frequency device (50+ posts
// inside a single UTC day, every row carrying a populated rawMetrics blob) must
// still dedupe repeated crash/service events globally and persist the exact same
// golden `device_reliability` row the unprojected read would have produced.
//
// Reliability scoring windows (getSince/computeUptimeAvailability) are all
// relative to the real Date.now() at compute time, so all seed timestamps here
// are anchored relative to "now" (never a fixed calendar date) — otherwise the
// fixture would silently age out of the 90-day lookback window months from now.

const DAY_MS = 24 * 60 * 60 * 1000;

function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// A single day anchored 5 days back from "now" — comfortably inside every
// scoring window (7d/30d/90d) with margin on both sides against clock skew
// between this file's seed pass and the real Date.now() the compute call uses.
const ANCHOR_DAY_KEY = toDayKey(new Date(Date.now() - 5 * DAY_MS));
const BOOT_TIME = new Date(`${ANCHOR_DAY_KEY}T00:00:00.000Z`);

const REPEATED_CRASH_TIMESTAMP = `${ANCHOR_DAY_KEY}T10:05:00.000Z`;
const DISTINCT_CRASH_TIMESTAMP = `${ANCHOR_DAY_KEY}T11:00:00.000Z`;
const REPEATED_SERVICE_FAILURE_TIMESTAMP = `${ANCHOR_DAY_KEY}T12:00:00.000Z`;

function rawMetricsBlob(seq: number): Record<string, unknown> {
  // Populated + sizeable on every row so a real (non-mocked) Postgres read that
  // accidentally re-included raw_metrics would be immediately obvious in size,
  // while the projected getHistoryForDevice select must never fetch it at all.
  return { cpu: 12, mem: 34, seq, blob: 'x'.repeat(2000) };
}

describe('reliability scoring — projected read golden value (integration)', () => {
  let orgId: string;
  let deviceId: string;

  beforeEach(async () => {
    // Seeded here (not beforeAll) so it runs AFTER the global per-test
    // cleanupDatabase beforeEach registered in setup.ts (registered first, at
    // import time, so it runs before this one) — otherwise the truncate wipes
    // this data before the single `it` below ever runs.
    await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id, name: 'Reliability Projection Org' });
      orgId = org.id;
      const site = await createSite({ orgId, name: 'Reliability Projection Site' });

      // ml.device_reliability.enabled already defaults to true (mlFeatureFlags.ts
      // defaultMlFeatureFlagValue); this explicit write is belt-and-suspenders so
      // the test doesn't silently depend on that default never changing.
      await getTestDb()
        .update(organizations)
        .set({ settings: { 'ml.device_reliability.enabled': true } })
        .where(eq(organizations.id, orgId));

      const [device] = await getTestDb()
        .insert(devices)
        .values({
          orgId,
          siteId: site.id,
          agentId: `reliability-projection-test-${Date.now()}`,
          hostname: 'reliability-projection-workstation',
          displayName: 'reliability-projection-workstation',
          osType: 'windows',
          osVersion: 'test',
          architecture: 'x86_64',
          agentVersion: '0.0.0-test',
          status: 'online',
          deviceRole: 'workstation',
          // ~40 days ago: well before the anchor day, so the enrollment clamp in
          // computeUptimeAvailability never truncates the 30d/90d windows here.
          enrolledAt: new Date(Date.now() - 40 * DAY_MS),
        })
        .returning({ id: devices.id });
      if (!device) throw new Error('failed to seed device');
      deviceId = device.id;

      // 50 posts inside the single anchor UTC day, 00:05 through 23:55 (roughly
      // every ~29 minutes) — the high-frequency multi-post-per-day pattern that
      // makes overlapping-window re-reads of the same event common in prod.
      const rowCount = 50;
      const rows = [];
      for (let i = 0; i < rowCount; i++) {
        const minutesIntoDay = 5 + Math.round((i * (23 * 60 + 50)) / (rowCount - 1));
        const collectedAt = new Date(BOOT_TIME.getTime() + minutesIntoDay * 60 * 1000);
        const uptimeSeconds = Math.round((collectedAt.getTime() - BOOT_TIME.getTime()) / 1000);

        const crashEvents = [];
        // Rows 0..24 (25 rows) all re-report the SAME crash event.
        if (i <= 24) {
          crashEvents.push({
            type: 'system_crash' as const,
            timestamp: REPEATED_CRASH_TIMESTAMP,
            details: { bugCheckCode: '0x1a' },
          });
        }
        // Row 30 reports a single DISTINCT crash.
        if (i === 30) {
          crashEvents.push({
            type: 'system_crash' as const,
            timestamp: DISTINCT_CRASH_TIMESTAMP,
            details: { bugCheckCode: '0x50' },
          });
        }

        const serviceFailures = [];
        // Rows 40..45 (6 rows) all re-report the SAME Spooler service failure.
        if (i >= 40 && i <= 45) {
          serviceFailures.push({
            serviceName: 'Spooler',
            timestamp: REPEATED_SERVICE_FAILURE_TIMESTAMP,
            recovered: true,
          });
        }

        rows.push({
          deviceId,
          orgId,
          collectedAt,
          uptimeSeconds,
          bootTime: BOOT_TIME,
          crashEvents,
          appHangs: [],
          serviceFailures,
          hardwareErrors: [],
          rawMetrics: rawMetricsBlob(i),
        });
      }
      await getTestDb().insert(deviceReliabilityHistory).values(rows);
    });
  });

  // No afterAll cleanup needed: the global per-test cleanupDatabase beforeEach
  // in setup.ts truncates all tenant tables (including these) before the next
  // test runs, so a manual delete here would be redundant.

  it('persists golden reliability fields from a projected read of a high-frequency device', async () => {
    const ok = await withSystemDbAccessContext(() => computeAndPersistDeviceReliability(deviceId));
    expect(ok).toBe(true);

    const [row] = await withSystemDbAccessContext(() =>
      getTestDb().select().from(deviceReliability).where(eq(deviceReliability.deviceId, deviceId)).limit(1),
    );
    expect(row).toBeDefined();

    // GOLDEN: global dedup collapses the 25 repeated-crash rows to 1 event, plus
    // the 1 distinct crash on row 30 → 2 total.
    expect(row!.crashCount30d).toBe(2);
    // GOLDEN: the 6 identical Spooler failures (rows 40..45) collapse to 1 event.
    expect(row!.serviceFailureCount30d).toBe(1);

    // Sanity: a bounded, valid score was produced from raw_metrics-free rows.
    expect(row!.reliabilityScore).toBeGreaterThanOrEqual(0);
    expect(row!.reliabilityScore).toBeLessThanOrEqual(100);

    // GOLDEN (pinned from the first real-Postgres green run of this fixture):
    // no hang/hardware events were seeded, so those counts are exactly 0; the
    // device is only "up" (observed) on the single anchor day within the 30/90-day
    // windows, so uptime is low and the score/trend below reflect that shape.
    expect(row!.hangCount30d).toBe(0);
    expect(row!.hardwareErrorCount30d).toBe(0);
    expect(row!.uptime30d).toBeCloseTo(19.35, 2);
    expect(row!.reliabilityScore).toBe(64);
    expect(row!.trendDirection).toBe('stable');
  });

  // #1105 regression lock: computeAndPersistDeviceReliability MUST run under a
  // system context. Its ml-feature-flag gate reads `organizations INNER JOIN
  // partners`, and under an ORG-scoped RLS context the partners row is invisible
  // (breeze_has_partner_access is false for org tokens) → the join yields nothing
  // → the flag resolves `org_not_found` → the compute silently no-ops and persists
  // NOTHING. This is exactly why the ingest route's Redis-outage fallback opens a
  // fresh system context instead of reusing its org context. If a future change
  // "simplifies" that back to org scope, this test fails.
  it('silently no-ops (persists nothing) when run under an org-scoped context', async () => {
    const orgContext = {
      scope: 'organization' as const,
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [],
      currentPartnerId: null,
    };

    const ok = await withDbAccessContext(orgContext, () => computeAndPersistDeviceReliability(deviceId));
    expect(ok).toBe(false);

    const rows = await withSystemDbAccessContext(() =>
      getTestDb().select().from(deviceReliability).where(eq(deviceReliability.deviceId, deviceId)).limit(1),
    );
    expect(rows).toHaveLength(0);
  });
});
