import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ rows: [] as unknown[][], deleted: [] as { table: unknown; predicate: any }[], inserted: [] as unknown[], upsert: vi.fn(), updates: [] as any[] }));
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
    for (const name of ['from', 'where', 'orderBy', 'limit', 'returning', 'for', 'innerJoin']) c[name] = () => c;
    return c;
  }
  tx.select = () => result(m.rows.shift() ?? []);
  tx.transaction = (fn: any) => fn(tx);
  tx.update = () => ({ set: (value: unknown) => { m.updates.push(value); return result([{ id: 'link' }]); } });
  tx.delete = (table: unknown) => ({ where: (predicate: unknown) => {
    m.deleted.push({ table, predicate }); return result([{ id: 'link', featureType: 'alert_rule' }]);
  } });
  tx.insert = (table: unknown) => ({ values: (value: unknown) => {
    m.inserted.push({ table, value }); const c = result([{ id: 'settings' }]);
    c.onConflictDoUpdate = (options: unknown) => { m.upsert(options); return c; }; return c;
  } });
  return { db: tx, runOutsideDbContext: (fn: any) => fn(),
    withDbAccessContext: (_c: any, fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn() };
});
import { listFeatureLinks, removeFeatureLink } from './configurationPolicy';
import { configPolicyAlertRules, configPolicyAutomations, configPolicyFeatureLinks, configPolicyMonitoringWatches, configPolicyMonitoringSettings } from '../db/schema';
beforeEach(() => { m.rows = []; m.deleted = []; m.inserted = []; m.updates = []; m.upsert.mockReset(); });
it.each(['automation'])('returns authoritative empty %s instead of retired mirror JSON', async (featureType) => {
  const link = { id: 'link', configPolicyId: 'policy', featureType, featurePolicyId: null,
    inlineSettings: { items: [{ name: 'Retired source' }] } };
  m.rows = [[link], [], [{ id: 'retired' }]];
  const [loaded] = await listFeatureLinks('policy');
  expect(loaded!.inlineSettings).toEqual({ items: [] });
});
it.each(['automation'])('preserves pre-backfill %s mirror when no normalized rows exist', async (featureType) => {
  const inlineSettings = { items: [{ name: 'Pre-backfill source' }] };
  m.rows = [[{ id: 'link', featureType, inlineSettings }], [], []];
  const [loaded] = await listFeatureLinks('policy');
  expect(loaded!.inlineSettings).toEqual(inlineSettings);
});
it.each(['automation'])('uses live normalized %s rows over the mirror', async (featureType) => {
  m.rows = [[{ id: 'link', featureType, inlineSettings: { items: [{ name: 'Mirror' }] } }], [{ name: 'Live source' }]];
  const [loaded] = await listFeatureLinks('policy');
  expect(loaded!.inlineSettings).toMatchObject({ items: [{ name: 'Live source' }] });
});

it.each(['alert_rule', 'automation', 'monitoring'])('removing %s preserves its retired source history', async (featureType) => {
  const link = { id: 'link', configPolicyId: 'policy', featureType, inlineSettings: { items: [{ name: 'Live' }] } };
  m.rows = [[link], [], ...(featureType === 'alert_rule' ? [] : featureType === 'automation' ? [[]] : [[], []]), [{ id: 'retired-source' }]];
  const result = await removeFeatureLink('link', 'policy');
  expect(result).toMatchObject({ id: 'link', kept: true, reason: 'retired_history' });
  expect(m.deleted.some((d) => d.table === configPolicyFeatureLinks || d.table === configPolicyMonitoringSettings)).toBe(false);
  expect(m.updates).toContainEqual(expect.objectContaining({ inlineSettings: featureType === 'monitoring' ? expect.objectContaining({ watches: [] }) : { items: [] } }));
  const table = featureType === 'alert_rule' ? configPolicyAlertRules : featureType === 'automation' ? configPolicyAutomations : configPolicyMonitoringWatches;
  const deletion = m.deleted.find((d) => d.table === table)!;
  if (featureType === 'automation') {
    expect(new PgDialect().sqlToQuery(deletion.predicate).sql).toContain('"retired_at" is null');
  } else {
    // Retired feature types no longer have a normalized mutation path.
    expect(deletion).toBeUndefined();
  }
});
it('removing a link without retired history still deletes the link', async () => {
  m.rows = [[{ id: 'link', featureType: 'alert_rule' }], [], [], [], []];
  expect(await removeFeatureLink('link', 'policy')).toMatchObject({ id: 'link' });
  expect(m.deleted.some((d) => d.table === configPolicyFeatureLinks)).toBe(true);
});
