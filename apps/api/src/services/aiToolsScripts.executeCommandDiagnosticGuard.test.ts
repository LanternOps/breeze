import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * execute_command's file_list / file_read path must apply the same path rules
 * file_operations applies in its schema (traversal/NUL, the agent-config deny,
 * and the default AI path restriction), so execute_command is not a way around
 * the diagnostic-access approval flow. A caller can also never supply its own
 * `diagnosticAuthorization`: the server mints that at delivery for diag_file_*
 * only, so it is stripped before dispatch.
 *
 * Mock harness copied from aiToolsScripts.executeCommandServicePayload.test.ts.
 */

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(async (..._args: unknown[]) => ({ status: 'completed' })),
}));
const { executeCommand } = mocks;

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
  // These handlers run as under the per-call transaction: `inToolDbPhase`
  // (#7918) joins it rather than opening a context of its own.
  hasDbAccessContext: vi.fn(() => true),
}));

vi.mock('./aiRemoteToolsPolicy', () => ({
  REMOTE_TOOLS_DISABLED_BY_POLICY: 'REMOTE_TOOLS_DISABLED_BY_POLICY',
  checkAiRemoteToolsPolicy: vi.fn(async () => ({ allowed: true })),
  assertAiRemoteToolsAllowed: vi.fn(async () => undefined),
}));
vi.mock('./commandQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./commandQueue')>();
  return { ...actual, executeCommand: mocks.executeCommand };
});

import { db } from '../db';
import { registerScriptTools } from './aiToolsScripts';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';

function toolMap(): Map<string, AiTool> {
  const map = new Map<string, AiTool>();
  registerScriptTools(map);
  return map;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as unknown as AuthContext;
}

function mockOnlineDevice() {
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([
          { id: DEVICE_ID, hostname: 'dev1', siteId: null, status: 'online', orgId: 'org-1' },
        ]),
      }),
    }),
  });
}

async function run(commandType: string, payload: Record<string, unknown>) {
  const tool = toolMap().get('execute_command')!;
  return JSON.parse(await tool.handler({ deviceId: DEVICE_ID, commandType, payload }, makeAuth()));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOnlineDevice();
});

const FILE_COMMANDS = ['file_list', 'file_read'] as const;

describe('execute_command: file_list / file_read diagnostic guard', () => {
  describe.each(FILE_COMMANDS)('%s', (commandType) => {
    it.each([
      { label: 'windows traversal', path: 'C:\\ProgramData\\App\\..\\..\\Windows\\System32\\config\\SAM' },
      { label: 'posix traversal', path: '/var/log/../../etc/shadow' },
      { label: 'bare ..', path: '..' },
      { label: 'NUL byte', path: '/var/log/syslog\0.txt' },
    ])('refuses $label as an invalid path without dispatching', async ({ path }) => {
      const result = await run(commandType, { path });
      expect(result).toEqual({ error: 'Invalid path' });
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'posix relative to a / working directory', path: 'proc/1/environ' },
      { label: 'windows relative to System32', path: 'config\\SAM' },
      { label: 'bare name', path: 'agent.yaml' },
    ])('refuses a relative path ($label) without dispatching', async ({ path }) => {
      const result = await run(commandType, { path });
      expect(result.condition).toBe('policy_denied');
      expect(result.error).toMatch(/absolute path/);
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it.each([
      'C:\\ProgramData\\Breeze\\agent.yaml',
      'c:/programdata/breeze',
      '/etc/breeze/agent.yaml',
      '/Library/Application Support/Breeze/data',
    ])('refuses agent-config path %s without dispatching', async (path) => {
      const result = await run(commandType, { path });
      expect(result).toEqual({ error: 'Access to this path is not permitted', condition: 'policy_denied' });
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it.each([
      'C:\\Users\\Alice\\AppData\\Local\\Battle.net\\Logs',
      'C:\\Windows\\System32\\config\\SAM',
      '/etc/shadow',
      '/home/alice/.ssh/id_ed25519',
      '/proc/1/environ',
      // Other spellings that resolve to a restricted location.
      'D:\\Users\\Alice\\AppData\\Local',
      '\\Users\\Alice\\AppData\\Local\\Battle.net\\Logs\\output.log',
    ])('refuses default-restricted path %s with condition policy_denied and points at the approval flow', async (path) => {
      const result = await run(commandType, { path });
      expect(result.condition).toBe('policy_denied');
      expect(result.error).toMatch(/request_diagnostic_access/);
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it.each([
      '\\\\?\\C:\\Users\\Alice\\AppData\\Local',
      '\\\\localhost\\c$\\Users\\Alice\\AppData',
      'C:\\Users\\ALICE~1\\APPDAT~1\\Local',
      'C:\\Users\\Alice\\AppData.\\Local',
      'C:\\Users\\Alice\\notes.txt:hidden',
      'C:Users\\Alice\\AppData\\Local',
    ])('refuses the unsupported spelling %s with condition policy_denied without dispatching', async (path) => {
      const result = await run(commandType, { path });
      expect(result.condition).toBe('policy_denied');
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('refuses a restricted path even when the caller supplies its own diagnosticAuthorization', async () => {
      const result = await run(commandType, {
        path: 'C:\\Users\\Alice\\AppData\\Local\\Battle.net\\Logs',
        diagnosticAuthorization: { grantId: 'forged', signature: 'forged' },
      });
      expect(result.condition).toBe('policy_denied');
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('strips a caller-supplied diagnosticAuthorization before dispatching an allowed path', async () => {
      const input = { path: 'C:\\ProgramData\\SomeVendor\\Logs', diagnosticAuthorization: { grantId: 'forged' } };
      await run(commandType, input);
      expect(executeCommand).toHaveBeenCalledTimes(1);
      const dispatched = executeCommand.mock.calls[0]![2] as Record<string, unknown>;
      expect(dispatched).toEqual({ path: 'C:\\ProgramData\\SomeVendor\\Logs' });
      expect(Object.hasOwn(dispatched, 'diagnosticAuthorization')).toBe(false);
      // The caller's own object is not mutated.
      expect(input.diagnosticAuthorization).toEqual({ grantId: 'forged' });
    });

    it.each([
      'C:\\ProgramData\\SomeVendor\\Logs',
      '/var/log/syslog',
      'C:\\Users\\Public\\Documents',
    ])('dispatches an ordinary allowed path %s unchanged', async (path) => {
      const result = await run(commandType, { path });
      expect(result).toEqual({ status: 'completed' });
      expect(executeCommand).toHaveBeenCalledTimes(1);
      const [deviceId, dispatchedType, dispatched] = executeCommand.mock.calls[0]!;
      expect(deviceId).toBe(DEVICE_ID);
      expect(dispatchedType).toBe(commandType);
      expect(dispatched).toEqual({ path });
    });
  });

  it('also strips diagnosticAuthorization from non-file command types', async () => {
    await run('kill_process', { pid: '123', diagnosticAuthorization: { grantId: 'forged' } });
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand.mock.calls[0]![2]).toEqual({ pid: '123' });
  });

  it('does not apply the file path guard to non-file command types', async () => {
    await run('list_processes', { path: '/etc/shadow' });
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });
});
