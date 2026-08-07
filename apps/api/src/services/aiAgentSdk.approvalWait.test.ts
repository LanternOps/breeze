/**
 * #3089 — the chat turn must not block indefinitely on pending approvals.
 *
 * Covers the shared per-cycle approval-wait budget (beginApprovalWait via the
 * tier-3/tier-2 flows), settleApprovalWaits (new-user-message / interrupt
 * settling), and waitForTurnToSettle. Mock scaffolding mirrors
 * aiAgentSdk.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSessionPreToolUse,
  settleApprovalWaits,
  waitForTurnToSettle,
  APPROVAL_WAIT_BUDGET_MS,
} from './aiAgentSdk';
import { db } from '../db';
import { checkGuardrails, checkToolPermission, checkToolRateLimit } from './aiGuardrails';
import { waitForApproval } from './aiAgent';
import type { ActionIntentSnapshot } from './actionIntents/intentService';

// ============================================
// Mocks (mirrors aiAgentSdk.test.ts)
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
  aiToolExecutions: { id: 'id', status: 'status' },
  aiActionPlans: {},
  devices: {},
  deviceSessions: {},
  approvalRequests: { id: 'approval_requests.id', status: 'approval_requests.status' },
}));

vi.mock('drizzle-orm', () => ({
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

vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('./aiAgentSdkTools', () => ({
  TOOL_TIERS: {
    execute_command: 3,
    take_screenshot: 2,
  },
  BREEZE_MCP_TOOL_NAMES: [],
}));

const mockGetUserPushTokens = vi.fn();
const mockDispatchApprovalPushToTokens = vi.fn();
vi.mock('./expoPush', () => ({
  getUserPushTokens: (...args: unknown[]) => mockGetUserPushTokens(...args),
  dispatchApprovalPushToTokens: (...args: unknown[]) => mockDispatchApprovalPushToTokens(...args),
}));

vi.mock('./pamToolActionGovernance', () => ({
  decideHelperToolAction: vi.fn(),
}));

const mockCreateActionIntent = vi.fn();
const mockWaitForIntentDecision = vi.fn();
const mockTransitionIntent = vi.fn();
vi.mock('./actionIntents/intentService', () => ({
  createActionIntent: (...args: unknown[]) => mockCreateActionIntent(...args),
  waitForIntentDecision: (...args: unknown[]) => mockWaitForIntentDecision(...args),
  transitionIntent: (...args: unknown[]) => mockTransitionIntent(...args),
}));

vi.mock('./actionIntents/durableRelease', () => ({
  requiresDurableRelease: vi.fn(() => false),
  DURABLE_RELEASE_ONLY_TOOLS: new Set<string>(),
}));

vi.mock('./actionIntents/revalidateRelease', () => ({
  revalidateApprovedIntentForRelease: vi.fn(() => Promise.resolve({ ok: true, auth: {} })),
}));

vi.mock('../db/schema/actionIntents', () => ({
  actionIntents: { id: 'id', status: 'status' },
}));

vi.mock('./sentry', () => ({
  captureException: vi.fn(),
}));

// ============================================
// Test helpers
// ============================================

function makeAuth() {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    canAccessOrg: () => true,
    orgCondition: () => null,
  } as any;
}

function makeActiveSession(overrides: Record<string, unknown> = {}) {
  return {
    breezeSessionId: 'session-1',
    orgId: 'org-1',
    auth: makeAuth(),
    approvalMode: 'per_step',
    isPaused: false,
    state: 'processing',
    eventBus: { publish: vi.fn() },
    abortController: new AbortController(),
    activePlanId: null,
    approvedPlanSteps: new Map(),
    currentPlanStepIndex: 0,
    toolUseIdQueue: ['tool-use-1'],
    auditSnapshot: null,
    allowedTools: undefined,
    approvalWaitDeadline: null,
    approvalWaitAbort: null,
    pendingApprovalWaits: 0,
    ...overrides,
  } as any;
}

function makeIntentSnapshot(overrides: Partial<ActionIntentSnapshot> = {}): ActionIntentSnapshot {
  return {
    id: 'intent-1',
    status: 'pending_approval',
    actionName: 'execute_command',
    argumentDigest: 'digest-1',
    source: 'chat',
    expiresAt: new Date(Date.now() + 300_000),
    result: null,
    errorCode: null,
    approvalRequestIds: ['appr-1'],
    requesterApprovalRequestId: null,
    approvalExpiresAt: new Date(Date.now() + 300_000),
    fanOutUserIds: [],
    ...overrides,
  };
}

function mockInsertReturning(row: Record<string, unknown>) {
  const returning = vi.fn().mockResolvedValue([row]);
  const values = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.insert).mockReturnValue({ values } as any);
  return { values, returning };
}

function mockUpdateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  vi.mocked(db.update).mockReturnValue({ set } as any);
  return { set, where };
}

/** Poll until `fn()` is true (waits blocked inside preToolUse are async). */
async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('until(): condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function tier3Guardrail(approvalScope: 'supervised' | 'four_eyes' = 'four_eyes') {
  vi.mocked(checkGuardrails).mockReturnValue({
    allowed: true,
    tier: 3,
    requiresApproval: true,
    description: 'Execute command',
    approvalScope,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkToolPermission).mockResolvedValue(null as any);
  vi.mocked(checkToolRateLimit).mockResolvedValue(null as any);
  mockGetUserPushTokens.mockResolvedValue([]);
  mockDispatchApprovalPushToTokens.mockResolvedValue(undefined);
});

// ============================================
// Shared per-cycle budget
// ============================================

describe('shared approval-wait budget (#3089)', () => {
  it('first tier-3 wait of a cycle gets the full budget and sets the shared deadline', async () => {
    tier3Guardrail();
    mockInsertReturning({ id: 'exec-1' });
    mockUpdateChain();
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot());
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = makeActiveSession();
    const before = Date.now();

    await createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });

    expect(mockWaitForIntentDecision).toHaveBeenCalledWith(
      'intent-1',
      APPROVAL_WAIT_BUDGET_MS,
      expect.any(AbortSignal),
    );
    // Deadline is shared session state for the rest of the cycle.
    expect(session.approvalWaitDeadline).toBeGreaterThanOrEqual(before + APPROVAL_WAIT_BUDGET_MS);
    // The in-flight counter is balanced once the wait ends.
    expect(session.pendingApprovalWaits).toBe(0);
  });

  it('a sibling wait in the same cycle gets zero budget once exhausted and returns pending immediately', async () => {
    tier3Guardrail();
    mockInsertReturning({ id: 'exec-2' });
    mockUpdateChain();
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-2', approvalRequestIds: ['appr-2'] }));
    mockWaitForIntentDecision.mockResolvedValue('pending_approval');
    // A sibling approval earlier in this cycle already burned the budget.
    const session = makeActiveSession({ approvalWaitDeadline: Date.now() - 1_000 });

    const result = await createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });

    expect(mockWaitForIntentDecision).toHaveBeenCalledWith('intent-2', 0, expect.any(AbortSignal));
    expect(result).toEqual({
      allowed: false,
      error: 'Approval still pending; this action will complete once approved.',
    });
    // The intent is untouched — it stays pending_approval for the durable
    // release worker to execute once an approver decides.
    expect(mockTransitionIntent).not.toHaveBeenCalled();
    // The approval card was still surfaced to the user.
    expect(session.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval_required', executionId: 'exec-2' }),
    );
  });
});

// ============================================
// Tier-3 approval scope propagation (2026-08-05 tier3-supervised-four-eyes)
// ============================================

describe('tier-3 approval scope propagation to the chat SSE approval event', () => {
  it('supervised: approval event carries approvalScope + selfApprovalRequestId; aiAgentSdk never dispatches push itself', async () => {
    tier3Guardrail('supervised');
    mockInsertReturning({ id: 'exec-supervised' });
    mockUpdateChain();
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-supervised', requesterApprovalRequestId: 'appr-self' }),
    );
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = makeActiveSession();

    await createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });

    expect(session.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'approval_required',
        executionId: 'exec-supervised',
        approvalScope: 'supervised',
        selfApprovalRequestId: 'appr-self',
        intentBacked: true,
      }),
    );
    // NOT asserted here: that push is skipped for supervised. Push for the
    // durable intent path is dispatched — and gated on scope — entirely
    // inside createActionIntent, which is mocked wholesale in this file, so
    // there is no call site either way and
    // `expect(mockDispatchApprovalPushToTokens).not.toHaveBeenCalled()`
    // could not fail regardless of the gating. That assertion used to sit
    // here and has been removed as false confidence. The real gate is proved
    // against the real implementation in
    // services/actionIntents/intentService.test.ts
    // ('createActionIntent — supervised/four_eyes scope').
  });

  it('four_eyes: approval event carries approvalScope; aiAgentSdk still never dispatches push itself', async () => {
    tier3Guardrail('four_eyes');
    mockInsertReturning({ id: 'exec-four-eyes' });
    mockUpdateChain();
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-four-eyes', requesterApprovalRequestId: null }),
    );
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = makeActiveSession();

    await createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });

    expect(session.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'approval_required',
        executionId: 'exec-four-eyes',
        approvalScope: 'four_eyes',
        selfApprovalRequestId: undefined,
        intentBacked: true,
      }),
    );
    // Same as the supervised case above: the four_eyes push fan-out is real
    // production behavior, but it lives inside the mocked createActionIntent,
    // so no assertion in this file can observe it. Covered for real in
    // services/actionIntents/intentService.test.ts.
  });

  it('aiAgentSdk itself never dispatches an approval push on the tier-3 path', async () => {
    // The one assertion in this area that IS meaningful here, stated once
    // instead of twice: aiAgentSdk.ts does have a push call site (the legacy
    // Tier-2 per_step bridge), so "no push from this module" is a real,
    // falsifiable property of the tier-3 branch — it would fail if that
    // bridge were ever reused for tier 3, producing a second, ungated
    // dispatch alongside createActionIntent's.
    tier3Guardrail('four_eyes');
    mockInsertReturning({ id: 'exec-no-push' });
    mockUpdateChain();
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-no-push' }));
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = makeActiveSession();

    await createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });

    // Proof the tier-3 branch actually ran (without it the two assertions
    // below would be trivially true for a call that never got that far).
    expect(mockCreateActionIntent).toHaveBeenCalled();
    expect(mockGetUserPushTokens).not.toHaveBeenCalled();
    expect(mockDispatchApprovalPushToTokens).not.toHaveBeenCalled();
  });
});

// ============================================
// settleApprovalWaits
// ============================================

describe('settleApprovalWaits (#3089)', () => {
  it('is a no-op returning false when no approval wait is in flight', () => {
    const session = makeActiveSession();
    expect(settleApprovalWaits(session)).toBe(false);
    expect(session.approvalWaitAbort).toBeNull();
  });

  it('settles an in-flight tier-3 wait: the turn unblocks with an approval-pending result and the intent is left for the worker', async () => {
    tier3Guardrail();
    mockInsertReturning({ id: 'exec-3' });
    mockUpdateChain();
    mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-3', approvalRequestIds: ['appr-3'] }));
    // Simulate a real DB-polling wait that only ends when the signal fires.
    mockWaitForIntentDecision.mockImplementation(
      (_id: string, _timeoutMs: number, signal: AbortSignal) =>
        new Promise((resolve) => {
          if (signal.aborted) return resolve('pending_approval');
          signal.addEventListener('abort', () => resolve('pending_approval'), { once: true });
        }),
    );
    const session = makeActiveSession();

    const resultPromise = createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });
    await until(() => session.pendingApprovalWaits === 1);

    expect(settleApprovalWaits(session)).toBe(true);

    const result = await resultPromise;
    expect(result).toEqual({
      allowed: false,
      error: 'Approval still pending; this action will complete once approved.',
    });
    expect(mockTransitionIntent).not.toHaveBeenCalled();
    expect(session.pendingApprovalWaits).toBe(0);
    // Budget is exhausted for the rest of the cycle so a sibling cannot
    // immediately re-block the turn.
    expect(session.approvalWaitDeadline).toBeLessThanOrEqual(Date.now());
    // Nothing left to settle.
    expect(settleApprovalWaits(session)).toBe(false);
  });

  it('settles an in-flight tier-2 wait and closes out the pending execution row so a later approve cannot strand it', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 2,
      requiresApproval: true,
      description: 'Take screenshot',
    } as any);
    mockInsertReturning({ id: 'exec-4' });
    const { set, where } = mockUpdateChain();
    vi.mocked(waitForApproval).mockImplementation(
      (_id: string, _timeoutMs: number, signal?: AbortSignal) =>
        new Promise((resolve) => {
          if (signal?.aborted) return resolve(false);
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        }),
    );
    const session = makeActiveSession();

    const resultPromise = createSessionPreToolUse(session)('take_screenshot', { deviceId: 'd-1' });
    await until(() => session.pendingApprovalWaits === 1);

    expect(settleApprovalWaits(session)).toBe(true);

    const result = await resultPromise;
    expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
    // The still-pending ledger row was closed out — WITH the status='pending'
    // CAS guard, so a genuine reject/timeout row is never overwritten — and a
    // later Approve click cannot flip it to a stranded 'approved' this legacy
    // bridge would never execute.
    expect(set).toHaveBeenCalledWith({
      status: 'rejected',
      errorMessage: 'Approval wait ended before a decision was made',
    });
    expect(where).toHaveBeenCalledWith({
      _and: [{ _eq: ['id', 'exec-4'] }, { _eq: ['status', 'pending'] }],
    });
    // The linked mobile approval_requests row is CAS'd out of 'pending' too,
    // closing the mobile decide → stranded-'approved' race at the source.
    expect(set).toHaveBeenCalledWith({ status: 'expired' });
    expect(where).toHaveBeenCalledWith({
      _and: [
        { _eq: ['approval_requests.id', 'exec-4'] },
        { _eq: ['approval_requests.status', 'pending'] },
      ],
    });
    expect(session.pendingApprovalWaits).toBe(0);
  });

  it('a zero-budget tier-2 approval never runs the ceremony (no mobile push, no UI card) and self-closes honestly', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 2,
      requiresApproval: true,
      description: 'Take screenshot',
    } as any);
    const { values } = mockInsertReturning({ id: 'exec-5' });
    const { set, where } = mockUpdateChain();
    // A sibling approval (or a settle) already exhausted this cycle's budget.
    const session = makeActiveSession({ approvalWaitDeadline: Date.now() - 1_000 });

    const result = await createSessionPreToolUse(session)('take_screenshot', { deviceId: 'd-1' });

    expect(result.allowed).toBe(false);
    expect((result as { error: string }).error).toMatch(/approval window for this turn has ended/);
    // No dead-on-arrival ceremony: only the ledger-row insert ran — no
    // approval_requests row, no push, no approval_required card, no wait.
    expect(values).toHaveBeenCalledTimes(1);
    expect(mockDispatchApprovalPushToTokens).not.toHaveBeenCalled();
    expect(session.eventBus.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval_required' }),
    );
    expect(waitForApproval).not.toHaveBeenCalled();
    // The ledger row is closed out honestly (CAS on status='pending').
    expect(set).toHaveBeenCalledWith({
      status: 'rejected',
      errorMessage: "Approval not requested — this turn's approval wait budget was already exhausted",
    });
    expect(where).toHaveBeenCalledWith({
      _and: [{ _eq: ['id', 'exec-5'] }, { _eq: ['status', 'pending'] }],
    });
    expect(session.pendingApprovalWaits).toBe(0);
  });

  it('helper/PAM approvals draw from the same shared budget (zero remaining → zero wait)', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-h9' });
    mockUpdateChain();
    const { decideHelperToolAction } = await import('./pamToolActionGovernance');
    vi.mocked(decideHelperToolAction).mockResolvedValue('prompt' as any);
    vi.mocked(waitForApproval).mockResolvedValue(false);
    const session = makeActiveSession({
      auth: { ...makeAuth(), helperDeviceId: 'dev-9' },
      approvalWaitDeadline: Date.now() - 1_000,
    });

    const result = await createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });

    expect(result.allowed).toBe(false);
    expect(waitForApproval).toHaveBeenCalledWith('exec-h9', 0, expect.any(AbortSignal));
    expect(session.pendingApprovalWaits).toBe(0);
  });
});

// ============================================
// waitForTurnToSettle
// ============================================

describe('waitForTurnToSettle (#3089)', () => {
  it('resolves true once the session leaves processing', async () => {
    const session = makeActiveSession({ state: 'processing' });
    setTimeout(() => { session.state = 'idle'; }, 250);

    await expect(waitForTurnToSettle(session, 3_000)).resolves.toBe(true);
  });

  it('resolves false when the session is still processing at the deadline', async () => {
    const session = makeActiveSession({ state: 'processing' });

    await expect(waitForTurnToSettle(session, 300)).resolves.toBe(false);
  });
});
