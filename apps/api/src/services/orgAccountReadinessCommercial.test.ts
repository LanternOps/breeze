import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../db', () => ({
  db: { select: vi.fn(), selectDistinct: vi.fn() },
}));

import { db } from '../db';
import { backupConfigs, contracts } from '../db/schema';
import { loadActiveContractCounts, loadBackupReadiness } from './orgAccountReadinessCommercial';

const PARTNER = '00000000-0000-0000-0000-00000000aaaa';
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const joins = new Map<unknown, unknown>();
const wheres = new Map<unknown, unknown>();

function chain(table: unknown, rows: unknown[]) {
  const result = Promise.resolve(rows) as Promise<unknown[]>;
  const self = result as unknown as Record<string, unknown>;
  self.innerJoin = (_other: unknown, condition: unknown) => { joins.set(table, condition); return result; };
  self.where = (condition: unknown) => { wheres.set(table, condition); return result; };
  self.groupBy = () => result;
  self.limit = () => result;
  return result;
}

/** `sequence` lets one table answer two different queries in call order —
 * loadBackupReadiness reads backup_configs twice (partner-wide EXISTS, then per-org). */
function setupDb(rowsByTable: Map<unknown, unknown[] | { sequence: unknown[][] }>) {
  const impl = () => ({
    from: (table: unknown) => {
      const spec = rowsByTable.get(table);
      if (spec && !Array.isArray(spec)) return chain(table, spec.sequence.shift() ?? []);
      return chain(table, spec ?? []);
    },
  }) as never;
  vi.mocked(db.select).mockImplementation(impl);
  vi.mocked(db.selectDistinct).mockImplementation(impl);
}

function compiled(captured: Map<unknown, unknown>, table: unknown) {
  const condition = captured.get(table);
  if (!condition) throw new Error('nothing captured for that table');
  return new PgDialect().sqlToQuery(condition as SQL);
}

beforeEach(() => {
  vi.clearAllMocks();
  joins.clear();
  wheres.clear();
});

describe('loadActiveContractCounts', () => {
  it('counts active contracts that have no end date or end today or later, per org', async () => {
    setupDb(new Map<unknown, unknown[]>([[contracts, [{ orgId: ORG_A, active: '2' }]]]));
    const out = await loadActiveContractCounts([ORG_A, ORG_B]);
    expect(out.get(ORG_A)).toBe(2);
    expect(out.has(ORG_B)).toBe(false);
    const where = compiled(wheres, contracts);
    expect(where.sql).toContain('"contracts"."org_id" in (');
    expect(where.sql).toContain('"contracts"."status" = ');
    expect(where.sql).toContain('"contracts"."end_date" is null');
    expect(where.sql).toContain('"contracts"."end_date" >= CURRENT_DATE');
    expect(where.params).toEqual([ORG_A, ORG_B, 'active']);
  });

  it('reads nothing for an empty id list', async () => {
    setupDb(new Map());
    expect(await loadActiveContractCounts([])).toEqual(new Map());
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('loadBackupReadiness', () => {
  it('is applicable when ANY non-deleted org of the partner has an active config, and reports which accepted orgs have one', async () => {
    setupDb(new Map<unknown, unknown[] | { sequence: unknown[][] }>([
      [backupConfigs, { sequence: [[{ id: 'cfg-1' }], [{ orgId: ORG_A }]] }],
    ]));
    const out = await loadBackupReadiness(PARTNER, [ORG_A, ORG_B]);
    expect(out.applicable).toBe(true);
    expect(out.configuredOrgIds).toEqual(new Set([ORG_A]));
    const join = compiled(joins, backupConfigs);
    expect(join.sql).toContain('"organizations"."id" = "backup_configs"."org_id"');
    const where = compiled(wheres, backupConfigs);
    // The last captured WHERE is the per-org query.
    expect(where.sql).toContain('"backup_configs"."org_id" in (');
    expect(where.sql).toContain('"backup_configs"."is_active" = ');
    expect(where.params).toEqual([ORG_A, ORG_B, true]);
  });

  it('is not applicable for a partner with no active config anywhere, and skips the per-org read', async () => {
    setupDb(new Map<unknown, unknown[] | { sequence: unknown[][] }>([[backupConfigs, { sequence: [[]] }]]));
    const out = await loadBackupReadiness(PARTNER, [ORG_A]);
    expect(out).toEqual({ applicable: false, configuredOrgIds: new Set() });
    expect(db.selectDistinct).not.toHaveBeenCalled();
  });
});
