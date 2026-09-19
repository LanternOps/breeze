/**
 * Live-Postgres proof for F1 (Task 16c, PR B second live check):
 * `alert.correlation_group.created` used to be published from INSIDE the
 * correlator's own transaction (`createAlertCorrelationWorker` runs
 * `runAlertCorrelationForDevice` inside `withSystemDbAccessContext`, which —
 * via `withDbAccessContext` — opens a real `baseDb.transaction`). Local event
 * delivery is synchronous and runs the subscriber on ANOTHER pooled
 * connection (via `runOutsideDbContext`), so `createAndEnqueueAgentRun`'s
 * insert could reach `correlation_group_id`'s FK before the group row had
 * committed — `ai_agent_runs_correlation_group_id_fkey` violated (2/2
 * reproductions in the live check, see task-16-manual-check.md's "Re-check
 * after 42P18 fix" section).
 *
 * The unit suite (`jobs/alertCorrelation.test.ts`) mocks `../db` wholesale —
 * `withSystemDbAccessContext` there is just `(fn) => fn()`, so it can prove
 * ORDERING (publish happens after the mocked context resolves) but nothing
 * about whether the row is actually COMMITTED and visible to a genuinely
 * separate connection at that moment. Only a real-DB integration test can
 * show that, which is what this suite does: it runs
 * `processAlertCorrelationJob` — the exact function the BullMQ worker calls —
 * end-to-end against the test DB, with `publishEvent` mocked so we can look
 * INSIDE the moment of publication and confirm the group row is visible via
 * a fresh `withSystemDbAccessContext` call (a separate pooled connection,
 * not the transaction that wrote it).
 *
 * Prerequisites:
 *   pnpm test-stack up   (or docker compose -f docker-compose.test.yml up -d)
 *
 * Run:
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     --pool=threads --maxWorkers=2 \
 *     src/__tests__/integration/alertCorrelationPublish.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// publishEvent writes to a Redis stream — spy on it so we can both assert the
// payload AND look inside the moment of publication (see below). Precedent:
// agentRunAdmission.integration.test.ts.
const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { db, withSystemDbAccessContext } from '../../db';
import { alertCorrelationGroups, alertRules, alertTemplates, alerts, devices } from '../../db/schema';
import { processAlertCorrelationJob } from '../../jobs/alertCorrelation';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  orgId: string;
  deviceId: string;
}

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });

    const suffix = randomUUID().slice(0, 8);
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `correlation-publish-${suffix}`,
        hostname: `correlation-publish-${suffix}`,
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning({ id: devices.id });
    if (!device) throw new Error('failed to seed device');

    const [template] = await db
      .insert(alertTemplates)
      .values({
        orgId: org.id,
        partnerId: null,
        name: `Correlation publish template ${suffix}`,
        conditions: { type: 'metric', metric: 'cpu', operator: 'gt', value: 90 },
        severity: 'high',
        titleTemplate: '{{ruleName}} triggered on {{deviceName}}',
        messageTemplate: '{{ruleName}} condition met',
      })
      .returning({ id: alertTemplates.id });
    if (!template) throw new Error('failed to seed alert template');

    const [rule] = await db
      .insert(alertRules)
      .values({
        orgId: org.id,
        partnerId: null,
        templateId: template.id,
        name: `Correlation publish rule ${suffix}`,
        targetType: 'organization',
        targetId: org.id,
        isActive: true,
      })
      .returning({ id: alertRules.id });
    if (!rule) throw new Error('failed to seed alert rule');

    const now = new Date();
    const later = new Date(now.getTime() + 60_000);
    // Two same-rule, same-device alerts a minute apart, well inside the 30-minute
    // default correlation window — runAlertCorrelationForDevice must both (a)
    // link them (same_rule_temporal, confidence > 0.3) and (b) group them, with
    // no pre-seeded alert_correlations/alert_correlation_groups rows: unlike
    // alertCorrelationGroups.integration.test.ts (D1), this suite exercises the
    // FULL scan-and-persist path, not just the group upsert.
    await db.insert(alerts).values([
      {
        ruleId: rule.id,
        deviceId: device.id,
        orgId: org.id,
        severity: 'critical',
        title: `High CPU usage detected ${suffix}`,
        triggeredAt: now,
      },
      {
        ruleId: rule.id,
        deviceId: device.id,
        orgId: org.id,
        severity: 'critical',
        title: `High CPU usage detected ${suffix}`,
        triggeredAt: later,
      },
    ]);

    return { orgId: org.id, deviceId: device.id };
  });
}

describe('alert.correlation_group.created publishes only after the correlator transaction commits (F1)', () => {
  runDb(
    'processAlertCorrelationJob: the group row is visible via a FRESH withSystemDbAccessContext call at the moment publishEvent fires',
    async () => {
      publishEventMock.mockClear();
      const fixture = await seedFixture();

      // Captured from INSIDE the publishEvent mock — i.e. at the exact moment
      // processAlertCorrelationJob calls it, after its own
      // withSystemDbAccessContext(() => runAlertCorrelationForDevice(...)) has
      // already resolved. Each withSystemDbAccessContext call opens its own
      // baseDb.transaction on a connection drawn from the pool — a separate
      // connection from whichever one ran the correlator's transaction — so
      // finding the row here is real proof of a COMMIT, not just of the
      // writing transaction being able to see its own uncommitted work.
      const visibleAtPublishTime: Array<{ groupId: string; found: boolean }> = [];
      publishEventMock.mockImplementation(async (...args: unknown[]) => {
        const [eventType, , payload] = args as [string, string, unknown];
        if (eventType === 'alert.correlation_group.created') {
          const { groupId } = payload as { groupId: string };
          const rows = await withSystemDbAccessContext(() =>
            db.select().from(alertCorrelationGroups).where(eq(alertCorrelationGroups.id, groupId)),
          );
          visibleAtPublishTime.push({ groupId, found: rows.length > 0 });
        }
        return 'test-event-id';
      });

      const result = await processAlertCorrelationJob({
        orgId: fixture.orgId,
        deviceId: fixture.deviceId,
        queuedAt: new Date().toISOString(),
      });

      // Sanity: the fixture actually produced a group (not a false-positive pass
      // from zero calls to either publishEvent or the assertions below).
      expect(result.createdGroups.length).toBeGreaterThanOrEqual(1);
      expect(publishEventMock).toHaveBeenCalledTimes(result.createdGroups.length);
      for (const call of publishEventMock.mock.calls) {
        expect(call[0]).toBe('alert.correlation_group.created');
        expect(call[1]).toBe(fixture.orgId);
      }

      expect(visibleAtPublishTime).toHaveLength(result.createdGroups.length);
      for (const { found } of visibleAtPublishTime) {
        expect(found).toBe(true);
      }
    },
  );
});
