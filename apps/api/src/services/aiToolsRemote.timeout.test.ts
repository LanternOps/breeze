import { beforeEach, describe, expect, it, vi } from 'vitest';

// #3096 review finding: the PR raised the vision-tool budget in toolTimeouts.ts,
// but take_screenshot / analyze_screen / computer_control called executeCommand
// with a hardcoded `timeoutMs: 30000` — the raised budget never reached
// commandQueue's single-shot waitForCommandResult, so analyze_screen still died
// at ~30s regardless of what getToolTimeout() returned. This suite asserts the
// two never drift apart again: whatever toolTimeouts.ts says for a given tool is
// exactly what reaches executeCommand's `timeoutMs` option.

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(async () => ({
    status: 'completed',
    stdout: JSON.stringify({ imageBase64: 'AA==' }),
  })),
}));

import { db } from '../db';
import { executeCommand } from './commandQueue';
import { registerRemoteTools } from './aiToolsRemote';
import { getToolTimeout } from './toolTimeouts';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';

function createQueryChain(rows: any[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerRemoteTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'user-1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
  } as AuthContext;
}

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
const mockExecuteCommand = executeCommand as unknown as ReturnType<typeof vi.fn>;

describe('aiToolsRemote — timeoutMs threads through to executeCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockImplementation(() =>
      createQueryChain([
        { id: DEVICE_ID, status: 'online', siteId: null, hostname: 'host-1', orgId: 'org-1' },
      ])
    );
    mockExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ imageBase64: 'AA==' }),
    });
  });

  it('take_screenshot passes getToolTimeout("take_screenshot"), not a hardcoded 30s', async () => {
    await handlerFor('take_screenshot')({ deviceId: DEVICE_ID }, makeAuth());
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    const [, , , options] = mockExecuteCommand.mock.calls[0]!;
    expect(options.timeoutMs).toBe(getToolTimeout('take_screenshot'));
  });

  it('analyze_screen passes getToolTimeout("analyze_screen"), not a hardcoded 30s', async () => {
    await handlerFor('analyze_screen')({ deviceId: DEVICE_ID }, makeAuth());
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    const [, , , options] = mockExecuteCommand.mock.calls[0]!;
    expect(options.timeoutMs).toBe(getToolTimeout('analyze_screen'));
  });

  it('computer_control passes getToolTimeout("computer_control"), not a hardcoded 30s', async () => {
    await handlerFor('computer_control')({ deviceId: DEVICE_ID, action: 'screenshot' }, makeAuth());
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    const [, , , options] = mockExecuteCommand.mock.calls[0]!;
    expect(options.timeoutMs).toBe(getToolTimeout('computer_control'));
  });

  it('all three vision/desktop tools get at least the agent round-trip budget end to end', async () => {
    // Guards the whole chain, not just the constant table: the value that
    // ACTUALLY reaches executeCommand must be >= execute_command's budget,
    // matching the invariant asserted in toolTimeouts.test.ts against the
    // source-of-truth table alone.
    const agentRoundTrip = getToolTimeout('execute_command');
    for (const [tool, input] of [
      ['take_screenshot', { deviceId: DEVICE_ID }],
      ['analyze_screen', { deviceId: DEVICE_ID }],
      ['computer_control', { deviceId: DEVICE_ID, action: 'screenshot' }],
    ] as const) {
      mockExecuteCommand.mockClear();
      await handlerFor(tool)(input, makeAuth());
      const [, , , options] = mockExecuteCommand.mock.calls[0]!;
      expect(options.timeoutMs, `${tool} timeoutMs`).toBeGreaterThanOrEqual(agentRoundTrip);
    }
  });
});
