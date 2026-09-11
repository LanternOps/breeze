import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * #4622 W03 — `device_inventory` unions hand-entered manual assets with agent
 * devices. The thing that must never regress here is that the site-scope
 * predicate is applied to EACH branch independently: a site-restricted
 * technician who could see manual rows from a site they are not allowed would
 * be a tenant-isolation leak dressed up as a report.
 */
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from '../db';
import type { ReportExecutionAuthority } from './siteScope';
import { generateDeviceInventoryReport } from './reportGenerationService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

function authority(
  kind: 'unrestricted' | 'restricted',
  siteIds: string[] = [],
): ReportExecutionAuthority {
  return {
    principalKind: 'user',
    scope: kind === 'restricted'
      ? { version: 1, kind, orgId: ORG_ID, siteIds }
      : { version: 1, kind, orgId: ORG_ID },
    principalUserId: USER_ID,
    capturedAt: new Date('2026-09-07T12:00:00.000Z'),
    fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
  };
}

const AGENT_ROW = {
  hostname: 'agent-1',
  displayName: 'Agent One',
  osType: 'windows',
  osVersion: '11',
  agentVersion: '0.110.0',
  status: 'online',
  lastSeenAt: new Date('2026-09-07T00:00:00.000Z'),
  enrolledAt: new Date('2026-01-01T00:00:00.000Z'),
  cpuModel: 'i7',
  ramTotalMb: 16384,
  diskTotalGb: 512,
  serialNumber: 'AGENT-SN',
};

const MANUAL_ROW = {
  name: 'Spare Laptop',
  serialNumber: 'MANUAL-SN',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
};

describe('device_inventory manual-asset union (#4622)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere.length = 0;
  });

  it('includes manual rows projected onto the agent column shape', async () => {
    queueSelects([AGENT_ROW], [MANUAL_ROW]);

    const report = await generateDeviceInventoryReport(ORG_ID, {}, authority('unrestricted'));

    expect(report.rowCount).toBe(2);
    const manual = report.rows.find((r) => r.serialNumber === 'MANUAL-SN');
    expect(manual).toEqual({
      hostname: 'Spare Laptop',
      displayName: 'Spare Laptop',
      osType: null,
      osVersion: null,
      agentVersion: null,
      status: 'unknown',
      lastSeenAt: null,
      enrolledAt: MANUAL_ROW.createdAt,
      cpuModel: null,
      ramTotalMb: null,
      diskTotalGb: null,
      serialNumber: 'MANUAL-SN',
    });
    // The agent row keeps exactly the shape it always had.
    expect(report.rows.find((r) => r.serialNumber === 'AGENT-SN')).toEqual(AGENT_ROW);
  });

  it('filters.includeManualAssets: false returns exactly the old agent-only shape', async () => {
    queueSelects([AGENT_ROW]);

    const report = await generateDeviceInventoryReport(
      ORG_ID,
      { filters: { includeManualAssets: false } },
      authority('unrestricted'),
    );

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(report.rows).toEqual([AGENT_ROW]);
    expect(report.rowCount).toBe(1);
  });

  it('applies the restricted site scope to the manual branch independently', async () => {
    queueSelects([AGENT_ROW], [MANUAL_ROW]);

    await generateDeviceInventoryReport(ORG_ID, {}, authority('restricted', [SITE_A]));

    expect(capturedWhere).toHaveLength(2);
    const [deviceParams, manualParams] = capturedWhere.map(paramsOf);
    expect(deviceParams).toContain(SITE_A);
    expect(deviceParams).not.toContain(SITE_B);
    // The leak this test exists for: a manual branch with no site predicate
    // would hand a site-restricted tech every manual asset in the org.
    expect(manualParams).toContain(SITE_A);
    expect(manualParams).not.toContain(SITE_B);
  });

  it('returns nothing at all for a restricted-empty authority, from either branch', async () => {
    queueSelects([AGENT_ROW], [MANUAL_ROW]);

    const report = await generateDeviceInventoryReport(ORG_ID, {}, authority('restricted', []));

    expect(db.select).not.toHaveBeenCalled();
    expect(report.rows).toEqual([]);
    expect(report.rowCount).toBe(0);
  });

  it('drops the manual branch when an OS-type filter is requested', async () => {
    queueSelects([AGENT_ROW]);

    const report = await generateDeviceInventoryReport(
      ORG_ID,
      { filters: { osTypes: ['windows'] } },
      authority('unrestricted'),
    );

    // A hand-entered asset has no OS to match, so including it would silently
    // widen an explicitly narrowed report.
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(report.rows).toEqual([AGENT_ROW]);
  });

  it('orders the merged rows by hostname across both branches', async () => {
    queueSelects(
      [{ ...AGENT_ROW, hostname: 'zeta' }],
      [{ ...MANUAL_ROW, name: 'alpha' }],
    );

    const report = await generateDeviceInventoryReport(ORG_ID, {}, authority('unrestricted'));

    expect(report.rows.map((r) => r.hostname)).toEqual(['alpha', 'zeta']);
  });
});
