import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const h = vi.hoisted(() => ({ rows: [] as unknown[][], predicates: [] as unknown[],
  mutate: vi.fn(() => { throw new Error('unexpected mutation'); }) }));
vi.mock('../db', () => {
  const executor: any = {
    select: vi.fn(() => {
      const rows = h.rows.shift() ?? [];
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn((predicate: unknown) => { h.predicates.push(predicate); return chain; });
      chain.limit = vi.fn(async () => rows);
      chain.orderBy = vi.fn(async () => rows);
      chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
      return chain;
    }),
    update: h.mutate, delete: h.mutate, insert: h.mutate,
  };
  executor.transaction = async (fn: (tx: unknown) => unknown) => fn(executor);
  return { db: executor, runOutsideDbContext: (fn: () => unknown) => fn(),
    withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn() };
});
import { listFeatureLinks, updateFeatureLink, getRetiredFeatureLink } from './configurationPolicy';
beforeEach(() => { h.rows.length = 0; h.predicates.length = 0; h.mutate.mockClear(); });
it('filters retired feature types in the list SQL', async () => {
  h.rows.push([]);
  expect(await listFeatureLinks('10000000-0000-4000-8000-000000000001')).toEqual([]);
  const query = new PgDialect().sqlToQuery(h.predicates[0] as never);
  expect(query.sql).toMatch(/feature_type.*not in/i);
  expect(query.params).toEqual(expect.arrayContaining(['alert_rule', 'monitoring']));
});
it('filters retired types in the effective-link query too', () => {
  const source = readFileSync(new URL('./configurationPolicy.ts', import.meta.url), 'utf8');
  expect(source).toMatch(/notInArray\(configPolicyEffectiveFeatureLinks\.featureType,\s*\[\.\.\.RETIRED_CONFIG_FEATURE_TYPES\]\)/);
});

it.each(['alert_rule', 'monitoring'])('updateFeatureLink refuses retired %s before normalized writes', async featureType => {
  h.rows.push([{ id: 'legacy-link', featureType, configPolicyId: 'policy-1' }]);
  await expect(updateFeatureLink('legacy-link', { inlineSettings: { items: [] } }, 'policy-1'))
    .rejects.toThrow(`Feature link legacy-link is retired (${featureType}); it cannot be edited`);
  expect(h.mutate).not.toHaveBeenCalled();
});
it('the public assembler no longer queries legacy tables', () => {
  const source = readFileSync(new URL('./configurationPolicy.ts', import.meta.url), 'utf8');
  const assembler = source.slice(source.indexOf('async function assembleInlineSettings'), source.indexOf('export async function addFeatureLink'));
  expect(assembler).not.toContain("case 'alert_rule'");
  expect(assembler).not.toContain("case 'monitoring'");
});

it('retired-link lookup binds both policy and link IDs and only returns retired types', async () => {
  h.rows.push([]);
  expect(await getRetiredFeatureLink('policy-1', 'legacy-link')).toBeNull();
  const query = new PgDialect().sqlToQuery(h.predicates[0] as never);
  expect(query.params).toEqual(expect.arrayContaining(['policy-1', 'legacy-link', 'alert_rule', 'monitoring']));
  expect(query.sql).toMatch(/config_policy_id/);
  expect(h.mutate).not.toHaveBeenCalled();
});
