import '../__tests__/integration/setup';
import { getTestDb } from '../__tests__/integration/setup';
import { createPartner, createOrganization, createSite } from '../__tests__/integration/db-utils';
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbAccessContext, withSystemDbAccessContext } from '../db';
import {
  alerts, alertRules, alertTemplates, devices, monitorDefinitions, monitorEpisodes, monitorDeviceState,
  deviceHardwareHealth, deviceHardwareComponents, automations, automationRuns,
} from '../db/schema';

const m = vi.hoisted(() => ({
  publish: vi.fn(), monitorId: '', notify: vi.fn(), queue: vi.fn(), flap: vi.fn(), cooling: vi.fn(),
  cooldown: vi.fn(), failAck: false, processor: null as null | ((job: any) => Promise<any>),
}));

vi.mock('./eventBus', async original => ({ ...await original<typeof import('./eventBus')>(), publishEvent: m.publish }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn().mockResolvedValue('correlation-job') }));
vi.mock('./alertCooldown', async original => ({
  ...await original<typeof import('./alertCooldown')>(),
  isCooldownActive: m.cooling, isFlapping: m.flap, setCooldown: m.cooldown, recordStateTransition: async () => {},
}));
vi.mock('./monitors/monitorResolver', () => ({
  resolveMonitorsForDevice: async () => ({
    kind: 'resolved',
    monitors: [{ monitorId: m.monitorId, enabled: true, overrides: null, sourcePolicyId: 'test', sourceLevel: 'device', inheritedFromParent: false }],
  }),
}));
vi.mock('../db', async original => {
  const actual = await original<typeof import('../db')>();
  return {
    ...actual,
    withSystemDbAccessContext: ((...args: Parameters<typeof actual.withSystemDbAccessContext>) => {
      if (m.failAck && args[1] === 'subject-alert-outbox.ack') throw new Error('outbox acknowledgement failed');
      return actual.withSystemDbAccessContext(...args);
    }) as typeof actual.withSystemDbAccessContext,
  };
});
vi.mock('bullmq', () => ({
  Queue: class { add = m.queue; getJob = async () => null; close = async () => {}; },
  Worker: class { constructor(_name: string, processor: (job: any) => Promise<any>) { m.processor = processor; } on() {} },
  Job: class {}, UnrecoverableError: class extends Error {},
}));
vi.mock('../services/redis', async original => ({
  ...await original<typeof import('../services/redis')>(),
  isRedisAvailable: () => true, getRedisConnection: () => ({}), getBullMQConnection: () => ({}),
}));
vi.mock('../services/notificationSenders/inAppSender', async original => ({
  ...await original<typeof import('../services/notificationSenders/inAppSender')>(),
  sendInAppNotification: m.notify,
}));

import { createAlert, evaluateDeviceAlerts } from './alertService';
import { drainSubjectAlertOutbox } from './subjectAlertOutbox';
import { drainSubjectResponseOutbox } from './subjectResponseOutbox';
import { recordMonitorEvaluation } from './monitors/episodeService';
import { __testOnly as automationWorker, createAutomationWorker } from '../jobs/automationWorker';
import { processAlertNotifications } from './notificationDispatcher';

beforeEach(() => {
  vi.clearAllMocks();
  m.failAck = false;
  m.queue.mockReset().mockResolvedValue({ id: 'queued' });
  m.cooling.mockReset().mockResolvedValue(false);
  m.publish.mockReset().mockResolvedValue(undefined);
  m.flap.mockReset().mockResolvedValue(false);
  m.cooldown.mockReset().mockResolvedValue(undefined);
  m.notify.mockReset();
});

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return withSystemDbAccessContext(async () => {
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'hardware-test',
      osType: 'windows', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online',
    }).returning();
    if (!device) throw new Error('Device seed failed');
    const condition = { componentTypes: ['physical_disk'], minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 };
    const [monitor] = await db.insert(monitorDefinitions).values({
      partnerId: partner.id, name: 'Hardware test', kind: 'hardware_health',
      condition, severity: 'high', autoResolve: true, deliveryMode: 'none',
    }).returning();
    if (!monitor) throw new Error('Monitor seed failed');
    m.monitorId = monitor.id;
    const [template] = await db.insert(alertTemplates).values({
      partnerId: partner.id, name: 'Hardware test', conditions: { type: 'hardware_health', ...condition },
      severity: 'high', autoResolve: true,
      titleTemplate: '{{componentLabel}} {{stateLabel}} on {{deviceName}}', messageTemplate: '{{stateDetail}}',
      managedByMonitorId: monitor.id,
    }).returning();
    if (!template) throw new Error('Template seed failed');
    const [rule] = await db.insert(alertRules).values({
      partnerId: partner.id, templateId: template.id, name: 'Hardware test',
      targetType: 'monitor', targetId: monitor.id, managedByMonitorId: monitor.id,
    }).returning();
    if (!rule) throw new Error('Rule seed failed');
    await db.insert(deviceHardwareHealth).values({ deviceId: device.id, orgId: org.id, pollIntervalMinutes: 10, diskHealthIntervalMinutes: 60 });
    await db.insert(deviceHardwareComponents).values(['a', 'b'].map(key => ({
      deviceId: device.id, orgId: org.id, componentKey: key,
      componentType: 'physical_disk' as const, source: 'storcli' as const, name: key, health: 'critical' as const,
      state: 'failed', criticalStreak: 2, unhealthyStreak: 2, firstSeenAt: new Date(), lastSeenAt: new Date(),
    })));
    return { partner, org, device, monitor, rule, template };
  });
}

async function alertRows(deviceId: string) {
  return withSystemDbAccessContext(() => db.select().from(alerts).where(eq(alerts.deviceId, deviceId)));
}

it('sweep creates two alerts, keeps acknowledged sibling, and resolves only recovered subject', async () => {
  const f = await fixture();
  const ids = await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  expect(ids).toHaveLength(2);
  const first = (await alertRows(f.device.id)).find(a => a.subjectKey === 'a')!;
  await withSystemDbAccessContext(async () => {
    await db.update(alerts).set({ status: 'acknowledged' }).where(eq(alerts.id, first.id));
    await db.update(deviceHardwareComponents).set({
      health: 'ok', state: 'online', criticalStreak: 0, unhealthyStreak: 0, healthyStreak: 2, belowCriticalStreak: 2,
    }).where(and(eq(deviceHardwareComponents.deviceId, f.device.id), eq(deviceHardwareComponents.componentKey, 'b')));
    await evaluateDeviceAlerts(f.device.id);
  });
  expect((await alertRows(f.device.id)).map(a => [a.subjectKey, a.status]).sort()).toEqual([['a', 'acknowledged'], ['b', 'resolved']]);
  const [episode] = await withSystemDbAccessContext(() => db.select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, f.monitor.id)));
  expect(episode!.endedAt).toBeNull();
  await withSystemDbAccessContext(async () => {
    await db.update(deviceHardwareComponents).set({ health: 'unknown' }).where(eq(deviceHardwareComponents.deviceId, f.device.id));
    await evaluateDeviceAlerts(f.device.id);
  });
  expect((await alertRows(f.device.id)).find(a => a.subjectKey === 'a')?.status).toBe('acknowledged');
});

it('autoResolve off preserves recovered subjects, and exempt/stale rows never alert', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    await db.update(deviceHardwareComponents).set({ alertExempt: true }).where(and(
      eq(deviceHardwareComponents.deviceId, f.device.id), eq(deviceHardwareComponents.componentKey, 'b'),
    ));
    expect(await evaluateDeviceAlerts(f.device.id)).toHaveLength(1);
    await db.update(alertRules).set({ overrideSettings: { autoResolve: false } }).where(eq(alertRules.id, f.rule.id));
    await db.update(deviceHardwareComponents).set({
      health: 'ok', state: 'online', criticalStreak: 0, unhealthyStreak: 0, healthyStreak: 2, belowCriticalStreak: 2,
    }).where(eq(deviceHardwareComponents.deviceId, f.device.id));
    await evaluateDeviceAlerts(f.device.id);
  });
  expect((await alertRows(f.device.id)).map(a => a.status)).toEqual(['active']);
  await withSystemDbAccessContext(async () => {
    await db.update(alertRules).set({ overrideSettings: { autoResolve: true } }).where(eq(alertRules.id, f.rule.id));
    await db.update(deviceHardwareComponents).set({ stale: true }).where(eq(deviceHardwareComponents.deviceId, f.device.id));
    await evaluateDeviceAlerts(f.device.id);
  });
  expect((await alertRows(f.device.id)).map(a => a.status)).toEqual(['active']);
});

it.each(['disk:race', undefined])('concurrent createAlert collapses subject %s to one row', async subjectKey => {
  const f = await fixture();
  const args = {
    ruleId: f.rule.id, deviceId: f.device.id, orgId: f.org.id, monitorId: f.monitor.id,
    kind: 'hardware_health' as const, severity: 'high' as const, title: 'Failure', message: 'Failure', subjectKey,
  };
  let arrivals = 0; let release!: () => void;
  const bothPassedDedupe = new Promise<void>(resolve => { release = resolve; });
  m.flap.mockImplementation(async () => {
    if (++arrivals === 2) release();
    await bothPassedDedupe; return false;
  });
  const ids = await Promise.all([withSystemDbAccessContext(() => createAlert(args)), withSystemDbAccessContext(() => createAlert(args))]);
  expect(ids.filter(Boolean)).toHaveLength(1);
  expect(await alertRows(f.device.id)).toHaveLength(1);
  await drainSubjectAlertOutbox(f.device.id);
  expect(m.publish.mock.calls.filter(c => c[0] === 'alert.triggered')).toHaveLength(1);
});

it('publishes only after commit and subscribers can read the owner', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    expect(await evaluateDeviceAlerts(f.device.id)).toHaveLength(2);
    expect(m.publish).not.toHaveBeenCalled(); expect(m.cooldown).not.toHaveBeenCalled();
    await expect(drainSubjectAlertOutbox(f.device.id)).rejects.toThrow('must run after commit');
  });
  m.publish.mockImplementation(async (_type, _orgId, payload) => {
    // The dispatcher has no ambient transaction: this opens another connection.
    const row = (await alertRows(f.device.id)).find(a => a.id === payload.alertId);
    expect(row).toBeDefined();
    const [episode] = await withSystemDbAccessContext(() => db.select().from(monitorEpisodes)
      .where(eq(monitorEpisodes.id, row!.episodeId!)));
    expect(payload.responsesOwner).toBe(episode!.alertId === row!.id);
  });
  await Promise.all([drainSubjectAlertOutbox(f.device.id), drainSubjectAlertOutbox(f.device.id)]);
  expect(m.publish).toHaveBeenCalledTimes(2);
  expect(m.cooldown).toHaveBeenCalledTimes(2);
});

it('outer rollback discards alerts, ownership and pending publication together', async () => {
  const f = await fixture();
  await expect(withSystemDbAccessContext(async () => {
    await evaluateDeviceAlerts(f.device.id);
    throw new Error('later transaction failure');
  })).rejects.toThrow('later transaction failure');
  await drainSubjectAlertOutbox(f.device.id);
  expect(await alertRows(f.device.id)).toEqual([]);
  const episodes = await withSystemDbAccessContext(() => db.select().from(monitorEpisodes)
    .where(eq(monitorEpisodes.monitorId, f.monitor.id)));
  expect(episodes).toEqual([]);
  expect(m.publish).not.toHaveBeenCalled(); expect(m.cooldown).not.toHaveBeenCalled();
});

it('failed publication deletes only its alert and releases only its ownership claim', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  const rows = await alertRows(f.device.id);
  const [episode] = await withSystemDbAccessContext(() => db.select().from(monitorEpisodes)
    .where(eq(monitorEpisodes.monitorId, f.monitor.id)));
  const failedId = episode!.alertId;
  m.publish.mockImplementation(async (_type, _orgId, payload) => {
    if (payload.alertId === failedId) throw new Error('transport unavailable');
  });
  await drainSubjectAlertOutbox(f.device.id);
  expect((await alertRows(f.device.id)).map(a => a.id)).toEqual(rows.filter(a => a.id !== failedId).map(a => a.id));
  const [after] = await withSystemDbAccessContext(() => db.select().from(monitorEpisodes)
    .where(eq(monitorEpisodes.id, episode!.id)));
  expect(after!.alertId).toBeNull(); expect(m.cooldown).toHaveBeenCalledTimes(1);
});

it('a Redis failure after publication cannot undo alerts or ownership', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  const before = await alertRows(f.device.id);
  m.cooldown.mockRejectedValue(new Error('Redis unavailable'));
  await drainSubjectAlertOutbox(f.device.id);
  expect((await alertRows(f.device.id)).map(a => a.id).sort()).toEqual(before.map(a => a.id).sort());
  const [episode] = await withSystemDbAccessContext(() => db.select().from(monitorEpisodes)
    .where(eq(monitorEpisodes.monitorId, f.monitor.id)));
  expect(before.map(a => a.id)).toContain(episode!.alertId);
  await drainSubjectAlertOutbox(f.device.id);
  expect(m.publish).toHaveBeenCalledTimes(2);
});

it('recovery before dispatch cancels triggers and retries only committed resolved events', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  await withSystemDbAccessContext(async () => {
    await db.update(deviceHardwareComponents).set({
      health: 'ok', state: 'online', criticalStreak: 0, unhealthyStreak: 0, healthyStreak: 2, belowCriticalStreak: 2,
    }).where(eq(deviceHardwareComponents.deviceId, f.device.id));
    await evaluateDeviceAlerts(f.device.id);
    expect(m.publish).not.toHaveBeenCalled(); expect(m.cooldown).not.toHaveBeenCalled();
  });
  m.publish.mockRejectedValue(new Error('transport unavailable'));
  await drainSubjectAlertOutbox(f.device.id);
  expect(m.publish.mock.calls.every(call => call[0] === 'alert.resolved')).toBe(true);
  expect((await alertRows(f.device.id)).map(a => a.status)).toEqual(['resolved', 'resolved']);
  expect(m.cooldown).not.toHaveBeenCalled();
  m.publish.mockClear().mockResolvedValue(undefined);
  await drainSubjectAlertOutbox(f.device.id);
  expect(m.publish).toHaveBeenCalledTimes(2);
  expect(m.cooldown).toHaveBeenCalledTimes(2);
});

it.each([false, true])('hardware recurrence never publishes before commit; rollback=%s', async rollback => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    await db.update(monitorDefinitions).set({ recurrenceThreshold: 2, recurrenceWindowHours: 24 })
      .where(eq(monitorDefinitions.id, f.monitor.id));
    await db.insert(monitorEpisodes).values({
      monitorId: f.monitor.id, deviceId: f.device.id, orgId: f.org.id,
      startedAt: new Date(Date.now() - 3600_000), endedAt: new Date(Date.now() - 1800_000), endReason: 'recovered',
    });
  });
  const transaction = withSystemDbAccessContext(async () => {
    await evaluateDeviceAlerts(f.device.id);
    expect(m.publish).not.toHaveBeenCalled();
    if (rollback) throw new Error('rollback recurrence');
  });
  if (rollback) await expect(transaction).rejects.toThrow('rollback recurrence');
  else await transaction;
  await drainSubjectAlertOutbox(f.device.id);
  const events = m.publish.mock.calls.filter(call => call[0] === 'alert.triggered').map(call => call[2]);
  expect(events).toHaveLength(rollback ? 0 : 3);
  if (!rollback) {
    const escalation = events.filter(payload => payload.requiresHuman === true);
    expect(escalation).toHaveLength(1);
    const [state] = await withSystemDbAccessContext(() => db.select().from(monitorDeviceState)
      .where(and(eq(monitorDeviceState.monitorId, f.monitor.id), eq(monitorDeviceState.deviceId, f.device.id))));
    expect(state!.escalationAlertId).toBe(escalation[0]!.alertId);
    expect(state!.responsesPaused).toBe(true);
  }
  await drainSubjectAlertOutbox(f.device.id);
  expect(m.publish).toHaveBeenCalledTimes(rollback ? 0 : 3);
});

it.each(['cooldown', 'flapping'])('suppressed %s sweeps never create recurrence or pause', async gate => {
  const f = await fixture();
  await withSystemDbAccessContext(() => db.update(monitorDefinitions)
    .set({ recurrenceThreshold: 2, recurrenceWindowHours: 24, pauseResponsesOnEscalation: true })
    .where(eq(monitorDefinitions.id, f.monitor.id)));
  (gate === 'cooldown' ? m.cooling : m.flap).mockResolvedValue(true);
  for (let i = 0; i < 4; i++) {
    expect(await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id))).toEqual([]);
  }
  await withSystemDbAccessContext(async () => {
    expect(await db.select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, f.monitor.id))).toEqual([]);
    const [state] = await db.select().from(monitorDeviceState).where(eq(monitorDeviceState.monitorId, f.monitor.id));
    expect(state).toMatchObject({
      currentEpisodeId: null, episodesInWindow: 0, escalatedAt: null, responsesPaused: false, lastState: 'ok',
    });
  });
  await drainSubjectAlertOutbox(f.device.id);
  expect(m.publish).not.toHaveBeenCalled();
  m.cooling.mockResolvedValue(false); m.flap.mockResolvedValue(false);
  expect(await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id))).toHaveLength(2);
  await withSystemDbAccessContext(async () => {
    const episodes = await db.select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, f.monitor.id));
    expect(episodes).toHaveLength(1);
    const [state] = await db.select().from(monitorDeviceState).where(eq(monitorDeviceState.monitorId, f.monitor.id));
    expect(state).toMatchObject({ episodesInWindow: 1, responsesPaused: false, lastState: 'breach' });
  });
});

it('partial admission counts one episode; suppressed siblings and repeated sweeps add none', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => db.update(monitorDefinitions)
    .set({ recurrenceThreshold: 2, recurrenceWindowHours: 24, pauseResponsesOnEscalation: true })
    .where(eq(monitorDefinitions.id, f.monitor.id)));
  m.cooling.mockImplementation(async (_rule, _device, subject) => subject === 'b');
  expect(await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id))).toHaveLength(1);
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  m.cooling.mockResolvedValue(false);
  expect(await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id))).toHaveLength(1);
  await withSystemDbAccessContext(async () => {
    expect(await db.select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, f.monitor.id))).toHaveLength(1);
    const [state] = await db.select().from(monitorDeviceState).where(eq(monitorDeviceState.monitorId, f.monitor.id));
    expect(state).toMatchObject({ episodesInWindow: 1, responsesPaused: false, lastState: 'breach' });
  });
});

it('subject queries cannot read another organization under app RLS', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  const outsider = await createOrganization({ partnerId: f.partner.id });
  const rows = await withDbAccessContext({
    scope: 'organization', orgId: outsider.id, accessibleOrgIds: [outsider.id],
    accessiblePartnerIds: [], currentPartnerId: f.partner.id, userId: null,
  }, () => db.select().from(alerts).where(eq(alerts.deviceId, f.device.id)));
  expect(rows).toEqual([]);
});

// ---------------------------------------------------------------------------
// Task 11 — single-response-owner contract
// ---------------------------------------------------------------------------

it('two failing disks notify twice, but only their atomic episode owner runs responses', async () => {
  const f = await fixture();
  m.queue.mockResolvedValue({ id: 'queued' }); m.notify.mockResolvedValue({ success: true, notificationCount: 1 });
  await Promise.all([
    withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id)),
    withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id)),
  ]);
  await drainSubjectAlertOutbox(f.device.id);
  const events = m.publish.mock.calls.filter(c => c[0] === 'alert.triggered').map(c => c[2]);
  expect(events).toHaveLength(2); expect(events.filter(p => p.responsesOwner)).toHaveLength(1);
  const [automation] = await getTestDb().insert(automations).values({
    orgId: f.org.id, name: 'Hardware response', managedByMonitorId: f.monitor.id,
    trigger: { type: 'event', event: 'alert.triggered', filter: { ruleId: f.rule.id } },
    actions: [{ type: 'execute_command', command: 'echo hardware-response', shell: 'bash' }],
  }).returning();
  const outcomes = [];
  for (const payload of events) {
    outcomes.push(await withSystemDbAccessContext(() => automationWorker.processTriggerEvent({
      type: 'trigger-event', automationId: automation!.id, eventType: 'alert.triggered', eventPayload: payload,
      eventId: randomUUID(), eventTimestamp: new Date().toISOString(),
    })));
    await withSystemDbAccessContext(() => processAlertNotifications({ type: 'process-alert', alertId: payload.alertId }));
  }
  expect(outcomes.filter(o => o.runId)).toHaveLength(1);
  expect(outcomes).toContainEqual({ skipped: 'subject_alert_not_response_owner' });
  const runs = await getTestDb().select().from(automationRuns).where(eq(automationRuns.automationId, automation!.id));
  expect(runs).toHaveLength(1);
  expect(m.notify).toHaveBeenCalledTimes(2);
  expect(new Set(m.notify.mock.calls.map(c => c[0].alertId)).size).toBe(2);
  const [episode] = await getTestDb().select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, f.monitor.id));
  expect(episode!.alertId).toBe(events.find(p => p.responsesOwner)!.alertId);
});

async function responseFixture() {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  m.failAck = true;
  await drainSubjectAlertOutbox(f.device.id);
  m.failAck = false;
  const payload = m.publish.mock.calls.filter(c => c[0] === 'alert.triggered').map(c => c[2])
    .find(p => p.responsesOwner === true)!;
  const [automation] = await getTestDb().insert(automations).values({
    orgId: f.org.id, name: 'Replay-safe hardware response', managedByMonitorId: f.monitor.id,
    trigger: { type: 'event', event: 'alert.triggered', filter: { ruleId: f.rule.id } },
    actions: [{ type: 'execute_command', command: 'echo hardware-response', shell: 'bash' }],
  }).returning();
  const job = {
    type: 'trigger-event' as const, automationId: automation!.id, eventType: 'alert.triggered',
    eventPayload: payload, eventId: payload.alertId, eventTimestamp: new Date().toISOString(),
  };
  return { ...f, automation: automation!, payload, job };
}

it('replayed owner after alert-outbox ack failure and queue eviction admits one response', async () => {
  const f = await responseFixture();
  m.publish.mockClear(); m.queue.mockClear();
  const outcomes = await Promise.all([1, 2].map(() => withSystemDbAccessContext(async () => {
    const result = await automationWorker.processTriggerEvent(f.job);
    expect(m.queue).not.toHaveBeenCalled(); expect(m.publish).not.toHaveBeenCalled();
    return result;
  })));
  expect(outcomes.filter(result => result.runId)).toHaveLength(1);
  await drainSubjectResponseOutbox(async pending => {
    const [committed] = await getTestDb().select().from(automationRuns).where(eq(automationRuns.id, pending.runId));
    expect(committed).toBeDefined();
    await m.queue('execute-run', pending);
  });
  expect(m.queue).toHaveBeenCalledTimes(1);
  const [before] = await getTestDb().select().from(monitorEpisodes).where(eq(monitorEpisodes.id, f.payload.episodeId));
  expect(before!.responsesAdmittedAt).toBeInstanceOf(Date);
  expect(before!.responseDispatch).toBeNull();
  // Evict all simulated transport history, then let the unacknowledged alert replay.
  m.queue.mockClear(); m.publish.mockClear();
  await withSystemDbAccessContext(() => db.update(alerts).set({
    context: sql`jsonb_set(${alerts.context}, '{_subjectDispatch}', (${alerts.context}->'_subjectDispatch') - 'leaseToken' - 'leaseUntil')`,
  }).where(and(eq(alerts.deviceId, f.device.id), sql`${alerts.context} ? '_subjectDispatch'`)));
  await drainSubjectAlertOutbox(f.device.id);
  const replay = m.publish.mock.calls.filter(c => c[0] === 'alert.triggered').map(c => c[2])
    .find(p => p.responsesOwner === true)!;
  expect(replay).toEqual(f.payload);
  expect(await withSystemDbAccessContext(() => automationWorker.processTriggerEvent({ ...f.job, eventPayload: replay })))
    .toEqual({ skipped: 'subject_episode_response_already_admitted_or_ineligible' });
  await drainSubjectResponseOutbox(async pending => { await m.queue('execute-run', pending); });
  expect(m.queue).not.toHaveBeenCalled();
  expect(await getTestDb().select().from(automationRuns).where(eq(automationRuns.automationId, f.automation.id))).toHaveLength(1);
  const [after] = await getTestDb().select().from(monitorEpisodes).where(eq(monitorEpisodes.id, f.payload.episodeId));
  expect(after!.responseRunId).toBe(before!.responseRunId);
  expect(after!.responsesAdmittedAt).toEqual(before!.responsesAdmittedAt);
});

it('the real worker queues a response only after its admission transaction commits', async () => {
  const f = await responseFixture();
  createAutomationWorker();
  m.queue.mockClear().mockImplementation(async (_name, data, options) => {
    expect(hasDbAccessContext()).toBe(false);
    const [run] = await getTestDb().select().from(automationRuns).where(eq(automationRuns.id, data.runId));
    expect(run).toBeDefined();
    expect(options).toMatchObject({ jobId: `automation-run-${data.runId}`, removeOnComplete: false });
    return { id: options.jobId };
  });
  const result = await m.processor!({ name: 'trigger-event', data: f.job });
  expect(result.runId).toBeDefined(); expect(m.queue).toHaveBeenCalledTimes(1);
});

it('response admission and envelope roll back together, then failed enqueue retries the same run', async () => {
  const f = await responseFixture();
  m.publish.mockClear(); m.queue.mockClear();
  await expect(withSystemDbAccessContext(async () => {
    await automationWorker.processTriggerEvent(f.job);
    await expect(drainSubjectResponseOutbox(m.queue)).rejects.toThrow('must run after commit');
    throw new Error('rollback response');
  })).rejects.toThrow('rollback response');
  const [rolledBack] = await getTestDb().select().from(monitorEpisodes).where(eq(monitorEpisodes.id, f.payload.episodeId));
  expect(rolledBack!.responsesAdmittedAt).toBeNull(); expect(rolledBack!.responseDispatch).toBeNull();
  expect(await getTestDb().select().from(automationRuns).where(eq(automationRuns.automationId, f.automation.id))).toEqual([]);
  expect(m.publish).not.toHaveBeenCalled(); expect(m.queue).not.toHaveBeenCalled();
  const admitted = await withSystemDbAccessContext(() => automationWorker.processTriggerEvent(f.job));
  m.queue.mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValue({ id: 'queued' });
  await drainSubjectResponseOutbox(m.queue);
  await drainSubjectResponseOutbox(m.queue);
  expect(m.queue).toHaveBeenCalledTimes(2);
  expect(m.queue.mock.calls.map(c => c[0].runId)).toEqual([admitted.runId, admitted.runId]);
  expect(await getTestDb().select().from(automationRuns).where(eq(automationRuns.automationId, f.automation.id))).toHaveLength(1);
});
