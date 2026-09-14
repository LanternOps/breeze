import { beforeEach, expect, it, vi } from 'vitest';

const { seed } = vi.hoisted(() => ({ seed: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./automationActionResults', () => ({ seedAutomationActionResults: seed }));
import { __testOnly } from './automationRuntime';

beforeEach(() => vi.clearAllMocks());
it.each([
  [{ automationId: 'auto-1', triggerContext: { alertId: 'alert-1', ruleId: 'rule-1' } }, { kind: 'alert', refId: 'alert-1', key: 'alert:rule-1' }],
  [{ automationId: 'auto-1' }, { kind: 'automation', refId: 'auto-1', key: 'automation:auto-1' }],
  [{ configPolicyId: 'policy-1' }, { kind: 'policy', refId: 'policy-1', key: 'policy:policy-1' }],
])('seeds device-owned action rows with the recorded run cause %j', async (source, expected) => {
  const trigger = __testOnly.automationRemediationTrigger(source as never);
  await __testOnly.seedDeviceAutomationActions('run-1', { id: 'device-1', orgId: 'device-org' }, [{ type: 'execute_command', command: 'whoami' }], trigger);
  expect(seed).toHaveBeenCalledWith({
    runId: 'run-1', device: { id: 'device-1', orgId: 'device-org' },
    actions: [{ actionIndex: 0, actionType: 'execute_command' }], trigger: expected,
  });
});
