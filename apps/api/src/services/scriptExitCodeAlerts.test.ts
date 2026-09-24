import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every db.select() chain ends in .limit(); each call consumes the next queued
// row set, in the order the evaluator issues its reads.
const selectResults: unknown[][] = [];
const selectMock = vi.fn(() => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({
      limit: vi.fn(async () => selectResults.shift() ?? []),
    })),
  })),
}));
const withDbTransactionMock = vi.fn(async (fn: () => Promise<unknown>) => fn());
const createSourcedAlertMock = vi.fn();
const resolveAlertMock = vi.fn();
const captureExceptionMock = vi.fn();

vi.mock('../db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...(args as [])) },
  withDbTransaction: (fn: () => Promise<unknown>) => withDbTransactionMock(fn),
}));

vi.mock('../db/schema', () => ({
  alerts: {
    id: 'alerts.id',
    deviceId: 'alerts.device_id',
    configItemName: 'alerts.config_item_name',
    status: 'alerts.status',
    suppressedUntil: 'alerts.suppressed_until',
    context: 'alerts.context',
  },
  devices: { id: 'devices.id', hostname: 'devices.hostname', displayName: 'devices.display_name' },
  scripts: { id: 'scripts.id', name: 'scripts.name', exitCodeSeverityMapping: 'scripts.exit_code_severity_mapping' },
}));

vi.mock('./alertService', () => ({
  createSourcedAlert: (...args: unknown[]) => createSourcedAlertMock(...args),
  resolveAlert: (...args: unknown[]) => resolveAlertMock(...args),
}));

vi.mock('./sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

import { evaluateScriptExitCodeAlert, type ScriptExitCodeAlertInput } from './scriptExitCodeAlerts';

const SCRIPT_ID = '44444444-4444-4444-8444-444444444444';
const EXEC_ORG = '55555555-5555-4555-8555-555555555555';
const DEVICE_ID = '66666666-6666-4666-8666-666666666666';
const EXECUTION_ID = '77777777-7777-4777-8777-777777777777';

function input(overrides: Partial<ScriptExitCodeAlertInput> = {}): ScriptExitCodeAlertInput {
  return {
    executionId: EXECUTION_ID,
    scriptId: SCRIPT_ID,
    orgId: EXEC_ORG,
    deviceId: DEVICE_ID,
    triggerType: 'scheduled',
    exitCode: 3,
    stderr: 'disk check failed: C: at 97%\nsecond line',
    ...overrides,
  };
}

const script = (mapping: unknown) => [{ name: 'Disk check', exitCodeSeverityMapping: mapping }];

describe('evaluateScriptExitCodeAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults.length = 0;
    createSourcedAlertMock.mockResolvedValue('alert-new');
    resolveAlertMock.mockResolvedValue(true);
  });

  it('(a) creates one alert at the mapped severity, in the execution org, for an unattended run', async () => {
    selectResults.push(
      script({ '3': 'high' }),
      [], // no open alert
      [], // no dismissed alert
      [{ hostname: 'ws-01', displayName: 'Front desk' }],
    );

    await evaluateScriptExitCodeAlert(input());

    expect(withDbTransactionMock).toHaveBeenCalledTimes(1);
    expect(createSourcedAlertMock).toHaveBeenCalledTimes(1);
    const params = createSourcedAlertMock.mock.calls[0]![0];
    expect(params).toMatchObject({
      deviceId: DEVICE_ID,
      orgId: EXEC_ORG,
      severity: 'high',
      title: 'Script "Disk check" exited 3: Front desk',
      configItemName: 'script_exit_code',
      publisher: 'route:agentWs:script-result',
      context: {
        source: 'script_exit_code',
        scriptId: SCRIPT_ID,
        executionId: EXECUTION_ID,
        exitCode: 3,
        triggerType: 'scheduled',
      },
    });
    expect(params.message).toContain('exited with code 3');
    expect(params.message).toContain('disk check failed: C: at 97%');
    expect(params.message).not.toContain('second line');
    expect(params.message.length).toBeLessThanOrEqual(300);
    expect(resolveAlertMock).not.toHaveBeenCalled();
  });

  it.each(['automation', 'policy', 'alert'] as const)('also creates for trigger type %s', async (triggerType) => {
    selectResults.push(script({ '3': 'high' }), [], [], [{ hostname: 'ws-01', displayName: null }]);

    await evaluateScriptExitCodeAlert(input({ triggerType }));

    expect(createSourcedAlertMock).toHaveBeenCalledTimes(1);
    expect(createSourcedAlertMock.mock.calls[0]![0].title).toBe('Script "Disk check" exited 3: ws-01');
  });

  it('(b) never creates for a manual run', async () => {
    selectResults.push(script({ '3': 'high' }), [], [], [{ hostname: 'ws-01', displayName: null }]);

    await evaluateScriptExitCodeAlert(input({ triggerType: 'manual' }));

    expect(createSourcedAlertMock).not.toHaveBeenCalled();
  });

  it('(c) never creates for a monitor probe run', async () => {
    selectResults.push(script({ '3': 'high' }), [], [], [{ hostname: 'ws-01', displayName: null }]);

    await evaluateScriptExitCodeAlert(input({ triggerType: 'monitor' }));

    expect(createSourcedAlertMock).not.toHaveBeenCalled();
  });

  it('(d) is opt-in: a NULL mapping raises nothing, even for a non-zero exit', async () => {
    selectResults.push(script(null), [], [], [{ hostname: 'ws-01', displayName: null }]);

    await evaluateScriptExitCodeAlert(input({ exitCode: 1 }));

    expect(createSourcedAlertMock).not.toHaveBeenCalled();
    expect(resolveAlertMock).not.toHaveBeenCalled();
    // Only the script read happened — no alert reads.
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('(e) is opt-in: an empty {} mapping raises nothing', async () => {
    selectResults.push(script({}), [], [], [{ hostname: 'ws-01', displayName: null }]);

    await evaluateScriptExitCodeAlert(input({ exitCode: 1 }));

    expect(createSourcedAlertMock).not.toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('(f) dedupes: an open alert for this script + device means nothing new', async () => {
    selectResults.push(script({ '3': 'high' }), [{ id: 'alert-open' }]);

    await evaluateScriptExitCodeAlert(input());

    expect(createSourcedAlertMock).not.toHaveBeenCalled();
  });

  it('(g) a dismissed alert for this script + device is a durable opt-out', async () => {
    selectResults.push(script({ '3': 'high' }), [], [{ id: 'alert-dismissed' }]);

    await evaluateScriptExitCodeAlert(input());

    expect(createSourcedAlertMock).not.toHaveBeenCalled();
  });

  it('(h) a clean manual re-run resolves the open alert as the system', async () => {
    selectResults.push(script({ '3': 'high' }), [{ id: 'alert-open' }]);

    await evaluateScriptExitCodeAlert(input({ triggerType: 'manual', exitCode: 0, stderr: null }));

    expect(resolveAlertMock).toHaveBeenCalledTimes(1);
    expect(resolveAlertMock.mock.calls[0]![0]).toBe('alert-open');
    expect(typeof resolveAlertMock.mock.calls[0]![1]).toBe('string');
    // No resolvedBy: a system resolution.
    expect(resolveAlertMock.mock.calls[0]![2]).toBeUndefined();
    expect(createSourcedAlertMock).not.toHaveBeenCalled();
  });

  it('a code the mapping sets to null also resolves the open alert', async () => {
    selectResults.push(script({ '3': 'high', '4': null }), [{ id: 'alert-open' }]);

    await evaluateScriptExitCodeAlert(input({ exitCode: 4 }));

    expect(resolveAlertMock).toHaveBeenCalledWith('alert-open', expect.any(String));
    expect(createSourcedAlertMock).not.toHaveBeenCalled();
  });

  it('(i) leaves an indefinitely-suppressed alert alone (the resolvable-set read returns nothing)', async () => {
    // The resolvable-set query excludes suppressed rows with no suppressedUntil,
    // so the DB returns no candidates for a device whose only alert is muted forever.
    selectResults.push(script({ '3': 'high' }), []);

    await evaluateScriptExitCodeAlert(input({ exitCode: 0, stderr: null }));

    expect(resolveAlertMock).not.toHaveBeenCalled();
  });

  it('(j) swallows a createSourcedAlert failure and reports it', async () => {
    selectResults.push(script({ '3': 'high' }), [], [], [{ hostname: 'ws-01', displayName: null }]);
    const boom = new Error('insert failed');
    createSourcedAlertMock.mockRejectedValueOnce(boom);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(evaluateScriptExitCodeAlert(input())).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledWith(
      boom,
      undefined,
      expect.objectContaining({ executionId: EXECUTION_ID, scriptId: SCRIPT_ID }),
    );
    errSpy.mockRestore();
  });

  it('(k) issues no query at all for an execution without a scriptId', async () => {
    await evaluateScriptExitCodeAlert(input({ scriptId: null }));

    expect(selectMock).not.toHaveBeenCalled();
    expect(withDbTransactionMock).not.toHaveBeenCalled();
    expect(createSourcedAlertMock).not.toHaveBeenCalled();
  });

  it('does nothing without a real exit code (timeout / cancelled / failed-to-start)', async () => {
    await evaluateScriptExitCodeAlert(input({ exitCode: null }));

    expect(selectMock).not.toHaveBeenCalled();
    expect(resolveAlertMock).not.toHaveBeenCalled();
  });

  it('does nothing when the script row is not visible, but leaves a warning', async () => {
    selectResults.push([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await evaluateScriptExitCodeAlert(input());

    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(createSourcedAlertMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('script row not visible'),
      expect.objectContaining({ scriptId: SCRIPT_ID, executionId: EXECUTION_ID }),
    );
    warn.mockRestore();
  });

  it('truncates a long stderr line so the message is exactly the cap, ending in an ellipsis', async () => {
    selectResults.push(script({ '3': 'high' }), [], [], [{ hostname: 'ws-01', displayName: null }]);

    await evaluateScriptExitCodeAlert(input({ stderr: 'x'.repeat(1000) }));

    const { message } = createSourcedAlertMock.mock.calls[0]![0];
    expect(message).toHaveLength(300);
    expect(message.endsWith('…')).toBe(true);
    expect(message.startsWith('The scheduled run exited with code 3')).toBe(true);
  });
});
