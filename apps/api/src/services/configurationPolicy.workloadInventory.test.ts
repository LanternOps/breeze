import { beforeEach, expect, it, vi } from 'vitest';
import { WORKLOAD_INVENTORY_DEFAULTS } from '@breeze/shared';

const m = vi.hoisted(() => ({
  rows: [] as unknown[][],
  inserted: [] as any[],
  deleted: [] as unknown[],
}));
vi.mock('../db', () => {
  const tx: any = {};
  function result(rows: unknown[]) {
    const c: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
    for (const key of ['from', 'where', 'limit', 'orderBy', 'returning', 'for', 'innerJoin']) c[key] = () => c;
    return c;
  }
  tx.select = () => result(m.rows.shift() ?? []);
  tx.transaction = (fn: any) => fn(tx);
  tx.update = () => ({ set: () => result([{ id: '11111111-1111-4111-8111-111111111111' }]) });
  tx.delete = (table: unknown) => ({
    where: () => {
      m.deleted.push(table);
      return result([]);
    },
  });
  tx.insert = (table: unknown) => ({
    values: (value: unknown) => {
      m.inserted.push({ table, value });
      return result([]);
    },
  });
  return {
    db: tx,
    runOutsideDbContext: (f: any) => f(),
    withSystemDbAccessContext: (f: any) => f(),
    withDbAccessContext: (_c: any, f: any) => f(),
  };
});

import { listFeatureLinks, updateFeatureLink, validateFeaturePolicyExists } from './configurationPolicy';
import { configPolicyWorkloadInventorySettings } from '../db/schema';

const id = '11111111-1111-4111-8111-111111111111';
const settings = {
  enabled: true,
  dockerEnabled: true,
  podmanEnabled: false,
  hypervEnabled: true,
  proxmoxEnabled: false,
  intervalMinutes: 120,
};
const link = {
  id,
  configPolicyId: id,
  featureType: 'workload_inventory',
  featurePolicyId: null,
  inlineSettings: WORKLOAD_INVENTORY_DEFAULTS,
};
beforeEach(() => {
  m.rows = [];
  m.inserted = [];
  m.deleted = [];
});

it('reads typed columns instead of the stale inline mirror', async () => {
  m.rows = [[link], [settings]];
  expect((await listFeatureLinks(id))[0]!.inlineSettings).toEqual(settings);
});

it('replaces the settings row on update', async () => {
  m.rows = [[link]];
  await updateFeatureLink(id, { inlineSettings: settings }, id);
  expect(m.deleted).toContain(configPolicyWorkloadInventorySettings);
  expect(m.inserted).toContainEqual({
    table: configPolicyWorkloadInventorySettings,
    value: { featureLinkId: id, ...settings },
  });
});

it('rejects an invalid interval before deleting the existing settings', async () => {
  m.rows = [[link]];
  await expect(updateFeatureLink(id, { inlineSettings: { intervalMinutes: 5 } }, id)).rejects.toThrow();
  expect(m.deleted).toEqual([]);
});

it.each([
  { orgId: id, partnerId: null },
  { orgId: null, partnerId: id },
])('is inline-only for %j', async (owner) => {
  // A same-org configuration policy row exists, so only the inline-only branch can refuse the id.
  m.rows = [[{ id }]];
  expect(await validateFeaturePolicyExists('workload_inventory', null, owner)).toEqual({ valid: true });
  expect((await validateFeaturePolicyExists('workload_inventory', id, owner)).valid).toBe(false);
});
