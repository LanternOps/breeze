import './setup';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentLogs, devices } from '../../db/schema';
import { diagnosticLogsRoutes } from '../../routes/devices/diagnosticLogs';
import { watchdogLogsRoutes } from '../../routes/devices/watchdogLogs';
import { __testOnly as retentionTestOnly } from '../../jobs/agentLogRetention';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';

async function insertDevice(orgId: string, siteId: string, suffix: string) {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `receipt-${suffix}-${randomUUID()}`.slice(0, 64),
    hostname: `receipt-${suffix}`,
    osType: 'linux',
    osVersion: 'test',
    architecture: 'x64',
    agentVersion: 'test',
  }).returning({ id: devices.id });
  return device!;
}

describe('agent log receipt-time boundary', () => {
  it('orders HTTP readers by receipt, keeps explicit event-time filters, and denies cross-org detail', async () => {
    const own = await setupTestEnvironment({
      rolePermissions: [{ resource: 'devices', action: 'read' }],
    });
    const foreign = await setupTestEnvironment({
      rolePermissions: [{ resource: 'devices', action: 'read' }],
    });
    const ownDevice = await insertDevice(own.organization.id, own.site.id, 'own');
    const foreignDevice = await insertDevice(foreign.organization.id, foreign.site.id, 'foreign');
    const historicalFutureId = randomUUID();
    const newestReceiptId = randomUUID();

    await getTestDb().insert(agentLogs).values([
      {
        id: historicalFutureId,
        deviceId: ownDevice.id,
        orgId: own.organization.id,
        timestamp: new Date('2099-01-01T00:00:00.000Z'),
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        level: 'warn',
        component: 'watchdog.clock',
        message: 'historical future event time',
      },
      {
        id: newestReceiptId,
        deviceId: ownDevice.id,
        orgId: own.organization.id,
        timestamp: new Date('2026-05-01T00:00:00.000Z'),
        createdAt: new Date('2026-05-02T00:00:00.000Z'),
        level: 'warn',
        component: 'watchdog.current',
        message: 'newest receipt',
      },
    ]);

    const app = new Hono();
    app.route('/devices', diagnosticLogsRoutes);
    app.route('/devices', watchdogLogsRoutes);
    const headers = { Authorization: `Bearer ${own.token}` };

    for (const suffix of ['diagnostic-logs', 'watchdog-logs']) {
      const response = await app.request(`/devices/${ownDevice.id}/${suffix}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json() as { logs: Array<{ id: string }> };
      expect(body.logs.map((row) => row.id)).toEqual([newestReceiptId, historicalFutureId]);
    }

    const eventTimeResponse = await app.request(
      `/devices/${ownDevice.id}/diagnostic-logs?since=2098-01-01T00:00:00.000Z`,
      { headers },
    );
    expect(eventTimeResponse.status).toBe(200);
    expect((await eventTimeResponse.json() as { logs: Array<{ id: string }> }).logs.map((row) => row.id))
      .toEqual([historicalFutureId]);

    const denied = await app.request(`/devices/${foreignDevice.id}/diagnostic-logs`, { headers });
    expect(denied.status).toBe(404);
  });

  it('breaks ties inside one receipt instant by event time, not by random uuid', async () => {
    // Ingest writes up to 100 rows per INSERT, so a whole batch lands on the
    // same created_at to the microsecond. Without the event-time tie-break the
    // random uuid id decides the order and each batch reads back shuffled.
    const env = await setupTestEnvironment({
      rolePermissions: [{ resource: 'devices', action: 'read' }],
    });
    const device = await insertDevice(env.organization.id, env.site.id, 'tie');
    const sharedReceipt = new Date('2026-06-01T00:00:00.000Z');
    // Ids chosen so ascending id order is the OPPOSITE of the expected order:
    // an id-only tie-break returns [olderEvent, newerEvent] and fails below.
    const newerEventId = '00000000-0000-4000-8000-00000000000a';
    const olderEventId = '11111111-1111-4111-8111-11111111111b';

    await getTestDb().insert(agentLogs).values([
      {
        id: newerEventId,
        deviceId: device.id,
        orgId: env.organization.id,
        timestamp: new Date('2026-06-01T00:00:09.000Z'),
        createdAt: sharedReceipt,
        level: 'info',
        component: 'watchdog.tie',
        message: 'second event in the batch',
      },
      {
        id: olderEventId,
        deviceId: device.id,
        orgId: env.organization.id,
        timestamp: new Date('2026-06-01T00:00:01.000Z'),
        createdAt: sharedReceipt,
        level: 'info',
        component: 'watchdog.tie',
        message: 'first event in the batch',
      },
    ]);

    const app = new Hono();
    app.route('/devices', diagnosticLogsRoutes);
    app.route('/devices', watchdogLogsRoutes);
    const headers = { Authorization: `Bearer ${env.token}` };

    for (const suffix of ['diagnostic-logs', 'watchdog-logs']) {
      const response = await app.request(`/devices/${device.id}/${suffix}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json() as { logs: Array<{ id: string }> };
      expect(body.logs.map((row) => row.id)).toEqual([newerEventId, olderEventId]);
    }
  });

  it('prunes by receipt time and installs the online receipt query indexes', async () => {
    const env = await setupTestEnvironment();
    const device = await insertDevice(env.organization.id, env.site.id, 'retention');
    const oldReceiptFutureEvent = randomUUID();
    const freshReceiptPastEvent = randomUUID();
    const now = Date.now();

    await getTestDb().insert(agentLogs).values([
      {
        id: oldReceiptFutureEvent,
        deviceId: device.id,
        orgId: env.organization.id,
        timestamp: new Date('2099-01-01T00:00:00.000Z'),
        createdAt: new Date(now - 8 * 86_400_000),
        level: 'info',
        component: 'receipt.retention',
        message: 'old receipt, future event',
      },
      {
        id: freshReceiptPastEvent,
        deviceId: device.id,
        orgId: env.organization.id,
        timestamp: new Date('2000-01-01T00:00:00.000Z'),
        createdAt: new Date(now),
        level: 'info',
        component: 'receipt.retention',
        message: 'fresh receipt, old event',
      },
    ]);

    const result = await retentionTestOnly.pruneAgentLogsByReceiptTime({
      cutoff: new Date(now - 7 * 86_400_000).toISOString(),
      batchSize: 10,
      maxBatches: 2,
    });
    expect(result.deleted).toBe(1);

    const remaining = await getTestDb()
      .select({ id: agentLogs.id })
      .from(agentLogs)
      .where(and(eq(agentLogs.orgId, env.organization.id), inArray(agentLogs.id, [oldReceiptFutureEvent, freshReceiptPastEvent])));
    expect(remaining).toEqual([{ id: freshReceiptPastEvent }]);

    const indexes = await getTestDb().execute(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'agent_logs'
        AND indexname IN (
          'agent_logs_created_at_idx',
          'agent_logs_device_created_at_idx',
          'agent_logs_org_created_at_idx'
        )
      ORDER BY indexname
    `) as unknown as Array<{ indexname: string; indexdef: string }>;
    expect(indexes.map((row) => row.indexname)).toEqual([
      'agent_logs_created_at_idx',
      'agent_logs_device_created_at_idx',
      'agent_logs_org_created_at_idx',
    ]);
    expect(indexes.find((row) => row.indexname === 'agent_logs_device_created_at_idx')?.indexdef)
      .toContain('(device_id, created_at DESC, id DESC)');
    expect(indexes.find((row) => row.indexname === 'agent_logs_org_created_at_idx')?.indexdef)
      .toContain('(org_id, created_at DESC, id DESC)');
  });
});
