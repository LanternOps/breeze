import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #7128 — the SDK tool wrapper (chat AND agent runs share `makeToolHandler`)
 * wraps every tool call in ONE `withDbAccessContext` transaction. For
 * `propose_script` that transaction was still open when the review job was
 * enqueued (the worker found the proposal 'missing') and stayed open, idle,
 * across the handler's 45 s review wait.
 *
 * A tool that declares `selfManagedDbContext` must therefore reach
 * `executeTool` with NO wrapper transaction; every other tool keeps it.
 */

const { mockExecuteTool, withDbAccessContextMock } = vi.hoisted(() => ({
  mockExecuteTool: vi.fn(async () => JSON.stringify({ ok: true })),
  withDbAccessContextMock: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: withDbAccessContextMock,
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {},
}));

vi.mock('./aiAgent', () => ({ waitForPlanApproval: vi.fn() }));

vi.mock('./aiToolOutput', () => ({
  compactToolResultForChat: vi.fn((_tool: string, raw: string) => raw),
  setToolPaginationHintResolver: vi.fn(),
}));

vi.mock('./aiToolsM365', () => ({
  m365LookupUserHandler: vi.fn(),
  m365RecentSigninsHandler: vi.fn(),
  m365ListGroupMembershipsHandler: vi.fn(),
  m365DisableUserHandler: vi.fn(),
  m365ResetPasswordHandler: vi.fn(),
  registerM365Tools: vi.fn(),
}));

// Only `executeTool` is replaced: the registry (`aiTools`) stays real, so the
// flag is read from the tool's actual registration, not a test fixture.
vi.mock('./aiTools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeTool: (...args: unknown[]) => mockExecuteTool(...(args as [])),
}));

import { __test__ } from './aiAgentSdkTools';
import { aiTools } from './aiTools';

const { makeHandler } = __test__;

const fakeAuth = {
  scope: 'organization',
  orgId: 'org-1',
  accessibleOrgIds: ['org-1'],
  partnerId: 'partner-1',
  user: { id: 'user-1' },
} as any;

describe('makeHandler — self-managed DB context tools (#7128)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTool.mockResolvedValue(JSON.stringify({ ok: true }));
  });

  it('propose_script is registered as self-managed', () => {
    expect(aiTools.get('propose_script')?.selfManagedDbContext).toBe(true);
  });

  it('opens NO wrapper transaction around a self-managed tool', async () => {
    const handler = makeHandler('propose_script', () => fakeAuth);

    await handler({ deviceIds: ['d1'] });

    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect((mockExecuteTool.mock.calls[0] as unknown as unknown[])[0]).toBe('propose_script');
    expect(withDbAccessContextMock).not.toHaveBeenCalled();
  });

  it('still wraps every other tool in its per-call transaction', async () => {
    const handler = makeHandler('get_script_proposal', () => fakeAuth);

    await handler({ proposalId: 'p1' });

    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(withDbAccessContextMock).toHaveBeenCalledTimes(1);
  });
});
