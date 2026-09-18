/**
 * #6096 residual 3 — `SecurityPostureFilter` had no device-id axis, so
 * `get_security_posture` had to fetch a `limit`-bounded page for the WHOLE org
 * and drop the out-of-scope rows afterwards. No leak, but the limit applied
 * before the narrowing, so a device-bound run could get an empty/short page
 * while its own device sat past the cut. The filter now narrows in SQL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const captured: { wheres: unknown[]; limit?: number } = { wheres: [] };

vi.mock('../db', () => {
  const rankedBuilder = {
    from: () => rankedBuilder,
    where: (w: unknown) => {
      captured.wheres.push(w);
      return rankedBuilder;
    },
    as: (name: string) => ({ _: { alias: name }, ...rankedBuilder }),
    innerJoin: () => rankedBuilder,
    orderBy: () => rankedBuilder,
    limit: (n: number) => {
      captured.limit = n;
      return Promise.resolve([]);
    },
  };
  return {
    db: { select: vi.fn(() => rankedBuilder) },
    runOutsideDbContext: vi.fn((fn: any) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
  };
});

import { db } from '../db';
import { listLatestSecurityPosture } from './securityPosture';

const dialect = new PgDialect();

beforeEach(() => {
  vi.clearAllMocks();
  captured.wheres = [];
  captured.limit = undefined;
});

describe('listLatestSecurityPosture — deviceIds filter', () => {
  it('binds the allowed device ids into the snapshot query', async () => {
    await listLatestSecurityPosture({ orgIds: ['org-1'], deviceIds: ['dev-1'], limit: 50 });
    const { sql, params } = dialect.sqlToQuery(captured.wheres[0] as never);
    expect(sql).toContain('"security_posture_snapshots"."device_id" in ($2)');
    expect(params).toEqual(['org-1', 'dev-1']);
    // ...and the page limit is applied to the ALREADY-narrowed set.
    expect(captured.limit).toBe(50);
  });

  it('adds no device predicate for an unrestricted caller', async () => {
    await listLatestSecurityPosture({ orgIds: ['org-1'], limit: 50 });
    const { sql } = dialect.sqlToQuery(captured.wheres[0] as never);
    expect(sql).not.toContain('device_id');
  });

  it('returns nothing, without querying, for an empty allowlist', async () => {
    const rows = await listLatestSecurityPosture({ orgIds: ['org-1'], deviceIds: [] });
    expect(rows).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});
