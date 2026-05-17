/**
 * LATERAL latest-metrics query — integration test
 *
 * `GET /devices` enriches each row with its newest `device_metrics` sample.
 * The query lives in `routes/devices/core.ts` and uses
 * `(VALUES ($1::uuid), ($2::uuid), ...) AS d(device_id) INNER JOIN LATERAL
 *  (SELECT ... FROM device_metrics WHERE device_id = d.device_id
 *   ORDER BY timestamp DESC LIMIT 1) AS m ON true`.
 *
 * Two things this test pins that a mocked unit test cannot:
 *
 *   1. The Drizzle `sql` template's array-spread behavior — passing a JS
 *      array of UUIDs as `${ids}::uuid[]` actually emits N positional
 *      parameters, not a single array. That bug bit production on this
 *      exact code path during deploy iteration; the `sql.join` + VALUES
 *      form below is the verified fix. A regression to the array-spread
 *      shape would fail this test at runtime against real Postgres.
 *
 *   2. The query plan still uses the (device_id, timestamp) PK with
 *      backward index scan + LIMIT 1 — i.e. the per-device cost stays
 *      O(log n) and doesn't fall back to a full per-device scan.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/devicesLatestMetricsLateral.integration.test.ts
 */
import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { devices, deviceMetrics } from '../../db/schema';
import { createPartner, createOrganization, createSite } from './db-utils';

// Index signature required so `db.execute<T>` accepts T as a Record<string, unknown>.
interface LateralRow extends Record<string, unknown> {
  device_id: string;
  cpu_percent: number;
  ram_percent: number;
  timestamp: Date;
}

// devices.agent_id is NOT NULL — generate per row so the FK-less insert
// satisfies the constraint without bringing in the enrollment service.
let agentIdCounter = 0;
async function insertDevice(opts: {
  orgId: string;
  siteId: string;
  hostname: string;
}): Promise<string> {
  const db = getTestDb();
  agentIdCounter++;
  const [row] = await db
    .insert(devices)
    .values({
      orgId: opts.orgId,
      siteId: opts.siteId,
      agentId: `agent-test-${agentIdCounter}-${Date.now()}`,
      hostname: opts.hostname,
      displayName: opts.hostname,
      osType: 'windows',
      osVersion: '11',
      osBuild: '22000',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertDevice: insert returned no row');
  return row.id;
}

async function insertMetric(opts: {
  deviceId: string;
  orgId: string;
  timestamp: Date;
  cpuPercent: number;
  ramPercent: number;
}) {
  const db = getTestDb();
  await db.insert(deviceMetrics).values({
    deviceId: opts.deviceId,
    orgId: opts.orgId,
    timestamp: opts.timestamp,
    cpuPercent: opts.cpuPercent,
    ramPercent: opts.ramPercent,
    ramUsedMb: 1000,
    diskPercent: 50,
    diskUsedGb: 100,
  });
}

describe('GET /devices latest-metrics LATERAL query (integration)', () => {
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
    const site = await createSite({ orgId });
    siteId = site.id;
  });

  it('returns the newest metric row per device, never a stale one', async () => {
    const deviceA = await insertDevice({ orgId, siteId, hostname: 'host-a' });
    const deviceB = await insertDevice({ orgId, siteId, hostname: 'host-b' });
    const deviceC = await insertDevice({ orgId, siteId, hostname: 'host-c' });

    // Each device gets multiple metric rows. The LATERAL must pick the
    // last (timestamp DESC LIMIT 1) — not the first, not the average.
    await insertMetric({ deviceId: deviceA, orgId, timestamp: new Date('2026-05-16T10:00:00Z'), cpuPercent: 5, ramPercent: 10 });
    await insertMetric({ deviceId: deviceA, orgId, timestamp: new Date('2026-05-16T11:00:00Z'), cpuPercent: 25, ramPercent: 40 });
    await insertMetric({ deviceId: deviceA, orgId, timestamp: new Date('2026-05-16T12:00:00Z'), cpuPercent: 50, ramPercent: 75 }); // newest

    await insertMetric({ deviceId: deviceB, orgId, timestamp: new Date('2026-05-16T09:00:00Z'), cpuPercent: 99, ramPercent: 99 });
    await insertMetric({ deviceId: deviceB, orgId, timestamp: new Date('2026-05-16T13:00:00Z'), cpuPercent: 3, ramPercent: 8 }); // newest

    await insertMetric({ deviceId: deviceC, orgId, timestamp: new Date('2026-05-16T08:00:00Z'), cpuPercent: 17, ramPercent: 22 }); // only one, also newest

    const deviceIds = [deviceA, deviceB, deviceC];

    // Mirror the exact construction used by routes/devices/core.ts.
    // If a future Drizzle change reverts to array-spread semantics, the
    // parameter binding will fail at this call against real Postgres.
    const idTuples = sql.join(
      deviceIds.map((id) => sql`(${id}::uuid)`),
      sql`, `
    );

    const rows = await getTestDb().execute<LateralRow>(sql`
      SELECT d.device_id, m.cpu_percent, m.ram_percent, m.timestamp
      FROM (VALUES ${idTuples}) AS d(device_id)
      INNER JOIN LATERAL (
        SELECT cpu_percent, ram_percent, timestamp
        FROM ${deviceMetrics}
        WHERE device_id = d.device_id
        ORDER BY timestamp DESC
        LIMIT 1
      ) AS m ON true
    `);

    expect(rows).toHaveLength(3);

    const byId = new Map(rows.map((r: LateralRow) => [r.device_id, r]));
    // cpu/ram values uniquely identify which metric row was picked,
    // so they double as a "newest-row" assertion. (Asserting the raw
    // timestamp round-trip is a separate concern — `timestamp without
    // time zone` + JS Date involves TZ semantics that aren't the subject
    // of this query test.)
    expect(byId.get(deviceA)?.cpu_percent).toBe(50);
    expect(byId.get(deviceA)?.ram_percent).toBe(75);
    expect(byId.get(deviceB)?.cpu_percent).toBe(3);
    expect(byId.get(deviceB)?.ram_percent).toBe(8);
    expect(byId.get(deviceC)?.cpu_percent).toBe(17);
    expect(byId.get(deviceC)?.ram_percent).toBe(22);
  });

  it('returns no row for a device with zero metrics (INNER JOIN drops it)', async () => {
    const deviceWithMetrics = await insertDevice({ orgId, siteId, hostname: 'host-with' });
    const deviceWithout = await insertDevice({ orgId, siteId, hostname: 'host-without' });
    await insertMetric({
      deviceId: deviceWithMetrics, orgId,
      timestamp: new Date('2026-05-16T12:00:00Z'),
      cpuPercent: 42, ramPercent: 50,
    });

    const deviceIds = [deviceWithMetrics, deviceWithout];
    const idTuples = sql.join(
      deviceIds.map((id) => sql`(${id}::uuid)`),
      sql`, `
    );

    const rows = await getTestDb().execute<LateralRow>(sql`
      SELECT d.device_id, m.cpu_percent, m.ram_percent, m.timestamp
      FROM (VALUES ${idTuples}) AS d(device_id)
      INNER JOIN LATERAL (
        SELECT cpu_percent, ram_percent, timestamp
        FROM ${deviceMetrics}
        WHERE device_id = d.device_id
        ORDER BY timestamp DESC
        LIMIT 1
      ) AS m ON true
    `);

    // Caller (core.ts) uses a Map keyed by device_id and falls back to
    // 0 / null when a device isn't in the map, so missing rows are
    // expected and benign — but the query itself must return ONLY the
    // device that has metrics.
    expect(rows).toHaveLength(1);
    const [onlyRow] = rows;
    if (!onlyRow) throw new Error('expected exactly one row');
    expect(onlyRow.device_id).toBe(deviceWithMetrics);
    expect(onlyRow.cpu_percent).toBe(42);
  });

  it('uses the (device_id, timestamp) PK with backward index scan + LIMIT 1', async () => {
    // Plan-shape guard. The point of LATERAL is that the inner subquery
    // does a backward index scan with LIMIT 1 — depth 1, not a full
    // per-device scan. EXPLAIN should show that. If a future refactor
    // accidentally regresses to a sort-on-disk or full-history shape,
    // this fails loudly with the plan that broke it.
    const device = await insertDevice({ orgId, siteId, hostname: 'host-plan' });
    for (let i = 0; i < 200; i++) {
      await insertMetric({
        deviceId: device, orgId,
        timestamp: new Date(Date.now() - i * 60_000),
        cpuPercent: i, ramPercent: i,
      });
    }

    const idTuples = sql.join([sql`(${device}::uuid)`], sql`, `);
    const plan = await getTestDb().execute<{ 'QUERY PLAN': string }>(sql`
      EXPLAIN
      SELECT d.device_id, m.cpu_percent, m.ram_percent, m.timestamp
      FROM (VALUES ${idTuples}) AS d(device_id)
      INNER JOIN LATERAL (
        SELECT cpu_percent, ram_percent, timestamp
        FROM ${deviceMetrics}
        WHERE device_id = d.device_id
        ORDER BY timestamp DESC
        LIMIT 1
      ) AS m ON true
    `);

    const planText = plan.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
    expect(planText).toMatch(/Index Scan Backward using device_metrics_device_id_timestamp_pk/);
    expect(planText).toMatch(/Limit/);
  });
});
