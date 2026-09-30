import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The automation-policy path has the same fault #7518 fixed for configuration
 * policies. The `evaluate-policy` job runs evaluatePolicy inside one system
 * transaction (policyEvaluationWorker `commitThenEnqueue`), and publishEvent
 * delivers the policy-alert-bridge on its own connection. The bridge judges a
 * violation by the persisted automation_policy_compliance row, so an event
 * published inside the transaction was judged on the PREVIOUS evaluation: a
 * compliant → failing transition raised no alert. Under `deferEnqueue` the
 * events wait for the result's `afterCommit`.
 * The real-DB proof is policyComplianceAlertDelivery.integration.test.ts.
 */

const { selectMock, insertMock, updateMock, publishEventMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  publishEventMock: vi.fn(),
}));

vi.mock('../jobs/automationWorker', () => ({ enqueueAutomationRun: vi.fn() }));
vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./eventBus', () => ({ publishEvent: publishEventMock }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { evaluatePolicy } from './policyEvaluationService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE = {
  id: '22222222-2222-4222-8222-222222222222',
  orgId: ORG_ID,
  hostname: 'WS-1',
  osType: 'windows',
  osVersion: '10.0.19045',
};
const POLICY = {
  id: '33333333-3333-4333-8333-333333333333',
  orgId: ORG_ID,
  partnerId: null,
  name: 'Keep Contoso Agent installed',
  enforcement: 'warn',
  enabled: true,
  targets: {},
  rules: [{ type: 'required_software', softwareName: 'Contoso Agent', versionOperator: 'any' }],
  checkIntervalMinutes: 60,
} as never;

/** The first select is the target-device lookup; every other read is empty. */
function mockSelects() {
  let call = 0;
  selectMock.mockImplementation(() => {
    const rows = call++ === 0 ? [DEVICE] : [];
    const chain: Record<string, unknown> = {};
    const step = () => chain;
    chain.from = step;
    chain.where = step;
    chain.innerJoin = step;
    chain.limit = () => Promise.resolve(rows);
    chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
    return chain;
  });
}

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  publishEventMock.mockReset();

  mockSelects();
  insertMock.mockReturnValue({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) });
  updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) });
});

describe('evaluatePolicy policy.* events', () => {
  it('under deferEnqueue, publishes nothing during the evaluation and publishes from afterCommit', async () => {
    let committed = false;
    const publishedWhileOpen: string[] = [];
    publishEventMock.mockImplementation(async (type: string) => {
      if (!committed) publishedWhileOpen.push(type);
      return 'event-id';
    });

    const result = await evaluatePolicy(POLICY, { source: 'policy-evaluation-worker', requestRemediation: false, deferEnqueue: true });
    expect(result.results).toEqual([expect.objectContaining({ deviceId: DEVICE.id, status: 'non_compliant' })]);
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(result.afterCommit).toBeTypeOf('function');

    committed = true;
    await result.afterCommit!();

    expect(publishedWhileOpen).toEqual([]);
    expect(publishEventMock.mock.calls.map((c) => [c[0], c[1], c[3]])).toEqual([
      ['policy.evaluated', ORG_ID, 'policy-evaluation-worker'],
      ['policy.violation', ORG_ID, 'policy-evaluation-worker'],
    ]);
    expect(publishEventMock.mock.calls[1]![2]).toMatchObject({
      policyId: (POLICY as { id: string }).id,
      deviceId: DEVICE.id,
      hostname: DEVICE.hostname,
      status: 'non_compliant',
      previousStatus: null,
      enforcement: 'warn',
    });
  });

  it('afterCommit never rejects: a failed publish is logged and the next event still goes out', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    publishEventMock.mockRejectedValueOnce(new Error('redis down')).mockResolvedValue('event-id');

    const result = await evaluatePolicy(POLICY, { requestRemediation: false, deferEnqueue: true });
    await expect(result.afterCommit!()).resolves.toBeUndefined();

    expect(publishEventMock.mock.calls.map((c) => c[0])).toEqual(['policy.evaluated', 'policy.violation']);
    errorSpy.mockRestore();
  });

  it('without deferEnqueue, publishes inline and returns no afterCommit', async () => {
    publishEventMock.mockResolvedValue('event-id');

    const result = await evaluatePolicy(POLICY, { requestRemediation: false });

    expect(publishEventMock.mock.calls.map((c) => c[0])).toEqual(['policy.evaluated', 'policy.violation']);
    expect(result.afterCommit).toBeUndefined();
  });
});
