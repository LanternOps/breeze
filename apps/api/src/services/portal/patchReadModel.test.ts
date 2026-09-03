import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'where', 'groupBy']) {
        chain[method] = vi.fn((arg: unknown) => {
          if (method === 'where') state.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import { patchesAppliedTile } from './patchReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('patchesAppliedTile', () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.wheres.length = 0;
  });

  it('returns month-to-date installs and critical outstanding devices', async () => {
    state.rows.push([{ applied: 41 }], [{ devicesWithOutstandingCritical: 3 }]);

    await expect(
      patchesAppliedTile(ORG_ID, {
        timezone: 'America/Denver',
        now: new Date('2026-09-02T12:00:00Z'),
      }),
    ).resolves.toEqual({
      status: 'ok',
      applied: 41,
      devicesWithOutstandingCritical: 3,
      month: '2026-09',
      timezone: 'America/Denver',
      asOf: '2026-09-02T12:00:00.000Z',
    });

    const compiled = state.wheres.map((where) =>
      new PgDialect().sqlToQuery(where as SQL),
    );
    expect(compiled).toHaveLength(2);
    expect(compiled[0]!.sql).toContain('date_trunc');
    for (const query of compiled) {
      expect(query.sql).toContain('"device_patches"."org_id" =');
      expect(query.params).toContain(ORG_ID);
    }
  });
});
