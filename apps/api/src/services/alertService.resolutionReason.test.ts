import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, sets, updateReturnResults, publishEventMock } = vi.hoisted(() => {
  const sets: Record<string, unknown>[] = [];
  const updateReturnResults: unknown[][] = [];
  const dbMock = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: () => ({ limit: () => Promise.resolve([]) }) })) })),
    update: vi.fn(() => ({
      set: (s: Record<string, unknown>) => { sets.push(s); return { where: () => ({ returning: () => Promise.resolve(updateReturnResults.shift() ?? []) }) }; },
    })),
  };
  return { dbMock, sets, updateReturnResults, publishEventMock: vi.fn(() => Promise.resolve('evt')) };
});

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('../db/schema', () => ({
  alerts: { id: 'alerts.id', status: 'alerts.status', orgId: 'alerts.orgId' },
  alertRules: { id: 'alert_rules.id', templateId: 'alert_rules.templateId' },
  alertTemplates: { id: 'alert_templates.id' },
  alertCorrelations: {}, devices: {}, deviceGroups: {}, deviceGroupMemberships: {}, sites: {}, configPolicyAlertRules: {},
}));
vi.mock('./alertConditions', () => ({ evaluateConditions: vi.fn(), evaluateAutoResolveConditions: vi.fn(), interpolateTemplate: vi.fn((t: string) => t) }));
vi.mock('./alertCooldown', () => ({
  isCooldownActive: vi.fn(() => Promise.resolve(false)), setCooldown: vi.fn(() => Promise.resolve()),
  recordStateTransition: vi.fn(() => Promise.resolve()), isFlapping: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('./eventBus', () => ({ publishEvent: publishEventMock }));
vi.mock('./alertCorrelationQueue', () => ({ enqueueAlertCorrelation: vi.fn() }));

import { resolveAlert } from './alertService';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'alert-1', orgId: 'org-1', ruleId: null, deviceId: 'device-1', subjectKey: null,
  triggeredAt: new Date('2026-11-01T00:00:00Z'), resolvedAt: new Date('2026-11-01T01:00:00Z'),
  resolvedBy: null, resolutionReason: null, ...over,
});

describe('resolveAlert resolution reason', () => {
  beforeEach(() => { sets.length = 0; updateReturnResults.length = 0; publishEventMock.mockClear(); });

  it('persists and publishes an explicit condition_cleared', async () => {
    updateReturnResults.push([row({ resolutionReason: 'condition_cleared' })]);
    await resolveAlert('alert-1', 'Auto-resolved: conditions cleared', undefined, false, 'condition_cleared');
    expect(sets[0]).toMatchObject({ status: 'resolved', resolutionReason: 'condition_cleared', resolvedBy: null });
    expect(publishEventMock).toHaveBeenCalledWith('alert.resolved', 'org-1',
      expect.objectContaining({ resolutionReason: 'condition_cleared', resolvedBy: null }), 'alert-service', expect.anything());
  });

  it('defaults to manual when a user resolves', async () => {
    updateReturnResults.push([row({ resolvedBy: 'user-1', resolutionReason: 'manual' })]);
    await resolveAlert('alert-1', 'fixed it', 'user-1');
    expect(sets[0]).toMatchObject({ resolvedBy: 'user-1', resolutionReason: 'manual' });
  });

  it('leaves the reason NULL (fail closed) when a system caller says nothing', async () => {
    updateReturnResults.push([row()]);
    await resolveAlert('alert-1', 'note');
    expect(sets[0]).toMatchObject({ resolutionReason: null });
    expect(publishEventMock).toHaveBeenCalledWith('alert.resolved', 'org-1', expect.objectContaining({ resolutionReason: null }), 'alert-service', expect.anything());
  });
});
