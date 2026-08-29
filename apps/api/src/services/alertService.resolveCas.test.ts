import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, updateWheres, updateReturnResults, publishEventMock } = vi.hoisted(() => {
  const updateWheres: unknown[] = [];
  const updateReturnResults: unknown[][] = [];
  const selectResults: unknown[][] = [];
  const dbMock = {
    _selectResults: selectResults,
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(selectResults.shift() ?? []) }) })
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: (w: unknown) => {
          updateWheres.push(w);
          return {
            returning: () => Promise.resolve(updateReturnResults.shift() ?? [])
          };
        }
      })
    }))
  };
  return { dbMock, updateWheres, updateReturnResults, publishEventMock: vi.fn(() => Promise.resolve('evt')) };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  isNotNull: (col: unknown) => ({ op: 'isNotNull', col }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  sql: Object.assign((s: unknown) => s, { raw: (s: unknown) => s })
}));

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('../db/schema', () => ({
  alerts: { id: 'alerts.id', status: 'alerts.status', orgId: 'alerts.orgId' },
  alertRules: { id: 'alert_rules.id', templateId: 'alert_rules.templateId' },
  alertTemplates: { id: 'alert_templates.id' },
  alertCorrelations: {},
  devices: {}, deviceGroups: {}, deviceGroupMemberships: {}, sites: {},
  configPolicyAlertRules: {}
}));
vi.mock('./alertConditions', () => ({
  evaluateConditions: vi.fn(), evaluateAutoResolveConditions: vi.fn(),
  interpolateTemplate: vi.fn((t: string) => t)
}));
vi.mock('./alertCooldown', () => ({
  isCooldownActive: vi.fn(() => Promise.resolve(false)),
  setCooldown: vi.fn(() => Promise.resolve()),
  isConfigPolicyRuleCooling: vi.fn(),
  markConfigPolicyRuleCooldown: vi.fn(),
  recordStateTransition: vi.fn(() => Promise.resolve()),
  isFlapping: vi.fn(() => Promise.resolve(false))
}));
vi.mock('./eventBus', () => ({ publishEvent: publishEventMock }));
vi.mock('./alertCorrelationQueue', () => ({ enqueueAlertCorrelation: vi.fn() }));

import { resolveAlert } from './alertService';

// The RETURNING row: triggeredAt is NOT NULL and this same UPDATE sets resolvedAt —
// resolveAlert publishes both on `alert.resolved` (C2 fix), so the fixture models them.
const WINNER = [{
  id: 'alert-1',
  orgId: 'org-1',
  ruleId: null,
  deviceId: 'device-1',
  configPolicyId: null,
  triggeredAt: new Date('2026-08-29T10:00:00.000Z'),
  resolvedAt: new Date('2026-08-29T10:05:00.000Z'),
}];

describe('resolveAlert is a compare-and-swap', () => {
  beforeEach(() => {
    updateWheres.length = 0;
    updateReturnResults.length = 0;
    publishEventMock.mockClear();
    dbMock._selectResults.length = 0;
  });

  it('reports true and publishes once for the caller that transitioned the row', async () => {
    updateReturnResults.push(WINNER);

    await expect(resolveAlert('alert-1')).resolves.toBe(true);
    expect(publishEventMock).toHaveBeenCalledTimes(1);
  });

  it('reports false and does NOT publish when the row was already resolved', async () => {
    updateReturnResults.push([]);   // CAS matched nothing: another caller won

    await expect(resolveAlert('alert-1')).resolves.toBe(false);
    // The whole point: alert.resolved must not fan out twice for one real
    // transition (escalation cancellation, AI triage loop guard both hang off it).
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('scopes the update to non-terminal statuses, not to the id alone', async () => {
    updateReturnResults.push(WINNER);
    await resolveAlert('alert-1');

    const where = JSON.stringify(updateWheres.at(-1));
    expect(where).toContain('alerts.id');
    // A status predicate IS the concurrency control. Without it the update is
    // unconditional and both callers "win".
    expect(where).toContain('alerts.status');
    expect(where).toContain('inArray');
  });
});
