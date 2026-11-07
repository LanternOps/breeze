/**
 * #10926 — `alert.triggered` must not reach `process-alert` before the alert
 * row commits.
 *
 * The bug: `createAlert` / `createSourcedAlert` published inside the caller's
 * open transaction. The `notification-dispatcher` subscriber runs inline and
 * queues `process-alert`; the BullMQ worker reads the row on ANOTHER pooled
 * connection, finds nothing (the insert is uncommitted) and returns
 * `{queued:0,inAppSent:false}` — a return, not a throw, so nothing retries and
 * the alert never notifies anyone.
 *
 * Mocks cannot see this: it needs a real second connection and a real worker.
 * So everything on the path is real — Postgres, Redis, the event bus, the
 * `notification-dispatcher` subscriber, the notification BullMQ worker and the
 * in-app sender. Each case holds the inserting transaction open after the
 * create returns, long enough for any `process-alert` job queued before COMMIT
 * to run against the uncommitted state, then commits and asserts that the
 * alert reached a user's in-app inbox and that no `process-alert` run missed
 * the row.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/alertPublishAfterCommit.integration.test.ts
 *   pnpm test-stack down
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Worker } from 'bullmq';

const h = vi.hoisted(() => ({
  dropAlertDispatch: false,
  failAck: false,
  failRetirementOutbox: false,
  failNextTriggeredPublish: false,
  /** True only while a test's inserting transaction is still open. */
  insideOpenTransaction: false,
}));

vi.mock('../../db', async (original) => {
  const actual = await original<typeof import('../../db')>();
  return {
    ...actual,
    // Simulates a process that dies between COMMIT and the after-commit
    // dispatch: the deferred alert dispatch is registered but never runs.
    // Every other deferred task is untouched.
    runAfterDbContextCommit: ((label: string, work: () => unknown) => {
      if (h.dropAlertDispatch && label.startsWith('alert-outbox')) return;
      return actual.runAfterDbContextCommit(label, work);
    }) as typeof actual.runAfterDbContextCommit,
    withSystemDbAccessContext: ((...args: Parameters<typeof actual.withSystemDbAccessContext>) => {
      if (h.failAck && args[1] === 'subject-alert-outbox.ack') {
        return Promise.reject(new Error('outbox acknowledgement failed (test)'));
      }
      return actual.withSystemDbAccessContext(...args);
    }) as typeof actual.withSystemDbAccessContext,
  };
});
// The real publish (Redis stream + local subscribers), with an opt-in failure.
vi.mock('../../services/eventBus', async (original) => {
  const actual = await original<typeof import('../../services/eventBus')>();
  return {
    ...actual,
    publishEvent: vi.fn((...args: Parameters<typeof actual.publishEvent>) => {
      if (h.failNextTriggeredPublish && args[0] === 'alert.triggered') {
        h.failNextTriggeredPublish = false;
        return Promise.reject(new Error('redis down (test)'));
      }
      return actual.publishEvent(...args);
    }),
  };
});
// An unrelated step of the minute-tick drain that can fail on its own.
vi.mock('../../services/hardwareHealth/retirementOutbox', async (original) => {
  const actual = await original<typeof import('../../services/hardwareHealth/retirementOutbox')>();
  return {
    ...actual,
    drainRetirementOutbox: vi.fn((...args: Parameters<typeof actual.drainRetirementOutbox>) => {
      if (h.failRetirementOutbox) return Promise.reject(new Error('retirement outbox failed (test)'));
      return actual.drainRetirementOutbox(...args);
    }),
  };
});
// Correlation has its own queue and contract; here it only records calls.
vi.mock('../../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(async () => null) }));

import { closeDb, db, withDbTransaction, withSystemDbAccessContext } from '../../db';
import {
  alertRules, alertTemplates, alerts, configPolicyAssignments, configPolicyFeatureLinks,
  configPolicyMonitors, configurationPolicies, deviceEventLogs, devices, monitorDefinitions,
  userNotifications,
} from '../../db/schema';
import { enqueueAlertCorrelation } from '../../jobs/alertCorrelation';
import { isCooldownActive } from '../../services/alertCooldown';
import { publishEvent } from '../../services/eventBus';
import {
  createSourcedAlert, evaluateDeviceAlerts, getApplicableRules, resolveAlert,
} from '../../services/alertService';
import { emitPatchJobFailureAlert } from '../../services/patchAlerts';
import { compileMonitorInTx } from '../../services/monitors/monitorCompiler';
import { registerEventSubscriber } from '../../services/eventSubscriberRegistry';
import {
  createNotificationWorker, handleAlertLifecycleEvent, shutdownNotificationDispatcher,
} from '../../services/notificationDispatcher';
import { drainSubjectAlertOutbox } from '../../services/subjectAlertOutbox';
import { closeRedis } from '../../services/redis';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

const runDb = describe.runIf(!!process.env.DATABASE_URL);

/** Long enough for a job queued before COMMIT to be picked up and finish. */
const HOLD_MS = 2_000;

type ProcessAlertResult = { queued: number; inAppSent: boolean };
const processAlertRuns = new Map<string, ProcessAlertResult[]>();
/** Every event the notification-dispatcher subscriber received. */
const deliveries: Array<{ alertId: string; type: string; insideOpenTransaction: boolean }> = [];
let worker: Worker | undefined;

function deliveriesFor(alertId: string, type = 'alert.triggered') {
  return deliveries.filter((d) => d.alertId === alertId && d.type === type);
}

const eventLogCondition = {
  type: 'event_log', category: 'application', level: 'info',
  sourcePattern: 'On Battery', messagePattern: 'On Battery', countThreshold: 1, windowMinutes: 60,
} as const;

beforeAll(() => {
  // The production subscriber, alone: no PSA, webhooks or flows in this suite.
  registerEventSubscriber({
    id: 'notification-dispatcher',
    eventTypes: ['alert.triggered', 'alert.acknowledged', 'alert.resolved'],
    handler: async (event) => {
      const alertId = (event.payload as { alertId?: string }).alertId;
      if (alertId) deliveries.push({ alertId, type: event.type, insideOpenTransaction: h.insideOpenTransaction });
      return handleAlertLifecycleEvent(event);
    },
  });
  worker = createNotificationWorker();
  worker.on('completed', (job, result: ProcessAlertResult) => {
    if (job.data?.type !== 'process-alert') return;
    const runs = processAlertRuns.get(job.data.alertId) ?? [];
    runs.push({ queued: result.queued, inAppSent: result.inAppSent });
    processAlertRuns.set(job.data.alertId, runs);
  });
});

afterAll(async () => {
  await worker?.close();
  await shutdownNotificationDispatcher();
  await closeRedis();
  await closeDb();
});

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Run `create` inside ONE system transaction and keep that transaction open
 * for HOLD_MS after it returns (or until a `process-alert` run for the alert
 * has already finished, which only happens when it was queued before COMMIT).
 */
async function createWithTransactionHeldOpen(create: () => Promise<string | null>): Promise<string> {
  const alertId = await withSystemDbAccessContext(async () => {
    h.insideOpenTransaction = true;
    try {
      const id = await create();
      if (!id) throw new Error('fixture did not create an alert');
      await waitUntil(() => processAlertRuns.has(id), HOLD_MS);
      return id;
    } finally {
      // Cleared before the callback returns, i.e. before COMMIT: anything
      // recorded while it was set was delivered to an uncommitted row.
      h.insideOpenTransaction = false;
    }
  });
  // Deterministic, independent of worker timing: nothing told the dispatcher
  // about this alert while its row was still uncommitted.
  expect(deliveries.filter((d) => d.alertId === alertId && d.insideOpenTransaction)).toEqual([]);
  return alertId;
}

function readAlert(alertId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(alerts).where(eq(alerts.id, alertId));
    return row;
  });
}

function pendingDispatch(row: { context: unknown } | undefined): Record<string, unknown> | undefined {
  return (row?.context as { _subjectDispatch?: Record<string, unknown> } | null)?._subjectDispatch;
}

/** End a pending envelope's lease or retry backoff now, as time passing would. */
async function expireLease(alertId: string): Promise<void> {
  await withSystemDbAccessContext(() => db.execute(sql`
    UPDATE alerts SET context = jsonb_set(context, '{_subjectDispatch,leaseUntil}', to_jsonb(now() - interval '1 second'))
    WHERE id = ${alertId} AND context ? '_subjectDispatch'`));
}

function inAppCount(alertId: string): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select({ id: userNotifications.id }).from(userNotifications)
      .where(sql`${userNotifications.metadata}->>'alertId' = ${alertId}`);
    return rows.length;
  });
}

async function expectDelivered(alertId: string): Promise<void> {
  await expect.poll(() => inAppCount(alertId), {
    timeout: 10_000,
    interval: 100,
    message: `no in-app notification; process-alert runs for ${alertId}: ${JSON.stringify(processAlertRuns.get(alertId) ?? [])}`,
  }).toBeGreaterThan(0);
  const runs = processAlertRuns.get(alertId) ?? [];
  // Every process-alert run for this alert found the row. A run that read
  // before COMMIT reports {queued:0,inAppSent:false} — the silent drop.
  expect(runs.length).toBeGreaterThan(0);
  expect(runs).toEqual(runs.map(() => expect.objectContaining({ inAppSent: true })));
}

async function seedOrgWithRecipient() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  // One active org user, so process-alert has an in-app recipient.
  await createUser({
    partnerId: partner.id, orgId: org.id, withMembership: true, email: `recipient-${randomUUID()}@example.com`,
  });
  const [device] = await withSystemDbAccessContext(() => db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `publish-after-commit-${randomUUID()}`,
    hostname: 'publish-after-commit', osType: 'windows', osVersion: '11', architecture: 'x64',
    agentVersion: '1.0.0', status: 'online', lastSeenAt: new Date(),
  }).returning());
  if (!device) throw new Error('device seed failed');
  return { partnerId: partner.id, orgId: org.id, deviceId: device.id };
}

type Seeded = Awaited<ReturnType<typeof seedOrgWithRecipient>>;

async function insertBreachEvent(f: Seeded): Promise<void> {
  await withSystemDbAccessContext(() => db.insert(deviceEventLogs).values({
    orgId: f.orgId, deviceId: f.deviceId, timestamp: new Date(), level: 'info', category: 'application',
    source: 'On Battery', message: 'On Battery', eventId: randomUUID(), details: { logName: 'Application', recordId: 1 },
  }));
}

async function seedPlainRule(f: Seeded): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [template] = await db.insert(alertTemplates).values({
      orgId: f.orgId, name: 'Plain battery rule', conditions: eventLogCondition, severity: 'high',
      titleTemplate: 'On battery: {{deviceName}}', messageTemplate: 'Device switched to battery power',
    }).returning();
    const [rule] = await db.insert(alertRules).values({
      orgId: f.orgId, templateId: template!.id, name: 'Plain battery rule', targetType: 'org', targetId: f.orgId,
    }).returning();
    return rule!.id;
  });
}

async function seedMonitorRule(f: Seeded): Promise<string> {
  const { type: _type, ...monitorCondition } = eventLogCondition;
  return withSystemDbAccessContext(async () => {
    const [monitor] = await db.insert(monitorDefinitions).values({
      orgId: f.orgId, name: 'Battery monitor', kind: 'event_log', condition: monitorCondition,
      severity: 'high', deliveryMode: 'none', autoResolve: false,
    }).returning();
    await db.transaction((tx) => compileMonitorInTx(tx, monitor!));
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: f.orgId, name: 'Battery policy', status: 'active',
    }).returning();
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: 'monitors',
    }).returning();
    await db.insert(configPolicyMonitors).values({ featureLinkId: link!.id, monitorId: monitor!.id });
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id, level: 'organization', targetId: f.orgId, priority: 0,
    });
    const rules = await getApplicableRules(f.deviceId);
    expect(rules.map((r) => r.rule.managedByMonitorId)).toEqual([monitor!.id]);
    return monitor!.id;
  });
}

async function sweepOneAlert(f: Seeded): Promise<string | null> {
  const ids = await evaluateDeviceAlerts(f.deviceId);
  expect(ids).toHaveLength(1);
  return ids[0] ?? null;
}

runDb('#10926 — alert.triggered reaches process-alert only after the alert row commits', () => {
  it('plain rule alert from the device sweep is delivered', async () => {
    const f = await seedOrgWithRecipient();
    const ruleId = await seedPlainRule(f);
    await insertBreachEvent(f);

    const alertId = await createWithTransactionHeldOpen(() => sweepOneAlert(f));

    const [row] = await withSystemDbAccessContext(() => db.select().from(alerts).where(eq(alerts.id, alertId)));
    expect(row).toMatchObject({ ruleId, monitorId: null, status: 'active' });
    await expectDelivered(alertId);
  });

  it('monitor-compiled rule alert from the device sweep is delivered', async () => {
    const f = await seedOrgWithRecipient();
    const monitorId = await seedMonitorRule(f);
    await insertBreachEvent(f);

    const alertId = await createWithTransactionHeldOpen(() => sweepOneAlert(f));

    const [row] = await withSystemDbAccessContext(() => db.select().from(alerts).where(eq(alerts.id, alertId)));
    expect(row).toMatchObject({ monitorId, status: 'active' });
    await expectDelivered(alertId);
  });

  it('patch-job failure alert (built-in rule, sourced context) is delivered', async () => {
    const f = await seedOrgWithRecipient();

    const alertId = await createWithTransactionHeldOpen(() => emitPatchJobFailureAlert({
      orgId: f.orgId, deviceId: f.deviceId, patchJobId: randomUUID(), hostname: 'publish-after-commit',
      failedCount: 2, errorExcerpt: null,
    }));

    const [row] = await withSystemDbAccessContext(() => db.select().from(alerts).where(eq(alerts.id, alertId)));
    expect((row!.context as { source?: string }).source).toBe('patch-job-finalizer');
    await expectDelivered(alertId);
  });

  it('device-less sourced alert (backup workload owner) is delivered', async () => {
    const f = await seedOrgWithRecipient();

    const alertId = await createWithTransactionHeldOpen(() => createSourcedAlert({
      orgId: f.orgId, deviceId: null, owner: { kind: 'backup_workload', ref: randomUUID() },
      severity: 'high', title: 'Workload backup failed', message: 'Backup failed',
      context: { source: 'backup_provider' }, publisher: 'publish-after-commit-test',
    }));

    const [row] = await withSystemDbAccessContext(() => db.select().from(alerts).where(eq(alerts.id, alertId)));
    expect(row).toMatchObject({ deviceId: null, ownerKind: 'backup_workload' });
    await expectDelivered(alertId);
  });

  it('crash recovery: a committed alert whose after-commit dispatch was lost is delivered by the minute-tick drain', async () => {
    const f = await seedOrgWithRecipient();
    await seedPlainRule(f);
    await insertBreachEvent(f);

    h.dropAlertDispatch = true;
    let alertId: string;
    try {
      alertId = await createWithTransactionHeldOpen(() => sweepOneAlert(f));
    } finally {
      h.dropAlertDispatch = false;
    }

    // Nothing has announced it yet. The row is committed and still active,
    // so every creator's dedupe skips it — it must not stay silent forever.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await inAppCount(alertId)).toBe(0);

    await drainSubjectAlertOutbox();

    await expectDelivered(alertId);
  });

  it('crash recovery still dispatches when an unrelated drain step fails, and the failure still surfaces', async () => {
    const f = await seedOrgWithRecipient();
    await seedPlainRule(f);
    await insertBreachEvent(f);

    h.dropAlertDispatch = true;
    let alertId: string;
    try {
      alertId = await createWithTransactionHeldOpen(() => sweepOneAlert(f));
    } finally {
      h.dropAlertDispatch = false;
    }

    h.failRetirementOutbox = true;
    try {
      await expect(drainSubjectAlertOutbox()).rejects.toThrow('retirement outbox failed (test)');
    } finally {
      h.failRetirementOutbox = false;
    }

    await expectDelivered(alertId);
  });

  it('a rolled-back savepoint inside a committed transaction announces nothing', async () => {
    const f = await seedOrgWithRecipient();
    let alertId: string | null = null;

    await withSystemDbAccessContext(async () => {
      await withDbTransaction(async () => {
        alertId = await createSourcedAlert({
          orgId: f.orgId, deviceId: f.deviceId, severity: 'high', title: 'Savepoint', message: 'Savepoint',
          context: { source: 'publish-after-commit-test' }, publisher: 'publish-after-commit-test',
        });
        throw new Error('savepoint rolls back');
      }).catch(() => undefined);
    });

    expect(alertId).toEqual(expect.any(String));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await readAlert(alertId!)).toBeUndefined();
    expect(deliveries.filter((d) => d.alertId === alertId)).toEqual([]);
  });

  it('more than one dispatch batch staged in one transaction is all announced', async () => {
    const f = await seedOrgWithRecipient();
    const count = 105;

    const ids = await withSystemDbAccessContext(async () => {
      const created: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = await createSourcedAlert({
          orgId: f.orgId, deviceId: null, owner: { kind: 'backup_workload', ref: randomUUID() },
          severity: 'low', title: `Workload ${i}`, message: 'Backup failed',
          context: { source: 'backup_provider' }, publisher: 'publish-after-commit-test',
        });
        if (!id) throw new Error('fixture did not create an alert');
        created.push(id);
      }
      return created;
    });

    // 105 ids queue for one dispatch loop that takes them 100 at a time.
    await expect.poll(() => ids.filter((id) => deliveriesFor(id).length === 0).length, {
      timeout: 30_000, interval: 200,
    }).toBe(0);
    expect(ids.every((id) => deliveriesFor(id).length === 1)).toBe(true);
    const pending = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT count(*)::int AS n FROM alerts WHERE org_id = ${f.orgId} AND context ? '_subjectDispatch'`));
    expect(pending).toEqual([{ n: 0 }]);
  });

  it('a rolled-back transaction announces nothing', async () => {
    const f = await seedOrgWithRecipient();
    let alertId: string | null = null;

    await expect(withSystemDbAccessContext(async () => {
      alertId = await createSourcedAlert({
        orgId: f.orgId, deviceId: f.deviceId, severity: 'high', title: 'Rolled back', message: 'Rolled back',
        context: { source: 'publish-after-commit-test' }, publisher: 'publish-after-commit-test',
      });
      throw new Error('caller fails after creating the alert');
    })).rejects.toThrow('caller fails after creating the alert');

    expect(alertId).toEqual(expect.any(String));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await readAlert(alertId!)).toBeUndefined();
    expect(deliveries.filter((d) => d.alertId === alertId)).toEqual([]);
    expect(processAlertRuns.has(alertId!)).toBe(false);
  });

  it('a failed publish keeps the row, backs off, and is retried by a later drain', async () => {
    const f = await seedOrgWithRecipient();
    const triggeredPublishes = (id: string) => vi.mocked(publishEvent).mock.calls
      .filter(([type, , payload]) => type === 'alert.triggered' && (payload as { alertId?: string }).alertId === id).length;

    h.failNextTriggeredPublish = true;
    const alertId = await createWithTransactionHeldOpen(() => createSourcedAlert({
      orgId: f.orgId, deviceId: null, owner: { kind: 'backup_workload', ref: randomUUID() },
      severity: 'high', title: 'Workload backup failed', message: 'Backup failed',
      context: { source: 'backup_provider' }, publisher: 'publish-after-commit-test',
    }));

    // The after-commit dispatch tried once and failed. Unlike the old inline
    // rollback, the alert survives with its envelope, backed off for a minute.
    await expect.poll(async () => pendingDispatch(await readAlert(alertId))?.failedAttempts, { timeout: 5_000 }).toBe(1);
    const failed = await readAlert(alertId);
    expect(failed?.status).toBe('active');
    expect(new Date(String(pendingDispatch(failed)?.leaseUntil)).getTime()).toBeGreaterThan(Date.now());
    expect(triggeredPublishes(alertId)).toBe(1);
    expect(deliveriesFor(alertId)).toEqual([]);

    // A drain inside the backoff leaves it alone, so failing rows step aside.
    await drainSubjectAlertOutbox();
    expect(triggeredPublishes(alertId)).toBe(1);

    await expireLease(alertId);
    await drainSubjectAlertOutbox();

    await expectDelivered(alertId);
    expect(triggeredPublishes(alertId)).toBe(2);
    expect(pendingDispatch(await readAlert(alertId))).toBeUndefined();
  });

  it('an alert resolved before its dispatch is never announced as triggered', async () => {
    const f = await seedOrgWithRecipient();

    h.dropAlertDispatch = true;
    let alertId: string;
    try {
      alertId = await createWithTransactionHeldOpen(() => emitPatchJobFailureAlert({
        orgId: f.orgId, deviceId: f.deviceId, patchJobId: randomUUID(), hostname: 'publish-after-commit',
        failedCount: 1, errorExcerpt: null,
      }));
    } finally {
      h.dropAlertDispatch = false;
    }
    await withSystemDbAccessContext(() => resolveAlert(alertId, 'Fixed before anyone was told'));

    await drainSubjectAlertOutbox();
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(deliveriesFor(alertId)).toEqual([]);
    expect(await inAppCount(alertId)).toBe(0);
    expect((await readAlert(alertId))?.status).toBe('resolved');
  });

  it('noise-control effects run once, after a successful acknowledgement, never on a replay', async () => {
    const f = await seedOrgWithRecipient();
    const correlationsFor = () => vi.mocked(enqueueAlertCorrelation).mock.calls
      .filter(([input]) => input.deviceId === f.deviceId).length;

    h.failAck = true;
    let alertId: string;
    try {
      alertId = await createWithTransactionHeldOpen(() => emitPatchJobFailureAlert({
        orgId: f.orgId, deviceId: f.deviceId, patchJobId: randomUUID(), hostname: 'publish-after-commit',
        failedCount: 1, errorExcerpt: null,
      }));
      // Published and delivered, but the acknowledgement failed: the envelope
      // stays for a replay, and the effects wait for that replay.
      await expectDelivered(alertId);
    } finally {
      h.failAck = false;
    }
    const row = await readAlert(alertId);
    expect(pendingDispatch(row)).toBeDefined();
    expect(correlationsFor()).toBe(0);
    expect(await isCooldownActive(row!.ruleId!, f.deviceId)).toBe(false);

    await expireLease(alertId);
    await drainSubjectAlertOutbox();

    expect(pendingDispatch(await readAlert(alertId))).toBeUndefined();
    expect(correlationsFor()).toBe(1);
    expect(await isCooldownActive(row!.ruleId!, f.deviceId)).toBe(true);
  });
});
