import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { registerConfigPolicyTools } from './aiToolsConfigPolicy';
const h = vi.hoisted(() => ({ rows: [] as unknown[][], predicates: [] as unknown[],
  mutate: vi.fn(() => { throw new Error('unexpected mutation'); }) }));
vi.mock('../db', () => {
  const executor: any = {
    select: vi.fn(() => {
      const rows = h.rows.shift() ?? [];
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn((predicate: unknown) => { h.predicates.push(predicate); return chain; });
      chain.limit = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.leftJoin = vi.fn(() => chain);
      chain.offset = vi.fn(() => chain);
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
import { listConfigPolicies, listFeatureLinks, updateFeatureLink, getRetiredFeatureLink } from './configurationPolicy';
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


const systemAuth = { scope: 'system', orgCondition: () => undefined } as never;
it('filters retired badges in the policy list SQL', async () => {
  h.rows.push([{ count: 1 }], [{ id: 'policy-1' }], []);
  const result = await listConfigPolicies(systemAuth, {}, { page: 1, limit: 20 });
  expect(result.data[0]?.featureLinks).toEqual([]);
  const query = new PgDialect().sqlToQuery(h.predicates[2] as never);
  expect(query.sql).toMatch(/feature_type.*not in/i);
  expect(query.params).toEqual(expect.arrayContaining(['policy-1', 'alert_rule', 'monitoring']));
});

it.each([
  ['list_configuration_policies', {}],
  ['configuration_policy_compliance', { action: 'summary' }],
])('filters retired links from %s SQL', async (name, input) => {
  h.rows.push([{ id: 'policy-1', name: 'Policy', status: 'active' }], []);
  const tools = new Map();
  registerConfigPolicyTools(tools);
  const response = JSON.parse(await tools.get(name).handler(input, systemAuth));
  expect(response.error).toBeUndefined();
  const query = new PgDialect().sqlToQuery(h.predicates[1] as never);
  expect(query.sql).toMatch(/feature_type.*not in/i);
  expect(query.params).toEqual(expect.arrayContaining(['policy-1', 'alert_rule', 'monitoring']));
});
