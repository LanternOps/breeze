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
      for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
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

import { backupTile } from './backupReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('backupTile', () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.wheres.length = 0;
  });

  it('returns latest passed verification and configured-device counts', async () => {
    state.rows.push(
      [{ total: 10 }],
      [{ id: 'active-config' }],
      [{ configured: 7 }],
      [{
        completedAt: new Date('2026-09-02T09:00:00Z'),
        verificationType: 'test_restore',
      }],
    );

    const now = new Date('2026-09-02T12:00:00Z');
    await expect(backupTile(ORG_ID, now)).resolves.toEqual({
      status: 'ok',
      completedAt: '2026-09-02T09:00:00.000Z',
      verificationType: 'test_restore',
      configured: 7,
      total: 10,
      asOf: now.toISOString(),
    });

    for (const where of state.wheres) {
      const query = new PgDialect().sqlToQuery(where as SQL);
      expect(query.params).toContain(ORG_ID);
    }
  });

  it('returns no_data when an active config exists but no job or verification has run', async () => {
    state.rows.push([{ total: 10 }], [{ id: 'active-config' }], [{ configured: 0 }], []);
    const now = new Date('2026-09-02T12:00:00Z');
    await expect(backupTile(ORG_ID, now)).resolves.toMatchObject({
      status: 'no_data',
      completedAt: null,
      configured: 0,
      total: 10,
      asOf: now.toISOString(),
    });
  });

  it('returns not_configured only when the organization has no active config', async () => {
    state.rows.push([{ total: 10 }], [], [{ configured: 0 }], []);
    await expect(
      backupTile(ORG_ID, new Date('2026-09-02T12:00:00Z')),
    ).resolves.toMatchObject({
      status: 'not_configured',
      completedAt: null,
      configured: 0,
      total: 10,
    });

    const compiled = state.wheres.map((where) =>
      new PgDialect().sqlToQuery(where as SQL),
    );
    expect(compiled.some(({ sql, params }) =>
      sql.includes('"backup_configs"."org_id" =') &&
      params.includes(ORG_ID)),
    ).toBe(true);
  });
});
