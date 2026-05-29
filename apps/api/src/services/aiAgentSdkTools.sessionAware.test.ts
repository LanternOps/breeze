import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================
// Mocks — keep makeSessionAwareHandler isolated from DB + heavy deps.
// runOutsideDbContext / withDbAccessContext just invoke their callback so the
// enforcement ordering (preToolUse -> handler -> postToolUse) is observable.
// ============================================
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  db: {},
}));

vi.mock('./aiAgent', () => ({ waitForPlanApproval: vi.fn() }));

// Identity compaction so we can assert on the exact handler output text.
vi.mock('./aiToolOutput', () => ({
  compactToolResultForChat: vi.fn((_tool: string, raw: string) => raw),
}));

// The M365 handlers are imported by the module under test; stub them out — we
// inject our own sessionHandler into makeSessionAwareHandler.
vi.mock('./aiToolsM365', () => ({
  m365LookupUserHandler: vi.fn(),
  m365RecentSigninsHandler: vi.fn(),
  m365ListGroupMembershipsHandler: vi.fn(),
  m365DisableUserHandler: vi.fn(),
  m365ResetPasswordHandler: vi.fn(),
}));

import { __test__ } from './aiAgentSdkTools';

const { makeSessionAwareHandler } = __test__;

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/* eslint-disable @typescript-eslint/no-explicit-any */
const fakeAuth = { scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'] } as any;
const fakeSession = { breezeSessionId: 'sess-123', auth: fakeAuth } as any;

const firstText = (res: ToolResult) => res.content[0]?.text ?? '';

describe('makeSessionAwareHandler (M365 enforcement routing)', () => {
  let getAuth: any;
  let getActiveSession: any;
  let sessionHandler: any;
  let onPreToolUse: any;
  let onPostToolUse: any;

  beforeEach(() => {
    vi.clearAllMocks();
    getAuth = vi.fn(() => fakeAuth);
    getActiveSession = vi.fn(() => fakeSession);
    sessionHandler = vi.fn(async () => JSON.stringify({ data: { ok: true } }));
    onPreToolUse = vi.fn(async () => ({ allowed: true }));
    onPostToolUse = vi.fn(async () => undefined);
  });

  // (1) Approval / guardrail / RBAC gate runs BEFORE the handler.
  // On the old inline registration the handler was called directly with no
  // onPreToolUse, so a tier-3 approval denial / RBAC denial could never block it.
  it('blocks execution and returns the error when onPreToolUse denies (sessionHandler never runs)', async () => {
    onPreToolUse.mockResolvedValueOnce({ allowed: false, error: 'approval_required' });
    const handler = makeSessionAwareHandler(
      'm365_reset_password', getAuth, getActiveSession, sessionHandler, onPreToolUse, onPostToolUse,
    );

    const res = (await handler({ userIdentifier: 'u@x.com', reason: 'r' })) as ToolResult;

    expect(onPreToolUse).toHaveBeenCalledWith('m365_reset_password', { userIdentifier: 'u@x.com', reason: 'r' });
    expect(sessionHandler).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('approval_required');
    // postToolUse still records the denied attempt (isError = true).
    expect(onPostToolUse).toHaveBeenCalledWith(
      'm365_reset_password', expect.any(Object), expect.stringContaining('approval_required'), true, 0,
    );
  });

  // (2) onPostToolUse runs on success — proves the audit-persistence path executes.
  // The old inline registration had NO onPostToolUse, so ai_tool_executions rows
  // and delegant_tool_call_id were never written.
  it('invokes onPostToolUse with toolName/args/result on success', async () => {
    sessionHandler.mockResolvedValueOnce(JSON.stringify({ data: { reset: true } }));
    const handler = makeSessionAwareHandler(
      'm365_disable_user', getAuth, getActiveSession, sessionHandler, onPreToolUse, onPostToolUse,
    );

    await handler({ userIdentifier: 'u@x.com', reason: 'r' });

    expect(onPostToolUse).toHaveBeenCalledTimes(1);
    expect(onPostToolUse).toHaveBeenCalledWith(
      'm365_disable_user',
      { userIdentifier: 'u@x.com', reason: 'r' },
      JSON.stringify({ data: { reset: true } }),
      false,
      expect.any(Number),
    );
  });

  // (3) preTool allowed -> handler runs once and its text is returned.
  it('calls sessionHandler once and returns its text when onPreToolUse allows', async () => {
    sessionHandler.mockResolvedValueOnce(JSON.stringify({ data: { display: 'Jane' } }));
    const handler = makeSessionAwareHandler(
      'm365_lookup_user', getAuth, getActiveSession, sessionHandler, onPreToolUse, onPostToolUse,
    );

    const res = (await handler({ userIdentifier: 'jane@x.com' })) as ToolResult;

    expect(onPreToolUse).toHaveBeenCalledTimes(1);
    expect(sessionHandler).toHaveBeenCalledTimes(1);
    // sessionHandler receives (args, auth, sessionId) — sessionId from active session.
    expect(sessionHandler).toHaveBeenCalledWith({ userIdentifier: 'jane@x.com' }, fakeAuth, 'sess-123');
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toBe(JSON.stringify({ data: { display: 'Jane' } }));
  });

  // (4) No active session -> no_active_session error, handler & enforcement skipped.
  it('returns no_active_session and skips handler when there is no active session', async () => {
    getActiveSession.mockReturnValueOnce(undefined);
    const handler = makeSessionAwareHandler(
      'm365_lookup_user', getAuth, getActiveSession, sessionHandler, onPreToolUse, onPostToolUse,
    );

    const res = (await handler({ userIdentifier: 'jane@x.com' })) as ToolResult;

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('no_active_session');
    expect(onPreToolUse).not.toHaveBeenCalled();
    expect(sessionHandler).not.toHaveBeenCalled();
  });
});
