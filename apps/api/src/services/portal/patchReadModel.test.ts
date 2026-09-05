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
      for (const method of ['from', 'innerJoin', 'where', 'groupBy', 'limit']) {
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
    state.rows.push(
      [{ id: 'patch-source-row' }],
      [{ applied: 41 }],
      [{ devicesWithOutstandingCritical: 3 }],
    );

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
    expect(compiled).toHaveLength(3);
    expect(compiled[1]!.sql).toContain('date_trunc');
    for (const query of compiled) {
      expect(query.sql).toContain('"device_patches"."org_id" =');
      expect(query.params).toContain(ORG_ID);
    }
  });

  it('binds the window anchor as an ISO string, never a Date (#4562 W04 regression)', async () => {
    state.rows.push([{ id: 'patch-source-row' }], [{ applied: 0 }], [{ devicesWithOutstandingCritical: 0 }]);

    await patchesAppliedTile(ORG_ID, {
      timezone: 'America/Denver',
      now: new Date('2026-09-02T12:00:00Z'),
    });

    // Drizzle's postgres-js driver replaces the timestamp serializers with
    // pass-throughs and relies on column mappers to stringify Dates. A Date
    // bound inside a raw `sql` fragment skips the mappers and postgres.js
    // throws `Buffer.byteLength ... Received an instance of Date` at bind
    // time — against a real database only, which is how the portal e2e
    // caught every dashboard request 500ing.
    const compiled = state.wheres.map((where) =>
      new PgDialect().sqlToQuery(where as SQL),
    );
    for (const query of compiled) {
      expect(query.params.some((param) => param instanceof Date)).toBe(false);
    }
    expect(compiled[1]!.params).toContain('2026-09-02T12:00:00.000Z');
  });

  it('returns no_data with null values when the org has no patch source rows', async () => {
    state.rows.push(
      [],
      [{ applied: 0 }],
      [{ devicesWithOutstandingCritical: 0 }],
    );

    await expect(
      patchesAppliedTile(ORG_ID, {
        timezone: 'America/Denver',
        now: new Date('2026-09-02T12:00:00Z'),
      }),
    ).resolves.toMatchObject({
      status: 'no_data',
      applied: null,
      devicesWithOutstandingCritical: null,
      month: '2026-09',
      timezone: 'America/Denver',
    });
  });
});
