import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W06 (#5221) Task A8 — the conversion census: aggregates only,
 * system context, never an id or a name (it is run on production and only its
 * numbers leave the host).
 */

const m = vi.hoisted(() => ({ rows: [] as unknown[], conversions: [] as unknown[], context: vi.fn() }));

vi.mock('../../../db', () => ({
  db: {
    select: () => ({ from: (t: { _: string }) => ({ where: async () => (t._ === 'conversions' ? m.conversions : m.rows) }) }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../../db/schema', () => ({
  automations: { _: 'automations', retiredAt: {}, managedByMonitorId: {} },
  flowAutomationConversions: { _: 'conversions', state: {} },
}));
vi.mock('./context', () => ({ loadConversionContext: m.context }));

import { conversionCensus } from './census';
import { ctx, row } from './__fixtures__/automations';

const NOW = new Date('2027-02-01T00:00:00Z');

beforeEach(() => {
  m.rows = [];
  m.conversions = [];
  m.context.mockReset().mockImplementation(async () => ctx());
});

describe('conversionCensus', () => {
  it('counts classes, fidelities, findings and switched rows', async () => {
    m.rows = [
      row({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
      row({ id: 'aaaaaaaa-0000-4000-8000-000000000002', enabled: false, trigger: { type: 'webhook', secret: 's' } }),
      row({ id: 'aaaaaaaa-0000-4000-8000-000000000003', managedByMonitorId: 'm' }),
      row({ id: 'aaaaaaaa-0000-4000-8000-000000000004', managedByAgentId: 'a' }),
      row({ id: 'aaaaaaaa-0000-4000-8000-000000000005', trigger: { type: 'event', eventType: 'x', filter: { _policyWorkflow: {} } } }),
    ];
    m.conversions = [
      { automationId: 'aaaaaaaa-0000-4000-8000-000000000001', state: 'switched', switchedAt: new Date('2027-01-01T00:00:00Z') },
    ];
    const c = await conversionCensus(NOW);
    expect(c.byClass).toEqual({ M: { total: 1, enabled: 1 }, A: { total: 1, enabled: 1 }, P: { total: 1, enabled: 1 }, S: { total: 2, enabled: 1 } });
    expect(c.switched).toBe(1);
    expect(c.enabledUnswitchedS).toBe(0);
    expect(c.oldestSwitchAgeMs).toBe(31 * 86_400_000);
    expect(c.byFidelity.exact + c.byFidelity.needs_review + c.byFidelity.unconvertible).toBe(2);
    expect(c.byFinding.webhook_body_shape).toBe(1);
  });

  it('R rows counted separately', async () => {
    m.rows = [row({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }), row({ id: 'aaaaaaaa-0000-4000-8000-000000000002' })];
    m.context.mockImplementationOnce(async () => ctx({ isRemediationTarget: true }));
    const c = await conversionCensus(NOW);
    expect(c.remediationTargets).toBe(1);
    expect(c.enabledUnswitchedS).toBe(2);
    expect(c.byFinding.compliance_remediation_target).toBe(1);
  });

  it('census output contains no uuid', async () => {
    m.rows = [row({ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Customer Acme payroll' })];
    const text = JSON.stringify(await conversionCensus(NOW));
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(text).not.toContain('Acme');
  });

  it('a row whose context cannot load is counted, not thrown', async () => {
    m.rows = [row({ id: 'aaaaaaaa-0000-4000-8000-000000000001' })];
    m.context.mockRejectedValueOnce(new Error('no owner'));
    const c = await conversionCensus(NOW);
    expect(c.contextErrors).toBe(1);
  });
});
