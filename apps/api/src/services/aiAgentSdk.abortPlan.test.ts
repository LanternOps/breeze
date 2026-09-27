import { describe, it, expect, vi, beforeEach } from 'vitest';
import { abortActivePlan } from './aiAgentSdk';
import { db } from '../db';

/**
 * #7085: abortActivePlan must settle a pending plan approval.
 *
 * `propose_action_plan` (aiAgentSdkTools.ts) blocks on `waitForPlanApproval`,
 * whose resolver lives on `session.planApprovalResolver`. The abort-plan and
 * pause routes both call abortActivePlan. Before the fix it cleared the plan
 * state but left that resolver live, so a later
 * `POST /ai/sessions/:id/approve-plan` passed the "pending approval" check,
 * resolved the wait with `true`, and the agent ran the plan the user aborted.
 */
// ============================================
// Mocks (mirror aiAgentSdk.test.ts)
// ============================================

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    update: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  aiSessions: { id: 'id', status: 'status', orgId: 'orgId' },
  aiMessages: {},
  aiToolExecutions: {},
  aiActionPlans: {},
  devices: {},
  deviceSessions: {},
  approvalRequests: { id: 'id' },
}));

vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: vi.fn((...args: unknown[]) => ({ _eq: args })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((...args: unknown[]) => ({ _isNull: args })),
}));

vi.mock('./aiAgent', () => ({
  getSession: vi.fn(),
  buildSystemPrompt: vi.fn(),
  waitForApproval: vi.fn(),
}));

vi.mock('./aiCostTracker', () => ({
  checkAiRateLimit: vi.fn(),
  checkBudget: vi.fn(),
  getRemainingBudgetUsd: vi.fn(),
}));

vi.mock('./aiInputSanitizer', () => ({
  sanitizeUserMessage: vi.fn(),
  sanitizePageContext: vi.fn(),
}));

vi.mock('./aiGuardrails', () => ({
  checkGuardrails: vi.fn(),
  checkToolPermission: vi.fn(),
  checkToolRateLimit: vi.fn(),
}));

vi.mock('./aiSessionLiveAuthority', () => ({
  resolveLiveSessionToolAuthority: vi.fn(async (session: any) => ({
    ok: true,
    auth: session.auth,
    toolAuth: session.toolAuth ?? session.auth,
  })),
}));

vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('./aiAgentSdkTools', () => ({
  TOOL_TIERS: { query_devices: 1, take_screenshot: 2, execute_command: 3 },
  BREEZE_MCP_TOOL_NAMES: [],
}));

const mockGetUserPushTokens = vi.fn();
const mockSendExpoPush = vi.fn();
vi.mock('./expoPush', () => ({
  getUserPushTokens: (...args: unknown[]) => mockGetUserPushTokens(...args),
  sendExpoPush: (...args: unknown[]) => mockSendExpoPush(...args),
  buildApprovalPush: vi.fn(() => ({
    title: 'Approval requested',
    body: 'body',
    data: { type: 'approval', approvalId: 'x' },
    sound: 'default' as const,
    priority: 'high' as const,
    channelId: 'approvals',
    ttl: 60,
  })),
}));

vi.mock('./pamToolActionGovernance', () => ({
  decideHelperToolAction: vi.fn(),
  mirrorElevationDecisionToExecution: vi.fn(),
}));

vi.mock('./m365Helpers', () => ({
  loadSession: vi.fn().mockResolvedValue(null),
  loadConnection: vi.fn().mockResolvedValue(null),
}));


// W04 (#5612): the lane's restore-checkpoint release precondition, mocked so
// its transitive scriptDispatch/schema imports never reach the partial
// schema mock in this file.
vi.mock('./actionIntents/laneCheckpoint', () => ({
  ensureLaneCheckpointBeforeRelease: vi.fn(async () => ({ ok: true, checkpointRef: null })),
}));

vi.mock('./actionIntents/revalidateRelease', () => ({
  revalidateApprovedIntentForRelease: vi.fn(async () => ({ ok: true, auth: {} })),
}));

vi.mock('./actionIntents/intentService', () => ({
  createActionIntent: vi.fn(),
  waitForIntentDecision: vi.fn(),
  transitionIntent: vi.fn(),
}));

/**
 * Same contract as `waitForPlanApproval` in aiAgent.ts (the module is mocked
 * here): the resolver is stored on the session, and calling it clears itself
 * and settles the waiting promise.
 */
function pendingPlanApproval(session: any): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    session.planApprovalResolver = (approved: boolean) => {
      session.planApprovalResolver = null;
      resolve(approved);
    };
  });
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    breezeSessionId: 'session-1',
    orgId: 'org-1',
    eventBus: { publish: vi.fn() },
    activePlanId: 'plan-1',
    approvedPlanSteps: new Map(),
    currentPlanStepIndex: 0,
    planApprovalResolver: null,
    ...overrides,
  } as any;
}

function mockPlanUpdate(result: () => Promise<unknown> = () => Promise.resolve(undefined)) {
  const where = vi.fn(() => result());
  const set = vi.fn(() => ({ where }));
  vi.mocked(db.update).mockReturnValue({ set } as any);
  return { set, where };
}

describe('abortActivePlan — pending plan approval (#7085)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('settles a pending plan approval as rejected and clears the resolver', async () => {
    mockPlanUpdate();
    const session = makeSession();
    const approval = pendingPlanApproval(session);

    await expect(abortActivePlan(session)).resolves.toBe(true);

    await expect(approval).resolves.toBe(false);
    // approve-plan gates on this being non-null; null means a later Approve
    // gets "No pending plan approval" instead of running the aborted plan.
    expect(session.planApprovalResolver).toBeNull();
    expect(session.activePlanId).toBeNull();
  });

  it('a later approve cannot resolve the aborted plan as approved', async () => {
    mockPlanUpdate();
    const session = makeSession();
    const approval = pendingPlanApproval(session);
    const heldResolver = session.planApprovalResolver;

    await abortActivePlan(session);
    // Even a caller that captured the resolver before the abort cannot flip
    // the outcome: the promise is already settled as rejected.
    heldResolver(true);

    await expect(approval).resolves.toBe(false);
  });

  it('settles the approval before the DB write, so an approve racing the abort write cannot win', async () => {
    let releaseWrite!: () => void;
    const write = new Promise<void>((r) => { releaseWrite = r; });
    mockPlanUpdate(() => write);
    const session = makeSession();
    const approval = pendingPlanApproval(session);
    const settled = vi.fn();
    void approval.then(settled);

    const aborting = abortActivePlan(session);
    // The DB write is still in flight here.
    expect(session.planApprovalResolver).toBeNull();
    await Promise.resolve();
    expect(settled).toHaveBeenCalledWith(false);

    releaseWrite();
    await aborting;
  });

  it('still settles the approval when the DB write fails', async () => {
    mockPlanUpdate(() => Promise.reject(new Error('db down')));
    const session = makeSession();
    const approval = pendingPlanApproval(session);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(abortActivePlan(session)).resolves.toBe(true);
    await expect(approval).resolves.toBe(false);
    expect(session.planApprovalResolver).toBeNull();
    errSpy.mockRestore();
  });

  it('is a no-op for the resolver when no approval is pending', async () => {
    mockPlanUpdate();
    const session = makeSession();

    await expect(abortActivePlan(session)).resolves.toBe(true);
    expect(session.planApprovalResolver).toBeNull();
  });
});
