import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  selections: [] as Record<string, unknown>[],
  leftJoins: [] as unknown[][],
  wheres: [] as unknown[],
  orderBys: [] as unknown[][],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((selection: Record<string, unknown>) => {
      state.selections.push(selection);
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) {
        chain[method] = vi.fn((...args: unknown[]) => {
          if (method === 'leftJoin') state.leftJoins.push(args);
          if (method === 'where') state.wheres.push(args[0]);
          if (method === 'orderBy') state.orderBys.push(args);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import {
  devicesCsvForOrg,
  enrichedDevicesForOrg,
} from './deviceReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('deviceReadModel', () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.selections.length = 0;
    state.leftJoins.length = 0;
    state.wheres.length = 0;
    state.orderBys.length = 0;
  });

  it('returns the enriched customer projection with explicit org scoping', async () => {
    state.rows.push(
      [{ count: 1 }],
      [{
        id: 'd-1',
        hostname: 'Laptop',
        displayName: 'Alice laptop',
        osType: 'windows',
        osVersion: '11',
        status: 'online',
        lastSeenAt: new Date('2026-09-02T11:00:00Z'),
        lastPatchAt: new Date('2026-09-01T00:00:00Z'),
        realTimeProtection: true,
        provider: 'windows_defender',
        avProducts: [{ displayName: 'Defender', provider: 'windows_defender' }],
        securityUpdatedAt: new Date('2026-09-02T10:00:00Z'),
        hasS1Agent: false,
        hasHuntressAgent: false,
        encryption: 'encrypted',
        lastBackupAt: new Date('2026-09-02T08:00:00Z'),
        warrantyEndsAt: '2027-01-01',
      }],
    );

    await expect(
      enrichedDevicesForOrg(ORG_ID, {
        page: 1,
        limit: 50,
        timezone: 'America/Denver',
      }),
    ).resolves.toEqual({
      data: [{
        id: 'd-1',
        hostname: 'Laptop',
        displayName: 'Alice laptop',
        osType: 'windows',
        osVersion: '11',
        status: 'online',
        lastSeenAt: 'Sep 2, 2026, 5:00 AM MDT',
        lastPatchAt: 'Aug 31, 2026, 6:00 PM MDT',
        protection: 'protected',
        encryption: 'encrypted',
        lastBackupAt: 'Sep 2, 2026, 2:00 AM MDT',
        warrantyEndsAt: '2027-01-01',
      }],
      pagination: { page: 1, limit: 50, total: 1 },
    });

    const dialect = new PgDialect();
    const queries = state.wheres.map((where) =>
      dialect.sqlToQuery(where as SQL),
    );
    for (const query of queries) expect(query.params).toContain(ORG_ID);
    expect(queries.some(({ sql }) => sql.includes('"devices"."org_id" ='))).toBe(true);

    const projection = state.selections[1]!;
    const scopedProjectionSql = [
      ['lastPatchAt', '"device_patches"."org_id" ='],
      ['hasS1Agent', '"s1_agents"."org_id" ='],
      ['hasHuntressAgent', '"huntress_agents"."org_id" ='],
      ['lastBackupAt', '"backup_jobs"."org_id" ='],
    ] as const;
    for (const [key, predicate] of scopedProjectionSql) {
      const query = dialect.sqlToQuery(projection[key] as SQL);
      expect(query.sql).toContain(predicate);
      expect(query.params).toContain(ORG_ID);
    }

    const scopedJoinSql = [
      '"security_status"."org_id" =',
      '"device_warranty"."org_id" =',
    ];
    expect(state.leftJoins).toHaveLength(2);
    state.leftJoins.forEach((join, index) => {
      const query = dialect.sqlToQuery(join[1] as SQL);
      expect(query.sql).toContain(scopedJoinSql[index]);
      expect(query.params).toContain(ORG_ID);
    });

    const orderBy = state.orderBys[0]!.map((expression) =>
      dialect.sqlToQuery(expression as SQL).sql,
    );
    expect(orderBy[0]).toContain('"devices"."last_seen_at" desc');
    expect(orderBy[1]).toContain('"devices"."id" desc');
  });

  it('streams the UI projection and neutralizes spreadsheet formulas', async () => {
    state.rows.push(
      [{ count: 1 }],
      [{
        id: 'd-1',
        hostname: '=cmd',
        displayName: null,
        osType: 'windows',
        osVersion: '11',
        status: 'online',
        lastSeenAt: null,
        lastPatchAt: null,
        realTimeProtection: null,
        provider: null,
        avProducts: [{ displayName: 'Defender' }],
        securityUpdatedAt: null,
        hasS1Agent: false,
        hasHuntressAgent: false,
        encryption: null,
        lastBackupAt: null,
        warrantyEndsAt: null,
      }],
    );

    let csv = '';
    for await (const chunk of devicesCsvForOrg(ORG_ID, {
      timezone: 'UTC',
    })) csv += chunk;

    expect(csv).toContain(
      '"Device","Type","Status","Last online","Last patch","Protection","Encryption","Last backup","Warranty ends"',
    );
    expect(csv).toContain("'=cmd");
  });
});
