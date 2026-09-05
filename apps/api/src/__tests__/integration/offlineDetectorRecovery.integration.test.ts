/** Real RLS/CAS and BullMQ proofs for Track C's offline transition review fixes. */
import './setup';
import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, db, withDbAccessContext } from '../../db';
import { alerts, alertRules, alertTemplates, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getAppDb, getTestDb } from './setup';
import { closeRedis, getBullMQConnection } from '../../services/redis';
import { publishEvent } from '../../services/eventBus';
import {
  getOfflineQueue,
  offlineTransitionId,
  processDetectOffline,
  processMarkOffline,
  shutdownOfflineDetector,
  type MarkOfflineJobData,
} from '../../jobs/offlineDetector';

// Keep DB reads/writes, Redis and BullMQ real. Publishing/correlation have their
// own delivery contracts; these tests inspect admission without invoking unrelated
// subscribers or starting a second background queue.
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn(async () => 'event-id') }));
vi.mock('../../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(async () => undefined) }));

let worker: Worker | undefined;
afterEach(async () => {
  if (worker) await worker.close();
  worker = undefined;
  await getOfflineQueue().obliterate({ force: true });
  vi.clearAllMocks();
});
afterAll(async () => {
  await shutdownOfflineDetector();
  await closeRedis();
  await closeDb();
});

async function fixture(isEphemeral = false) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const observedLastSeenAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'offline-test',
    osType: 'linux', osVersion: 'test', architecture: 'amd64', agentVersion: 'test',
    status: 'online', lastSeenAt: new Date(observedLastSeenAt), isEphemeral,
  }).returning();
  const data: MarkOfflineJobData = {
    type: 'mark-offline', deviceId: device!.id, orgId: org.id, observedLastSeenAt,
    transitionId: offlineTransitionId(org.id, device!.id, observedLastSeenAt),
  };
  return { org, device: device!, data };
}

describe('offline detector recovery (real Postgres RLS and Redis)', () => {
  it('creates a legacy offline alert as breeze_app and keeps it isolated to its org', async () => {
    const { org, device, data } = await fixture();
    const [template] = await getTestDb().insert(alertTemplates).values({
      orgId: org.id, name: 'Offline fixture', conditions: { type: 'offline' },
      severity: 'high', titleTemplate: '{{deviceName}} offline', messageTemplate: 'Offline fixture',
    }).returning();
    const [rule] = await getTestDb().insert(alertRules).values({
      orgId: org.id, templateId: template!.id, name: 'Offline fixture',
      targetType: 'device', targetId: device.id,
    }).returning();

    // Negative control: the unprivileged connection cannot see this tenant's
    // rules without explicit GUC context. A superuser test would hide the bug.
    const role = await db.execute(sql`SELECT current_user AS role`);
    expect(role[0]?.role).toBe('breeze_app');
    expect(await getAppDb().select().from(alertRules).where(eq(alertRules.id, rule!.id))).toEqual([]);

    expect(await processMarkOffline(data)).toEqual({ transitioned: true, alertCreated: true });
    const created = await getTestDb().select().from(alerts).where(eq(alerts.deviceId, device.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ orgId: org.id, ruleId: rule!.id, status: 'active' });

    const otherOrg = await createOrganization({ partnerId: org.partnerId! });
    const crossOrg = await withDbAccessContext({
      scope: 'organization', orgId: otherOrg.id, accessibleOrgIds: [otherOrg.id],
      accessiblePartnerIds: [], userId: null,
    }, () => db.select().from(alerts).where(eq(alerts.deviceId, device.id)));
    expect(crossOrg).toEqual([]);

    expect(await processMarkOffline(data)).toEqual({ transitioned: false, alertCreated: false });
    expect(vi.mocked(publishEvent).mock.calls.filter(([type]) => type === 'device.offline')).toHaveLength(1);
    expect(await getTestDb().select().from(alerts).where(eq(alerts.deviceId, device.id))).toHaveLength(1);
  });

  it('leaves a reconnected device online and emits nothing for the stale observation', async () => {
    const { device, data } = await fixture(true);
    await getTestDb().update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device.id));
    expect(await processMarkOffline(data)).toEqual({ transitioned: false, alertCreated: false });
    expect(vi.mocked(publishEvent)).not.toHaveBeenCalled();
    const [current] = await getTestDb().select().from(devices).where(eq(devices.id, device.id));
    expect(current!.status).toBe('online');
  });

  it('reuses the observation ID after exhausted failures while deduplicating active work', async () => {
    const { device, data } = await fixture(true);
    let fail = true;
    let attempts = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    worker = new Worker<MarkOfflineJobData>('offline-detection', async (job) => {
      attempts++;
      if (fail) throw new Error('injected pre-CAS database outage');
      await gate;
      return processMarkOffline(job.data);
    }, { connection: getBullMQConnection(), concurrency: 1 });
    const queue = getOfflineQueue();
    try {
      await processDetectOffline({ type: 'detect-offline' });
      await vi.waitFor(async () => {
        expect(attempts).toBe(3);
        expect(await queue.getJob(data.transitionId)).toBeUndefined();
      }, { timeout: 10_000, interval: 30 });
      const [stillOnline] = await getTestDb().select().from(devices).where(eq(devices.id, device.id));
      expect(stillOnline!.status).toBe('online');

      fail = false;
      await processDetectOffline({ type: 'detect-offline' });
      await vi.waitFor(() => expect(attempts).toBe(4));
      // Another sweep while the retry is active must not create a second worker
      // execution. It carries the same observed heartbeat and deterministic ID.
      await processDetectOffline({ type: 'detect-offline' });
      expect(await queue.getWaitingCount()).toBe(0);
      release();
      await vi.waitFor(async () => {
        const job = await queue.getJob(data.transitionId);
        expect(await job?.getState()).toBe('completed');
      });
      expect(attempts).toBe(4);
      expect(vi.mocked(publishEvent)).toHaveBeenCalledTimes(1);
      const [current] = await getTestDb().select().from(devices).where(eq(devices.id, device.id));
      expect(current!.status).toBe('offline');
    } finally {
      release();
    }
  });
});
