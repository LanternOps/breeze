import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #3087 follow-up (code-review finding, IMPORTANT): `propose_action_plan`
 * guarded on `session.auth.orgId`, which is null for partner-scope logins —
 * exactly the population #3087 narrows tool execution for via
 * `session.toolAuth`/`session.orgId`. That guard hard-failed every plan
 * proposal ("Action plans require an organization context") for a
 * partner-scope tech running a device-bound session in hybrid_plan/
 * action_plan approval mode, even though `session.orgId` (the canonical,
 * always-set session org) was available the whole time. Every other DB write
 * in this handler's file already keys off `session.orgId` — this tool was
 * the odd one out.
 *
 * Covers the fix in aiAgentSdkTools.ts's `propose_action_plan` handler:
 * `const orgId = session.orgId` (not `session.auth.orgId`).
 */

const { dbInsertMock, dbUpdateMock, withDbAccessContextMock, capturedDbCtx } = vi.hoisted(() => {
  const capturedDbCtx: unknown[] = [];
  return {
    dbInsertMock: vi.fn(),
    dbUpdateMock: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    withDbAccessContextMock: vi.fn((ctx: unknown, fn: () => unknown) => {
      capturedDbCtx.push(ctx);
      return fn();
    }),
    capturedDbCtx,
  };
});

vi.mock('../db', () => ({
  db: { insert: dbInsertMock, update: dbUpdateMock },
  withDbAccessContext: withDbAccessContextMock,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

// Auto-approve so the handler runs its full success path (plan row insert +
// 'executing' status update), rather than stopping at the intermediate
// "awaiting approval" state — that keeps the assertions below about the
// FINAL result content meaningful.
vi.mock('./aiAgent', () => ({ waitForPlanApproval: vi.fn(() => Promise.resolve(true)) }));

vi.mock('./aiToolsM365', () => ({
  m365LookupUserHandler: vi.fn(),
  m365RecentSigninsHandler: vi.fn(),
  m365ListGroupMembershipsHandler: vi.fn(),
  m365DisableUserHandler: vi.fn(),
  m365ResetPasswordHandler: vi.fn(),
  registerM365Tools: vi.fn(),
}));

vi.mock('./aiToolsGoogle', () => ({
  googleLookupUserHandler: vi.fn(),
  googleResetPasswordHandler: vi.fn(),
  googleSuspendUserHandler: vi.fn(),
  googleRestoreUserHandler: vi.fn(),
  googleSignOutHandler: vi.fn(),
  googleSetForwardingHandler: vi.fn(),
  googleDisableForwardingHandler: vi.fn(),
  googleSetVacationHandler: vi.fn(),
  googleUpdateUserHandler: vi.fn(),
  googleShareCalendarHandler: vi.fn(),
  googleOffboardUserHandler: vi.fn(),
  googleWipeMobileDeviceHandler: vi.fn(),
  googleSecurityDriftHandler: vi.fn(),
  googleEmailReportHandler: vi.fn(),
  googleListUserGroupsHandler: vi.fn(),
  googleAddToGroupHandler: vi.fn(),
  googleRemoveFromGroupHandler: vi.fn(),
  googleMoveOuHandler: vi.fn(),
  googleRenameUserHandler: vi.fn(),
  googleResetTwoSvHandler: vi.fn(),
  googleAddMailDelegateHandler: vi.fn(),
  googleRemoveMailDelegateHandler: vi.fn(),
  googleListLicensesHandler: vi.fn(),
  googleAssignLicenseHandler: vi.fn(),
  googleRemoveLicenseHandler: vi.fn(),
}));

import { createBreezeMcpServer } from './aiAgentSdkTools';
import type { ActiveSession } from './streamingSessionManager';
import type { AuthContext } from '../middleware/auth';

/** Partner-scope login: orgId is null (partner tokens never carry one). */
const partnerAuth = {
  scope: 'partner',
  orgId: null,
  partnerId: 'partner-1',
  accessibleOrgIds: ['session-org', 'sibling-org'],
  user: { id: 'user-1', email: 'tech@msp.example' },
} as unknown as AuthContext;

function getRegisteredHandler(name: string) {
  const session = {
    breezeSessionId: 'sess-123',
    orgId: 'session-org', // canonical session org — always set, unlike auth.orgId
    auth: partnerAuth,
    toolAuth: partnerAuth,
    approvalMode: 'action_plan',
    activePlanId: null,
    approvedPlanSteps: new Map(),
    currentPlanStepIndex: 0,
    eventBus: { publish: vi.fn() },
  } as unknown as ActiveSession;

  const mcpServer = createBreezeMcpServer(
    () => session.toolAuth,
    undefined,
    undefined,
    () => session,
  );
  // The SDK's tool() handlers are registered on the real (unmocked)
  // @modelcontextprotocol/sdk McpServer instance; `_registeredTools` is its
  // internal registry (see node_modules/@modelcontextprotocol/sdk/dist/esm/
  // server/mcp.js) — the only place the callback is reachable outside the
  // wire protocol.
  const registered = (mcpServer.instance as unknown as {
    _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
  })._registeredTools[name];
  if (!registered) throw new Error(`tool '${name}' not registered`);
  return { handler: registered.handler, session };
}

describe('propose_action_plan — org resolution (#3087 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedDbCtx.length = 0;
  });

  it('creates the plan under session.orgId for a partner-scope login (auth.orgId is null), not a hard failure', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'plan-1' }]);
    const values = vi.fn().mockReturnValue({ returning });
    dbInsertMock.mockReturnValue({ values });

    const { handler, session } = getRegisteredHandler('propose_action_plan');

    const result = await handler(
      {
        title: 'Patch and reboot',
        steps: [{ toolName: 'query_devices', input: {}, reasoning: 'find target devices' }],
      },
      {},
    ) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    // Must NOT be the "Action plans require an organization context" refusal
    // that fired when the guard read `session.auth.orgId` (null here).
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).not.toContain('organization context');

    // The plan row is inserted under the canonical session org.
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-123',
      orgId: 'session-org',
      status: 'pending',
    }));

    // The RLS DB access context for the insert is scoped to the session org too.
    expect(capturedDbCtx).toContainEqual(expect.objectContaining({
      scope: 'organization',
      orgId: 'session-org',
      accessibleOrgIds: ['session-org'],
    }));

    // waitForPlanApproval is mocked to auto-approve, so the handler runs
    // through to its final "approved" result — proving the whole plan
    // lifecycle (not just the initial insert) works under a partner login.
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ result: 'approved', planId: 'plan-1' });
    expect(session.activePlanId).toBe('plan-1');
  });
});
