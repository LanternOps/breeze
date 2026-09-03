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
      for (const method of ['from', 'where', 'orderBy', 'limit']) {
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

import { actionItemsTile } from './actionItemsReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('actionItemsTile', () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.wheres.length = 0;
  });

  it('combines findings and suggestions and limits top issues to three', async () => {
    state.rows.push(
      [{ count: 2 }],
      [{ count: 3 }],
      [{ topIssues: ['one', 'two', 'three', 'four'] }],
    );

    const now = new Date('2026-09-02T12:00:00Z');
    await expect(actionItemsTile(ORG_ID, now)).resolves.toEqual({
      status: 'ok',
      count: 5,
      topIssues: ['one', 'two', 'three'],
      asOf: now.toISOString(),
    });

    for (const where of state.wheres) {
      expect(
        new PgDialect().sqlToQuery(where as SQL).params,
      ).toContain(ORG_ID);
    }
  });
});
