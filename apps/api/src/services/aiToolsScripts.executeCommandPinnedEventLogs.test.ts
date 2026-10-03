import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7906: when the chat gate classified an `event_logs_query` call as Tier-2
 * read-only, it pins the strictly-parsed payload on the execution context.
 * The handler must dispatch THOSE values — never re-read the raw input
 * payload after classification.
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

// The remote-tools policy check has its own suites
// (aiDispatch.test.ts, aiRemoteToolsPolicy.contract.test.ts); allow it here.
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

beforeEach(() => {
  vi.clearAllMocks();
  mockOnlineDevice();
});

describe('execute_command — pinned event_logs_query payload (#7906)', () => {
  it('dispatches the pinned payload, not the raw input payload', async () => {
    const tool = toolMap().get('execute_command')!;
    await tool.handler(
      { deviceId: DEVICE_ID, commandType: 'event_logs_query', payload: { logName: 'Security', query: '*' } },
      makeAuth(),
      { pinnedEventLogsQuery: { payload: Object.freeze({ logName: 'System', level: 'error' }) } },
    );

    expect(executeCommand).toHaveBeenCalledTimes(1);
    const [, commandType, payload] = executeCommand.mock.calls[0]!;
    expect(commandType).toBe('event_logs_query');
    expect(payload).toEqual({ logName: 'System', level: 'error' });
  });

  it('refuses (fails closed) when a pinned payload arrives for a different commandType', async () => {
    const tool = toolMap().get('execute_command')!;
    const out = await tool.handler(
      { deviceId: DEVICE_ID, commandType: 'file_read', payload: { path: 'C:\\x' } },
      makeAuth(),
      { pinnedEventLogsQuery: { payload: Object.freeze({ logName: 'System' }) } },
    );

    expect(executeCommand).not.toHaveBeenCalled();
    expect(JSON.parse(out as string).error).toMatch(/event_logs_query/);
  });

  it('without a pinned payload the raw payload is dispatched as before', async () => {
    const tool = toolMap().get('execute_command')!;
    await tool.handler(
      { deviceId: DEVICE_ID, commandType: 'event_logs_query', payload: { logName: 'Application' } },
      makeAuth(),
    );

    const [, , payload] = executeCommand.mock.calls[0]!;
    expect(payload).toEqual({ logName: 'Application' });
  });
});
