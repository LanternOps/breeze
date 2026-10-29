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

const { selectMock, insertMock, publishEventMock, resolveRulesMock, scanDueMock, withDbTransactionMock, captureExceptionMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  publishEventMock: vi.fn(),
  resolveRulesMock: vi.fn(),
  scanDueMock: vi.fn(),
  withDbTransactionMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  captureExceptionMock: vi.fn(),
}));

vi.mock('../jobs/automationWorker', () => ({ enqueueAutomationRun: vi.fn() }));
vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  hasDbAccessContext: () => true,
  withDbTransaction: withDbTransactionMock,
}));
vi.mock('./eventBus', () => ({ publishEvent: publishEventMock }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./featureConfigResolver', () => ({
  resolveComplianceRulesForDevice: resolveRulesMock,
  scanDueComplianceChecks: scanDueMock,
}));

import { __policyEvaluationAfterCommit, scanAndEvaluateConfigPolicyCompliance } from './policyEvaluationService';

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
  withDbTransactionMock.mockReset();
  withDbTransactionMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  captureExceptionMock.mockReset();

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
      '[PolicyEvaluation] Failed to publish policy.evaluated (config-policy-compliance):',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('afterCommit still publishes the events when the remediation step rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    publishEventMock.mockResolvedValue('event-id');
    // remediationAfterCommit loads the worker module outside its own per-run try.
    vi.doMock('../jobs/automationWorker', () => {
      throw new Error('module load failed');
    });
    try {
      const afterCommit = __policyEvaluationAfterCommit(
        [{ runId: 'run-1', deviceId: DEVICE.id }],
        [{ type: 'policy.violation', orgId: ORG_ID, payload: { deviceId: DEVICE.id }, source: 'config-policy-compliance' }],
      );
      await expect(afterCommit!()).resolves.toBeUndefined();
      expect(publishEventMock.mock.calls.map((c) => c[0])).toEqual(['policy.violation']);
    } finally {
      vi.doUnmock('../jobs/automationWorker');
      errorSpy.mockRestore();
    }
  });

  it('without deferEnqueue, publishes inline and returns no afterCommit', async () => {
    publishEventMock.mockResolvedValue('event-id');

    const result = await scanAndEvaluateConfigPolicyCompliance();

    expect(publishEventMock.mock.calls.map((c) => c[0])).toEqual(['policy.evaluated', 'policy.violation']);
    expect(result.afterCommit).toBeUndefined();
  });

  // #10401 — the scan runs every device in ONE system transaction. A SQL error
  // in one evaluation aborts that transaction, and postgres.js re-throws it at
  // COMMIT: nothing the scan wrote persists, no event goes out, and every
  // compliance alert in the fleet stays as it was. Each device runs in its own
  // savepoint, and each rule set in a savepoint nested inside it, so a failed
  // rule set rolls back alone: the device's other rule sets still commit and
  // still raise their events.
  describe('per-rule-set isolation', () => {
    const OTHER = { ...DEVICE, id: '55555555-5555-4555-8555-555555555555', hostname: 'WS-2' };
    const SECOND_RULE = { ...RULE, id: '66666666-6666-4666-8666-666666666666', name: 'Second rule set' };
    const sqlError = Object.assign(new Error('value too long for type character varying(200)'), { code: '22001' });

    /**
     * Models Postgres savepoints: each withDbTransaction opens a frame, a
     * rejected callback discards its frame (ROLLBACK TO SAVEPOINT), a resolved
     * one merges it into the parent (RELEASE). `committed` is what the outer
     * transaction would commit. SECOND_RULE's upsert fails on DEVICE only.
     */
    function trackSavepoints() {
      const committed: string[] = [];
      const frames: string[][] = [committed];
      withDbTransactionMock.mockImplementation(async (fn: () => Promise<unknown>) => {
        const frame: string[] = [];
        frames.push(frame);
        try {
          const out = await fn();
          frames.pop();
          frames[frames.length - 1]!.push(...frame);
          return out;
        } catch (error) {
          frames.pop();
          throw error;
        }
      });
      insertMock.mockImplementation(() => ({
        values: (row: { deviceId: string; configItemName: string }) => ({
          onConflictDoUpdate: () => {
            if (row.deviceId === DEVICE.id && row.configItemName === SECOND_RULE.name) {
              return Promise.reject(sqlError);
            }
            frames[frames.length - 1]!.push(`${row.deviceId}:${row.configItemName}`);
            return Promise.resolve();
          },
        }),
      }));
      return committed;
    }

    beforeEach(() => {
      let deviceLookups = 0;
      selectMock.mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        const step = () => chain;
        chain.from = step;
        chain.where = step;
        chain.innerJoin = step;
        chain.leftJoin = step;
        chain.limit = () => Promise.resolve([deviceLookups++ === 0 ? DEVICE : OTHER]);
        chain.then = (resolve: (v: unknown) => unknown) => resolve([]);
        return chain;
      });
      scanDueMock.mockResolvedValue([
        { complianceRule: RULE, assignmentLevel: 'device', assignmentTargetId: DEVICE.id, policyId: 'p', policyName: 'P' },
        { complianceRule: SECOND_RULE, assignmentLevel: 'device', assignmentTargetId: DEVICE.id, policyId: 'p', policyName: 'P' },
        { complianceRule: RULE, assignmentLevel: 'device', assignmentTargetId: OTHER.id, policyId: 'p', policyName: 'P' },
      ]);
      resolveRulesMock.mockResolvedValue([RULE, SECOND_RULE]);
      publishEventMock.mockResolvedValue('event-id');
    });

    it('rolls back only the failed rule set; the device\'s other rule sets commit and raise events', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const committed = trackSavepoints();
      try {
        const result = await scanAndEvaluateConfigPolicyCompliance({ deferEnqueue: true });

        expect(committed).toEqual([`${DEVICE.id}:${RULE.name}`, `${OTHER.id}:${RULE.name}`]);
        expect(result.devicesEvaluated).toBe(2);
        expect(result.devicesFailed).toBe(0);
        expect(result.ruleSetsFailed).toBe(1);
        expect(result.results.map((r) => [r.deviceId, r.complianceRuleId])).toEqual([
          [DEVICE.id, RULE.id],
          [OTHER.id, RULE.id],
        ]);
        expect(captureExceptionMock).toHaveBeenCalledTimes(1);
        expect(captureExceptionMock).toHaveBeenCalledWith(
          sqlError,
          undefined,
          { job: 'config-policy-compliance-scan', stage: 'rule_set' },
          { fingerprint: ['config-policy-compliance-device', '22001'] },
        );

        await result.afterCommit!();
        const published = publishEventMock.mock.calls.map((c) => {
          const payload = c[2] as { deviceId: string; configPolicyComplianceRuleId: string };
          return `${c[0]}:${payload.deviceId}:${payload.configPolicyComplianceRuleId}`;
        });
        expect(published).toEqual([
          `policy.evaluated:${DEVICE.id}:${RULE.id}`,
          `policy.violation:${DEVICE.id}:${RULE.id}`,
          `policy.evaluated:${OTHER.id}:${RULE.id}`,
          `policy.violation:${OTHER.id}:${RULE.id}`,
        ]);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('without deferEnqueue, publishes the surviving rule sets inline and nothing for the failed one', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      trackSavepoints();
      try {
        const result = await scanAndEvaluateConfigPolicyCompliance();

        expect(result.ruleSetsFailed).toBe(1);
        const publishedRules = publishEventMock.mock.calls.map(
          (c) => (c[2] as { configPolicyComplianceRuleId: string }).configPolicyComplianceRuleId,
        );
        expect(publishedRules).toEqual([RULE.id, RULE.id, RULE.id, RULE.id]);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('a device whose every rule set fails counts as a failed device without failing the scan', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const committed = trackSavepoints();
      resolveRulesMock.mockImplementation(async (deviceId: string) => (deviceId === DEVICE.id ? [SECOND_RULE] : [RULE]));
      scanDueMock.mockResolvedValue([
        { complianceRule: SECOND_RULE, assignmentLevel: 'device', assignmentTargetId: DEVICE.id, policyId: 'p', policyName: 'P' },
        { complianceRule: RULE, assignmentLevel: 'device', assignmentTargetId: OTHER.id, policyId: 'p', policyName: 'P' },
      ]);
      try {
        const result = await scanAndEvaluateConfigPolicyCompliance({ deferEnqueue: true });

        expect(committed).toEqual([`${OTHER.id}:${RULE.name}`]);
        expect(result.devicesFailed).toBe(1);
        expect(result.ruleSetsFailed).toBe(1);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  // Every evaluation failing is a fault the whole scan shares, not one bad rule
  // set: the job must fail rather than commit an empty scan that looks healthy.
  // A device counts as failed when it threw outright or every rule set failed.
  it('fails the scan when every evaluation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    insertMock.mockImplementation(() => ({
      values: () => ({ onConflictDoUpdate: () => Promise.reject(new Error('column does not exist')) }),
    }));
    try {
      await expect(scanAndEvaluateConfigPolicyCompliance({ deferEnqueue: true }))
        .rejects.toThrow('every compliance evaluation failed (1 device(s), 1 rule set(s))');
      expect(publishEventMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // A failure outside any rule set (resolving the device's rules, loading its
  // telemetry) still rolls back the whole device and is reported as one.
  it('fails the scan when every device fails before reaching a rule set', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loadError = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    resolveRulesMock.mockRejectedValue(loadError);
    try {
      await expect(scanAndEvaluateConfigPolicyCompliance({ deferEnqueue: true }))
        .rejects.toThrow('every compliance evaluation failed (1 device(s), 0 rule set(s))');
      expect(captureExceptionMock).toHaveBeenCalledWith(
        loadError,
        undefined,
        { job: 'config-policy-compliance-scan', stage: 'device' },
        { fingerprint: ['config-policy-compliance-device', '42P01'] },
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
