import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));

import { db } from '../db';
import { loadEdrDeviceCoverage, EDR_PRODUCT_LABEL } from './securityComplianceReportEdr';

const whereCalls: unknown[][] = [];
function queue(rows: unknown[]) {
  whereCalls.length = 0;
  vi.mocked(db.select).mockImplementation((() => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'groupBy']) chain[m] = () => chain;
    chain.where = (...args: unknown[]) => {
      whereCalls.push(args);
      return chain;
    };
    (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve);
    return chain;
  }) as never);
}

beforeEach(() => vi.clearAllMocks());

describe('loadEdrDeviceCoverage', () => {
  it('returns the set of linked device ids, ignoring unlinked rows', async () => {
    queue([{ deviceId: 'dev-1' }, { deviceId: null }, { deviceId: 'dev-3' }]);
    const set = await loadEdrDeviceCoverage('org-1', ['dev-1', 'dev-2', 'dev-3']);
    expect([...set].sort()).toEqual(['dev-1', 'dev-3']);
  });

  it('does not query for an empty device population', async () => {
    queue([]);
    const set = await loadEdrDeviceCoverage('org-1', []);
    expect(set.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('counts only healthy, org-scoped endpoints linked to the report devices', async () => {
    queue([]);
    await loadEdrDeviceCoverage('org-1', ['dev-1']);
    const rendered = new PgDialect().sqlToQuery(whereCalls[0]![0] as never);
    expect(rendered.sql).toMatch(/"edr_endpoints"\."org_id" = /i);
    expect(rendered.sql).toMatch(/"edr_endpoints"\."health" = /i);
    expect(rendered.sql).toMatch(/"edr_endpoints"\."breeze_device_id" in/i);
    expect(rendered.params).toEqual(expect.arrayContaining(['org-1', 'healthy', 'dev-1']));
  });

  // #12825: a provider whose list does not refresh health / online keeps the last value it read;
  // a healthy + online read older than the freshness bound is no evidence of protection now.
  it('counts a detail-owned provider\'s endpoint only when its details were read within the freshness bound', async () => {
    queue([]);
    const asOf = new Date('2026-11-27T12:00:00.000Z');
    await loadEdrDeviceCoverage('org-1', ['dev-1'], asOf);
    const rendered = new PgDialect().sqlToQuery(whereCalls[0]![0] as never);
    expect(rendered.sql).toMatch(/"edr_endpoints"\."online" = /i);
    expect(rendered.sql).toMatch(/\("edr_endpoints"\."provider" not in \(\$\d+, \$\d+\) or "edr_endpoints"\."vendor_detail_synced_at" >= \$\d+::timestamptz\)/i);
    expect(rendered.params).toEqual(expect.arrayContaining(['bitdefender', 'emsisoft', '2026-11-26T12:00:00.000Z']));
  });

  it('labels the product generically, never by vendor', () => {
    expect(EDR_PRODUCT_LABEL).toBe('Managed endpoint protection');
  });
});
