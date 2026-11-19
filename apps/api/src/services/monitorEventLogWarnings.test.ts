import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadPolicyApplicationProviders, captureException, hasDbAccessContext, withDbTransaction } = vi.hoisted(() => ({
  loadPolicyApplicationProviders: vi.fn(),
  captureException: vi.fn(),
  hasDbAccessContext: vi.fn(() => true),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./eventLogPolicyProviders', () => ({ loadPolicyApplicationProviders }));
vi.mock('./sentry', () => ({ captureException }));
vi.mock('../db', () => ({ hasDbAccessContext, withDbTransaction }));

import { policyAwareMonitorEventLogWarnings } from './monitorEventLogWarnings';

const ORG = '11111111-1111-4111-8111-111111111111';
const dellRule = {
  kind: 'event_log',
  condition: { category: 'application', level: 'warning', sourcePattern: 'Dell UPS' },
  orgId: ORG,
  partnerId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  hasDbAccessContext.mockReturnValue(true);
});

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

  it('runs the lookup in a savepoint so a failed query cannot abort the request transaction that holds the saved monitor', async () => {
    loadPolicyApplicationProviders.mockResolvedValue([]);
    await policyAwareMonitorEventLogWarnings(dellRule);
    expect(withDbTransaction).toHaveBeenCalledTimes(1);
  });

  describe('the recovery condition (alert re-arm W3)', () => {
    const collected = { category: 'application', level: 'error', countThreshold: 1, windowMinutes: 60 };
    const row = (autoResolveConditions: unknown) => ({
      kind: 'event_log', condition: collected, autoResolveConditions, orgId: ORG, partnerId: null,
    });
    const uncollected = { category: 'application', level: 'info', sourcePattern: 'Nothing-Collects-This', countThreshold: 1, windowMinutes: 60 };

    beforeEach(() => loadPolicyApplicationProviders.mockResolvedValue([]));

    it('warns, and says it is about the recovery condition, when its events are not collected', async () => {
      // The trigger is fine, so without this the alert opens and silently never clears.
      const warnings = await policyAwareMonitorEventLogWarnings(row(uncollected));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Recovery condition');
      expect(warnings[0]).toContain('Nothing-Collects-This');
    });

    it('honours providers a scoped policy lists', async () => {
      loadPolicyApplicationProviders.mockResolvedValue(['Nothing-Collects-This']);
      expect(await policyAwareMonitorEventLogWarnings(row(uncollected))).toEqual([]);
    });

    it('says nothing for a collected source, no condition, or a raw blob the engine can evaluate', async () => {
      expect(await policyAwareMonitorEventLogWarnings(row({ ...uncollected, sourcePattern: 'APCPBEAgent' }))).toEqual([]);
      expect(await policyAwareMonitorEventLogWarnings(row(null))).toEqual([]);
      expect(await policyAwareMonitorEventLogWarnings(row({ logic: 'or', conditions: [{ type: 'event_log' }] }))).toEqual([]);
    });

    it('#10935: says a stored value can never resolve, on any kind, whenever that monitor is saved', async () => {
      const [warning, ...rest] = await policyAwareMonitorEventLogWarnings(row({ conditions: [{ type: 'event_log' }] }));
      expect(rest).toEqual([]);
      expect(warning).toContain('Recovery condition');
      expect(warning).toContain('auto-resolve');

      const cpu = { kind: 'cpu', condition: {}, autoResolveConditions: uncollected, orgId: ORG, partnerId: null };
      expect(await policyAwareMonitorEventLogWarnings(cpu)).toHaveLength(1);
      expect(loadPolicyApplicationProviders).toHaveBeenCalledTimes(1);
    });
  });

  it('skips the lookup outside a DB access context (built-in check only)', async () => {
    hasDbAccessContext.mockReturnValue(false);
    expect(await policyAwareMonitorEventLogWarnings(dellRule)).toHaveLength(1);
    expect(loadPolicyApplicationProviders).not.toHaveBeenCalled();
  });
});
