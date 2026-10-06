import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./commandQueue', () => ({
  executeCommandWithSystemPrecheck: vi.fn().mockResolvedValue({ status: 'completed' }),
  executeCommandWithCallerPrecheck: vi.fn().mockResolvedValue({ status: 'completed' }),
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
vi.mock('./remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('../db', () => ({
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'organization' })),
  hasDbAccessContext: vi.fn(() => true),
  withSystemDbAccessContext: vi.fn((fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { executeCommandWithSystemPrecheck, executeCommandWithCallerPrecheck, executeCommand, queueCommandForExecution, queueCommand, insertQueuedCommandInTransaction } from './commandQueue';
import { dispatchDeviceCommand } from './dispatchDeviceCommand';
import { dispatchScriptToDevice } from './scriptDispatch';
import { checkRemoteAccess } from './remoteAccessPolicy';
import { getCurrentDbAccessContext, hasDbAccessContext, withSystemDbAccessContext } from '../db';
import { dbAccessContextFromAuth } from '../middleware/auth';
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
import {
  REMOTE_TOOLS_COMMAND_TYPES,
  REMOTE_TOOLS_DISABLED_BY_POLICY,
  RemoteToolsDisabledByPolicyError,
} from './aiRemoteToolsPolicy';

const AGENT_ORIGIN = { kind: 'ai_agent' as const, agentRunId: 'run-1' };
const withOrigin = { aiOrigin: AGENT_ORIGIN } as never;
const withoutOrigin = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRemoteAccess).mockResolvedValue({ allowed: true });
  vi.mocked(getCurrentDbAccessContext).mockReturnValue({ scope: 'organization' } as never);
  vi.mocked(hasDbAccessContext).mockReturnValue(true);
});

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

  it('from a self-managed handler (no ambient context) prechecks under the CALLER’s own context (#7918)', async () => {
    vi.mocked(hasDbAccessContext).mockReturnValue(false);
    const auth = {
      aiOrigin: AGENT_ORIGIN, scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'],
      partnerId: 'partner-1', user: { id: 'user-1' }, principal: { kind: 'user_session' },
    } as never;

    await aiExecuteCommand(auth, 'take_screenshot', 'dev-1', 'take_screenshot', {}, { timeoutMs: 120_000 });

    expect(executeCommand).not.toHaveBeenCalled();
    expect(executeCommandWithCallerPrecheck).toHaveBeenCalledWith(
      'dev-1', 'take_screenshot', {}, dbAccessContextFromAuth(auth),
      expect.objectContaining({ aiOrigin: AGENT_ORIGIN, timeoutMs: 120_000 }),
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

// The REST /system-tools routes refuse a device whose
// remote_access policy disables remote tools (routes/systemTools/index.ts). The
// AI dispatch door must refuse the same command types, at every entry point.
describe('aiDispatch enforces the per-device remote-tools policy', () => {
  const DENIED = { allowed: false, reason: 'Remote tools is disabled by policy "Locked"' };
  const deny = () => vi.mocked(checkRemoteAccess).mockResolvedValue(DENIED);

  it('covers the process, service, task, registry, file, event-log and startup-item families', () => {
    for (const t of [
      'list_processes', 'kill_process', 'list_services', 'restart_service', 'tasks_list', 'task_run',
      'registry_get', 'registry_set', 'file_list', 'file_read', 'file_write', 'file_delete', 'file_mkdir',
      'event_logs_query', 'manage_startup_item',
    ]) {
      expect(REMOTE_TOOLS_COMMAND_TYPES.has(t), t).toBe(true);
    }
    expect(REMOTE_TOOLS_COMMAND_TYPES.has('update_agent')).toBe(false);
    expect(REMOTE_TOOLS_COMMAND_TYPES.has('script')).toBe(false);
  });

  it.each([...REMOTE_TOOLS_COMMAND_TYPES])('aiExecuteCommand refuses %s on a policy-denied device and never dispatches', async (type) => {
    deny();
    const result = await aiExecuteCommand(withOrigin, 'execute_command', 'dev-1', type, {});
    expect(result.status).toBe('failed');
    expect(result.error).toContain(REMOTE_TOOLS_DISABLED_BY_POLICY);
    expect(result.error).toContain('Locked');
    expect(checkRemoteAccess).toHaveBeenCalledWith('dev-1', 'remoteTools');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('refuses at EVERY dispatch entry point, before any dispatch happens', async () => {
    deny();

    const sys = await aiExecuteCommandWithSystemPrecheck(withOrigin, 'disk_cleanup', 'dev-1', 'file_delete', {}, { expectedOrgId: 'org-1' });
    expect(sys.status).toBe('failed');
    expect(sys.error).toContain(REMOTE_TOOLS_DISABLED_BY_POLICY);

    const queued = await aiQueueCommandForExecution(withOrigin, 'manage_services', 'dev-1', 'restart_service', {});
    expect(queued.command).toBeUndefined();
    expect(queued.error).toContain(REMOTE_TOOLS_DISABLED_BY_POLICY);

    await expect(aiQueueCommand(withOrigin, 'manage_processes', 'dev-1', 'kill_process', {}))
      .rejects.toBeInstanceOf(RemoteToolsDisabledByPolicyError);

    const dispatched = await aiDispatchDeviceCommand(withOrigin, 'manage_registry', { deviceId: 'dev-1', type: 'registry_set' });
    expect(dispatched.ok).toBe(false);
    expect(dispatched.ok === false && dispatched.error).toContain(REMOTE_TOOLS_DISABLED_BY_POLICY);

    await expect(aiInsertQueuedCommandInTransaction(AGENT_ORIGIN, {} as never, {
      id: 'cmd-1', deviceId: 'dev-1', type: 'file_write' as never, payload: {}, createdBy: null,
    })).rejects.toMatchObject({ code: REMOTE_TOOLS_DISABLED_BY_POLICY });

    expect(executeCommandWithSystemPrecheck).not.toHaveBeenCalled();
    expect(queueCommandForExecution).not.toHaveBeenCalled();
    expect(queueCommand).not.toHaveBeenCalled();
    expect(dispatchDeviceCommand).not.toHaveBeenCalled();
    expect(insertQueuedCommandInTransaction).not.toHaveBeenCalled();
  });

  it('matches the command type case-insensitively, so a casing variant cannot slip past', async () => {
    deny();
    const result = await aiExecuteCommand(withOrigin, 'execute_command', 'dev-1', 'KILL_PROCESS', {});
    expect(result.error).toContain(REMOTE_TOOLS_DISABLED_BY_POLICY);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the policy lookup itself throws', async () => {
    vi.mocked(checkRemoteAccess).mockRejectedValue(new Error('db down'));
    const result = await aiExecuteCommand(withOrigin, 'manage_services', 'dev-1', 'stop_service', {});
    expect(result.status).toBe('failed');
    expect(result.error).toContain(REMOTE_TOOLS_DISABLED_BY_POLICY);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('dispatches normally when the policy allows remote tools', async () => {
    await aiExecuteCommand(withOrigin, 'manage_services', 'dev-1', 'stop_service', {});
    expect(checkRemoteAccess).toHaveBeenCalledWith('dev-1', 'remoteTools');
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });

  it('leaves non-remote-tools command types (update_agent, script) untouched: no lookup, dispatched', async () => {
    deny();
    await aiExecuteCommand(withOrigin, 'update_agent', 'dev-1', 'update_agent', {});
    await aiQueueCommandForExecution(withOrigin, 'run_script', 'dev-1', 'script', {});
    expect(checkRemoteAccess).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(queueCommandForExecution).toHaveBeenCalledTimes(1);
  });

  it('with NO ambient DB context (the context-free lane) resolves the policy under a short system context', async () => {
    vi.mocked(getCurrentDbAccessContext).mockReturnValue(null as never);
    deny();
    const result = await aiExecuteCommandWithSystemPrecheck(withOrigin, 'disk_cleanup', 'dev-1', 'file_delete', {}, { expectedOrgId: 'org-1' });
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    expect(result.error).toContain(REMOTE_TOOLS_DISABLED_BY_POLICY);
  });

  it('with an ambient context JOINS it rather than opening a second connection', async () => {
    await aiExecuteCommand(withOrigin, 'manage_services', 'dev-1', 'stop_service', {});
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});
