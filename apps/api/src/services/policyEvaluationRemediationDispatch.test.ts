import { beforeEach, describe, expect, it, vi } from 'vitest';

// #3413: both remediation triggers inserted an automation_runs row and then
// flipped it to 'completed' on a setTimeout without ever dispatching, so policy
// drift showed "remediated" while the device was never touched. The observable
// guarantee is that the real automation runtime is asked to run the row.

const enqueueAutomationRunMock = vi.fn().mockResolvedValue({ enqueued: true });
vi.mock('../jobs/automationWorker', () => ({
  enqueueAutomationRun: (...args: unknown[]) => enqueueAutomationRunMock(...args),
}));

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./featureConfigResolver', () => ({
  resolveComplianceRulesForDevice: vi.fn(),
  scanDueComplianceChecks: vi.fn(),
}));

import {
  __triggerConfigPolicyRemediation,
  __triggerRemediationAutomation,
} from './policyEvaluationService';

const DEVICE = {
  id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  orgId: 'oooooooo-oooo-oooo-oooo-oooooooooooo',
  hostname: 'WS-1',
  osType: 'windows',
  osVersion: '10.0.19045',
};
const RUN_ID = 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr';
const AUTOMATION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SCRIPT_ID = 'ssssssss-ssss-ssss-ssss-ssssssssssss';

/** Queue results for the successive `.select()` chains each trigger performs. */
function queueSelects(...results: unknown[][]) {
  const queue = [...results];
  selectMock.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const step = () => chain;
    chain.from = step;
    chain.where = step;
    chain.innerJoin = step;
    chain.leftJoin = step;
    chain.limit = () => Promise.resolve(queue.shift() ?? []);
    chain.then = (resolve: (v: unknown) => unknown) => resolve(queue.shift() ?? []);
    return chain;
  });
}

beforeEach(() => {
  enqueueAutomationRunMock.mockClear();
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();

  insertMock.mockReturnValue({
    values: () => ({ returning: () => Promise.resolve([{ id: RUN_ID, logs: [] }]) }),
  });
  updateMock.mockReturnValue({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  });
});

describe('policy remediation actually dispatches (#3413)', () => {
  it('config-policy remediation enqueues the run it just created', async () => {
    queueSelects(
      [{ orgId: DEVICE.orgId }],                                   // device org lookup
      [{ partnerId: null }],                                       // automationOwnershipConditionForOrg
      [{ id: AUTOMATION_ID, actions: [{ scriptId: SCRIPT_ID }] }], // candidate automations
      [{ id: AUTOMATION_ID, enabled: true }],                      // the automation row
    );

    const result = await __triggerConfigPolicyRemediation(
      {
        id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        name: 'BitLocker enabled',
        remediationScriptId: SCRIPT_ID,
        featureLinkId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      } as never,
      DEVICE as never,
    );

    expect(result).toBe(true);
    expect(enqueueAutomationRunMock).toHaveBeenCalledTimes(1);
    // the run it inserted, targeted at exactly the device being remediated
    expect(enqueueAutomationRunMock).toHaveBeenCalledWith(RUN_ID, [DEVICE.id]);
  });

  it('does not dispatch when no matching automation exists', async () => {
    queueSelects(
      [{ orgId: DEVICE.orgId }],
      [{ partnerId: null }],
      [{ id: AUTOMATION_ID, actions: [{ scriptId: 'some-other-script' }] }],
    );

    const result = await __triggerConfigPolicyRemediation(
      {
        id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        name: 'BitLocker enabled',
        remediationScriptId: SCRIPT_ID,
        featureLinkId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      } as never,
      DEVICE as never,
    );

    expect(result).toBe(false);
    expect(enqueueAutomationRunMock).not.toHaveBeenCalled();
  });

  it('does not dispatch when the rule carries no remediation script', async () => {
    const result = await __triggerConfigPolicyRemediation(
      { id: 'c1', name: 'no-script', remediationScriptId: null, featureLinkId: 'f1' } as never,
      DEVICE as never,
    );

    expect(result).toBe(false);
    expect(enqueueAutomationRunMock).not.toHaveBeenCalled();
  });

  it('exports the standalone-policy trigger too, so both paths are covered', () => {
    // The standalone variant carried the identical simulate-completion stub;
    // pinning its presence keeps a future refactor from dropping one of them.
    expect(typeof __triggerRemediationAutomation).toBe('function');
  });

  it('does not create a standalone-policy remediation run for a managed automation', async () => {
    queueSelects(
      [{ partnerId: null }],
      [{ id: AUTOMATION_ID, enabled: true, managedByAgentId: 'agent-1' }],
    );

    const result = await __triggerRemediationAutomation(
      { id: 'policy-1', name: 'Managed policy' } as never,
      DEVICE as never,
      'non_compliant',
      AUTOMATION_ID,
    );

    expect(result).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('does not create a config-policy remediation run for a managed automation', async () => {
    queueSelects(
      [{ orgId: DEVICE.orgId }],
      [{ partnerId: null }],
      [{ id: AUTOMATION_ID, actions: [{ scriptId: SCRIPT_ID }] }],
      [{ id: AUTOMATION_ID, enabled: true, managedByAgentId: 'agent-1' }],
    );

    const result = await __triggerConfigPolicyRemediation(
      {
        id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        name: 'BitLocker enabled',
        remediationScriptId: SCRIPT_ID,
        featureLinkId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      } as never,
      DEVICE as never,
    );

    expect(result).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
  });
});
