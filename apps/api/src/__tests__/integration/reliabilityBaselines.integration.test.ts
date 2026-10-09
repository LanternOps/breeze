import './setup';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { deviceReliability, deviceReliabilityHistory, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import {
  clearReliabilityBaseline, createReliabilityBaseline, listReliabilityBaselines,
} from '../../services/reliabilityBaselines';
import { computeAndPersistDeviceReliability, persistDeviceReliability, scoreDeviceReliabilityAsOf } from '../../services/reliabilityScoring';

const DAY = 86_400_000;
const system: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null };
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(system, fn);

async function deviceWithCrashHistory() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org!.id, siteId: site!.id, agentId: randomUUID(), hostname: 'rb-int', osType: 'windows',
    osVersion: '11', architecture: 'x64', agentVersion: '1.0.0', deviceRole: 'workstation',
    enrolledAt: new Date(Date.now() - 120 * DAY),
  }).returning();
  // 40 daily samples; a BSOD on each of days 25..20 ago.
  const now = Date.now();
  await getTestDb().insert(deviceReliabilityHistory).values(Array.from({ length: 40 }, (_, i) => {
    const collectedAt = new Date(now - (39 - i) * DAY);
    const daysAgo = 39 - i;
    return {
      deviceId: device!.id, orgId: org!.id, collectedAt, uptimeSeconds: 3600,
      bootTime: new Date(collectedAt.getTime() - 3_600_000),
      crashEvents: daysAgo >= 20 && daysAgo <= 25 ? [{ type: 'bsod' as const, timestamp: new Date(collectedAt.getTime() - 60_000).toISOString() }] : [],
    };
  }));
  return { orgId: org!.id, device: { id: device!.id, orgId: org!.id, deviceRole: 'workstation', enrolledAt: new Date(now - 120 * DAY) } };
}

describe('reliability baselines (real DB)', () => {
  it('a marker after the crashes lifts the score and freezes the before snapshot', async () => {
    const { device } = await deviceWithCrashHistory();
    await asSystem(() => computeAndPersistDeviceReliability(device.id));
    const [before] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    expect(before!.crashCount30d).toBeGreaterThan(0);

    const marker = await asSystem(() => createReliabilityBaseline({
      device, reason: 'remediated', baselineAt: new Date(Date.now() - 10 * DAY), note: 'Updated storage driver',
      source: 'manual', sourceRef: null, createdBy: null, recompute: true,
    }));
    expect(marker!.beforeSnapshot!.counts30d.crashes).toBeGreaterThan(0);
    expect(marker!.beforeSnapshot!.reliabilityScore).toBe(before!.reliabilityScore);

    const [after] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    expect(after!.crashCount30d).toBe(0);
    expect(after!.reliabilityScore).toBeGreaterThan(before!.reliabilityScore);
    expect((after!.details as any).baseline).toMatchObject({ id: marker!.id, provisional: true });
  });

  it('clearing the marker restores the unmarked score; clearing twice is reported', async () => {
    const { device } = await deviceWithCrashHistory();
    await asSystem(() => computeAndPersistDeviceReliability(device.id));
    const [unmarked] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    const marker = await asSystem(() => createReliabilityBaseline({
      device, reason: 'reimaged', baselineAt: new Date(Date.now() - 10 * DAY), note: null,
      source: 'manual', sourceRef: null, createdBy: null, recompute: true,
    }));
    expect(await asSystem(() => clearReliabilityBaseline({ deviceId: device.id, baselineId: marker!.id, clearedBy: null }))).toBe('cleared');
    expect(await asSystem(() => clearReliabilityBaseline({ deviceId: device.id, baselineId: marker!.id, clearedBy: null }))).toBe('already_cleared');
    expect(await asSystem(() => clearReliabilityBaseline({ deviceId: device.id, baselineId: randomUUID(), clearedBy: null }))).toBe('not_found');
    const [restored] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    expect(restored!.reliabilityScore).toBe(unmarked!.reliabilityScore);
    expect((restored!.details as any).baseline).toBeUndefined();
  });

  it('a backdated marker earlier than the active one is listed but not effective, with the correct predecessor snapshot', async () => {
    const { device } = await deviceWithCrashHistory();
    const later = await asSystem(() => createReliabilityBaseline({
      device, reason: 'reimaged', baselineAt: new Date(Date.now() - 5 * DAY), note: null,
      source: 'manual', sourceRef: null, createdBy: null, recompute: true,
    }));
    const earlier = await asSystem(() => createReliabilityBaseline({
      device, reason: 'hardware_replaced', baselineAt: new Date(Date.now() - 15 * DAY), note: null,
      source: 'manual', sourceRef: null, createdBy: null, recompute: true,
    }));
    const list = await asSystem(() => listReliabilityBaselines(device.id));
    expect(list.find((m) => m.id === later!.id)!.active).toBe(true);
    expect(list.find((m) => m.id === earlier!.id)!.active).toBe(false);
    // Earlier marker's "before" is scored as of 15d ago with no predecessor → it sees the crashes.
    expect(earlier!.beforeSnapshot!.counts30d.crashes).toBeGreaterThan(0);
    const [row] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    expect((row!.details as any).baseline.id).toBe(later!.id);
  });

  it('compare-and-set skips a stale run that scored against the previous marker', async () => {
    const { device } = await deviceWithCrashHistory();
    await asSystem(() => computeAndPersistDeviceReliability(device.id));
    // A "worker" run computes with no marker…
    const stale = await asSystem(() => scoreDeviceReliabilityAsOf(device, new Date(), null));
    // …a marker lands and recomputes…
    const marker = await asSystem(() => createReliabilityBaseline({
      device, reason: 'reimaged', baselineAt: new Date(Date.now() - 10 * DAY), note: null,
      source: 'manual', sourceRef: null, createdBy: null, recompute: true,
    }));
    // …then the stale run tries to persist: it must be skipped.
    await asSystem(() => persistDeviceReliability(device, stale.values, null));
    const [row] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    expect((row!.details as any).baseline.id).toBe(marker!.id);
    expect(row!.crashCount30d).toBe(0);
  });

  it('an automatic marker is idempotent per recovery, even after it was cleared', async () => {
    const { device } = await deviceWithCrashHistory();
    const recoveryId = randomUUID();
    const input = {
      device, reason: 'reimaged' as const, baselineAt: new Date(Date.now() - DAY), note: null,
      source: 'bare_metal_recovery' as const, sourceRef: recoveryId, createdBy: null, recompute: false,
    };
    const first = await asSystem(() => createReliabilityBaseline(input));
    expect(first).not.toBeNull();
    await asSystem(() => clearReliabilityBaseline({ deviceId: device.id, baselineId: first!.id, clearedBy: null }));
    expect(await asSystem(() => createReliabilityBaseline(input))).toBeNull();
  });

  it('a worker upsert that blocks on the marker transaction re-scores against the committed marker', async () => {
    const { device } = await deviceWithCrashHistory();
    await asSystem(() => computeAndPersistDeviceReliability(device.id));

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let markerWritten!: () => void;
    const markerWrittenSignal = new Promise<void>((resolve) => { markerWritten = resolve; });

    // Tx A: the marker route. Inserts the marker and upserts the marker-aware row,
    // so it holds that row's lock until the gate opens and it commits.
    const txA = asSystem(async () => {
      const created = await createReliabilityBaseline({
        device, reason: 'reimaged', baselineAt: new Date(Date.now() - 10 * DAY), note: null,
        source: 'manual', sourceRef: null, createdBy: null, recompute: true,
      });
      markerWritten();
      await gate;
      return created;
    });
    await Promise.race([markerWrittenSignal, txA]);

    // Tx B: the worker. Its first read cannot see A's uncommitted marker, so it
    // scores stale and its upsert blocks on A's row lock.
    const txB = asSystem(() => computeAndPersistDeviceReliability(device.id));
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseGate();

    const [marker] = await Promise.all([txA, txB]);
    const [row] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    expect((row!.details as any).baseline?.id).toBe(marker!.id);
    expect(row!.crashCount30d).toBe(0);
  });
});
