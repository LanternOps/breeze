import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadPolicyApplicationProviders, captureException } = vi.hoisted(() => ({
  loadPolicyApplicationProviders: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('./eventLogPolicyProviders', () => ({ loadPolicyApplicationProviders }));
vi.mock('./sentry', () => ({ captureException }));

import { policyAwareMonitorEventLogWarnings } from './monitorEventLogWarnings';

const ORG = '11111111-1111-4111-8111-111111111111';
const dellRule = {
  kind: 'event_log',
  condition: { category: 'application', level: 'warning', sourcePattern: 'Dell UPS' },
  orgId: ORG,
  partnerId: null,
};

beforeEach(() => vi.clearAllMocks());

describe('policyAwareMonitorEventLogWarnings', () => {
  it('skips the policy lookup for monitors without an event_log condition', async () => {
    expect(await policyAwareMonitorEventLogWarnings({ kind: 'cpu', condition: {}, orgId: ORG, partnerId: null })).toEqual([]);
    expect(loadPolicyApplicationProviders).not.toHaveBeenCalled();
  });

  it('does not warn when a scoped policy lists the provider', async () => {
    loadPolicyApplicationProviders.mockResolvedValue(['Dell UPS Local Node Manager']);
    expect(await policyAwareMonitorEventLogWarnings(dellRule)).toEqual([]);
  });

  it('falls back to the built-in check when the policy lookup fails (advisory only, never fails the save)', async () => {
    loadPolicyApplicationProviders.mockRejectedValue(new Error('db down'));
    const warnings = await policyAwareMonitorEventLogWarnings(dellRule);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Dell UPS');
    expect(captureException).toHaveBeenCalled();
  });
});
