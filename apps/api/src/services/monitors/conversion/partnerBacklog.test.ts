import { beforeEach, describe, expect, it, vi } from 'vitest';
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../../db', () => ({
  db: { execute },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
import { listPartnerConversionBacklog, PARTNER_BACKLOG_SQL_SOURCES } from './partnerBacklog';

beforeEach(() => vi.clearAllMocks());

describe('listPartnerConversionBacklog', () => {
  it('counts every legacy source table exactly once', () => {
    expect([...PARTNER_BACKLOG_SQL_SOURCES].sort()).toEqual([
      'alert_templates', 'automations', 'config_policy_alert_rules', 'config_policy_automations', 'config_policy_monitoring_watches', 'network_monitors',
    ]);
  });
  it('maps rows to camelCase and orders pending partners first', async () => {
    execute.mockResolvedValue([
      { partner_id: 'p-2', partner_name: 'Beta', pending_rows: 0, pending_policies: 0, network_checks: 3 },
      { partner_id: 'p-1', partner_name: 'Acme', pending_rows: 7, pending_policies: 2, network_checks: '2' },
    ]);
    const rows = await listPartnerConversionBacklog();
    expect(rows).toEqual([
      { partnerId: 'p-1', partnerName: 'Acme', pendingRows: 7, pendingPolicies: 2, networkChecks: 2 },
      { partnerId: 'p-2', partnerName: 'Beta', pendingRows: 0, pendingPolicies: 0, networkChecks: 3 },
    ]);
  });
});


it('keeps network checks out of the retired-runtime pending counts', async () => {
  execute.mockResolvedValue([]);
  await listPartnerConversionBacklog();
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]).sql;
  expect(query).toContain('network_monitors');
  expect(query).toContain('nm.managed_by_monitor_id IS NULL');
  expect(query).toContain('nm.retired_at IS NULL');
  expect(query).toContain('AS network_checks');
  expect(query.slice(query.indexOf('pending AS ('), query.indexOf('SELECT p.id'))).not.toContain('network_monitors');
});
