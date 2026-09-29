import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The scheduled compliance scan runs inside one system transaction
 * (policyEvaluationWorker `commitThenEnqueue`). publishEvent delivers the
 * policy-alert-bridge on its own connection, and the bridge acts on the
 * persisted automation_policy_compliance row, so a policy.* event published
 * inside that transaction is judged on the PREVIOUS evaluation: the first
 * failing check raised nothing ("no persisted compliance row … not alerting").
 * Under `deferEnqueue` the events wait for the result's `afterCommit`.
 * The real-DB proof is configComplianceAlertDelivery.integration.test.ts.
 */

const { selectMock, insertMock, publishEventMock, resolveRulesMock, scanDueMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  publishEventMock: vi.fn(),
  resolveRulesMock: vi.fn(),
  scanDueMock: vi.fn(),
}));

vi.mock('../jobs/automationWorker', () => ({ enqueueAutomationRun: vi.fn() }));
vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./eventBus', () => ({ publishEvent: publishEventMock }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./featureConfigResolver', () => ({
  resolveComplianceRulesForDevice: resolveRulesMock,
  scanDueComplianceChecks: scanDueMock,
}));

import { scanAndEvaluateConfigPolicyCompliance } from './policyEvaluationService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE = {
  id: '22222222-2222-4222-8222-222222222222',
  orgId: ORG_ID,
  hostname: 'WS-1',
  osType: 'windows',
  osVersion: '10.0.19045',
};
const RULE = {
  id: '33333333-3333-4333-8333-333333333333',
  featureLinkId: '44444444-4444-4444-8444-444444444444',
  name: 'Keep Contoso Agent installed',
  rules: [{ type: 'required_software', softwareName: 'Contoso Agent', versionOperator: 'any' }],
  enforcementLevel: 'warn',
  checkIntervalMinutes: 60,
  remediationScriptId: null,
  sortOrder: 0,
};

/** Every select chain resolves to [] except the device lookup (the only `.limit`). */
function mockSelects() {
  selectMock.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const step = () => chain;
    chain.from = step;
    chain.where = step;
    chain.innerJoin = step;
    chain.leftJoin = step;
    chain.limit = () => Promise.resolve([DEVICE]);
    chain.then = (resolve: (v: unknown) => unknown) => resolve([]);
    return chain;
  });
}

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  publishEventMock.mockReset();
  resolveRulesMock.mockReset();
  scanDueMock.mockReset();

  mockSelects();
  insertMock.mockReturnValue({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) });
  scanDueMock.mockResolvedValue([
    { complianceRule: RULE, assignmentLevel: 'device', assignmentTargetId: DEVICE.id, policyId: 'p', policyName: 'P' },
  ]);
  resolveRulesMock.mockResolvedValue([RULE]);
});

describe('scanAndEvaluateConfigPolicyCompliance compliance events', () => {
  it('under deferEnqueue, publishes nothing during the scan and publishes from afterCommit', async () => {
    let committed = false;
    const publishedWhileOpen: string[] = [];
    publishEventMock.mockImplementation(async (type: string) => {
      if (!committed) publishedWhileOpen.push(type);
      return 'event-id';
    });

    const result = await scanAndEvaluateConfigPolicyCompliance({ deferEnqueue: true });
    expect(result.results).toEqual([expect.objectContaining({ complianceRuleId: RULE.id, status: 'non_compliant' })]);
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(result.afterCommit).toBeTypeOf('function');

    committed = true;
    await result.afterCommit!();

    expect(publishedWhileOpen).toEqual([]);
    expect(publishEventMock.mock.calls.map((c) => [c[0], c[1], c[3]])).toEqual([
      ['policy.evaluated', ORG_ID, 'config-policy-compliance'],
      ['policy.violation', ORG_ID, 'config-policy-compliance'],
    ]);
    expect(publishEventMock.mock.calls[1]![2]).toMatchObject({
      configPolicyComplianceRuleId: RULE.id,
      configPolicyComplianceRuleName: RULE.name,
      configPolicyId: RULE.featureLinkId,
      deviceId: DEVICE.id,
      hostname: DEVICE.hostname,
      status: 'non_compliant',
      enforcementLevel: 'warn',
    });
  });

  it('afterCommit never rejects: a failed publish is logged and the next event still goes out', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    publishEventMock
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue('event-id');

    const result = await scanAndEvaluateConfigPolicyCompliance({ deferEnqueue: true });
    await expect(result.afterCommit!()).resolves.toBeUndefined();

    expect(publishEventMock.mock.calls.map((c) => c[0])).toEqual(['policy.evaluated', 'policy.violation']);
    expect(errorSpy).toHaveBeenCalledWith(
      '[ConfigPolicyCompliance] Failed to publish policy.evaluated:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('without deferEnqueue, publishes inline and returns no afterCommit', async () => {
    publishEventMock.mockResolvedValue('event-id');

    const result = await scanAndEvaluateConfigPolicyCompliance();

    expect(publishEventMock.mock.calls.map((c) => c[0])).toEqual(['policy.evaluated', 'policy.violation']);
    expect(result.afterCommit).toBeUndefined();
  });
});
