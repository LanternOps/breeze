import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
  },
}));

vi.mock('../../../db', () => ({
  db: mockDb,
}));

vi.mock('../../../db/schema', () => ({
  scriptExecutions: {
    monitorId: 'scriptExecutions.monitorId',
    deviceId: 'scriptExecutions.deviceId',
    status: 'scriptExecutions.status',
    exitCode: 'scriptExecutions.exitCode',
    stdout: 'scriptExecutions.stdout',
    completedAt: 'scriptExecutions.completedAt',
    createdAt: 'scriptExecutions.createdAt',
  },
}));

import { scriptMonitorHandler, type ScriptMonitorCondition } from './scriptMonitor';
import { scriptKind } from '../../monitors/kinds/script';

const DEVICE_ID = 'device-1';
const MONITOR_ID = 'monitor-1';

// Drives db.select({...}).from(...).where(...).orderBy(...).limit(...) to
// resolve with `rows` — the handler's one query shape.
function setRows(rows: Array<Record<string, unknown>>) {
  mockDb.select.mockReturnValue({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  });
}

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    status: 'completed',
    exitCode: 0,
    stdout: '',
    completedAt: new Date('2026-09-13T00:00:00.000Z'),
    createdAt: new Date('2026-09-13T00:00:00.000Z'),
    ...overrides,
  };
}

function condition(overrides: Partial<ScriptMonitorCondition> = {}): ScriptMonitorCondition {
  return {
    type: 'script_monitor',
    monitorId: MONITOR_ID,
    intervalMinutes: 60,
    breachOnNonZeroExit: true,
    ...overrides,
  };
}

describe('scriptMonitorHandler', () => {
  beforeEach(() => {
    mockDb.select.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marker state "breach" passes, with detail as the description', async () => {
    setRows([
      makeExecution({
        stdout: '::breeze:monitor:: {"state":"breach","detail":"disk check failed"}',
      }),
    ]);

    const result = await scriptMonitorHandler.evaluate(condition(), DEVICE_ID);

    expect(result.passed).toBe(true);
    expect(result.description).toBe('disk check failed');
  });

  it('marker state "ok" does not pass', async () => {
    setRows([
      makeExecution({
        stdout: '::breeze:monitor:: {"state":"ok","detail":"all clear"}',
      }),
    ]);

    const result = await scriptMonitorHandler.evaluate(condition(), DEVICE_ID);

    expect(result.passed).toBe(false);
    expect(result.description).toBe('all clear');
  });

  it('uses the LAST marker line when stdout has more than one', async () => {
    setRows([
      makeExecution({
        stdout: [
          '::breeze:monitor:: {"state":"breach","detail":"early, stale line"}',
          'some other diagnostic output',
          '::breeze:monitor:: {"state":"ok","detail":"final verdict"}',
        ].join('\n'),
      }),
    ]);

    const result = await scriptMonitorHandler.evaluate(condition(), DEVICE_ID);

    expect(result.passed).toBe(false);
    expect(result.description).toBe('final verdict');
  });

  it('no marker + breachOnNonZeroExit true: non-zero exit code breaches', async () => {
    setRows([makeExecution({ stdout: 'plain output, no marker', exitCode: 1 })]);

    const result = await scriptMonitorHandler.evaluate(condition({ breachOnNonZeroExit: true }), DEVICE_ID);

    expect(result.passed).toBe(true);
  });

  it('no marker + breachOnNonZeroExit true: zero exit code does not breach', async () => {
    setRows([makeExecution({ stdout: 'plain output, no marker', exitCode: 0 })]);

    const result = await scriptMonitorHandler.evaluate(condition({ breachOnNonZeroExit: true }), DEVICE_ID);

    expect(result.passed).toBe(false);
  });

  it('no marker + breachOnNonZeroExit false: never breaches regardless of exit code', async () => {
    setRows([makeExecution({ stdout: 'plain output, no marker', exitCode: 1 })]);

    const result = await scriptMonitorHandler.evaluate(condition({ breachOnNonZeroExit: false }), DEVICE_ID);

    expect(result.passed).toBe(false);
  });

  it('malformed marker + exitCode 0: falls back to the exit-code rule (no breach), never throws', async () => {
    setRows([
      makeExecution({ stdout: '::breeze:monitor:: {not valid json', exitCode: 0 }),
    ]);

    const result = await scriptMonitorHandler.evaluate(condition({ breachOnNonZeroExit: true }), DEVICE_ID);

    expect(result.passed).toBe(false);
  });

  it('malformed marker + exitCode 1: falls back to the exit-code rule (breach), proving fallback not throw', async () => {
    setRows([
      makeExecution({ stdout: '::breeze:monitor:: {not valid json', exitCode: 1 }),
    ]);

    const result = await scriptMonitorHandler.evaluate(condition({ breachOnNonZeroExit: true }), DEVICE_ID);

    expect(result.passed).toBe(true);
  });

  it('status "timeout" does not breach, per spec', async () => {
    setRows([makeExecution({ status: 'timeout', exitCode: null, stdout: '' })]);

    const result = await scriptMonitorHandler.evaluate(condition(), DEVICE_ID);

    expect(result.passed).toBe(false);
    expect(result.description).toMatch(/did not complete/i);
  });

  it('status "failed" does not breach', async () => {
    setRows([makeExecution({ status: 'failed', exitCode: null, stdout: '' })]);

    const result = await scriptMonitorHandler.evaluate(condition(), DEVICE_ID);

    expect(result.passed).toBe(false);
    expect(result.description).toMatch(/did not complete/i);
  });

  it('no row at all: no recent probe result, not a breach', async () => {
    setRows([]);

    const result = await scriptMonitorHandler.evaluate(condition(), DEVICE_ID);

    expect(result.passed).toBe(false);
    expect(result.description).toBe('No recent probe result');
  });

  it('stale probe (older than 3x intervalMinutes) never latches a breach', async () => {
    // intervalMinutes: 60 -> stale threshold is 180 minutes. 200 minutes old.
    setRows([
      makeExecution({
        stdout: '::breeze:monitor:: {"state":"breach","detail":"would have breached"}',
        completedAt: new Date('2026-09-12T20:40:00.000Z'), // 200 min before system time
      }),
    ]);

    const result = await scriptMonitorHandler.evaluate(condition({ intervalMinutes: 60 }), DEVICE_ID);

    expect(result.passed).toBe(false);
    expect(result.description).toBe('No recent probe result');
  });

  it('a fresh probe within the staleness window still evaluates normally', async () => {
    // 170 minutes old, under the 180-minute (3x60) threshold.
    setRows([
      makeExecution({
        stdout: '::breeze:monitor:: {"state":"breach","detail":"still fresh enough"}',
        completedAt: new Date('2026-09-12T21:10:00.000Z'),
      }),
    ]);

    const result = await scriptMonitorHandler.evaluate(condition({ intervalMinutes: 60 }), DEVICE_ID);

    expect(result.passed).toBe(true);
    expect(result.description).toBe('still fresh enough');
  });

  describe('validate', () => {
    it('rejects a missing monitorId', () => {
      const errors = scriptMonitorHandler.validate({ intervalMinutes: 60 }, 'c');
      expect(errors).toContain('c.monitorId: Must be a non-empty string');
    });

    it('rejects a non-positive intervalMinutes', () => {
      const errors = scriptMonitorHandler.validate({ monitorId: MONITOR_ID, intervalMinutes: 0 }, 'c');
      expect(errors).toContain('c.intervalMinutes: Must be a positive number');
    });

    it('accepts a valid condition', () => {
      const errors = scriptMonitorHandler.validate({ monitorId: MONITOR_ID, intervalMinutes: 60 }, 'c');
      expect(errors).toEqual([]);
    });
  });
});

describe('scriptKind (monitors/kinds/script.ts)', () => {
  it('does not allow scriptId to be overridden by a config-policy attachment', () => {
    expect(scriptKind.overridableKeys).not.toContain('scriptId');
  });

  it('allows intervalMinutes and timeoutSeconds to be overridden', () => {
    expect(scriptKind.overridableKeys).toEqual(
      expect.arrayContaining(['intervalMinutes', 'timeoutSeconds']),
    );
  });

  it('is not agent-delivered — the server dispatches the script', () => {
    expect(scriptKind.agentDelivered).toBe(false);
  });

  it('compiles to a script_monitor condition carrying the monitor definition id from ctx', () => {
    const compiled = scriptKind.toAlertCondition(
      {
        scriptId: 'script-1',
        intervalMinutes: 45,
        timeoutSeconds: 120,
        breachOnNonZeroExit: false,
      },
      { monitorId: MONITOR_ID },
    );

    expect(compiled).toEqual({
      type: 'script_monitor',
      monitorId: MONITOR_ID,
      intervalMinutes: 45,
      breachOnNonZeroExit: false,
    });
  });
});
