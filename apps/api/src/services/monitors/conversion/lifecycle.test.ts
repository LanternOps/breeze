import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isRevertAvailable, findLiveTargetDependencies } from './lifecycle';
vi.mock('../../../db', () => ({ db: {} }));
it.each([
  'config_policy_alert_rules', 'config_policy_monitoring_watches', 'alert_templates',
  'automations', 'config_policy_automations',
] as const)('disallows restoring the retired %s runtime', source => {
  expect(isRevertAvailable(source)).toBe(false);
});
it('leaves the network runtime lifecycle to W05e', () => {
  expect(isRevertAvailable('network_monitors')).toBe(true);
});
it('avoids querying when no target dependencies exist', async () => {
  const select = vi.fn();
  expect(await findLiveTargetDependencies([{ id: 'row', sourceState: {} }], { select } as never)).toEqual(new Set());
  expect(select).not.toHaveBeenCalled();
});
it('resolves targets outside the page and safely compares malformed historical ids as text', async () => {
  const where = vi.fn(async (_predicate: unknown) => [{ id: 'target-on-other-page' }]);
  const executor = { select: () => ({ from: () => ({ where }) }) };
  expect(await findLiveTargetDependencies([
    { id: 'dependent', sourceState: { targetConversionId: 'target-on-other-page' } },
    { id: 'reverted', sourceState: { targetConversionId: 'missing' } },
    { id: 'invalid', sourceState: { targetConversionId: 3 } },
  ], executor as never)).toEqual(new Set(['dependent']));
  const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as never);
  expect(query.sql).toContain('::text');
  expect(query.sql).toContain('"reverted_at" is null');
  expect(query.params).toEqual(['target-on-other-page', 'missing']);
});
