/**
 * #6108 — real-PostgreSQL proof that a long walked-table instance suffix no
 * longer costs the whole poll.
 *
 * The regression this guards was invisible to every mocked suite: the drizzle
 * stub they use accepts any string, so only a live column can show that
 * `snmp_metrics.instance` at VARCHAR(64) aborted the poll's single multi-row
 * INSERT with 22001 and discarded EVERY metric in it. `snmpwalk` of
 * inetCidrRouteTable on a stock Ubuntu snmpd returns 110-char suffixes for
 * IPv6 destinations, so this is what any IPv6-capable router does on its first
 * poll.
 *
 * Two properties, both needing real Postgres:
 *  1. after 2026-10-17-140000-snmp-metrics-instance-width.sql, a 110-char
 *     instance round-trips intact (the column is wide enough);
 *  2. a row that STILL exceeds the widened column is dropped on its own — the
 *     other metrics of the same poll persist and the loss is reported on
 *     snmp_devices.last_error instead of vanishing.
 */
import './setup';

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class { close = vi.fn(); on = vi.fn(); },
  Job: class {},
}));
vi.mock('../../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));
vi.mock('../../jobs/workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import { snmpDevices, snmpMetrics } from '../../db/schema';
import { __testables } from '../../jobs/snmpWorker';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const { processPollResults } = __testables;

/** A real inetCidrRouteTable IPv6 instance suffix: 110 chars, > VARCHAR(64). */
const IPV6_ROUTE_INSTANCE =
  '2.16.32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.1.64.2.16.32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.2.0.2.16.32.1.13.184.0.0.0.0';

/** Wider than the widened column, so the ingest guard must drop just this row. */
const UNSTORABLE_INSTANCE = '1.' + '255.'.repeat(60) + '1';

let fixture: { orgId: string; snmpDeviceId: string };

async function seedFixture() {
  const adminDb = getTestDb() as any;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [snmp] = await adminDb.insert(snmpDevices).values({
    orgId: org.id,
    name: 'Synthetic router',
    ipAddress: '192.0.2.115',
    snmpVersion: 'v2c',
    community: 'synthetic-encrypted-community',
    isActive: true,
    consecutiveFailures: 3,
  }).returning();
  return { orgId: org.id as string, snmpDeviceId: snmp.id as string };
}

function metric(instance: string, oid: string, name: string, value: number) {
  return {
    oid,
    baseOid: '1.3.6.1.2.1.4.24.7.1.7',
    instance,
    name,
    value,
    timestamp: '2026-09-17T12:00:00.000Z',
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await seedFixture();
});

describe('snmp_metrics.instance width (#6108)', () => {
  it('sanity: the column is at least 200 chars wide after the migration', async () => {
    const adminDb = getTestDb() as any;
    const rows = await adminDb.execute(sql`
      SELECT character_maximum_length AS len FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'snmp_metrics' AND column_name = 'instance'`);
    const len = Number((Array.isArray(rows) ? rows[0] : rows.rows?.[0])?.len);
    expect(len).toBeGreaterThanOrEqual(200);
    expect(IPV6_ROUTE_INSTANCE.length).toBeGreaterThan(64);
  });

  it('round-trips a 110-char IPv6 route instance instead of discarding the poll', async () => {
    const adminDb = getTestDb() as any;

    await processPollResults({
      type: 'process-poll-results',
      deviceId: fixture.snmpDeviceId,
      protocol: 2,
      metrics: [
        metric(IPV6_ROUTE_INSTANCE, '1.3.6.1.2.1.4.24.7.1.7.' + IPV6_ROUTE_INSTANCE.slice(0, 80), 'inetCidrRouteIfIndex', 2),
        metric('1', '1.3.6.1.2.1.2.2.1.10.1', 'ifInOctets', 4096),
      ],
    });

    const stored = await adminDb.select({ instance: snmpMetrics.instance, name: snmpMetrics.name })
      .from(snmpMetrics)
      .where(eq(snmpMetrics.deviceId, fixture.snmpDeviceId));
    expect(stored).toHaveLength(2);
    expect(stored.map((r: { instance: string }) => r.instance).sort()).toEqual([IPV6_ROUTE_INSTANCE, '1'].sort());

    const [device] = await adminDb.select({
      lastStatus: snmpDevices.lastStatus,
      lastError: snmpDevices.lastError,
      consecutiveFailures: snmpDevices.consecutiveFailures,
    }).from(snmpDevices).where(eq(snmpDevices.id, fixture.snmpDeviceId));
    expect(device).toMatchObject({ lastStatus: 'online', lastError: null, consecutiveFailures: 0 });
  });

  it('drops only a still-unstorable row and reports it, keeping the rest of the poll', async () => {
    const adminDb = getTestDb() as any;

    await processPollResults({
      type: 'process-poll-results',
      deviceId: fixture.snmpDeviceId,
      protocol: 2,
      metrics: [
        metric('1', '1.3.6.1.2.1.2.2.1.10.1', 'ifInOctets', 4096),
        metric(UNSTORABLE_INSTANCE, '1.3.6.1.2.1.4.24.7.1.7.1', 'inetCidrRouteIfIndex', 2),
        metric('2', '1.3.6.1.2.1.2.2.1.16.2', 'ifOutOctets', 8192),
      ],
    });

    const stored = await adminDb.select({ name: snmpMetrics.name })
      .from(snmpMetrics)
      .where(eq(snmpMetrics.deviceId, fixture.snmpDeviceId));
    expect(stored.map((r: { name: string }) => r.name).sort()).toEqual(['ifInOctets', 'ifOutOctets']);

    const [device] = await adminDb.select({
      lastStatus: snmpDevices.lastStatus,
      lastError: snmpDevices.lastError,
      lastErrorAt: snmpDevices.lastErrorAt,
    }).from(snmpDevices).where(eq(snmpDevices.id, fixture.snmpDeviceId));
    expect(device.lastStatus).toBe('online');
    expect(device.lastError).toContain('instance');
    expect(device.lastError).toContain('Dropped 1');
    expect(device.lastErrorAt).toBeInstanceOf(Date);
  });
});
