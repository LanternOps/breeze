import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for the class of bug fixed in D.2/D.3 of the MCP
 * tool-registration-debt payoff: manage_scheduled_tasks and registry_operations
 * were dispatching INVENTED command-type strings (e.g. 'scheduled_tasks_run',
 * 'registry_read_key') that do not exist in commandQueue.ts's CommandTypes —
 * the agent silently rejects/ignores an unrecognized command type, so every
 * call from these tools was a dead end with zero test coverage catching it.
 *
 * This suite asserts the command type strings these two handlers actually
 * dispatch are real members of CommandTypes (not just plausible-looking
 * strings), and pins the exact action → CommandTypes mapping so a future edit
 * can't silently drift back to invented values. `./commandQueue` is only
 * partially mocked (executeCommand swapped for a spy via importOriginal) so
 * CommandTypes stays the real, exported source of truth.
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
}));

vi.mock('./commandQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./commandQueue')>();
  return { ...actual, executeCommand: mocks.executeCommand };
});

import { db } from '../db';
import { CommandTypes } from './commandQueue';
import { registerScriptTools } from './aiToolsScripts';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const REAL_COMMAND_TYPES = new Set<string>(Object.values(CommandTypes));

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

beforeEach(() => {
  vi.clearAllMocks();
  mockOnlineDevice();
});

describe('manage_scheduled_tasks — dispatches real CommandTypes values', () => {
  const cases: Array<{ action: string; input: Record<string, unknown>; expected: string }> = [
    { action: 'list', input: {}, expected: CommandTypes.TASKS_LIST },
    { action: 'run', input: { taskName: '\\Microsoft\\Windows\\Foo\\Bar' }, expected: CommandTypes.TASK_RUN },
    { action: 'disable', input: { taskName: '\\Microsoft\\Windows\\Foo\\Bar' }, expected: CommandTypes.TASK_DISABLE },
    { action: 'enable', input: { taskName: '\\Microsoft\\Windows\\Foo\\Bar' }, expected: CommandTypes.TASK_ENABLE },
  ];

  it.each(cases)('action "$action" dispatches a real, correctly-mapped CommandTypes value', async ({ action, input, expected }) => {
    const tool = toolMap().get('manage_scheduled_tasks')!;
    await tool.handler({ deviceId: DEVICE_ID, action, ...input }, makeAuth());

    expect(executeCommand).toHaveBeenCalledTimes(1);
    const [, commandType] = executeCommand.mock.calls[0]!;
    expect(REAL_COMMAND_TYPES.has(commandType as string)).toBe(true);
    expect(commandType).toBe(expected);
  });

  it('sends the full task path as payload.path (agent reads "path", not "taskName")', async () => {
    const tool = toolMap().get('manage_scheduled_tasks')!;
    await tool.handler({ deviceId: DEVICE_ID, action: 'run', taskName: '\\Microsoft\\Windows\\Foo\\Bar' }, makeAuth());

    const [, , payload] = executeCommand.mock.calls[0]!;
    expect(payload).toEqual({ path: '\\Microsoft\\Windows\\Foo\\Bar' });
  });

  it('the "delete" action no longer exists (dropped — no agent-side implementation)', async () => {
    const tool = toolMap().get('manage_scheduled_tasks')!;
    const result = await tool.handler({ deviceId: DEVICE_ID, action: 'delete', taskName: 'x' }, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed.error).toMatch(/unknown action/i);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});

describe('registry_operations — dispatches real CommandTypes values', () => {
  const cases: Array<{ action: string; input: Record<string, unknown>; expected: string }> = [
    { action: 'read_key', input: { keyPath: 'HKLM\\SOFTWARE\\Foo' }, expected: CommandTypes.REGISTRY_VALUES },
    { action: 'get_value', input: { keyPath: 'HKLM\\SOFTWARE\\Foo', valueName: 'Bar' }, expected: CommandTypes.REGISTRY_GET },
    { action: 'set_value', input: { keyPath: 'HKLM\\SOFTWARE\\Foo', valueName: 'Bar', valueData: 'baz' }, expected: CommandTypes.REGISTRY_SET },
    { action: 'create_key', input: { keyPath: 'HKLM\\SOFTWARE\\Foo' }, expected: CommandTypes.REGISTRY_KEY_CREATE },
    { action: 'delete_key', input: { keyPath: 'HKLM\\SOFTWARE\\Foo' }, expected: CommandTypes.REGISTRY_KEY_DELETE },
  ];

  it.each(cases)('action "$action" dispatches a real, correctly-mapped CommandTypes value', async ({ action, input, expected }) => {
    const tool = toolMap().get('registry_operations')!;
    await tool.handler({ deviceId: DEVICE_ID, action, ...input }, makeAuth());

    expect(executeCommand).toHaveBeenCalledTimes(1);
    const [, commandType] = executeCommand.mock.calls[0]!;
    expect(REAL_COMMAND_TYPES.has(commandType as string)).toBe(true);
    expect(commandType).toBe(expected);
  });

  it('splits keyPath into {hive, path} — agent reads hive/path, not a combined keyPath', async () => {
    const tool = toolMap().get('registry_operations')!;
    await tool.handler(
      { deviceId: DEVICE_ID, action: 'get_value', keyPath: 'HKLM\\SOFTWARE\\Microsoft\\Windows', valueName: 'Ver' },
      makeAuth(),
    );

    const [, , payload] = executeCommand.mock.calls[0]!;
    expect(payload).toEqual({ hive: 'HKLM', path: 'SOFTWARE\\Microsoft\\Windows', name: 'Ver' });
  });

  it('defaults to hive HKLM when keyPath carries no recognized hive prefix', async () => {
    const tool = toolMap().get('registry_operations')!;
    await tool.handler(
      { deviceId: DEVICE_ID, action: 'read_key', keyPath: 'SOFTWARE\\NoHivePrefix' },
      makeAuth(),
    );

    const [, , payload] = executeCommand.mock.calls[0]!;
    expect(payload).toEqual({ hive: 'HKLM', path: 'SOFTWARE\\NoHivePrefix' });
  });

  it('maps valueName/valueData/valueType to name/data/type for set_value', async () => {
    const tool = toolMap().get('registry_operations')!;
    await tool.handler(
      {
        deviceId: DEVICE_ID,
        action: 'set_value',
        keyPath: 'HKCU\\Software\\Foo',
        valueName: 'Enabled',
        valueData: '1',
        valueType: 'REG_DWORD',
      },
      makeAuth(),
    );

    const [, , payload] = executeCommand.mock.calls[0]!;
    expect(payload).toEqual({ hive: 'HKCU', path: 'Software\\Foo', name: 'Enabled', data: '1', type: 'REG_DWORD' });
  });
});
