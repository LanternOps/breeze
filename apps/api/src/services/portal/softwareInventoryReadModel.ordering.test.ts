import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ queries: [] as string[] }));
vi.mock('../../db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy');
  return {
    db: drizzle(async (query) => {
      mocks.queries.push(query);
      return { rows: [] };
    }),
  };
});

import { softwareInventorySummary } from './softwareInventoryReadModel';

beforeEach(() => { mocks.queries = []; });

describe('software summary composite pagination key (#7734)', () => {
  it('compiles ORDER BY over the complete GROUP BY tuple before LIMIT/OFFSET', async () => {
    await softwareInventorySummary('11111111-1111-4111-8111-111111111111', {
      page: 2, limit: 1, now: new Date('2026-10-10T04:00:00Z'),
    });
    const grouped = mocks.queries.filter((query) => query.includes('group by'));
    expect(grouped).toHaveLength(1);
    const query = grouped[0]!;
    const tuple = '"software_inventory"."name", "software_inventory"."version", "software_inventory"."vendor"';
    const order = '"software_inventory"."name" asc, "software_inventory"."version" asc, "software_inventory"."vendor" asc';
    expect(query).toContain(`group by ${tuple} order by ${order}`);
    expect(query).toMatch(/order by .+ limit \$\d+ offset \$\d+$/);
  });
});
