import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * #5776 — `generateDeviceInventoryReport` gets a real `filters.deviceIds`
 * branch (matching `generateSoftwareInventoryReport`) and a `deviceId`
 * column, so the `export_dataset` device_inventory adapter can restrict a
 * run's frozen target set by device id instead of by hostname. Hostnames are
 * not unique within an org, so a hostname-based restriction can admit a
 * device outside the run's target set whenever two devices share a hostname.
 */
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from '../db';
import type { OrgReportExecutionAuthority } from './siteScope';
import { generateDeviceInventoryReport } from './reportGenerationService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** where() conditions captured per db.select() call, in call order. */
const capturedWhere: SQL[][] = [];

function queueSelects(...resultSets: unknown[][]) {
  const queue = [...resultSets];
  vi.mocked(db.select).mockImplementation((() => {
    const mine: SQL[] = [];
    capturedWhere.push(mine);
    const rows = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit']) {
      chain[method] = () => chain;
    }
    chain.where = (condition: SQL) => {
      mine.push(condition);
      return chain;
    };
    (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve);
    return chain;
  }) as never);
}

function paramsOf(conditions: SQL[]): unknown[] {
  const dialect = new PgDialect();
  return conditions.flatMap((c) => dialect.sqlToQuery(c).params);
}

function authority(): OrgReportExecutionAuthority {
  return {
    principalKind: 'user',
    scope: { version: 1, kind: 'unrestricted', orgId: ORG_ID },
    principalUserId: USER_ID,
    capturedAt: new Date('2026-09-15T12:00:00.000Z'),
    fingerprint: 'f'.repeat(64),
  };
}

function deviceRow(deviceId: string, hostname: string) {
  return {
    deviceId,
    hostname,
    displayName: hostname,
    osType: 'windows',
    osVersion: '11',
    agentVersion: '0.113.0',
    status: 'online',
    lastSeenAt: new Date('2026-09-15T00:00:00.000Z'),
    enrolledAt: new Date('2026-01-01T00:00:00.000Z'),
    cpuModel: 'i7',
    ramTotalMb: 16384,
    diskTotalGb: 512,
    serialNumber: `SN-${deviceId}`,
  };
}

describe('device_inventory filters.deviceIds (#5776)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere.length = 0;
  });

  it('restricts by device id, not hostname, when two devices share a hostname', async () => {
    // DEVICE_A and DEVICE_B share the SAME hostname ('shared-host') — a
    // re-imaged machine or manual duplicate. Only DEVICE_A is admitted via
    // filters.deviceIds. The queued result is what the real
    // `inArray(devices.id, [DEVICE_A])` predicate would return (the DB does
    // the filtering); this test proves that predicate's params name DEVICE_A
    // and not DEVICE_B, i.e. the restriction is keyed on device id, so a
    // hostname collision cannot let DEVICE_B ride along.
    queueSelects([deviceRow(DEVICE_A, 'shared-host')]);

    const report = await generateDeviceInventoryReport(
      ORG_ID,
      { filters: { deviceIds: [DEVICE_A] } },
      authority(),
    );

    // The manual-asset branch must not run at all once deviceIds narrows the
    // report — manual assets have no device id to match against.
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(capturedWhere).toHaveLength(1);
    expect(paramsOf(capturedWhere[0]!)).toContain(DEVICE_A);
    expect(paramsOf(capturedWhere[0]!)).not.toContain(DEVICE_B);

    expect(report.rowCount).toBe(1);
    expect(report.rows[0]).toMatchObject({ deviceId: DEVICE_A, hostname: 'shared-host' });
  });

  it('an empty deviceIds array is treated as no filter (falls through to unrestricted)', async () => {
    queueSelects([deviceRow(DEVICE_A, 'host-a')], []);

    await generateDeviceInventoryReport(ORG_ID, { filters: { deviceIds: [] } }, authority());

    // Falls back to the normal two-branch (agent + manual) query, same as no
    // filter at all — an empty array is not a real restriction.
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('projects deviceId: null on manual-asset rows when no deviceIds filter is applied', async () => {
    queueSelects(
      [deviceRow(DEVICE_A, 'host-a')],
      [{ name: 'Spare Laptop', serialNumber: 'MANUAL-SN', createdAt: new Date('2026-05-01T00:00:00.000Z') }],
    );

    const report = await generateDeviceInventoryReport(ORG_ID, {}, authority());

    const manual = report.rows.find((r) => r.serialNumber === 'MANUAL-SN');
    expect(manual?.deviceId).toBeNull();
  });
});
