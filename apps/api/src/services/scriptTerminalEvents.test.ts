import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deferred, publishEventMock } = vi.hoisted(() => ({
  deferred: [] as Array<{ label: string; run: () => unknown }>,
  publishEventMock: vi.fn(async () => 'evt-1'),
}));

vi.mock('../db', () => ({
  runAfterDbContextCommit: (label: string, run: () => unknown) => { deferred.push({ label, run }); },
}));
vi.mock('./eventBus', () => ({
  publishEvent: publishEventMock,
  EVENT_TYPES: { SCRIPT_COMPLETED: 'script.completed', SCRIPT_FAILED: 'script.failed' },
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { emitScriptTerminalEvent, scriptEventTypeForStatus } from './scriptTerminalEvents';

const base = {
  executionId: 'exec-1',
  orgId: 'org-1',
  deviceId: 'dev-1',
  scriptId: 'script-1',
  triggerType: 'automation',
  automationRunId: 'run-1',
  exitCode: 0,
};

describe('scriptTerminalEvents (#7277)', () => {
  beforeEach(() => {
    deferred.length = 0;
    publishEventMock.mockClear();
  });

  it('maps statuses: completed→completed, failed/timeout→failed, cancelled→none', () => {
    expect(scriptEventTypeForStatus('completed')).toBe('script.completed');
    expect(scriptEventTypeForStatus('failed')).toBe('script.failed');
    expect(scriptEventTypeForStatus('timeout')).toBe('script.failed');
    expect(scriptEventTypeForStatus('cancelled')).toBeNull();
  });

  it('does not publish inside the transaction — only when the deferred commit hook runs', async () => {
    emitScriptTerminalEvent({ ...base, status: 'completed' });
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await deferred[0]!.run();
    expect(publishEventMock).toHaveBeenCalledWith(
      'script.completed',
      'org-1',
      {
        executionId: 'exec-1',
        scriptId: 'script-1',
        deviceId: 'dev-1',
        status: 'completed',
        exitCode: 0,
        triggerType: 'automation',
        automationRunId: 'run-1',
      },
      'script-execution',
    );
  });

  it('emits script.failed for a timeout and never carries output', async () => {
    emitScriptTerminalEvent({ ...base, status: 'timeout', exitCode: null });
    await deferred[0]!.run();
    const [type, , payload] = publishEventMock.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(type).toBe('script.failed');
    expect(payload).not.toHaveProperty('stdout');
    expect(payload).not.toHaveProperty('stderr');
  });

  it('queues nothing for a cancelled execution', () => {
    emitScriptTerminalEvent({ ...base, status: 'cancelled' });
    expect(deferred).toHaveLength(0);
  });

  it('swallows a publish failure (ingestion must not fail on an event)', async () => {
    publishEventMock.mockRejectedValueOnce(new Error('redis down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    emitScriptTerminalEvent({ ...base, status: 'failed' });
    await expect(deferred[0]!.run()).resolves.toBeUndefined();
  });
});
