import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

const m = vi.hoisted(() => ({ where: vi.fn(), select: vi.fn() }));
vi.mock('../db', () => {
  const chain: any = {};
  chain.from = () => chain;
  chain.where = (w: unknown) => {
    m.where(w);
    return chain;
  };
  // Offline rows can never carry a log-shipping-failing count (the predicate
  // requires status = 'online'); the fixture mirrors what Postgres returns.
  chain.groupBy = async () => [
    { status: 'online', count: '2', migrationRequiredCount: '1', logShippingFailingCount: '1' },
    { status: 'offline', count: '1', migrationRequiredCount: '0', logShippingFailingCount: '0' },
  ];
  return {
    db: {
      select: (fields: unknown) => {
        m.select(fields);
        return chain;
      },
    },
  };
});

import { queryDeviceStats } from './deviceStats';
import { devices } from '../db/schema';

const render = (w: unknown) => new PgDialect().sqlToQuery(w as any);

describe('queryDeviceStats', () => {
  beforeEach(() => {
    m.where.mockClear();
    m.select.mockClear();
  });

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

  it('aggregates counts, offline complement, migration and log-shipping-failing totals', async () => {
    expect(await queryDeviceStats(undefined)).toEqual({
      total: 3,
      online: 2,
      offline: 1,
      byStatus: { online: 2, offline: 1 },
      migrationRequiredCount: 1,
      logShippingFailingCount: 1,
    });
  });

  // #8611: the count uses the SAME predicate as the logShippingFailing filter,
  // so it excludes offline devices and episodes younger than 30 minutes.
  it('counts log-shipping-failing devices with the shared sustained-failure predicate', async () => {
    await queryDeviceStats(undefined);
    const fields = m.select.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields.logShippingFailingCount).toBeDefined();
    const s = render(fields.logShippingFailingCount).sql.replace(/"/g, '');
    expect(s).toMatch(/^count\(\*\) filter \(where /);
    expect(s).toContain("devices.status = 'online'");
    expect(s).toContain("devices.log_shipping_state = 'failing'");
    expect(s).toContain('devices.log_shipping_failure_started_at IS NOT NULL');
    expect(s).toContain("NOW() - (1800000 * interval '1 millisecond')");
  });
});
