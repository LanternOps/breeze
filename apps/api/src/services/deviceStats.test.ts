import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

const m = vi.hoisted(() => ({ where: vi.fn() }));
vi.mock('../db', () => {
  const chain: any = {};
  chain.from = () => chain;
  chain.where = (w: unknown) => {
    m.where(w);
    return chain;
  };
  chain.groupBy = async () => [
    { status: 'online', count: '2', migrationRequiredCount: '1' },
    { status: 'offline', count: '1', migrationRequiredCount: '0' },
  ];
  return { db: { select: () => chain } };
});

import { queryDeviceStats } from './deviceStats';
import { devices } from '../db/schema';

const render = (w: unknown) => new PgDialect().sqlToQuery(w as any);

describe('queryDeviceStats', () => {
  beforeEach(() => m.where.mockClear());

  it('always excludes decommissioned and ephemeral devices, even unscoped', async () => {
    await queryDeviceStats(undefined);
    const { sql } = render(m.where.mock.calls[0]![0]);
    expect(sql).toContain("!= 'decommissioned'");
    expect(sql).toContain('"is_ephemeral"');
  });

  it('adds the caller scope on top of the exclusions', async () => {
    await queryDeviceStats(eq(devices.siteId, 'site-x'));
    expect(render(m.where.mock.calls[0]![0]).params).toContain('site-x');
  });

  it('aggregates counts, offline complement and migration total', async () => {
    expect(await queryDeviceStats(undefined)).toEqual({
      total: 3,
      online: 2,
      offline: 1,
      byStatus: { online: 2, offline: 1 },
      migrationRequiredCount: 1,
    });
  });
});
