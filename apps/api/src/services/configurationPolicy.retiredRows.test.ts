import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ rows: [] as unknown[][], deleted: [] as { table: unknown; predicate: any }[], inserted: [] as unknown[], upsert: vi.fn() }));
vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class extends Error {}, resolveOwnedAutomationReferences: vi.fn(),
}));
vi.mock('./automationRuntime', () => ({
  normalizeAutomationActions: (a: unknown) => a, resolveAutomationReferencesForOwner: vi.fn(),
}));
vi.mock('../db', () => {
  const tx: any = {};
  function result(rows: unknown[]) {
    const c: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
    for (const name of ['from', 'where', 'orderBy', 'limit', 'returning']) c[name] = () => c;
    return c;
  }
  tx.select = () => result(m.rows.shift() ?? []);
  tx.transaction = (fn: any) => fn(tx);
  tx.update = () => ({ set: () => result([{ id: 'link' }]) });
  tx.delete = (table: unknown) => ({ where: (predicate: unknown) => {
    m.deleted.push({ table, predicate }); return Promise.resolve([]);
  } });
  tx.insert = (table: unknown) => ({ values: (value: unknown) => {
    m.inserted.push({ table, value }); const c = result([{ id: 'settings' }]);
    c.onConflictDoUpdate = (options: unknown) => { m.upsert(options); return c; }; return c;
  } });
  return { db: tx, runOutsideDbContext: (fn: any) => fn(),
    withDbAccessContext: (_c: any, fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn() };
});
import { listFeatureLinks, updateFeatureLink } from './configurationPolicy';
import { configPolicyAlertRules, configPolicyMonitoringSettings } from '../db/schema';
beforeEach(() => { m.rows = []; m.deleted = []; m.inserted = []; m.upsert.mockReset(); });
it.each(['alert_rule', 'automation'])('returns authoritative empty %s instead of retired mirror JSON', async (featureType) => {
  const link = { id: 'link', configPolicyId: 'policy', featureType, featurePolicyId: null,
    inlineSettings: { items: [{ name: 'Retired source' }] } };
  m.rows = [[link], []];
  const [loaded] = await listFeatureLinks('policy');
  expect(loaded!.inlineSettings).toEqual({ items: [] });
});
it('saving an entirely retired rule feature cannot recreate its mirrored rules', async () => {
  const link = { id: 'link', configPolicyId: 'policy', featureType: 'alert_rule', featurePolicyId: null,
    inlineSettings: { items: [{ name: 'Retired source' }] } };
  m.rows = [[link], [], [link]];
  const [loaded] = await listFeatureLinks('policy');
  await updateFeatureLink('link', { inlineSettings: loaded!.inlineSettings }, 'policy');
  expect(m.inserted).toEqual([]);
  const deletion = m.deleted.find((d) => d.table === configPolicyAlertRules)!;
  expect(new PgDialect().sqlToQuery(deletion.predicate).sql).toContain('"retired_at" is null');
});
it('upserts watch settings without cascading deletion of retired watches', async () => {
  m.rows = [[{ id: 'link', configPolicyId: 'policy', featureType: 'monitoring' }]];
  await updateFeatureLink('link', { inlineSettings: { checkIntervalSeconds: 30, watches: [] } }, 'policy');
  expect(m.deleted.some((d) => d.table === configPolicyMonitoringSettings)).toBe(false);
  expect(m.upsert).toHaveBeenCalledWith(expect.objectContaining({ target: configPolicyMonitoringSettings.featureLinkId }));
});
