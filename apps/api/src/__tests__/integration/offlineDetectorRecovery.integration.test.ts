/** Real RLS/CAS and BullMQ proofs for Track C's offline transition review fixes. */
import './setup';
import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, db, withDbAccessContext } from '../../db';
import { alerts, alertRules, alertTemplates, devices, offlineTransitionEffects } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getAppDb, getTestDb } from './setup';
import { findDueOfflineEffects } from '../../services/offlineEffectsStore';
import { processOfflineEffect } from '../../services/offlineTransitionEffects';
import { closeRedis, getBullMQConnection } from '../../services/redis';
import { publishEvent } from '../../services/eventBus';
import {
  getOfflineQueue,
  offlineTransitionId,
  processDetectOffline,
  processMarkOffline,
  shutdownOfflineDetector,
  transitionDeviceOffline,
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

    expect(await processMarkOffline(data)).toEqual({ transitioned: true, alertCreated: false });
    for (let pass = 0; pass < 4; pass++) {
      for (const id of await findDueOfflineEffects()) await processOfflineEffect(id);
    }
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
    worker = new Worker<MarkOfflineJobData | { type: 'offline-effect'; effectId: string }>('offline-detection', async (job) => {
      if (job.data.type === 'offline-effect') return processOfflineEffect(job.data.effectId);
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
      await vi.waitFor(() => expect(vi.mocked(publishEvent)).toHaveBeenCalledTimes(1));
      const [current] = await getTestDb().select().from(devices).where(eq(devices.id, device.id));
      expect(current!.status).toBe('offline');
    } finally {
      release();
    }
  });
});

// #6503 follow-up: transitionDeviceOffline is called from inside the agent WS
// handlers' already-open ORG-scoped withDbAccessContext (routes/agentWs.ts's
// runWithAgentDbAccess), not from a bare BullMQ job like processMarkOffline
// above. CI caught what the mocked unit suite could not: under real RLS, the
// offline_transition_effects INSERT was denied (42501) from inside that
// ambient org context, and — because the denial happened inside the caller's
// open transaction — the very next statement on the same connection failed
// with "current transaction is aborted". A negative control here (asserting
// the ambient-context call would fail WITHOUT the runOutsideDbContext +
// withSystemDbAccessContext escape) would require reverting the fix in this
// test file, so instead this proves the fix's actual contract: called from
// inside that same ambient org context, the transition still lands.
describe('transitionDeviceOffline from inside an ambient org-scoped context (#6503)', () => {
  function withSimulatedAgentWsContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    // Mirrors runWithAgentOrgDbAccess exactly (routes/agentWs.ts) — the WS
    // handlers never carry a userId or partner-axis access.
    return withDbAccessContext(
      { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null },
      fn,
    );
  }

  it('persists the offline transition and flips device status, called from inside an org-scoped context', async () => {
    const { org, device } = await fixture();

    const result = await withSimulatedAgentWsContext(org.id, () =>
      transitionDeviceOffline(device.agentId!, ['online']),
    );

    expect(result).toEqual({ transitioned: true });
    const [current] = await getTestDb().select().from(devices).where(eq(devices.id, device.id));
    expect(current!.status).toBe('offline');
    // The negative control the offlineDetectorRecovery suite above already
    // runs as breeze_app with no context: proves this row is genuinely
    // RLS-visible, not just present because the test helper bypasses RLS.
    const effects = await getTestDb().select().from(offlineTransitionEffects).where(eq(offlineTransitionEffects.deviceId, device.id));
    expect(effects.length).toBeGreaterThan(0);
    expect(effects.every((e) => e.orgId === org.id)).toBe(true);
  });

  it("does NOT poison the caller's ambient transaction after a real offline_transition_effects INSERT", async () => {
    const { org, device } = await fixture();

    // The real bug (pre-fix, head 95d9629a): the INSERT inside
    // persistOfflineTransition ran under the caller's org-scoped RLS context,
    // got denied with 42501, and — because that happened inside the caller's
    // OPEN transaction — every subsequent statement on the same connection
    // failed with "current transaction is aborted". Reproducing that requires
    // the transition to actually REACH the insert (unlike an early-return
    // no-op), and the follow-up read must happen in the SAME ambient
    // transaction the WS handlers actually share between their pre-check
    // select and the transitionDeviceOffline call — a fresh
    // withSimulatedAgentWsContext call per operation would open a NEW
    // connection/transaction each time and could not observe poisoning even
    // if it were still there.
    const { result, afterRead } = await withSimulatedAgentWsContext(org.id, async () => {
      const transitionResult = await transitionDeviceOffline(device.agentId!, ['online']);
      // Same connection, same still-open org transaction as the transition
      // call above — this is exactly the statement that failed with "current
      // transaction is aborted" pre-fix.
      const rows = await db.select().from(devices).where(eq(devices.id, device.id));
      return { result: transitionResult, afterRead: rows };
    });

    expect(result).toEqual({ transitioned: true });
    expect(afterRead[0]?.status).toBe('offline');
  });

  it('does not transition when the device is not online, and leaves the ambient context usable', async () => {
    const { org, device } = await fixture();
    await getTestDb().update(devices).set({ status: 'maintenance' }).where(eq(devices.id, device.id));

    // Unlike the sibling test above, this path returns early (device isn't
    // 'online') before ever reaching the offline_transition_effects INSERT —
    // it cannot exercise transaction-poisoning by RLS denial. It only proves
    // the no-op path itself doesn't leave the ambient context unusable.
    const { result, afterRead } = await withSimulatedAgentWsContext(org.id, async () => {
      const transitionResult = await transitionDeviceOffline(device.agentId!, ['online']);
      const rows = await db.select().from(devices).where(eq(devices.id, device.id));
      return { result: transitionResult, afterRead: rows };
    });

    expect(result).toEqual({ transitioned: false });
    expect(afterRead[0]?.status).toBe('maintenance');
  });

  it('does not leak an offline_transition_effects row across orgs', async () => {
    const { org, device } = await fixture();
    const otherOrg = await createOrganization({ partnerId: org.partnerId! });

    const result = await withSimulatedAgentWsContext(org.id, () =>
      transitionDeviceOffline(device.agentId!, ['online']),
    );
    expect(result).toEqual({ transitioned: true });

    // Same shape as the cross-org negative control in the suite above: an
    // unrelated org's ambient context must see nothing for this device.
    const crossOrgEffects = await withSimulatedAgentWsContext(otherOrg.id, () =>
      db.select().from(offlineTransitionEffects).where(eq(offlineTransitionEffects.deviceId, device.id)),
    );
    expect(crossOrgEffects).toEqual([]);

    const ownOrgEffects = await withSimulatedAgentWsContext(org.id, () =>
      db.select().from(offlineTransitionEffects).where(eq(offlineTransitionEffects.deviceId, device.id)),
    );
    expect(ownOrgEffects.length).toBeGreaterThan(0);
  });
});
