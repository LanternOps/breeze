import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #9427 W1 T2b — the action-plan card is tracked on the session (key
 * `plan:<planId>`) for exactly as long as `waitForPlanApproval` is pending.
 * A plan rejection or timeout publishes no event, so without this registry an
 * attaching client could not tell a decided plan card from a pending one.
 *
 * Scaffolding mirrors aiAgentSdkTools.proposeActionPlan.test.ts.
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

// Each test decides how the plan wait ends.
vi.mock('./aiAgent', () => ({ waitForPlanApproval: vi.fn() }));

vi.mock('./aiToolsM365', async (importOriginal) => ({
  ...await importOriginal<typeof import('./aiToolsM365')>(),
  m365LookupUserHandler: vi.fn(),
  m365RecentSigninsHandler: vi.fn(),
  m365ListGroupMembershipsHandler: vi.fn(),
  m365DisableUserHandler: vi.fn(),
  m365ResetPasswordHandler: vi.fn(),
}));

vi.mock('./aiToolsGoogle', async (importOriginal) => ({
  ...await importOriginal<typeof import('./aiToolsGoogle')>(),
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
import { waitForPlanApproval } from './aiAgent';
import { SessionEventBus } from './sessionEventBus';
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
    eventBus: new SessionEventBus(),
    pendingCards: new Map(),
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

describe('propose_action_plan — pending plan card (#9427)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedDbCtx.length = 0;
    const returning = vi.fn().mockResolvedValue([{ id: 'plan-1' }]);
    dbInsertMock.mockReturnValue({ values: vi.fn().mockReturnValue({ returning }) });
  });

  const args = {
    title: 'Patch and reboot',
    steps: [{ toolName: 'query_devices', input: {}, reasoning: 'find target devices' }],
  };

  /** Run the handler with the plan wait held open; returns the session, the handler promise, and the wait's resolver. */
  async function startBlocked() {
    let settle: ((approved: boolean) => void) | undefined;
    vi.mocked(waitForPlanApproval).mockImplementation(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const { handler, session } = getRegisteredHandler('propose_action_plan');
    const result = handler(args, {});
    const start = Date.now();
    while (!settle) {
      if (Date.now() - start > 2000) throw new Error('plan wait never started');
      await new Promise((r) => setTimeout(r, 5));
    }
    return { session, result: { promise: result }, settle };
  }

  it('is tracked verbatim while the plan wait is pending', async () => {
    const { session, result, settle } = await startBlocked();
    expect(session.pendingCards.get('plan:plan-1')).toEqual({
      type: 'plan_approval_required',
      planId: 'plan-1',
      steps: [{ toolName: 'query_devices', input: {}, reasoning: 'find target devices', status: 'pending' }],
    });
    expect(session.eventBus.snapshot().replay).toContainEqual(session.pendingCards.get('plan:plan-1'));
    settle(false);
    await result.promise;
  });

  it('is removed when the plan is approved', async () => {
    const { session, result, settle } = await startBlocked();
    settle(true);
    await result.promise;
    expect(session.pendingCards.size).toBe(0);
  });

  it('is removed when the plan is rejected', async () => {
    const { session, result, settle } = await startBlocked();
    settle(false);
    expect(JSON.stringify(await result.promise)).toContain('rejected');
    expect(session.pendingCards.size).toBe(0);
  });

  it('is removed when the plan wait times out', async () => {
    // waitForPlanApproval resolves false once its timeout elapses.
    vi.mocked(waitForPlanApproval).mockResolvedValue(false);
    const { handler, session } = getRegisteredHandler('propose_action_plan');
    await handler(args, {});
    expect(session.eventBus.snapshot().replay).toContainEqual(expect.objectContaining({ type: 'plan_approval_required', planId: 'plan-1' }));
    expect(session.pendingCards.size).toBe(0);
  });

  it('is removed when the plan wait throws', async () => {
    vi.mocked(waitForPlanApproval).mockRejectedValue(new Error('boom'));
    const { handler, session } = getRegisteredHandler('propose_action_plan');
    await Promise.resolve(handler(args, {})).catch(() => undefined);
    expect(session.eventBus.snapshot().replay).toContainEqual(expect.objectContaining({ type: 'plan_approval_required', planId: 'plan-1' }));
    expect(session.pendingCards.size).toBe(0);
  });
});
