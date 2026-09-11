import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  where: undefined as SQL | undefined,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn((where: SQL) => {
            state.where = where;
            return {
              limit: vi.fn(async () => state.rows),
            };
          }),
        })),
      })),
    })),
  },
}));

import {
  resolveOrgTimezone,
  resolveTimezoneFromRows,
} from './timezone';

describe('portal timezone resolution', () => {
  beforeEach(() => {
    state.rows = [];
    state.where = undefined;
  });

  it.each([
    [{ timezone: 'America/Denver' }, 'Europe/Berlin', { timezone: 'Asia/Tokyo' }, 'America/Denver'],
    [{}, 'Europe/Berlin', { timezone: 'Asia/Tokyo' }, 'Europe/Berlin'],
    [{}, 'UTC', { timezone: 'Asia/Tokyo' }, 'Asia/Tokyo'],
    [{}, 'utc', {}, 'UTC'],
    [{ timezone: 'not/a-zone' }, 'not/a-zone', { timezone: 'Asia/Tokyo' }, 'Asia/Tokyo'],
    [null, null, null, 'UTC'],
  ])(
    'uses the worker precedence with canonicalization and validation',
    (orgSettings, partnerTimezone, partnerSettings, expected) => {
      expect(resolveTimezoneFromRows(
        orgSettings,
        partnerTimezone,
        partnerSettings,
      )).toBe(expected);
    },
  );

  it('queries the requested organization with a left join', async () => {
    state.rows = [{
      orgSettings: {},
      partnerTimezone: 'UTC',
      partnerSettings: {},
    }];

    await expect(resolveOrgTimezone(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    )).resolves.toBe('UTC');

    const query = new PgDialect().sqlToQuery(state.where as SQL);
    expect(query.sql).toContain(
      '"organizations"."id" = $1',
    );
    expect(query.params).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]);
  });
});
