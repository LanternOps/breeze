import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { withSystemDbAccessContext } from '../../db';
import { deviceReliability, deviceReliabilityHistory, devices } from '../../db/schema';
import { computeAndPersistDeviceReliability } from '../../services/reliabilityScoring';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;

let agentCounter = 0;
async function insertDevice(
  orgId: string,
  siteId: string,
  deviceRole: string,
): Promise<string> {
  agentCounter++;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `reliability-weights-${Date.now()}-${agentCounter}`,
      hostname: `reliability-weights-host-${agentCounter}`,
      displayName: `reliability-weights-host-${agentCounter}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      deviceRole,
      // Enrolled well before the lookback window so uptime is computed over the
      // full 30/90 day windows rather than clamped to "up since enrollment".
      enrolledAt: new Date(Date.now() - 120 * DAY_MS),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertDevice returned no row');
  return row.id;
}

// Seed a single low-uptime history snapshot, with no crashes/hangs/service/
// hardware faults — i.e. a "clean" device whose only weak factor is uptime.
// Uptime is now real availability (observed up-days / window): a device enrolled
// 120 days ago with just ONE day of reliability history is treated as offline
// for the other ~90 days, so availability is a few percent and the uptime factor
// scores 0. That is what isolates the device-type weighting in the assertions
// below (the uptime factor matters for the infra profile, not the workstation).
async function insertLowUptimeHistory(orgId: string, deviceId: string): Promise<void> {
  const collectedAt = new Date(Date.now() - 1 * DAY_MS);
  await getTestDb()
    .insert(deviceReliabilityHistory)
    .values({
      orgId,
      deviceId,
      collectedAt,
      uptimeSeconds: 12 * 3600,
      bootTime: new Date(collectedAt.getTime() - 12 * 3600 * 1000),
    });
}

async function getPersistedReliability(deviceId: string) {
  const [row] = await getTestDb()
    .select({
      reliabilityScore: deviceReliability.reliabilityScore,
      details: deviceReliability.details,
      topIssues: deviceReliability.topIssues,
    })
    .from(deviceReliability)
    .where(eq(deviceReliability.deviceId, deviceId))
    .limit(1);
  return row ?? null;
}

describe('reliability device-type-aware weight profile integration (#1721)', () => {
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, name: 'Reliability Weights Org' });
    orgId = org.id;
    const site = await createSite({ orgId, name: 'Reliability Weights Site' });
    siteId = site.id;
  });

  it('persists the infra weight profile (uptime weighted 30) for a server device', async () => {
    const deviceId = await insertDevice(orgId, siteId, 'server');
    await insertLowUptimeHistory(orgId, deviceId);

    const computed = await withSystemDbAccessContext(() =>
      computeAndPersistDeviceReliability(deviceId),
    );
    expect(computed).toBe(true);

    const row = await getPersistedReliability(deviceId);
    expect(row).not.toBeNull();
    const details = row!.details as { weightProfile?: string; factors?: Record<string, { weight?: number }> };
    expect(details.weightProfile).toBe('infra');
    expect(details.factors?.uptime?.weight).toBe(30);
  });

  it('persists the workstation profile (uptime weighted 0) and suppresses the uptime top-issue', async () => {
    const deviceId = await insertDevice(orgId, siteId, 'workstation');
    await insertLowUptimeHistory(orgId, deviceId);

    const computed = await withSystemDbAccessContext(() =>
      computeAndPersistDeviceReliability(deviceId),
    );
    expect(computed).toBe(true);

    const row = await getPersistedReliability(deviceId);
    expect(row).not.toBeNull();
    const details = row!.details as { weightProfile?: string; factors?: Record<string, { weight?: number }> };
    expect(details.weightProfile).toBe('workstation');
    expect(details.factors?.uptime?.weight).toBe(0);

    const topIssues = (row!.topIssues ?? []) as Array<{ type: string }>;
    expect(topIssues.find((issue) => issue.type === 'uptime')).toBeUndefined();
  });

  it('a clean low-uptime workstation scores higher than the same device as a server', async () => {
    const serverId = await insertDevice(orgId, siteId, 'server');
    const workstationId = await insertDevice(orgId, siteId, 'workstation');
    await insertLowUptimeHistory(orgId, serverId);
    await insertLowUptimeHistory(orgId, workstationId);

    await withSystemDbAccessContext(async () => {
      await computeAndPersistDeviceReliability(serverId);
      await computeAndPersistDeviceReliability(workstationId);
    });

    const serverRow = await getPersistedReliability(serverId);
    const workstationRow = await getPersistedReliability(workstationId);
    expect(serverRow).not.toBeNull();
    expect(workstationRow).not.toBeNull();
    // Uptime no longer drags the workstation's weighted total down.
    expect(workstationRow!.reliabilityScore).toBeGreaterThan(serverRow!.reliabilityScore);
  });

  // Issue #1908 (a/b): rate-normalization wiring, end to end. Two identical
  // workstations (uptime weight 0, so only fault factors drive the score) carry
  // the SAME single crash inside the 30d window. The one that reported on fewer
  // days has a higher per-up-day crash rate, so its persisted score must be
  // strictly lower. This exercises countObservedUpDaysInWindow → the four scorer
  // call sites in computeAndPersistDeviceReliability — a regression that dropped
  // the observedUpDays30 argument (reverting to the default 30) would fail here.
  it('rate-normalizes faults by observed up-days: fewer reporting days → lower score (#1908)', async () => {
    // One crash, 2 days ago, identical for both devices (same distinct key).
    const crashTs = new Date(Date.now() - 2 * DAY_MS).toISOString();
    const seedReportingDays = async (deviceId: string, days: number): Promise<void> => {
      for (let i = 1; i <= days; i++) {
        const collectedAt = new Date(Date.now() - i * DAY_MS);
        await getTestDb()
          .insert(deviceReliabilityHistory)
          .values({
            orgId,
            deviceId,
            collectedAt,
            uptimeSeconds: 12 * 3600,
            bootTime: new Date(collectedAt.getTime() - 12 * 3600 * 1000),
            crashEvents: i === 2 ? [{ type: 'bsod', timestamp: crashTs }] : [],
          });
      }
    };

    const sparseId = await insertDevice(orgId, siteId, 'workstation'); // 14 reporting days
    const denseId = await insertDevice(orgId, siteId, 'workstation'); // 28 reporting days
    await seedReportingDays(sparseId, 14);
    await seedReportingDays(denseId, 28);

    await withSystemDbAccessContext(async () => {
      await computeAndPersistDeviceReliability(sparseId);
      await computeAndPersistDeviceReliability(denseId);
    });

    const sparse = await getPersistedReliability(sparseId);
    const dense = await getPersistedReliability(denseId);
    expect(sparse).not.toBeNull();
    expect(dense).not.toBeNull();
    // Same single crash, fewer observed up-days → higher rate → strictly lower score.
    expect(sparse!.reliabilityScore).toBeLessThan(dense!.reliabilityScore);
  });
});
