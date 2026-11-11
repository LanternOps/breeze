import './setup';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbContext from '../../db';
import { devices } from '../../db/schema';
import { deviceWakeAttempts, deviceWakeStatus, type WakeAttemptOutcome } from '../../db/schema/deviceWake';
import { resolveOpenWakeAttempts } from '../../jobs/wakeAttemptSweep';
import { runWakeAttemptRetention } from '../../jobs/wakeAttemptRetention';
import { WAKE_OUTCOME_WINDOW_MS } from '../../services/wakeAttempts';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';
import { insertDevice } from './unassignedPoolFixtures';

const now = new Date('2026-10-31T12:00:00Z');
const requestedAt = new Date(+now - WAKE_OUTCOME_WINDOW_MS);
describe('wake attempt sweep and retention (real Postgres)', () => {
  let orgId: string;
  let siteId: string;
  beforeEach(async () => {
    orgId = (await createOrganization({ partnerId: (await createPartner()).id })).id;
    siteId = (await createSite({ orgId })).id;
  });
  async function seed(outcome: WakeAttemptOutcome = 'sent', lastSeenAt: Date | null = null, uptimeSeconds: number | null = null, requested = requestedAt) {
    const device = await insertDevice(orgId, siteId);
    await getTestDb().update(devices).set({ lastSeenAt, uptimeSeconds }).where(eq(devices.id, device.id));
    const [attempt] = await getTestDb().insert(deviceWakeAttempts).values({ deviceId: device.id, orgId, outcome,
      requestedAt: requested, deadlineAt: new Date(+requested + WAKE_OUTCOME_WINDOW_MS) }).returning();
    return attempt!;
  }
  const attempt = async (id: string) => (await getTestDb().select().from(deviceWakeAttempts).where(eq(deviceWakeAttempts.id, id)))[0];
  const status = async (deviceId: string) => (await getTestDb().select().from(deviceWakeStatus).where(eq(deviceWakeStatus.deviceId, deviceId)))[0];

  it.each([0, 600, 601, null])('boot_after_send with uptime %s; creates status without proof when absent', async uptime => {
    const a = await seed('sent', now, uptime);
    await resolveOpenWakeAttempts(() => now);
    expect(await attempt(a.id)).toMatchObject({ outcome: 'came_online', resolvedAt: now, bootAfterSend: uptime !== null && uptime <= 600 });
    expect(await status(a.deviceId)).toMatchObject({ orgId, lastCameOnlineAt: now, proofFingerprint: null, consecutiveTimeouts: 0 });
  });
  it('boot_after_send measures from the last sighting, not the current time', async () => {
    const lastSeen = new Date(+now - 120_000);
    const booted = await seed('sent', lastSeen, 480);
    const earlier = await seed('sent', lastSeen, 481);
    await resolveOpenWakeAttempts(() => now);
    expect(await attempt(booted.id)).toMatchObject({ outcome: 'came_online', bootAfterSend: true });
    expect(await attempt(earlier.id)).toMatchObject({ outcome: 'came_online', bootAfterSend: false });
  });
  it('closes promptly before deadline, using current fingerprint and clearing timeouts', async () => {
    const a = await seed('pending', now, 0, new Date(+now - 60_000));
    await getTestDb().insert(deviceWakeStatus).values({ deviceId: a.deviceId, orgId, fingerprint: 'current', proofFingerprint: 'old', consecutiveTimeouts: 3 });
    expect(await resolveOpenWakeAttempts(() => now)).toEqual({ resolved: 1 });
    expect(await status(a.deviceId)).toMatchObject({ lastCameOnlineAt: now, proofFingerprint: 'current', consecutiveTimeouts: 0 });
  });
  it('increments timeouts exactly once across repeated and concurrent sweeps', async () => {
    const a = await seed();
    await getTestDb().insert(deviceWakeStatus).values({ deviceId: a.deviceId, orgId, consecutiveTimeouts: 2 });
    const results = await Promise.all([resolveOpenWakeAttempts(() => now), resolveOpenWakeAttempts(() => now)]);
    expect(results.reduce((n, r) => n + r.resolved, 0)).toBe(1);
    expect(await resolveOpenWakeAttempts(() => now)).toEqual({ resolved: 0 });
    expect(await status(a.deviceId)).toMatchObject({ consecutiveTimeouts: 3 });
    expect(await attempt(a.id)).toMatchObject({ outcome: 'timed_out', resolvedAt: now });
  });
  it('creates a status row for a timeout', async () => {
    const a = await seed();
    await resolveOpenWakeAttempts(() => now);
    expect(await status(a.deviceId)).toMatchObject({ orgId, consecutiveTimeouts: 1 });
  });
  it.each(['pending', 'sent', 'refused', 'send_failed'] as const)('%s does not change status for send failure, unknown, or closed attempts', async outcome => {
    const a = await seed(outcome, outcome === 'sent' ? now : null);
    await getTestDb().insert(deviceWakeStatus).values({ deviceId: a.deviceId, orgId, consecutiveTimeouts: 4, fingerprint: 'same' });
    const before = await status(a.deviceId);
    await resolveOpenWakeAttempts(() => new Date(+now + 120_001));
    expect(await status(a.deviceId)).toEqual(before);
    expect((await attempt(a.id))!.outcome).toBe(outcome === 'pending' ? 'send_failed' : outcome === 'sent' ? 'unknown' : outcome);
  });
  it('evaluates all eligible attempts in bounded batches in one run', async () => {
    await seed();
    await seed('pending', now, 0, new Date(+now - 60_000));
    await seed();
    expect(await resolveOpenWakeAttempts(() => now, 1)).toEqual({ resolved: 3 });
  });
  it('uses fresh time and heartbeat evidence when a batch crosses the grace boundary', async () => {
    const rows = [await seed(), await seed()].sort((a, b) => a.id.localeCompare(b.id));
    const [early, late] = rows as [typeof rows[number], typeof rows[number]];
    await getTestDb().update(devices).set({ lastSeenAt: now, uptimeSeconds: 0 }).where(eq(devices.id, early.deviceId));
    for (const row of rows) {
      await getTestDb().insert(deviceWakeStatus).values({ deviceId: row.deviceId, orgId,
        fingerprint: 'current', proofFingerprint: 'old', consecutiveTimeouts: 3 });
    }
    const lateStatus = await status(late.deviceId);
    let effectiveTime = now;
    const clock = () => effectiveTime;
    const pastGrace = new Date(+now + 120_001);
    const original = dbContext.withSystemDbAccessContext;
    let resolving = 0;
    const spy = vi.spyOn(dbContext, 'withSystemDbAccessContext').mockImplementation(async (fn, label) => {
      if (label === 'wakeAttemptSweep.resolve' && ++resolving === 2) {
        effectiveTime = pastGrace;
        await getTestDb().update(devices).set({ lastSeenAt: pastGrace, uptimeSeconds: 0 })
          .where(eq(devices.id, late.deviceId));
      }
      return original(fn, label);
    });
    try { expect(await resolveOpenWakeAttempts(clock, 2)).toEqual({ resolved: 2 }); }
    finally { spy.mockRestore(); }
    expect(await attempt(early.id)).toMatchObject({ outcome: 'came_online', resolvedAt: now, bootAfterSend: true });
    expect(await status(early.deviceId)).toMatchObject({ lastCameOnlineAt: now, proofFingerprint: 'current', consecutiveTimeouts: 0 });
    expect(await attempt(late.id)).toMatchObject({ outcome: 'unknown', resolvedAt: pastGrace });
    expect(await status(late.deviceId)).toEqual(lateStatus);
  });
  it('leaves unseen attempts before deadline open without starving a due attempt', async () => {
    const waiting = await seed('pending', null, null, now);
    const due = await seed();
    expect(await resolveOpenWakeAttempts(() => now, 1)).toEqual({ resolved: 1 });
    expect((await attempt(waiting.id))!.outcome).toBe('pending');
    expect((await attempt(due.id))!.outcome).toBe('timed_out');
  });
  it.each(['delete', 'move'] as const)('a device %s between selection and finalisation does not abort the batch', async action => {
    const a = await seed();
    const b = await seed();
    const otherOrg = await createOrganization({ partnerId: (await createPartner()).id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    const original = dbContext.withSystemDbAccessContext;
    let changed = false;
    const spy = vi.spyOn(dbContext, 'withSystemDbAccessContext').mockImplementation(async (fn, label) => {
      if (label === 'wakeAttemptSweep.resolve' && !changed) {
        changed = true;
        if (action === 'delete') await getTestDb().delete(devices).where(eq(devices.id, a.deviceId));
        else await getTestDb().update(devices).set({ orgId: otherOrg.id, siteId: otherSite.id }).where(eq(devices.id, a.deviceId));
      }
      return original(fn, label);
    });
    try { await resolveOpenWakeAttempts(() => now); } finally { spy.mockRestore(); }
    expect(changed).toBe(true);
    expect((await attempt(b.id))!.outcome).toBe('timed_out');
    if (action === 'delete') expect(await attempt(a.id)).toBeUndefined();
    else {
      await resolveOpenWakeAttempts(() => now);
      expect(await status(a.deviceId)).toMatchObject({ orgId: otherOrg.id, consecutiveTimeouts: 1 });
    }
  });
  it('rolls back a failed attempt and continues resolving other attempts', async () => {
    const a = await seed();
    const b = await seed();
    const original = dbContext.withSystemDbAccessContext;
    let failed = false;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(dbContext, 'withSystemDbAccessContext').mockImplementation((fn, label) => original(async () => {
      const result = await fn();
      if (label === 'wakeAttemptSweep.resolve' && !failed) { failed = true; throw new Error('injected transaction failure'); }
      return result;
    }, label));
    try { expect(await resolveOpenWakeAttempts(() => now)).toEqual({ resolved: 1 }); } finally { spy.mockRestore(); log.mockRestore(); }
    const rows = [await attempt(a.id), await attempt(b.id)];
    expect(rows.map(r => r!.outcome).sort()).toEqual(['sent', 'timed_out']);
    const open = rows.find(r => r!.outcome === 'sent')!;
    expect(await status(open.deviceId)).toBeUndefined();
    expect(await resolveOpenWakeAttempts(() => now)).toEqual({ resolved: 1 });
  });
  it('retention prunes closed attempts older than 90 days and leaves open ones', async () => {
    const old = new Date(Date.now() - 91 * 86_400_000);
    const closed = await Promise.all((['came_online', 'timed_out', 'send_failed', 'unknown', 'refused'] as const).map(outcome => seed(outcome, null, null, old)));
    const pending = await seed('pending', null, null, old);
    const sent = await seed('sent', null, null, old);
    const recent = await seed('timed_out', null, null, new Date());
    expect(await runWakeAttemptRetention({ batchSize: 2 })).toMatchObject({ deleted: 5, retentionDays: 90 });
    for (const a of closed) expect(await attempt(a.id)).toBeUndefined();
    for (const a of [pending, sent, recent]) expect(await attempt(a.id)).toBeDefined();
  });
});
