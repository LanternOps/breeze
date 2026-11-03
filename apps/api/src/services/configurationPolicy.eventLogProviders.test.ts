import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import { addFeatureLink, listFeatureLinks } from './configurationPolicy';
import { configPolicyEventLogSettings } from '../db/schema';

function chain(rows: unknown[]) {
  const result: any = { then: (resolve: (rows: unknown[]) => void) => resolve(rows) };
  for (const method of ['from', 'where', 'limit', 'onConflictDoNothing', 'returning']) {
    result[method] = vi.fn(() => result);
  }
  return result;
}

const policyId = '00000000-0000-4000-8000-000000000001';
const linkId = '00000000-0000-4000-8000-000000000002';

function executor() {
  let normalized: Record<string, unknown> = {};
  const link = { id: linkId, configPolicyId: policyId, featureType: 'event_log', inlineSettings: {} };
  const tx: any = {
    transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    insert: vi.fn((table: unknown) => ({ values: vi.fn((values: Record<string, unknown>) => {
      if (table === configPolicyEventLogSettings) normalized = values;
      return chain([link]);
    }) })),
    select: vi.fn(() => {
      const result = chain([]);
      result.from = vi.fn((table: unknown) => chain([table === configPolicyEventLogSettings ? normalized : link]));
      return result;
    }),
  };
  return { tx, normalized: () => normalized };
}

describe('event-log normalized Application providers', () => {
  it('round-trips the parsed provider list through the normalized row', async () => {
    const { tx, normalized } = executor();
    await addFeatureLink(policyId, 'event_log', null, {
      applicationProviders: [' Dell UPS Local Node Manager ', 'dell ups local node manager', 'MSSQL$SQLEXPRESS'],
    }, undefined, tx);
    expect(normalized().applicationProviders).toEqual(['Dell UPS Local Node Manager', 'MSSQL$SQLEXPRESS']);
    const links = await listFeatureLinks(policyId, tx);
    expect(links[0]?.inlineSettings).toMatchObject({ applicationProviders: normalized().applicationProviders });
  });

  it('assembles an empty provider list for a legacy normalized row', async () => {
    const { tx } = executor();
    const links = await listFeatureLinks(policyId, tx);
    expect(links[0]?.inlineSettings).toMatchObject({ applicationProviders: [] });
  });

  it('rejects unsafe names before inserting the normalized settings', async () => {
    const { tx, normalized } = executor();
    await expect(addFeatureLink(policyId, 'event_log', null, {
      applicationProviders: ["Foo' or '1'='1"],
    }, undefined, tx)).rejects.toThrow();
    expect(normalized()).toEqual({});
  });
});
