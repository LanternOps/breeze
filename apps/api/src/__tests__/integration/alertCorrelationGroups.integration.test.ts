/**
 * Live-Postgres proof for D1 (Task 16b): `upsertGroup`/`upsertMembers` in
 * `services/alertCorrelationGroups.ts` bound their `jsonb_build_object(...)`
 * arguments as untyped parameters. `jsonb_build_object` is `VARIADIC "any"`,
 * so a parameter used only as an argument to it (never as a direct INSERT
 * column value) gives Postgres no column type to infer from — the extended
 * query protocol postgres.js/Drizzle use here then raises `42P18 could not
 * determine data type of parameter`.
 *
 * The unit suite (`services/alertCorrelationGroups.test.ts`) mocks `db.execute`
 * entirely, so it can never see this — it doesn't send the query through a
 * real Postgres parser. Only a real-DB integration test does.
 *
 * Prerequisites:
 *   pnpm test-stack up   (or docker compose -f docker-compose.test.yml up -d)
 *
 * Run:
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     --pool=threads --maxWorkers=2 \
 *     src/__tests__/integration/alertCorrelationGroups.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import {
  alertCorrelationGroups,
  alertCorrelations,
  alertRules,
  alertTemplates,
  alerts,
  devices,
} from '../../db/schema';
import { persistAlertCorrelationGroupsForAlerts } from '../../services/alertCorrelationGroups';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  orgId: string;
  deviceId: string;
  alertAId: string;
  alertBId: string;
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
        agentId: `correlation-groups-${suffix}`,
        hostname: `correlation-groups-${suffix}`,
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
        name: `Correlation groups template ${suffix}`,
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
        name: `Correlation groups rule ${suffix}`,
        targetType: 'organization',
        targetId: org.id,
        isActive: true,
      })
      .returning({ id: alertRules.id });
    if (!rule) throw new Error('failed to seed alert rule');

    const now = new Date();
    const later = new Date(now.getTime() + 60_000);
    const [alertA, alertB] = await db
      .insert(alerts)
      .values([
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
      ])
      .returning({ id: alerts.id });
    if (!alertA || !alertB) throw new Error('failed to seed alerts');

    await db.insert(alertCorrelations).values({
      parentAlertId: alertA.id,
      childAlertId: alertB.id,
      correlationType: 'same_device_temporal',
      confidence: '0.91',
    });

    return {
      orgId: org.id,
      deviceId: device.id,
      alertAId: alertA.id,
      alertBId: alertB.id,
    };
  });
}

describe('alert_correlation_groups upsert against real Postgres (D1, 42P18)', () => {
  runDb(
    'persists a group + members with typed jsonb params, and the second pass is a re-upsert (xmax != 0)',
    async () => {
      const fixture = await seedFixture();

      const first = await withSystemDbAccessContext(() =>
        persistAlertCorrelationGroupsForAlerts({
          orgId: fixture.orgId,
          alertIds: [fixture.alertAId, fixture.alertBId],
        }),
      );

      expect(first.groupsWritten).toBe(1);
      expect(first.membersWritten).toBe(2);
      expect(first.createdGroupIds).toHaveLength(1);

      const groupId = first.createdGroupIds[0]!;
      const [row] = await withSystemDbAccessContext(() =>
        db.select().from(alertCorrelationGroups).where(eq(alertCorrelationGroups.id, groupId)),
      );
      expect(row).toBeDefined();
      expect(row!.orgId).toBe(fixture.orgId);
      expect(row!.rootAlertId).toBe(fixture.alertAId);
      const metadata = row!.metadata as { version?: string; correlationTypes?: string[] };
      expect(metadata.version).toBe('alert-correlation-groups-v1');
      expect(metadata.correlationTypes).toEqual(['same_device_temporal']);

      // Second pass over the same alerts hits the same group_key, so it's an
      // UPDATE via ON CONFLICT — xmax != 0 — and createdGroupIds must be empty.
      const second = await withSystemDbAccessContext(() =>
        persistAlertCorrelationGroupsForAlerts({
          orgId: fixture.orgId,
          alertIds: [fixture.alertAId, fixture.alertBId],
        }),
      );
      expect(second.groupsWritten).toBe(1);
      expect(second.membersWritten).toBe(2);
      expect(second.createdGroupIds).toEqual([]);
    },
  );
});
