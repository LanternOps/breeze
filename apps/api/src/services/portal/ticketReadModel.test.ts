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
      for (const method of ['from', 'where']) {
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

import { supportTile } from './ticketReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('supportTile', () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.wheres.length = 0;
  });

  it('returns org-wide open count and response sample', async () => {
    state.rows.push(
      [{ openTickets: 4 }],
      [{ averageFirstResponseMinutes: 35, sampleSize: 2 }],
    );

    await expect(
      supportTile(ORG_ID, {
        timezone: 'UTC',
        now: new Date('2026-09-02T12:00:00Z'),
      }),
    ).resolves.toEqual({
      status: 'ok',
      openTickets: 4,
      averageFirstResponseMinutes: 35,
      sampleSize: 2,
      month: '2026-09',
      timezone: 'UTC',
      asOf: '2026-09-02T12:00:00.000Z',
    });

    const [openQuery, responseQuery] = state.wheres.map((where) =>
      new PgDialect().sqlToQuery(where as SQL),
    );
    expect(openQuery!.sql).toContain('"tickets"."org_id" =');
    expect(openQuery!.sql).toContain('"tickets"."deleted_at" is null');
    expect(openQuery!.sql).not.toContain('date_trunc');
    expect(responseQuery!.sql).toContain('"tickets"."org_id" =');
    expect(responseQuery!.sql).toContain('"tickets"."deleted_at" is null');
    expect(responseQuery!.sql).toContain('date_trunc');
    expect(openQuery!.params).toContain(ORG_ID);
    expect(responseQuery!.params).toContain(ORG_ID);
  });
});
