import { describe, it, expect, vi, beforeEach } from 'vitest';

const applyMock = vi.fn();
vi.mock('./customFields/scriptWriteBack', () => ({
  applyScriptCustomFieldWrites: (...args: unknown[]) => applyMock(...args),
}));

// Minimal Drizzle capture: we only assert what reaches scriptExecutions.set().
const setCalls: Array<Record<string, unknown>> = [];
vi.mock('../db', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setCalls.push(values);
        return { where: () => ({ returning: async () => [{ id: 'exec-1', scriptId: 'script-1' }] }) };
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { commandResultHandlers } from './commandResultHandlers';

const EXEC_ID = '55555555-5555-4555-8555-555555555555';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

const call = (stdout: string | undefined, resultEnvelope: unknown = undefined) =>
  commandResultHandlers.script!({
    agentId: '33333333-3333-4333-8333-333333333333',
    command: { id: 'cmd-1', payload: { executionId: EXEC_ID }, type: 'script' } as never,
    commandId: 'cmd-1',
    result: { status: 'completed', exitCode: 0, stdout, result: resultEnvelope } as never,
    resolvedDeviceId: DEVICE_ID,
    stdout,
  });

beforeEach(() => {
  vi.clearAllMocks();
  setCalls.length = 0;
});

describe('handleScriptResult custom-field write-back', () => {
  it('passes stdout and the result envelope to the write-back', async () => {
    applyMock.mockResolvedValue(null);
    await call('::breeze:custom-fields:: {"a":1}', {
      customFieldWrites: { schemaVersion: 1, fields: {} },
    });
    expect(applyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: DEVICE_ID,
        commandId: 'cmd-1',
        stdout: '::breeze:custom-fields:: {"a":1}',
        resultEnvelope: { customFieldWrites: { schemaVersion: 1, fields: {} } },
      }),
    );
  });

  it('stores the summary on the script_executions row', async () => {
    applyMock.mockResolvedValue({ applied: ['a'], rejected: [] });
    await call('::breeze:custom-fields:: {"a":1}');
    expect(setCalls[0]?.customFieldResult).toEqual({ applied: ['a'], rejected: [] });
  });

  it('leaves customFieldResult null when the result carried no markers', async () => {
    applyMock.mockResolvedValue(null);
    await call('plain output');
    expect(setCalls[0]?.customFieldResult).toBeNull();
  });

  it('still persists stdout when the write-back throws', async () => {
    applyMock.mockRejectedValue(new Error('boom'));
    await call('::breeze:custom-fields:: {"a":1}');
    expect(setCalls[0]?.stdout).toContain('::breeze:custom-fields::');
    expect(setCalls[0]?.customFieldResult).toBeNull();
  });

  it('runs the write-back for a non-zero exit code', async () => {
    applyMock.mockResolvedValue({ applied: ['a'], rejected: [] });
    await commandResultHandlers.script!({
      agentId: 'agent-1',
      command: { id: 'cmd-2', payload: { executionId: EXEC_ID }, type: 'script' } as never,
      commandId: 'cmd-2',
      result: { status: 'completed', exitCode: 3, stdout: '::breeze:custom-fields:: {"a":1}' } as never,
      resolvedDeviceId: DEVICE_ID,
      stdout: '::breeze:custom-fields:: {"a":1}',
    });
    expect(applyMock).toHaveBeenCalled();
  });

  it('runs the write-back even when the command carries NO executionId', async () => {
    // A script dispatched without an executionId still ran on a device and its
    // markers are still valid; only the summary persistence needs a row.
    applyMock.mockResolvedValue({ applied: ['a'], rejected: [] });
    await commandResultHandlers.script!({
      agentId: 'agent-1',
      command: { id: 'cmd-3', payload: {}, type: 'script' } as never,
      commandId: 'cmd-3',
      result: { status: 'completed', exitCode: 0, stdout: '::breeze:custom-fields:: {"a":1}' } as never,
      resolvedDeviceId: DEVICE_ID,
      stdout: '::breeze:custom-fields:: {"a":1}',
    });
    expect(applyMock).toHaveBeenCalled();
    expect(setCalls).toHaveLength(0);
  });

  it('runs the write-back even when the executionId is a non-uuid (the #3162 guard path)', async () => {
    applyMock.mockResolvedValue({ applied: ['a'], rejected: [] });
    await commandResultHandlers.script!({
      agentId: 'agent-1',
      command: { id: 'cmd-4', payload: { executionId: 'not-a-uuid' }, type: 'script' } as never,
      commandId: 'cmd-4',
      result: { status: 'completed', exitCode: 0, stdout: '::breeze:custom-fields:: {"a":1}' } as never,
      resolvedDeviceId: DEVICE_ID,
      stdout: '::breeze:custom-fields:: {"a":1}',
    });
    expect(applyMock).toHaveBeenCalled();
  });
});
