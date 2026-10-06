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

  // #7918: run_script waits up to 60 s per device for the agent; held in the
  // wrapper's transaction, production Postgres killed it after one minute.
  it('opens NO wrapper transaction around run_script (#7918)', async () => {
    expect(aiTools.get('run_script')?.selfManagedDbContext).toBe(true);

    await makeHandler('run_script', () => fakeAuth)({ proposalId: 'p1', deviceIds: ['d1'] });

    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(withDbAccessContextMock).not.toHaveBeenCalled();
  });

  it.each(['manage_invoices', 'manage_quotes'])('%s pay links open no outer transaction', async (name) => {
    await makeHandler(name, () => fakeAuth)({ action: 'create_pay_link' });
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(withDbAccessContextMock).not.toHaveBeenCalled();
  });

  it.each(['manage_invoices', 'manage_quotes'])('%s other actions retain their transaction', async (name) => {
    await makeHandler(name, () => fakeAuth)({ action: 'create_draft' });
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(withDbAccessContextMock).toHaveBeenCalledTimes(1);
  });

  it.each(['manage_invoices', 'manage_quotes'])('%s pay links still honor denial and audit callbacks', async (name) => {
    const pre = vi.fn().mockResolvedValue({ allowed: false, error: 'Approval required' });
    const post = vi.fn().mockResolvedValue(undefined);
    const result = await makeHandler(name, () => fakeAuth, pre, post)({ action: 'create_pay_link' });
    expect(result.isError).toBe(true);
    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    pre.mockResolvedValue({ allowed: true });
    await makeHandler(name, () => fakeAuth, pre, post)({ action: 'create_pay_link' });
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(withDbAccessContextMock).not.toHaveBeenCalled();
  });

  it('still wraps every other tool in its per-call transaction', async () => {
    const handler = makeHandler('get_script_proposal', () => fakeAuth);

    await handler({ proposalId: 'p1' });

    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(withDbAccessContextMock).toHaveBeenCalledTimes(1);
  });
});
