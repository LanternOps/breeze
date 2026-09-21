import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ convert: vi.fn() }));
vi.mock('../services/monitors/ruleConversionService', () => ({ convertRuleToMonitor: m.convert }));
import { migrateAlertRulesLive } from './migrateToConfigPolicies';
import type { AuthContext } from '../middleware/auth';
const auth = { scope: 'system', user: { id: '30000000-0000-4000-8000-000000000001' } } as AuthContext;
const ORG = '30000000-0000-4000-8000-000000000002';
function tx(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  return { db: { select: () => ({ from: () => ({ where }) }), insert: vi.fn() }, where };
}
beforeEach(() => vi.resetAllMocks());
it('converts each source via the ledger-aware service and never writes umbrella attachments', async () => {
  const f = tx([{ id: 'r1', templateId: 't1' }, { id: 'r2', templateId: 't1' }]);
  m.convert.mockResolvedValue({ ok: true, data: { monitorId: 'monitor', configPolicyId: 'target-specific-policy', convertedRuleIds: ['r1', 'r2'] } });
  expect(await migrateAlertRulesLive(f.db as never, ORG, auth)).toBe(2);
  expect(m.convert.mock.calls).toEqual([['r1', auth, f.db]]);
  expect(f.db.insert).not.toHaveBeenCalled();
  const query = new PgDialect().sqlToQuery(f.where.mock.calls[0]![0]);
  expect(query.sql).toContain('"managed_by_monitor_id" is null');
  expect(query.sql).toContain('"retired_at" is null');
  expect(query.params).toEqual([ORG]);
});
it('empty input does nothing and an unconvertible source is reported, never retired silently', async () => {
  expect(await migrateAlertRulesLive(tx([]).db as never, ORG, auth)).toBe(0);
  m.convert.mockResolvedValue({ ok: false, failure: { kind: 'not_convertible' } });
  await expect(migrateAlertRulesLive(tx([{ id: 'r1' }]).db as never, ORG, auth)).rejects.toThrow('r1: not_convertible');
});
