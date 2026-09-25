import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rows: [] as unknown[][], inserted: [] as any[], deleted: [] as unknown[] }));

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
  return { db: tx, runOutsideDbContext: (fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn(), withDbAccessContext: (_ctx: any, fn: any) => fn() };
});

import { listFeatureLinks, updateFeatureLink, validateFeaturePolicyExists } from './configurationPolicy';
import { configPolicyHardwareMonitoringSettings } from '../db/schema';

const id = '11111111-1111-4111-8111-111111111111';
const link = { id, configPolicyId: id, featureType: 'hardware_monitoring', featurePolicyId: null, inlineSettings: { enabled: true } };

beforeEach(() => {
  m.rows = [];
  m.inserted = [];
  m.deleted = [];
});

it('assembles normalized values rather than the mirror', async () => {
  m.rows = [[link], [{ enabled: false, pollIntervalMinutes: 20, diskHealthIntervalMinutes: 120 }]];
  expect((await listFeatureLinks(id))[0]!.inlineSettings).toEqual({ enabled: false, pollIntervalMinutes: 20, diskHealthIntervalMinutes: 120 });
});

it('replaces settings through the normalized table', async () => {
  m.rows = [[link]];
  await updateFeatureLink(id, { inlineSettings: { enabled: false, pollIntervalMinutes: 20, diskHealthIntervalMinutes: 120 } }, id);
  expect(m.deleted).toContain(configPolicyHardwareMonitoringSettings);
  expect(m.inserted).toContainEqual({
    table: configPolicyHardwareMonitoringSettings,
    value: { featureLinkId: id, enabled: false, pollIntervalMinutes: 20, diskHealthIntervalMinutes: 120 },
  });
});

it('rejects invalid settings before deletion', async () => {
  m.rows = [[link]];
  await expect(updateFeatureLink(id, { inlineSettings: { pollIntervalMinutes: 1 } }, id)).rejects.toThrow();
  expect(m.deleted).toEqual([]);
});

it.each([
  { orgId: id, partnerId: null },
  { orgId: null, partnerId: id },
])('is inline-only for %j', async owner => {
  m.rows = [[{ id }]];
  expect((await validateFeaturePolicyExists('hardware_monitoring', id, owner)).valid).toBe(false);
  expect(await validateFeaturePolicyExists('hardware_monitoring', null, owner)).toEqual({ valid: true });
});
