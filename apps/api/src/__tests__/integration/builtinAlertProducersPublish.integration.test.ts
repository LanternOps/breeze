/**
 * #11328 — built-in rule-less producers publish `alert.triggered` exactly once.
 *
 * Log correlation, DNS threat and AI act-verify alerts were raw inserts into
 * `alerts`: the row reached the inbox, but no `alert.triggered` was published,
 * so notification channels, routing rules and escalation never saw it. They now
 * go through `createSourcedAlert`, which stages the event with the row and
 * publishes it after COMMIT through the alert outbox.
 *
 * Real Postgres and the real outbox; only `publishEvent` is replaced by a
 * recorder. Each case runs the producer, waits for the after-commit dispatch,
 * and checks one `alert.triggered` naming the alert's device subject. It then
 * runs the producer again for the same condition and drains the outbox: the
 * open alert is the producer's dedupe, so nothing new is created or published.
 *
 * The fourth producer, the AI fix-watch attention alert, is covered by
 * `services/aiAgents/fixWatch.test.ts`: reaching it needs a full agent run,
 * watch and recurrence fixture, and it calls the same `createSourcedAlert`.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/builtinAlertProducersPublish.integration.test.ts
 *   pnpm test-stack down
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

vi.mock('../../services/eventBus', async (original) => {
  const actual = await original<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'event-id') };
});
// Correlation has its own queue and contract; here it only records calls.
vi.mock('../../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(async () => null) }));

import { closeDb, db, withSystemDbAccessContext } from '../../db';
import { alerts, logCorrelationRules } from '../../db/schema';
import { publishEvent } from '../../services/eventBus';
import { drainSubjectAlertOutbox } from '../../services/subjectAlertOutbox';
import { handleDnsThreatBlocked } from '../../services/dnsThreatAlerts';
import { persistCorrelationForRule } from '../../services/logSearch';
import { recordActVerifyFailureAlert } from '../../services/aiAgents/actVerify';
import { closeRedis } from '../../services/redis';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const runDb = describe.runIf(!!process.env.DATABASE_URL);

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

beforeEach(() => {
  vi.mocked(publishEvent).mockClear();
});

async function seedDevice() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id, hostname: 'producer-publish' });
  return { orgId: org.id, siteId: site.id, deviceId: device.id };
}

type Seeded = Awaited<ReturnType<typeof seedDevice>>;

function triggeredCalls(orgId: string) {
  return vi.mocked(publishEvent).mock.calls.filter((call) => call[0] === 'alert.triggered' && call[1] === orgId);
}

function openAlertsFor(f: Seeded, source: string) {
  return withSystemDbAccessContext(() => db.select().from(alerts).where(and(
    eq(alerts.orgId, f.orgId),
    eq(alerts.deviceId, f.deviceId),
    sql`${alerts.context}->>'source' = ${source}`,
  )));
}

/**
 * The after-commit dispatch is asynchronous: wait for it, then assert exactly
 * one `alert.triggered` for this alert, naming its device subject.
 */
async function expectPublishedOnce(f: Seeded, alertId: string, source: string) {
  await expect.poll(() => triggeredCalls(f.orgId).length, { timeout: 10_000, interval: 50 }).toBe(1);
  const [type, orgId, payload, publisher, options] = triggeredCalls(f.orgId)[0]!;
  expect(type).toBe('alert.triggered');
  expect(orgId).toBe(f.orgId);
  expect(payload).toMatchObject({
    alertId,
    ruleId: null,
    deviceId: f.deviceId,
    owner: null,
    ownerKey: `device:${f.deviceId}`,
    source,
  });
  expect(typeof publisher).toBe('string');
  // The device's site rides on the event so site-restricted users see it.
  expect(options).toMatchObject({ siteId: f.siteId });

  // Acknowledged: the outbox envelope is gone from the committed row.
  const [row] = await withSystemDbAccessContext(() => db.select().from(alerts).where(eq(alerts.id, alertId)));
  expect(row?.status).toBe('active');
  expect((row?.context as Record<string, unknown>)._subjectDispatch).toBeUndefined();
}

/** A repeat run for the same condition: no new alert, nothing published, even after a full drain. */
async function expectNoRepublish(f: Seeded, source: string) {
  await drainSubjectAlertOutbox();
  expect(triggeredCalls(f.orgId)).toHaveLength(1);
  expect(await openAlertsFor(f, source)).toHaveLength(1);
}

runDb('#11328 — built-in rule-less producers publish alert.triggered once', () => {
  it('DNS threat alert', async () => {
    const f = await seedDevice();
    const blocked = {
      deviceId: f.deviceId, domain: 'malware.example.com', category: 'malware',
      integrationId: null, timestamp: new Date().toISOString(),
    };

    const first = await withSystemDbAccessContext(() => handleDnsThreatBlocked(f.orgId, blocked));
    expect(first.reason).toBe('created');
    await expectPublishedOnce(f, first.alertId!, 'dns_threat_evaluator');

    const second = await withSystemDbAccessContext(() => handleDnsThreatBlocked(f.orgId, blocked));
    expect(second).toEqual({ alertId: null, reason: 'cooldown' });
    await expectNoRepublish(f, 'dns_threat_evaluator');
  });

  it('AI act-verify failure alert', async () => {
    const f = await seedDevice();
    const failure = {
      run: { id: randomUUID(), orgId: f.orgId, deviceId: f.deviceId, agentId: randomUUID() },
      op: { key: 'manage_services.restart' },
      target: { kind: 'service' as const, serviceName: 'Spooler' },
      detail: 'service status is "Stopped"',
    };

    await recordActVerifyFailureAlert(failure);
    const [created] = await openAlertsFor(f, 'ai_agent_act_verify');
    expect(created).toBeDefined();
    await expectPublishedOnce(f, created!.id, 'ai_agent_act_verify');

    // The same failing action retried in the same run.
    await recordActVerifyFailureAlert(failure);
    await expectNoRepublish(f, 'ai_agent_act_verify');

    // A different target in the same run is a different failure: its own
    // alert, published once. The jsonb target match must not collapse it.
    await recordActVerifyFailureAlert({ ...failure, target: { kind: 'service', serviceName: 'Other' } });
    await expect.poll(() => triggeredCalls(f.orgId).length, { timeout: 10_000, interval: 50 }).toBe(2);
    expect(await openAlertsFor(f, 'ai_agent_act_verify')).toHaveLength(2);
  });

  it('log correlation alert', async () => {
    const f = await seedDevice();
    const [rule] = await withSystemDbAccessContext(() => db.insert(logCorrelationRules).values({
      orgId: f.orgId, name: 'Repeated logon failures', pattern: 'logon failure',
      severity: 'error', alertOnMatch: true,
    }).returning());
    const detection = {
      orgId: f.orgId,
      pattern: 'logon failure',
      firstSeen: new Date(Date.now() - 60_000),
      lastSeen: new Date(),
      occurrences: 5,
      affectedDevices: [{ deviceId: f.deviceId, hostname: 'producer-publish', count: 5 }],
      sampleLogs: [],
      timeWindowSeconds: 300,
      minDevices: 1,
      minOccurrences: 3,
    };

    const first = await withSystemDbAccessContext(() => persistCorrelationForRule(rule!, detection));
    expect(first.alertId).not.toBeNull();
    await expectPublishedOnce(f, first.alertId!, 'log_correlation');

    const second = await withSystemDbAccessContext(() => persistCorrelationForRule(rule!, detection));
    expect(second).toEqual({ correlationId: first.correlationId, alertId: first.alertId });
    await expectNoRepublish(f, 'log_correlation');
  });
});
