import './setup';
import { cleanupRedis, getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { EvidenceCursor } from '@breeze/shared';
import { closeDb, db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  alerts, configurationPolicies, configPolicyFeatureLinks, configPolicyMonitors,
  configPolicyAssignments, devices, deviceEventLogs, monitorDefinitions,
  monitorDeviceState, monitorEpisodes,
} from '../../db/schema';
import { compileMonitorInTx } from '../../services/monitors/monitorCompiler';
import { checkAllAutoResolve, evaluateDeviceAlerts, getApplicableRules } from '../../services/alertService';
import { eventLogHandler } from '../../services/alertConditions/handlers/eventLog';
import * as eventBus from '../../services/eventBus';
import { closeRedis, getRedis, isRedisAvailable } from '../../services/redis';
import { createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const system = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);
const createdOrgIds: string[] = [];
const at = (time: string) => new Date(`2026-10-30T${time}Z`);
const condition = {
  type: 'event_log', category: 'application', level: 'info',
  sourcePattern: 'On Battery', messagePattern: 'On Battery', countThreshold: 1, windowMinutes: 60,
} as const;

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const orgIds = createdOrgIds.splice(0);
  if (!orgIds.length) return;
  await system(async () => {
    await db.delete(alerts).where(inArray(alerts.orgId, orgIds));
    await db.delete(monitorDeviceState).where(inArray(monitorDeviceState.orgId, orgIds));
    await db.delete(monitorEpisodes).where(inArray(monitorEpisodes.orgId, orgIds));
    await db.delete(configurationPolicies).where(inArray(configurationPolicies.orgId, orgIds));
    await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.orgId, orgIds));
    await db.delete(deviceEventLogs).where(inArray(deviceEventLogs.orgId, orgIds));
    await db.delete(devices).where(inArray(devices.orgId, orgIds));
  });
  await cleanupRedis();
});

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  createdOrgIds.push(org.id);
  const site = await createSite({ orgId: org.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `rearm-${randomUUID()}`,
    hostname: 'rearm-test', osType: 'windows', osVersion: '11', architecture: 'x64',
    agentVersion: '1.0.0', status: 'online', lastSeenAt: new Date(),
  }).returning();
  return { orgId: org.id, deviceId: device!.id };
}

async function attachMonitor(f: Awaited<ReturnType<typeof fixture>>) {
  const { type: _type, ...monitorCondition } = condition;
  return system(async () => {
    const [monitor] = await db.insert(monitorDefinitions).values({
      orgId: f.orgId, name: 'Battery lifecycle', kind: 'event_log', condition: monitorCondition,
      severity: 'high', deliveryMode: 'none', autoResolve: true,
      autoResolveConditions: {
        type: 'event_log', category: 'application', level: 'info',
        messagePattern: 'Power Restored', countThreshold: 1, windowMinutes: 60,
      },
    }).returning();
    await db.transaction(tx => compileMonitorInTx(tx, monitor!));
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
    expect(rules).toHaveLength(1);
    expect(rules[0]!.monitor?.kind).toBe('event_log');
    return { monitorId: monitor!.id, ruleId: rules[0]!.rule.id };
  });
}

function cursors(alert: typeof alerts.$inferSelect): EvidenceCursor[] {
  return Object.values((alert.context as { lifecycle: { cursor: Record<string, EvidenceCursor> } }).lifecycle.cursor);
}

describe('event-log alert re-arm lifecycle', () => {
  it('anchors two outages, freezes recovery, and never reopens on consumed or delayed evidence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('10:00:00'));
    const f = await fixture();
    const { monitorId, ruleId } = await attachMonitor(f);
    const published = vi.spyOn(eventBus, 'publishEvent'); // Call through to real Redis.
    let recordId = 0;
    const insertEvent = async (time: string, message: string, ingested = time) => {
      const [row] = await system(() => db.insert(deviceEventLogs).values({
        ...f, timestamp: at(time), createdAt: at(ingested), level: 'info', category: 'application',
        source: 'On Battery', message, eventId: randomUUID(), details: { logName: 'Application', recordId: ++recordId },
      }).returning());
      return { ts: row!.timestamp.toISOString(), createdAt: row!.createdAt.toISOString(),
        id: row!.id, logName: 'Application', recordId };
    };
    const readAlerts = () => system(() => db.select().from(alerts).where(and(
      eq(alerts.ruleId, ruleId), eq(alerts.deviceId, f.deviceId),
    )));
    const episodes = () => system(() => db.select().from(monitorEpisodes).where(and(
      eq(monitorEpisodes.monitorId, monitorId), eq(monitorEpisodes.deviceId, f.deviceId),
    )));
    const sweep = async (time: string) => {
      vi.setSystemTime(at(time));
      expect(await getRedis()!.ping()).toBe('PONG');
      expect(isRedisAvailable(), 'must not use the in-memory cooldown fallback').toBe(true);
      await cleanupRedis();
      await system(async () => {
        await evaluateDeviceAlerts(f.deviceId);
        await checkAllAutoResolve(f.orgId);
      });
    };

    const triggerA = await insertEvent('10:00:00', 'On Battery', '10:00:30');
    await sweep('10:01:00');
    let rows = await readAlerts();
    expect(rows).toHaveLength(1);
    const aId = rows[0]!.id;
    expect(rows[0]!.status).toBe('active');
    expect(cursors(rows[0]!)).toEqual([triggerA]);
    const recoveryA = await insertEvent('10:04:00', 'Power Restored');
    await sweep('10:05:00');
    rows = await readAlerts();
    expect(rows[0]).toMatchObject({ id: aId, status: 'resolved', resolutionReason: 'condition_cleared' });
    expect(cursors(rows[0]!)).toEqual([recoveryA]);
    const firstEpisode = (await episodes())[0]!;
    expect(firstEpisode.endReason).toBe('recovered');
    expect(firstEpisode.endedAt).not.toBeNull();

    for (const time of ['10:10:00', '10:20:00', '10:30:00', '10:40:00', '12:59:00']) {
      if (time === '10:30:00') await insertEvent('10:02:00', 'On Battery', time);
      await sweep(time);
      expect(await readAlerts(), `no reopen at ${time}`).toHaveLength(1);
      expect((await episodes()).filter(e => e.endedAt === null)).toHaveLength(0);
      expect(cursors((await readAlerts())[0]!)).toEqual([recoveryA]);
    }
    await insertEvent('12:59:00', 'Power Restored');
    const triggerB = await insertEvent('13:00:00', 'On Battery');
    await sweep('13:01:00');
    rows = await readAlerts();
    expect(rows).toHaveLength(2);
    const b = rows.find(row => row.id !== aId)!;
    expect(b.status).toBe('active');
    expect(cursors(b)).toEqual([triggerB]);
    const flap = await insertEvent('13:02:00', 'On Battery');
    await sweep('13:03:00');
    expect(cursors((await readAlerts()).find(row => row.id === b.id)!)).toEqual([flap]);
    await insertEvent('13:01:00', 'Power Restored', '13:04:00');
    await sweep('13:04:00');
    expect((await readAlerts()).find(row => row.id === b.id)!.status).toBe('active');
    const recoveryB = await insertEvent('13:10:00', 'Power Restored');
    await sweep('13:11:00');
    rows = await readAlerts();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.status === 'resolved' && row.resolutionReason === 'condition_cleared')).toBe(true);
    expect(cursors(rows.find(row => row.id === b.id)!)).toEqual([recoveryB]);
    const resolutions = published.mock.calls.filter(([type, orgId]) => type === 'alert.resolved' && orgId === f.orgId);
    expect(resolutions).toHaveLength(2);
    expect(resolutions.map(([, , payload]) => (payload as { alertId: string }).alertId).sort()).toEqual([aId, b.id].sort());

    const plan = await system(() => db.transaction(async tx => {
      // Small fixtures favor seq scans; disabling them proves this predicate matches the index.
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute(sql`EXPLAIN
        SELECT DISTINCT ON (rule_id) rule_id AS "ruleId", context->'lifecycle'->'cursor' AS "cursor",
          COALESCE(resolved_at, dismissed_at) AT TIME ZONE 'UTC' AS "closedAt"
        FROM alerts WHERE device_id = ${f.deviceId}
          AND rule_id = ANY(${sql.param([ruleId])}::uuid[]) AND rule_id IS NOT NULL
          AND status IN ('resolved', 'dismissed') AND COALESCE(subject_key, '') = ''
        ORDER BY rule_id, COALESCE(resolved_at, dismissed_at) DESC`);
    }));
    expect(JSON.stringify(plan)).toContain('alerts_rule_device_subject_closed_idx');
  });

  it('exists-after-cursor probe stays under 20 ms on a device with 50k event rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('14:00:00'));
    const f = await fixture();
    await system(() => db.execute(sql`
      INSERT INTO device_event_logs (device_id, org_id, timestamp, created_at, source, message, level, category, event_id, details)
      SELECT ${f.deviceId}::uuid, ${f.orgId}::uuid,
        ${at('14:00:00').toISOString()}::timestamptz - (50000 - n) * interval '0.072 seconds',
        ${at('14:00:00').toISOString()}::timestamp - (50000 - n) * interval '0.072 seconds',
        'On Battery', CASE WHEN n % 10 = 0 THEN 'On Battery' ELSE 'Routine event' END,
        'info'::event_log_level, 'application'::event_log_category, n::text,
        jsonb_build_object('logName', 'Application', 'recordId', n)
      FROM generate_series(1, 50000) AS series(n)`));
    await getTestDb().execute(sql`ANALYZE device_event_logs`);
    const [row] = await system(() => db.select().from(deviceEventLogs).where(and(
      eq(deviceEventLogs.deviceId, f.deviceId), eq(deviceEventLogs.eventId, '49990'),
    )));
    const cursor: EvidenceCursor = { id: row!.id, ts: row!.timestamp.toISOString(),
      createdAt: row!.createdAt.toISOString(), logName: 'Application', recordId: 49990 };
    // The exact candidate query the handler issues under a cursor (the probe).
    const probeSql = (prefix: string) => sql`${sql.raw(prefix)}
      SELECT id, timestamp, created_at, details->>'logName', details->>'recordId'
      FROM device_event_logs WHERE device_id = ${f.deviceId} AND category = 'application'
        AND timestamp >= ${at('13:00:00').toISOString()}::timestamptz
        AND level = ANY(ARRAY['info','warning','error','critical']::event_log_level[])
        AND source ILIKE '%On Battery%' AND message ILIKE '%On Battery%'
        AND timestamp >= ${new Date(Date.parse(cursor.ts) - 1000).toISOString()}::timestamptz
      ORDER BY timestamp DESC, created_at DESC, id DESC LIMIT 50`;
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const time = async (fn: () => Promise<unknown>) => {
      await fn(); // warm
      const samples: number[] = [];
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        await fn();
        samples.push(performance.now() - start);
      }
      return samples;
    };
    const { probeMs, anchoredMs, unanchoredMs } = await system(async () => {
      const result = await eventLogHandler.evaluate(condition, f.deviceId, { evidenceAfter: cursor, side: 'trigger' });
      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe(5000);
      expect(result.evidenceWatermark?.recordId).toBe(50000);
      return {
        probeMs: await time(() => db.execute(probeSql(''))),
        anchoredMs: await time(() => eventLogHandler.evaluate(condition, f.deviceId, { evidenceAfter: cursor, side: 'trigger' })),
        // Today's rolling count plus the newest-row watermark, without a cursor.
        unanchoredMs: await time(() => eventLogHandler.evaluate(condition, f.deviceId)),
      };
    });
    // stdout directly: the integration setup silences console.log.
    process.stdout.write(`event_log 50k: probe median ${median(probeMs).toFixed(2)} ms; handler anchored ${median(anchoredMs).toFixed(2)} ms, unanchored ${median(unanchoredMs).toFixed(2)} ms\n`);
    if (median(probeMs) >= 20) {
      console.error('exists-after-cursor probe EXPLAIN ANALYZE', await system(() => db.execute(probeSql('EXPLAIN ANALYZE'))));
    }
    // The budget is for the added exists-after-cursor probe; the rolling count
    // it sits on top of is unchanged from before this feature.
    expect(median(probeMs), `probe samples ${probeMs.join(', ')}`).toBeLessThan(20);
    expect(median(anchoredMs) - median(unanchoredMs), 'cost a cursor adds to one evaluation').toBeLessThan(20);
  });
});
