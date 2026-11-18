import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import { addFeatureLink, listFeatureLinks } from './configurationPolicy';
import { configPolicyMaintenanceSettings } from '../db/schema';

// #9574: the configured weekday / day of month must survive the trip through
// the normalized config_policy_maintenance_settings row and back out as the
// link's inlineSettings — the shape the web form and AI tools read.

function chain(rows: unknown[]) {
  const result: any = { then: (resolve: (rows: unknown[]) => void) => resolve(rows) };
  for (const method of ['from', 'where', 'limit', 'onConflictDoNothing', 'returning']) {
    result[method] = vi.fn(() => result);
  }
  return result;
}

const policyId = '00000000-0000-4000-8000-000000000001';
const linkId = '00000000-0000-4000-8000-000000000002';

function executor(storedRow?: Record<string, unknown>) {
  let normalized: Record<string, unknown> = storedRow ?? {};
  const link = { id: linkId, configPolicyId: policyId, featureType: 'maintenance', inlineSettings: {} };
  const tx: any = {
    transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    insert: vi.fn((table: unknown) => ({ values: vi.fn((values: Record<string, unknown>) => {
      if (table === configPolicyMaintenanceSettings) normalized = values;
      return chain([link]);
    }) })),
    select: vi.fn(() => {
      const result = chain([]);
      result.from = vi.fn((table: unknown) => chain([table === configPolicyMaintenanceSettings ? normalized : link]));
      return result;
    }),
  };
  return { tx, normalized: () => normalized };
}

describe('maintenance day of week / day of month (#9574)', () => {
  it('writes the chosen days to the normalized row and reads them back', async () => {
    const { tx, normalized } = executor();
    await addFeatureLink(policyId, 'maintenance', null, {
      recurrence: 'weekly',
      windowStart: '02:00',
      dayOfWeek: 'wed',
      dayOfMonth: 31,
    }, undefined, tx);
    expect(normalized()).toMatchObject({ dayOfWeek: 'wed', dayOfMonth: 31 });
    const links = await listFeatureLinks(policyId, tx);
    expect(links[0]?.inlineSettings).toMatchObject({ dayOfWeek: 'wed', dayOfMonth: 31 });
  });

  it('defaults an omitted day to Sunday / the 1st (the pre-#9574 behaviour)', async () => {
    const { tx, normalized } = executor();
    await addFeatureLink(policyId, 'maintenance', null, { recurrence: 'weekly' }, undefined, tx);
    expect(normalized()).toMatchObject({ dayOfWeek: 'sun', dayOfMonth: 1 });
  });

  it('refuses an unknown weekday before inserting the normalized row', async () => {
    const { tx, normalized } = executor();
    await expect(
      addFeatureLink(policyId, 'maintenance', null, { recurrence: 'weekly', dayOfWeek: 'funday' }, undefined, tx),
    ).rejects.toThrow();
    expect(normalized()).toEqual({});
  });
});
