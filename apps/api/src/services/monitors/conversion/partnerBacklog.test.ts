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
      'alert_templates', 'automations', 'config_policy_alert_rules', 'config_policy_automations', 'config_policy_monitoring_watches',
    ]);
  });
  it('maps rows to camelCase and orders pending partners first', async () => {
    execute.mockResolvedValue([
      { partner_id: 'p-2', partner_name: 'Beta', pending_rows: 0, pending_policies: 0 },
      { partner_id: 'p-1', partner_name: 'Acme', pending_rows: 7, pending_policies: 2 },
    ]);
    const rows = await listPartnerConversionBacklog();
    expect(rows).toEqual([
      { partnerId: 'p-1', partnerName: 'Acme', pendingRows: 7, pendingPolicies: 2 },
      { partnerId: 'p-2', partnerName: 'Beta', pendingRows: 0, pendingPolicies: 0 },
    ]);
  });
});

