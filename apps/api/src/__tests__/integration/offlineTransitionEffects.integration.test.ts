/** Real PostgreSQL + Redis failure boundaries for the offline source outbox. */
import './setup';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { buildOrgExportZip } from '../../services/tenantExport';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, db, hasDbAccessContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { alerts, alertRules, alertTemplates, devices, configurationPolicies, configPolicyAssignments, configPolicyFeatureLinks, configPolicyAlertRules, configPolicyMaintenanceSettings, offlineTransitionEffects as effects, type OfflineEffect } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getAppDb, getTestDb, getTestRedis } from './setup';
import { getOfflineQueue, offlineTransitionId, processMarkOffline, shutdownOfflineDetector } from '../../jobs/offlineDetector';
import * as store from '../../services/offlineEffectsStore';
import { processOfflineEffect } from '../../services/offlineTransitionEffects';
import * as eventBus from '../../services/eventBus';
import { applyOfflineAlertPostprocess } from '../../services/offlineAlertPostprocess';
import { closeRedis, getRedis } from '../../services/redis';
import { resolveAlert } from '../../services/alertService';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

// Correlation has its own worker tests. All alert/lease/RLS SQL and event Redis
// publication here are real; no external subscriber registry is booted.
vi.mock('../../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(async () => null) }));

afterEach(async () => {
  vi.restoreAllMocks();
  await getOfflineQueue().obliterate({ force: true });
});
afterAll(async () => { await shutdownOfflineDetector(); await closeRedis(); await closeDb(); });

async function fixture(ephemeral = false) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const observedLastSeenAt = new Date(Date.now() - 600_000).toISOString();
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'durable-offline',
    osType: 'linux', osVersion: 'test', architecture: 'amd64', agentVersion: 'test',
    status: 'online', lastSeenAt: new Date(observedLastSeenAt), isEphemeral: ephemeral,
  }).returning();
  const data = { type: 'mark-offline' as const, deviceId: device!.id, orgId: org.id, observedLastSeenAt,
    transitionId: offlineTransitionId(org.id, device!.id, observedLastSeenAt) };
  return { partner, org, site, device: device!, data };
}
async function pending(deviceId: string, kind?: OfflineEffect['kind']) {
  return getTestDb().select().from(effects).where(and(eq(effects.deviceId, deviceId), ...(kind ? [eq(effects.kind, kind)] : [])));
}
async function executeKind(deviceId: string, kind: OfflineEffect['kind']) {
  const rows = (await pending(deviceId, kind)).filter((e) => !e.completedAt);
  for (const row of rows) await processOfflineEffect(row.id);
  return rows;
}
async function addRule(orgId: string, deviceId: string, cooldown = 5) {
  const [template] = await getTestDb().insert(alertTemplates).values({ orgId, name: 'Offline fixture',
    conditions: { type: 'offline' }, severity: 'high', titleTemplate: '{{deviceName}} offline', messageTemplate: 'Offline fixture', cooldownMinutes: cooldown,
  }).returning();
  const [rule] = await getTestDb().insert(alertRules).values({ orgId, templateId: template!.id, name: 'Offline rule', targetType: 'device', targetId: deviceId }).returning();
  return rule!;
}
async function addPolicy(f: Awaited<ReturnType<typeof fixture>>, duration = 5, maintenance = false) {
  const [policy] = await getTestDb().insert(configurationPolicies).values({ orgId: f.org.id, name: 'Offline policy' }).returning();
  await getTestDb().insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'device', targetId: f.device.id });
  const [link] = await getTestDb().insert(configPolicyFeatureLinks).values({ configPolicyId: policy!.id, featureType: 'alert_rule' }).returning();
  const [rule] = await getTestDb().insert(configPolicyAlertRules).values({ featureLinkId: link!.id, name: 'Offline policy rule', severity: 'high', conditions: { type: 'offline', durationMinutes: duration }, cooldownMinutes: 5 }).returning();
  if (maintenance) {
    const [windowLink] = await getTestDb().insert(configPolicyFeatureLinks).values({ configPolicyId: policy!.id, featureType: 'maintenance' }).returning();
    await getTestDb().insert(configPolicyMaintenanceSettings).values({ featureLinkId: windowLink!.id, recurrence: 'daily', timezone: 'UTC',
      windowStart: '00:00', durationHours: 24, suppressAlerts: true });
  }
  return rule!;
}

async function admitAlert(f: Awaited<ReturnType<typeof fixture>>) {
  await processMarkOffline(f.data);
  await executeKind(f.device.id, 'alert-plan');
  await executeKind(f.device.id, 'alert-rule');
}
async function retryNow(id: string) {
  await getTestDb().update(effects).set({ availableAt: new Date(0), leaseUntil: null, leaseToken: null }).where(eq(effects.id, id));
}
async function nextObservation(f: Awaited<ReturnType<typeof fixture>>) {
  const observedLastSeenAt = new Date(new Date(f.data.observedLastSeenAt).getTime() + 1_000).toISOString();
  await getTestDb().update(devices).set({ status: 'online', lastSeenAt: new Date(observedLastSeenAt) }).where(eq(devices.id, f.device.id));
  return { ...f, data: { ...f.data, observedLastSeenAt, transitionId: offlineTransitionId(f.org.id, f.device.id, observedLastSeenAt) } };
}

describe('durable offline effects', () => {
  it('commits recoverable pending work with CAS and a duplicate cannot re-admit it', async () => {
    const f = await fixture(true);
    expect(await processMarkOffline(f.data)).toEqual({ transitioned: true, alertCreated: false });
    const rows = await pending(f.device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'offline-event', completedAt: null, orgId: f.org.id });
    expect(await processMarkOffline(f.data)).toEqual({ transitioned: false, alertCreated: false });
    expect(await pending(f.device.id)).toHaveLength(1);
    expect(await store.findDueOfflineEffects()).toContain(rows[0]!.id);
    const [current] = await getTestDb().select().from(devices).where(eq(devices.id, f.device.id));
    expect(current!.status).toBe('offline');
  });

  it('enqueues committed children outside database scope and recovers them if enqueue fails', async () => {
    const f = await fixture();
    await addRule(f.org.id, f.device.id);
    await processMarkOffline(f.data);
    const [plan] = await pending(f.device.id, 'alert-plan');
    const enqueue = vi.fn(async (ids: string[]) => {
      expect(hasDbAccessContext()).toBe(false);
      expect(ids).toHaveLength(1);
      const [persisted] = await getTestDb().select().from(effects).where(eq(effects.id, ids[0]!));
      expect(persisted?.kind).toBe('alert-rule');
      throw new Error('child queue unavailable');
    });
    await expect(processOfflineEffect(plan!.id, enqueue)).rejects.toThrow('child queue unavailable');
    expect(enqueue).toHaveBeenCalledOnce();
    const [committedPlan] = await pending(f.device.id, 'alert-plan');
    expect(committedPlan!.completedAt).not.toBeNull();
    const [rule] = await pending(f.device.id, 'alert-rule');
    expect(await store.findDueOfflineEffects()).toContain(rule!.id);
    await processOfflineEffect(rule!.id);
    expect(await getTestDb().select().from(alerts).where(eq(alerts.deviceId, f.device.id))).toHaveLength(1);
  });

  it('rolls status and already-inserted pending effects back together on admission failure', async () => {
    const f = await fixture();
    const persist = store.persistOfflineTransition;
    vi.spyOn(store, 'persistOfflineTransition').mockImplementationOnce(async (...args) => {
      await persist(...args);
      throw new Error('injected after outbox insert');
    });
    await expect(processMarkOffline(f.data)).rejects.toThrow('injected after outbox insert');
    expect(await pending(f.device.id)).toEqual([]);
    const [current] = await getTestDb().select().from(devices).where(eq(devices.id, f.device.id));
    expect(current!.status).toBe('online');
  });

  it('recovers after committed CAS even when immediate queue publication fails', async () => {
    const f = await fixture(true);
    vi.spyOn(getOfflineQueue(), 'addBulk').mockRejectedValueOnce(new Error('injected Redis admission outage'));
    await expect(processMarkOffline(f.data)).rejects.toThrow('injected Redis admission outage');
    const [effect] = await pending(f.device.id);
    expect(await store.findDueOfflineEffects()).toContain(effect!.id);
    await processOfflineEffect(effect!.id);
    expect((await pending(f.device.id))[0]!.completedAt).not.toBeNull();
    expect(await getTestRedis().xlen(`breeze:events:${f.org.id}`)).toBe(1);
  });

  it('keeps publication failure pending and recovers with the same event identity', async () => {
    const f = await fixture(true);
    await processMarkOffline(f.data);
    const [effect] = await pending(f.device.id);
    vi.spyOn(eventBus, 'publishEvent').mockRejectedValueOnce(new Error('injected XADD failure'));
    await expect(processOfflineEffect(effect!.id)).rejects.toThrow('injected XADD failure');
    const [failed] = await pending(f.device.id);
    expect(failed).toMatchObject({ completedAt: null, attempts: 1, leaseToken: null, lastError: 'effect_delivery_failed' });
    expect(failed!.availableAt.getTime()).toBeGreaterThan(Date.now() - 50);
    await retryNow(effect!.id);
    await processOfflineEffect(effect!.id);
    const stream = await getTestRedis().xrange(`breeze:events:${f.org.id}`, '-', '+');
    expect(JSON.parse(stream[0]![1][1]!)).toMatchObject({ id: effect!.id, orgId: f.org.id });
  });

  it('reclaims a crashed publisher and redelivers one logical identity after send-before-ack', async () => {
    const f = await fixture(true);
    await processMarkOffline(f.data);
    const [row] = await pending(f.device.id);
    const first = await store.claimOfflineEffect(row!.id);
    expect(first).toBeDefined();
    expect(await store.claimOfflineEffect(row!.id)).toBeUndefined();
    const payload = first!.payload;
    if (payload.type !== 'offline-event') throw new Error('fixture kind');
    await eventBus.publishEvent('device.offline', f.org.id, { deviceId: f.device.id, hostname: f.device.hostname,
      displayName: f.device.displayName, lastSeenAt: f.data.observedLastSeenAt }, 'offline-detector', {
      eventId: first!.id, occurredAt: first!.createdAt.toISOString(), siteId: f.site.id,
    });
    // Persisted lease + stream entry is the exact process-death boundary.
    await getTestDb().update(effects).set({ leaseUntil: new Date(0) }).where(eq(effects.id, first!.id));
    await processOfflineEffect(first!.id);
    const events = (await getTestRedis().xrange(`breeze:events:${f.org.id}`, '-', '+')).map(([, fields]) => JSON.parse(fields[1]!));
    expect(events).toHaveLength(2); // truthful at-least-once physical delivery
    expect(events[1]).toEqual(events[0]);
    expect(events[0].id).toBe(first!.id);
    expect((await pending(f.device.id))[0]!.completedAt).not.toBeNull();
  });

  it('rolls back child admission if the final lease fence expires inside the transaction', async () => {
    const f = await fixture();
    await processMarkOffline(f.data);
    const [plan] = await pending(f.device.id, 'alert-plan');
    const claimed = await store.claimOfflineEffect(plan!.id);
    await expect(store.withOfflineEffectLease(claimed!, async () => {
      await db.update(effects).set({ leaseUntil: new Date(0) }).where(eq(effects.id, claimed!.id));
      await store.insertOfflineEffect(claimed!, { type: 'alert-event', siteId: f.site.id, occurredAt: new Date().toISOString(), event: { deviceId: f.device.id } }, randomUUID());
      await store.finishOfflineEffect(claimed!);
    })).rejects.toThrow('lease expired');
    expect(await pending(f.device.id, 'alert-event')).toHaveLength(0);
    expect((await pending(f.device.id, 'alert-plan'))[0]!.completedAt).toBeNull();
  });

  it('rejects stale owner completion after another worker reclaims the expired lease', async () => {
    const f = await fixture(true);
    await processMarkOffline(f.data);
    const [row] = await pending(f.device.id);
    const first = await store.claimOfflineEffect(row!.id);
    await getTestDb().update(effects).set({ leaseUntil: new Date(0) }).where(eq(effects.id, row!.id));
    const second = await store.claimOfflineEffect(row!.id);
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
    expect(await store.withOfflineEffectLease(first!, () => store.finishOfflineEffect(first!))).toBeUndefined();
    expect((await pending(f.device.id))[0]!.completedAt).toBeNull();
    await store.withOfflineEffectLease(second!, () => store.finishOfflineEffect(second!));
  });

  it('atomically admits one alert and pending consequences; resolved-alert retry cannot duplicate it', async () => {
    const f = await fixture();
    await addRule(f.org.id, f.device.id);
    await admitAlert(f);
    const created = await getTestDb().select().from(alerts).where(eq(alerts.deviceId, f.device.id));
    expect(created).toHaveLength(1);
    const posts = await pending(f.device.id, 'alert-postprocess');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.completedAt).toBeNull();
    expect(posts[0]!.cooldownUntil).not.toBeNull();
    expect(await pending(f.device.id, 'alert-event')).toHaveLength(1);
    await getTestDb().update(alerts).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(alerts.id, created[0]!.id));
    const [rule] = await pending(f.device.id, 'alert-rule');
    await getTestDb().update(effects).set({ completedAt: null }).where(eq(effects.id, rule!.id));
    await processOfflineEffect(rule!.id);
    expect(await getTestDb().select().from(alerts).where(eq(alerts.deviceId, f.device.id))).toHaveLength(1);
    expect(await pending(f.device.id, 'alert-event')).toHaveLength(1);
  });

  it('preserves historical offline events but suppresses late alerts after reconnect', async () => {
    const f = await fixture();
    await addRule(f.org.id, f.device.id);
    await processMarkOffline(f.data);
    await executeKind(f.device.id, 'alert-plan');
    await getTestDb().update(devices).set({ status: 'online', lastSeenAt: new Date() }).where(eq(devices.id, f.device.id));
    await executeKind(f.device.id, 'alert-rule');
    await executeKind(f.device.id, 'offline-event');
    expect(await getTestDb().select().from(alerts).where(eq(alerts.deviceId, f.device.id))).toHaveLength(0);
    expect(await getTestRedis().xlen(`breeze:events:${f.org.id}`)).toBe(1);
  });

  it('enforces durable cooldown across two generations while Redis postprocess is stalled', async () => {
    const first = await fixture();
    const rule = await addRule(first.org.id, first.device.id, 5);
    await admitAlert(first);
    const [created] = await getTestDb().select().from(alerts).where(eq(alerts.deviceId, first.device.id));
    await getTestDb().update(alerts).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(alerts.id, created!.id));
    expect(await getTestRedis().exists(`breeze:alerts:cooldown:${rule.id}:${first.device.id}`)).toBe(0);
    await admitAlert(await nextObservation(first));
    expect(await getTestDb().select().from(alerts).where(eq(alerts.deviceId, first.device.id))).toHaveLength(1);
    expect(await pending(first.device.id, 'alert-postprocess')).toHaveLength(1);
  });

  it('records durable cooldown-only flapping suppression without an alert or false trigger', async () => {
    let f = await fixture();
    const rule = await addRule(f.org.id, f.device.id, 0);
    for (let i = 0; i < 2; i++) {
      await admitAlert(f);
      await getTestDb().update(alerts).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(alerts.deviceId, f.device.id));
      f = await nextObservation(f);
    }
    await getTestDb().update(alertTemplates).set({ cooldownMinutes: 5 }).where(eq(alertTemplates.id, rule.templateId));
    await admitAlert(f);
    expect(await getTestDb().select().from(alerts).where(eq(alerts.deviceId, f.device.id))).toHaveLength(2);
    const receipts = await pending(f.device.id, 'alert-postprocess');
    expect(receipts).toHaveLength(3);
    const suppressed = receipts.find((r) => r.transitionId === f.data.transitionId)!;
    expect(suppressed.payload).toMatchObject({ recordTrigger: false, alertId: null });
    expect(suppressed.cooldownUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('projects cooldown and flapping idempotently without extending an old deadline', async () => {
    const f = await fixture();
    const rule = await addRule(f.org.id, f.device.id);
    await admitAlert(f);
    const [post] = await pending(f.device.id, 'alert-postprocess');
    await applyOfflineAlertPostprocess(getTestRedis(), post!);
    const ttl = await getTestRedis().pttl(`breeze:alerts:cooldown:${rule.id}:${f.device.id}`);
    await applyOfflineAlertPostprocess(getTestRedis(), post!);
    expect(await getTestRedis().llen(`breeze:alerts:flap:${rule.id}:${f.device.id}`)).toBe(1);
    expect(await getTestRedis().pttl(`breeze:alerts:cooldown:${rule.id}:${f.device.id}`)).toBeLessThanOrEqual(ttl);
  });

  it('retains long cooldown receipts and all pending rows while pruning old expired terminal work', async () => {
    const f = await fixture();
    const old = new Date(Date.now() - 20 * 86400_000);
    const base = { transitionId: randomUUID(), orgId: f.org.id, deviceId: f.device.id, ruleId: randomUUID(), kind: 'alert-postprocess' as const,
      createdAt: old, availableAt: old, payload: { type: 'alert-postprocess' as const, ruleId: randomUUID(), policy: false, alertId: null,
        occurredAt: old.toISOString(), multiplier: 4, recordTrigger: false } };
    const keepCooldown = randomUUID(), keepPending = randomUUID(), remove = randomUUID();
    await getTestDb().insert(effects).values([
      { ...base, id: keepCooldown, completedAt: old, cooldownUntil: new Date(Date.now() + 8 * 86400_000) },
      { ...base, id: keepPending, completedAt: null, attempts: 1000, cooldownUntil: old },
      { ...base, id: remove, completedAt: old, cooldownUntil: old },
    ]);
    expect(await store.pruneOfflineEffects()).toBe(1);
    const remaining = (await pending(f.device.id)).map((r) => r.id);
    expect(remaining).toContain(keepCooldown); expect(remaining).toContain(keepPending); expect(remaining).not.toContain(remove);
  });

  it('preserves original event ownership after a device move and suppresses pending alerts', async () => {
    const f = await fixture();
    await addRule(f.org.id, f.device.id);
    await processMarkOffline(f.data);
    await executeKind(f.device.id, 'alert-plan');
    const destination = await createOrganization({ partnerId: f.partner.id });
    const site = await createSite({ orgId: destination.id });
    await getTestDb().update(devices).set({ orgId: destination.id, siteId: site.id, hostname: 'destination-secret' }).where(eq(devices.id, f.device.id));
    await executeKind(f.device.id, 'alert-rule');
    await executeKind(f.device.id, 'offline-event');
    expect(await getTestDb().select().from(alerts).where(eq(alerts.deviceId, f.device.id))).toHaveLength(0);
    expect(await getTestRedis().xlen(`breeze:events:${destination.id}`)).toBe(0);
    const entries = await getTestRedis().xrange(`breeze:events:${f.org.id}`, '-', '+');
    expect(entries).toHaveLength(1);
    const [, fields] = entries[0]!;
    expect(JSON.parse(fields![1]!)).toMatchObject({ orgId: f.org.id, siteId: f.site.id, payload: { hostname: 'durable-offline' } });
  });

  it('cancels pending work on device deletion and tenant erasure', async () => {
    const f = await fixture(true);
    await processMarkOffline(f.data);
    const [effect] = await pending(f.device.id);
    await getTestDb().delete(devices).where(eq(devices.id, f.device.id));
    expect(await pending(f.device.id)).toHaveLength(0);
    expect(await processOfflineEffect(effect!.id)).toEqual({ claimed: false });
    const other = await fixture(true);
    await processMarkOffline(other.data);
    const [otherEffect] = await pending(other.device.id);
    await cascadeDeleteOrg(other.org.id, randomUUID());
    expect(await pending(other.device.id)).toHaveLength(0);
    expect(await processOfflineEffect(otherEffect!.id)).toEqual({ claimed: false });
  });

  it('preserves existing adaptive cooldown progression across resolve and the next generation', async () => {
    const f = await fixture();
    const rule = await addRule(f.org.id, f.device.id, 1);
    const old = new Date(Date.now() - 10 * 60_000);
    const alertId = randomUUID();
    // Durable historical trigger fixture, then real cache projection and real
    // resolveAlert: the latter must advance1x to2x, and next admission to4x.
    await getTestDb().insert(alerts).values({ id: alertId, orgId: f.org.id, deviceId: f.device.id, ruleId: rule.id,
      severity: 'high', title: 'Previous offline', triggeredAt: old });
    const [receipt] = await getTestDb().insert(effects).values({ id: randomUUID(), transitionId: randomUUID(), orgId: f.org.id,
      deviceId: f.device.id, kind: 'alert-postprocess', ruleId: rule.id, createdAt: old, cooldownUntil: new Date(old.getTime() + 60_000),
      payload: { type: 'alert-postprocess', ruleId: rule.id, policy: false, alertId, occurredAt: old.toISOString(), multiplier: 1, recordTrigger: true },
    }).returning();
    await applyOfflineAlertPostprocess(getTestRedis(), receipt!);
    await getRedis()!.ping();
    expect(await withSystemDbAccessContext(() => resolveAlert(alertId, 'reconnected'))).toBe(true);
    const adaptiveKey = `breeze:alerts:cooldown:adaptive:${rule.id}:${f.device.id}`;
    expect(JSON.parse((await getTestRedis().get(adaptiveKey))!).multiplier).toBe(2);
    // Emulate expiry of just the cooldown key; the one-hour adaptive history and
    // expired original durable receipt remain, exactly as on the next heartbeat gap.
    await getTestRedis().del(`breeze:alerts:cooldown:${rule.id}:${f.device.id}`);
    await admitAlert(f);
    const current = (await pending(f.device.id, 'alert-postprocess')).find((r) => r.transitionId === f.data.transitionId)!;
    expect(current.payload).toMatchObject({ multiplier: 4, recordTrigger: true });
    expect(current.cooldownUntil!.getTime() - new Date((current.payload as { occurredAt: string }).occurredAt).getTime()).toBe(4 * 60_000);
  });

  it('creates a policy alert with cpar cooldown and retries atomic child admission failure', async () => {
    const f = await fixture();
    const rule = await addPolicy(f);
    await processMarkOffline(f.data);
    await executeKind(f.device.id, 'alert-plan');
    const insert = store.insertOfflineEffect;
    vi.spyOn(store, 'insertOfflineEffect').mockImplementation(async (...args) => {
      const id = await insert(...args);
      if (args[1].type === 'alert-event') throw new Error('injected after alert child insert');
      return id;
    });
    await expect(executeKind(f.device.id, 'alert-rule')).rejects.toThrow('injected after alert child insert');
    expect(await getTestDb().select().from(alerts).where(eq(alerts.deviceId, f.device.id))).toHaveLength(0);
    expect(await pending(f.device.id, 'alert-event')).toHaveLength(0);
    vi.restoreAllMocks();
    const [task] = await pending(f.device.id, 'alert-rule');
    await retryNow(task!.id);
    await executeKind(f.device.id, 'alert-rule');
    const [alert] = await getTestDb().select().from(alerts).where(eq(alerts.deviceId, f.device.id));
    expect(alert).toMatchObject({ configPolicyId: rule.id, configItemName: rule.name, ruleId: null });
    const [event] = await pending(f.device.id, 'alert-event');
    expect(event!.payload).toMatchObject({ type: 'alert-event', event: { configPolicyAlertRuleId: rule.id, source: 'config_policy' } });
    await executeKind(f.device.id, 'alert-postprocess');
    expect(await getTestRedis().exists(`breeze:alerts:cooldown:cpar:${rule.id}:${f.device.id}`)).toBe(1);
  });

  it.each([{ duration: 60, maintenance: false }, { duration: 5, maintenance: true }])('skips policy conditions that are false or suppressed by maintenance: %j', async ({ duration, maintenance }) => {
    const f = await fixture();
    await addPolicy(f, duration, maintenance);
    await admitAlert(f);
    expect(await getTestDb().select().from(alerts).where(eq(alerts.deviceId, f.device.id))).toHaveLength(0);
    expect((await pending(f.device.id, 'alert-rule'))[0]!.completedAt).not.toBeNull();
  });

  it('isolates invalid cooldown work without starving valid policy or legacy siblings', async () => {
    const f = await fixture();
    const invalid = await addRule(f.org.id, f.device.id);
    await getTestDb().update(alertRules).set({ overrideSettings: { cooldownMinutes: 'invalid' } }).where(eq(alertRules.id, invalid.id));
    await addRule(f.org.id, f.device.id);
    await addPolicy(f);
    await processMarkOffline(f.data);
    await executeKind(f.device.id, 'alert-plan');
    const tasks = await pending(f.device.id, 'alert-rule');
    expect(tasks).toHaveLength(3);
    for (const task of tasks) {
      if (task.ruleId === invalid.id) await expect(processOfflineEffect(task.id)).rejects.toThrow('Invalid offline alert cooldown');
      else await processOfflineEffect(task.id);
    }
    expect(await getTestDb().select().from(alerts).where(eq(alerts.deviceId, f.device.id))).toHaveLength(2);
    expect((await pending(f.device.id, 'alert-rule')).find((t) => t.ruleId === invalid.id)).toMatchObject({ completedAt: null, lastError: 'effect_delivery_failed' });
  });

  it('exports only source-tenant scalar receipts without payloads or lease capabilities', async () => {
    const source = await fixture(true);
    const other = await fixture(true);
    await processMarkOffline(source.data);
    await processMarkOffline(other.data);
    const [effect] = await pending(source.device.id);
    await store.claimOfflineEffect(effect!.id);
    const { zipBuffer } = await buildOrgExportZip(source.org.id, randomUUID(), 'operator@breeze.test');
    const archive = await JSZip.loadAsync(zipBuffer);
    const rows = JSON.parse(await archive.file('offline_transition_effects.json')!.async('string')) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: effect!.id, org_id: source.org.id, device_id: source.device.id });
    expect(rows[0]).not.toHaveProperty('payload');
    expect(rows[0]).not.toHaveProperty('lease_token');
  });

  it('blocks tenant-written intents, cross-tenant reads and forged source snapshots', async () => {
    const f = await fixture(true);
    const otherOrg = await createOrganization({ partnerId: f.partner.id });
    await processMarkOffline(f.data);
    const [row] = await pending(f.device.id);
    const role = await db.execute(sql`SELECT current_user AS role`);
    expect(role[0]?.role).toBe('breeze_app');
    expect(await getAppDb().select().from(effects)).toEqual([]);
    const context = { scope: 'organization' as const, orgId: f.org.id, accessibleOrgIds: [f.org.id], accessiblePartnerIds: [], userId: null };
    expect(await withDbAccessContext(context, () => db.select().from(effects))).toHaveLength(1);
    await expect(withDbAccessContext(context, () => db.insert(effects).values({ ...row!, id: randomUUID() }))).rejects.toThrow();
    expect(await withDbAccessContext({ ...context, orgId: otherOrg.id, accessibleOrgIds: [otherOrg.id] }, () => db.select().from(effects))).toEqual([]);
    if (row!.payload.type !== 'offline-event') throw new Error('fixture kind');
    const sourcePayload = row!.payload;
    await expect(withSystemDbAccessContext(() => db.insert(effects).values({ ...row!, id: randomUUID(), payload: {
      ...sourcePayload, observation: { ...sourcePayload.observation, orgId: otherOrg.id },
    } }))).rejects.toThrow();
    await expect(withSystemDbAccessContext(() => db.update(effects).set({ orgId: otherOrg.id }).where(eq(effects.id, row!.id)))).rejects.toThrow();
    await expect(withSystemDbAccessContext(() => db.execute(sql`INSERT INTO offline_transition_effects
      (id, transition_id, org_id, device_id, kind, payload)
      VALUES (${randomUUID()}, 'malformed', ${f.org.id}, ${f.device.id}, 'offline-event', '{}'::jsonb)`))).rejects.toThrow();
  });
});
