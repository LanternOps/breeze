import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./commandQueue', () => ({
  executeCommandWithSystemPrecheck: vi.fn().mockResolvedValue({ status: 'completed' }),
  executeCommand: vi.fn().mockResolvedValue({ status: 'completed' }),
  queueCommandForExecution: vi.fn().mockResolvedValue({ command: { id: 'cmd-1' } }),
  queueCommand: vi.fn().mockResolvedValue({ id: 'cmd-1' }),
  insertQueuedCommandInTransaction: vi.fn().mockResolvedValue({ id: 'cmd-1' }),
}));
vi.mock('./dispatchDeviceCommand', () => ({
  dispatchDeviceCommand: vi.fn().mockResolvedValue({ ok: true, command: { id: 'cmd-1' } }),
}));
vi.mock('./scriptDispatch', () => ({
  dispatchScriptToDevice: vi.fn().mockResolvedValue({ ok: true, commandId: 'cmd-1' }),
}));

import { executeCommandWithSystemPrecheck, executeCommand, queueCommandForExecution, queueCommand, insertQueuedCommandInTransaction } from './commandQueue';
import { dispatchDeviceCommand } from './dispatchDeviceCommand';
import { dispatchScriptToDevice } from './scriptDispatch';
import {
  aiExecuteCommandWithSystemPrecheck,
  aiExecuteCommand,
  aiQueueCommandForExecution,
  aiQueueCommand,
  aiDispatchDeviceCommand,
  aiDispatchScriptToDevice,
  aiInsertQueuedCommandInTransaction,
  requireAiOrigin,
  MissingAiOriginError,
} from './aiDispatch';

const AGENT_ORIGIN = { kind: 'ai_agent' as const, agentRunId: 'run-1' };
const withOrigin = { aiOrigin: AGENT_ORIGIN } as never;
const withoutOrigin = {} as never;

beforeEach(() => vi.clearAllMocks());

describe('aiDispatch adapter (#5022 W01)', () => {
  it('forwards the auth context origin into the dispatch options', async () => {
    await aiExecuteCommand(withOrigin, 'execute_command', 'dev-1', 'run_shell', {});

    expect(executeCommand).toHaveBeenCalledWith(
      'dev-1',
      'run_shell',
      {},
      expect.objectContaining({ aiOrigin: AGENT_ORIGIN }),
    );
  });

  it('binds context-free cleanup dispatch to its org and preserves AI origin', async () => {
    await aiExecuteCommandWithSystemPrecheck(withOrigin, 'disk_cleanup', 'dev-1', 'file_delete', { cleanupRunId: 'run-1' }, { expectedOrgId: 'org-1', userId: 'user-1', timeoutMs: 30000 });
    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledWith('dev-1', 'file_delete', { cleanupRunId: 'run-1' }, { expectedOrgId: 'org-1', userId: 'user-1', timeoutMs: 30000, aiOrigin: AGENT_ORIGIN });
    expect(executeCommand).not.toHaveBeenCalled();
    await expect(aiExecuteCommandWithSystemPrecheck(withoutOrigin, 'disk_cleanup', 'dev-1', 'file_delete', {}, { expectedOrgId: 'org-1' })).rejects.toBeInstanceOf(MissingAiOriginError);
    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledTimes(1);
  });

  it('throws, naming the tool, when the AuthContext carries no origin', async () => {
    await expect(
      aiExecuteCommand(withoutOrigin, 'execute_command', 'dev-1', 'run_shell', {}),
    ).rejects.toBeInstanceOf(MissingAiOriginError);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('fails closed: it never silently dispatches an unattributed command', () => {
    expect.assertions(1);
    try {
      requireAiOrigin(withoutOrigin, 'manage_services');
    } catch (e) {
      expect((e as Error).message).toContain('manage_services');
    }
  });

  it('forwards the origin through every one of the six wrappers', async () => {
    await aiQueueCommandForExecution(withOrigin, 'manage_services', 'dev-1', 'restart_service', {});
    expect(queueCommandForExecution).toHaveBeenCalledWith(
      'dev-1',
      'restart_service',
      {},
      expect.objectContaining({ aiOrigin: AGENT_ORIGIN }),
    );

    await aiQueueCommand(withOrigin, 'manage_alerts', 'dev-1', 'list_processes', {}, 'user-1');
    expect(queueCommand).toHaveBeenCalledWith(
      'dev-1',
      'list_processes',
      {},
      'user-1',
      expect.objectContaining({ aiOrigin: AGENT_ORIGIN }),
    );

    await aiDispatchDeviceCommand(withOrigin, 'manage_processes', { deviceId: 'dev-1', type: 'kill_process' });
    expect(dispatchDeviceCommand).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'dev-1', aiOrigin: AGENT_ORIGIN }),
    );

    await aiDispatchScriptToDevice(withOrigin, 'run_script', { device: { id: 'dev-1' } } as never);
    expect(dispatchScriptToDevice).toHaveBeenCalledWith(
      expect.objectContaining({ aiOrigin: AGENT_ORIGIN }),
    );

    const tx = {} as never;
    await aiInsertQueuedCommandInTransaction(AGENT_ORIGIN, tx, {
      id: 'cmd-1',
      deviceId: 'dev-1',
      type: 'peripheral_policy_sync_v2' as never,
      payload: {},
      createdBy: null,
    });
    expect(insertQueuedCommandInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ aiOrigin: AGENT_ORIGIN }),
    );
  });

  it('rejects each wrapper when the origin is absent, before any dispatch happens', async () => {
    await expect(
      aiQueueCommandForExecution(withoutOrigin, 'manage_services', 'dev-1', 'restart_service', {}),
    ).rejects.toBeInstanceOf(MissingAiOriginError);
    await expect(
      aiQueueCommand(withoutOrigin, 'manage_alerts', 'dev-1', 'list_processes', {}),
    ).rejects.toBeInstanceOf(MissingAiOriginError);
    await expect(
      aiDispatchDeviceCommand(withoutOrigin, 'manage_processes', { deviceId: 'dev-1', type: 'kill_process' }),
    ).rejects.toBeInstanceOf(MissingAiOriginError);
    await expect(
      aiDispatchScriptToDevice(withoutOrigin, 'run_script', { device: { id: 'dev-1' } } as never),
    ).rejects.toBeInstanceOf(MissingAiOriginError);

    expect(queueCommandForExecution).not.toHaveBeenCalled();
    expect(queueCommand).not.toHaveBeenCalled();
    expect(dispatchDeviceCommand).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });
});
