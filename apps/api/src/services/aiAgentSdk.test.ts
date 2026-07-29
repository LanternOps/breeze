import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionPostToolUse, createSessionPreToolUse, runPreFlightChecks, safeParseJson } from './aiAgentSdk';
import { db } from '../db';
import { checkGuardrails, checkToolPermission, checkToolRateLimit } from './aiGuardrails';
import { waitForApproval } from './aiAgent';
import type { ActionIntentSnapshot } from './actionIntents/intentService';
import type { IntentReleaseRevalidation } from './actionIntents/revalidateRelease';

// ============================================
// Mocks
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

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ _eq: args })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((...args: unknown[]) => ({ _isNull: args })),
}));

const mockGetSession = vi.fn();
const mockBuildSystemPrompt = vi.fn();
vi.mock('./aiAgent', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  buildSystemPrompt: (...args: unknown[]) => mockBuildSystemPrompt(...args),
  waitForApproval: vi.fn(),
}));

const mockCheckAiRateLimit = vi.fn();
const mockCheckBudget = vi.fn();
const mockGetRemainingBudgetUsd = vi.fn();
vi.mock('./aiCostTracker', () => ({
  checkAiRateLimit: (...args: unknown[]) => mockCheckAiRateLimit(...args),
  checkBudget: (...args: unknown[]) => mockCheckBudget(...args),
  getRemainingBudgetUsd: (...args: unknown[]) => mockGetRemainingBudgetUsd(...args),
}));

const mockSanitizeUserMessage = vi.fn();
const mockSanitizePageContext = vi.fn();
vi.mock('./aiInputSanitizer', () => ({
  sanitizeUserMessage: (...args: unknown[]) => mockSanitizeUserMessage(...args),
  sanitizePageContext: (...args: unknown[]) => mockSanitizePageContext(...args),
}));

vi.mock('./aiGuardrails', () => ({
  checkGuardrails: vi.fn(),
  checkToolPermission: vi.fn(),
  checkToolRateLimit: vi.fn(),
}));

const mockWriteAuditEvent = vi.fn();
vi.mock('./auditEvents', () => ({
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('./aiAgentSdkTools', () => ({
  TOOL_TIERS: {
    query_devices: 1,
    take_screenshot: 2,
    execute_command: 3,
    m365_reset_password: 3,
    google_reset_password: 3,
    // Base (static) tier 1 — file_operations only reaches tier 3 via
    // action-escalation (action === 'read') in aiGuardrails.ts, which the
    // tests below stub via checkGuardrails, not this map.
    file_operations: 1,
    get_device_details: 1,
  },
  BREEZE_MCP_TOOL_NAMES: [],
}));

const mockGetUserPushTokens = vi.fn();
const mockDispatchApprovalPushToTokens = vi.fn();
const mockBuildApprovalPush = vi.fn((..._args: unknown[]) => ({
  title: 'Approval requested',
  body: 'Breeze AI: Execute command',
  data: { type: 'approval', approvalId: 'x' },
  sound: 'default' as const,
  priority: 'high' as const,
  channelId: 'approvals',
  ttl: 60,
}));
vi.mock('./expoPush', () => ({
  getUserPushTokens: (...args: unknown[]) => mockGetUserPushTokens(...args),
  dispatchApprovalPushToTokens: (...args: unknown[]) => mockDispatchApprovalPushToTokens(...args),
  buildApprovalPush: (...args: unknown[]) => mockBuildApprovalPush(...args),
}));

const mockDecideHelperToolAction = vi.fn();
vi.mock('./pamToolActionGovernance', () => ({
  decideHelperToolAction: (...args: unknown[]) => mockDecideHelperToolAction(...args),
  mirrorElevationDecisionToExecution: vi.fn(),
}));

const mockCreateActionIntent = vi.fn();
const mockWaitForIntentDecision = vi.fn();
const mockTransitionIntent = vi.fn();
vi.mock('./actionIntents/intentService', () => ({
  createActionIntent: (...args: unknown[]) => mockCreateActionIntent(...args),
  waitForIntentDecision: (...args: unknown[]) => mockWaitForIntentDecision(...args),
  transitionIntent: (...args: unknown[]) => mockTransitionIntent(...args),
}));

// Mocked as a collaborator (like intentService): the inline release path calls
// this to re-prove the requester's authorization before executing. Also cuts
// the real module's ../aiTools import chain (which would otherwise drag in
// aiToolSchemas' drizzle-enum schemas the ../db/schema mock doesn't provide).
// Default: still authorized. Fail-path tests override the resolved value.
// Typed as the real discriminated union (not a loosened `{ ok, auth }`
// shape) so a test can legitimately assert the `{ ok: false; errorCode }`
// failure arm without a type-checker escape hatch.
const mockRevalidateApprovedIntentForRelease = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ ok: true, auth: {} } as IntentReleaseRevalidation),
);
const mockRequiresDurableRelease = vi.fn((_name: string) => false);
vi.mock('./actionIntents/durableRelease', () => ({
  requiresDurableRelease: (name: string) => mockRequiresDurableRelease(name),
  DURABLE_RELEASE_ONLY_TOOLS: new Set<string>(),
}));

vi.mock('./actionIntents/revalidateRelease', () => ({
  revalidateApprovedIntentForRelease: (...args: unknown[]) =>
    mockRevalidateApprovedIntentForRelease(...args),
}));

// Real actionIntents schema is imported by aiAgentSdk for the inline system
// read; the ../db/schema mock above only stubs approvalRequests, so stub the
// actionIntents table object the query builder references here too.
vi.mock('../db/schema/actionIntents', () => ({
  actionIntents: { id: 'id', status: 'status' },
}));

// Real (unmocked) module: TEMP_PASSWORD_ENC_KEY is a plain string constant,
// no DB/network surface, and asserting against the real value pins the
// actual key resultSecrets.ts uses rather than a test-local guess.
const mockCaptureException = vi.fn();
vi.mock('./sentry', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

// ============================================
// Test helpers
// ============================================

type TestAuth = {
  user: { id: string; email: string; name: string };
  orgId: string;
  scope: string;
  accessibleOrgIds: string[];
  canAccessOrg: (orgId: string) => boolean;
  orgCondition: () => null;
};

function makeAuth(overrides?: Partial<TestAuth>) {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    orgId: 'org-1',
    scope: 'org',
    accessibleOrgIds: ['org-1'],
    canAccessOrg: () => true,
    orgCondition: () => null,
    ...overrides,
  } as any;
}

function makeSession(overrides?: Record<string, unknown>) {
  return {
    id: 'session-1',
    orgId: 'org-1',
    userId: 'user-1',
    status: 'active',
    turnCount: 0,
    maxTurns: 50,
    systemPrompt: 'existing system prompt',
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };
}

function mockInsertValues() {
  const values = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.insert).mockReturnValue({ values } as any);
  return values;
}

function mockInsertReturning(row: Record<string, unknown>) {
  const returning = vi.fn().mockResolvedValue([row]);
  const values = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.insert).mockReturnValue({ values } as any);
  return { values, returning };
}

function makeActiveSession(overrides: Record<string, unknown> = {}) {
  return {
    breezeSessionId: 'session-1',
    orgId: 'org-1',
    auth: makeAuth({ scope: 'organization' }),
    approvalMode: 'per_step',
    isPaused: false,
    eventBus: { publish: vi.fn() },
    abortController: new AbortController(),
    activePlanId: null,
    approvedPlanSteps: new Map(),
    currentPlanStepIndex: 0,
    toolUseIdQueue: ['tool-use-1'],
    auditSnapshot: null,
    allowedTools: undefined,
    ...overrides,
  } as any;
}

// Typed as the real snapshot so an omitted field is a COMPILE error rather
// than a silently-undefined property: the untyped literal is what let the
// four-eyes → SSE hop (`selfApprovalRequestId`) go untested entirely.
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
    // Default is the FOUR-EYES case: the requester holds no approval row.
    requesterApprovalRequestId: null,
    ...overrides,
  };
}

/** The approval_required event the SDK published on this session. */
function publishedApprovalRequired(session: { eventBus: { publish: ReturnType<typeof vi.fn> } }) {
  const call = session.eventBus.publish.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((e) => e.type === 'approval_required');
  expect(call).toBeDefined();
  return call!;
}

// ============================================
// Tests
// ============================================

describe('runPreFlightChecks', () => {
  const auth = makeAuth();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(makeSession());
    mockCheckAiRateLimit.mockResolvedValue(null);
    mockCheckBudget.mockResolvedValue(null);
    mockSanitizeUserMessage.mockReturnValue({ sanitized: 'hello', flags: [] });
    mockBuildSystemPrompt.mockResolvedValue('system prompt');
    mockGetRemainingBudgetUsd.mockResolvedValue(10.0);
  });

  // --- Session ---

  it('returns error when session is not found', async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await runPreFlightChecks('bad-id', 'hello', auth);
    expect(result).toEqual({ ok: false, error: 'Session not found' });
  });

  // --- Rate limits use session's org, not auth's org ---

  it('passes session orgId (not auth orgId) to rate limit check', async () => {
    const sessionOrg = 'org-session-99';
    mockGetSession.mockResolvedValue(makeSession({ orgId: sessionOrg }));
    mockCheckAiRateLimit.mockResolvedValue(null);

    await runPreFlightChecks('session-1', 'hello', auth);

    expect(mockCheckAiRateLimit).toHaveBeenCalledWith(auth.user.id, sessionOrg);
  });

  it('returns error when rate limit is hit', async () => {
    mockCheckAiRateLimit.mockResolvedValue('Rate limit exceeded');
    const result = await runPreFlightChecks('session-1', 'hello', auth);
    expect(result).toEqual({ ok: false, error: 'Rate limit exceeded' });
  });

  it('returns error when rate limit check throws', async () => {
    mockCheckAiRateLimit.mockRejectedValue(new Error('Redis down'));
    const result = await runPreFlightChecks('session-1', 'hello', auth);
    expect(result).toEqual({ ok: false, error: 'Unable to verify rate limits. Please try again.' });
  });

  // --- Budget uses session's org ---

  it('passes session orgId (not auth orgId) to budget check', async () => {
    const sessionOrg = 'org-session-99';
    mockGetSession.mockResolvedValue(makeSession({ orgId: sessionOrg }));
    mockCheckBudget.mockResolvedValue(null);

    await runPreFlightChecks('session-1', 'hello', auth);

    expect(mockCheckBudget).toHaveBeenCalledWith(sessionOrg);
  });

  it('returns error when budget is exceeded', async () => {
    mockCheckBudget.mockResolvedValue('Monthly budget exhausted');
    const result = await runPreFlightChecks('session-1', 'hello', auth);
    expect(result).toEqual({ ok: false, error: 'Monthly budget exhausted' });
  });

  it('returns error when budget check throws', async () => {
    mockCheckBudget.mockRejectedValue(new Error('DB error'));
    const result = await runPreFlightChecks('session-1', 'hello', auth);
    expect(result).toEqual({ ok: false, error: 'Unable to verify budget. Please try again.' });
  });

  // --- Session status ---

  it('returns error when session is not active', async () => {
    mockGetSession.mockResolvedValue(makeSession({ status: 'closed' }));
    const result = await runPreFlightChecks('session-1', 'hello', auth);
    expect(result).toEqual({ ok: false, error: 'Session is not active' });
  });

  // --- Turn limit ---

  it('returns error when turn limit is reached', async () => {
    mockGetSession.mockResolvedValue(makeSession({ turnCount: 50, maxTurns: 50 }));
    const result = await runPreFlightChecks('session-1', 'hello', auth);
    expect(result).toEqual({ ok: false, error: 'Session turn limit reached (50)' });
  });

  it('returns error when turn count exceeds max', async () => {
    mockGetSession.mockResolvedValue(makeSession({ turnCount: 55, maxTurns: 50 }));
    const result = await runPreFlightChecks('session-1', 'hello', auth);
    expect(result).toEqual({ ok: false, error: 'Session turn limit reached (50)' });
  });

  // --- Session age expiration ---

  it('returns error and marks session expired when older than 24h', async () => {
    const createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    mockGetSession.mockResolvedValue(makeSession({ createdAt, lastActivityAt: new Date() }));

    const mockSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

    const result = await runPreFlightChecks('session-1', 'hello', auth);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('expired');
      expect(result.error).toContain('24h');
    }
    expect(db.update).toHaveBeenCalled();
  });

  // --- Idle timeout ---

  it('returns error and marks session expired when idle for 2h+', async () => {
    const lastActivityAt = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h idle
    mockGetSession.mockResolvedValue(makeSession({ lastActivityAt }));

    const mockSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

    const result = await runPreFlightChecks('session-1', 'hello', auth);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('inactivity');
    }
    expect(db.update).toHaveBeenCalled();
  });

  // --- Input sanitization ---

  it('writes audit event when sanitization flags are raised', async () => {
    mockSanitizeUserMessage.mockReturnValue({ sanitized: 'cleaned', flags: ['prompt_injection'] });
    const reqCtx = { headers: {} } as any;

    const result = await runPreFlightChecks('session-1', 'ignore previous', auth, undefined, reqCtx);

    expect(result.ok).toBe(true);
    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      reqCtx,
      expect.objectContaining({
        action: 'ai.security.prompt_injection_detected',
        resourceType: 'ai_session',
      }),
    );
  });

  it('does not write audit event when no request context provided', async () => {
    mockSanitizeUserMessage.mockReturnValue({ sanitized: 'cleaned', flags: ['prompt_injection'] });

    await runPreFlightChecks('session-1', 'ignore previous', auth);

    expect(mockWriteAuditEvent).not.toHaveBeenCalled();
  });

  // --- Page context sanitization failure ---

  it('falls back to session system prompt when page context sanitization throws', async () => {
    const pageContext = { type: 'device', id: 'dev-1', hostname: 'test' } as any;
    mockSanitizePageContext.mockImplementation(() => { throw new Error('bad context'); });
    mockGetSession.mockResolvedValue(makeSession({ systemPrompt: 'saved prompt' }));

    const result = await runPreFlightChecks('session-1', 'hello', auth, pageContext);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.systemPrompt).toBe('saved prompt');
    }
    // Should NOT have called buildSystemPrompt with the failed page context
    expect(mockBuildSystemPrompt).not.toHaveBeenCalledWith(auth, pageContext);
  });

  it('writes audit event on page context sanitization failure when request context present', async () => {
    const pageContext = { type: 'device', id: 'dev-1', hostname: 'test' } as any;
    const reqCtx = { headers: {} } as any;
    mockSanitizePageContext.mockImplementation(() => { throw new Error('xss detected'); });

    await runPreFlightChecks('session-1', 'hello', auth, pageContext, reqCtx);

    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      reqCtx,
      expect.objectContaining({
        action: 'ai.security.page_context_sanitization_failed',
        result: 'failure',
        errorMessage: 'xss detected',
      }),
    );
  });

  // --- System prompt ---

  it('uses buildSystemPrompt with sanitized page context when provided', async () => {
    const pageContext = { type: 'device', id: 'dev-1', hostname: 'test' } as any;
    const sanitizedCtx = { type: 'device', id: 'dev-1', hostname: 'sanitized' } as any;
    mockSanitizePageContext.mockReturnValue(sanitizedCtx);
    mockBuildSystemPrompt.mockResolvedValue('contextual prompt');

    const result = await runPreFlightChecks('session-1', 'hello', auth, pageContext);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.systemPrompt).toBe('contextual prompt');
    }
    expect(mockBuildSystemPrompt).toHaveBeenCalledWith(auth, sanitizedCtx);
  });

  it('falls back to session systemPrompt when no page context', async () => {
    mockGetSession.mockResolvedValue(makeSession({ systemPrompt: 'stored prompt' }));

    const result = await runPreFlightChecks('session-1', 'hello', auth);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.systemPrompt).toBe('stored prompt');
    }
    // No page context → should not call buildSystemPrompt at all
    expect(mockBuildSystemPrompt).not.toHaveBeenCalled();
  });

  it('calls buildSystemPrompt(auth) when no page context and no stored systemPrompt', async () => {
    mockGetSession.mockResolvedValue(makeSession({ systemPrompt: null }));
    mockBuildSystemPrompt.mockResolvedValue('default prompt');

    const result = await runPreFlightChecks('session-1', 'hello', auth);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.systemPrompt).toBe('default prompt');
    }
    expect(mockBuildSystemPrompt).toHaveBeenCalledWith(auth);
  });

  // --- Remaining budget ---

  it('returns remaining budget as maxBudgetUsd', async () => {
    mockGetRemainingBudgetUsd.mockResolvedValue(42.5);

    const result = await runPreFlightChecks('session-1', 'hello', auth);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.maxBudgetUsd).toBe(42.5);
    }
  });

  it('sets maxBudgetUsd to undefined when remaining budget is null', async () => {
    mockGetRemainingBudgetUsd.mockResolvedValue(null);

    const result = await runPreFlightChecks('session-1', 'hello', auth);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.maxBudgetUsd).toBeUndefined();
    }
  });

  it('returns error when getRemainingBudgetUsd throws', async () => {
    mockGetRemainingBudgetUsd.mockRejectedValue(new Error('DB timeout'));

    const result = await runPreFlightChecks('session-1', 'hello', auth);

    expect(result).toEqual({ ok: false, error: 'Unable to verify spending budget. Please try again later.' });
  });

  // --- Successful result ---

  it('returns all fields on successful pre-flight', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);
    mockSanitizeUserMessage.mockReturnValue({ sanitized: 'clean input', flags: [] });
    mockGetRemainingBudgetUsd.mockResolvedValue(25.0);

    const result = await runPreFlightChecks('session-1', 'hello', auth);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session).toEqual(session);
      expect(result.sanitizedContent).toBe('clean input');
      expect(result.systemPrompt).toBeDefined();
      expect(result.maxBudgetUsd).toBe(25.0);
    }
  });
});

// ============================================
// createSessionPreToolUse
// ============================================

describe('createSessionPreToolUse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    mockGetUserPushTokens.mockResolvedValue([]);
    mockDispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
  });

  it('auto-approve allows Tier 2 tools and creates an executing audit record', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 2,
      requiresApproval: false,
      description: 'Take screenshot',
    } as any);
    const values = mockInsertValues();
    const session = makeActiveSession({ approvalMode: 'auto_approve' });

    const result = await createSessionPreToolUse(session)('take_screenshot', { deviceId: 'device-1' });

    expect(result).toEqual({ allowed: true });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      toolName: 'take_screenshot',
      status: 'executing',
    }));
    expect(waitForApproval).not.toHaveBeenCalled();
  });

  describe('Tier 3: durable action-intents backing (spec §6.1)', () => {
    beforeEach(() => {
      mockCreateActionIntent.mockReset();
      mockWaitForIntentDecision.mockReset();
      mockTransitionIntent.mockReset();
      mockRevalidateApprovedIntentForRelease.mockReset();
      mockRevalidateApprovedIntentForRelease.mockResolvedValue({ ok: true, auth: {} } as IntentReleaseRevalidation);
      // Default chainable for the inline release-win system read (loads the
      // intent row + winning approval before revalidation). Revalidation itself
      // is mocked above, so the row contents only need to be non-null.
      const selectChain: Record<string, unknown> = {
        from: vi.fn(() => selectChain),
        where: vi.fn(() => selectChain),
        limit: vi.fn(async () => [{ id: 'intent', boundArgumentDigest: 'digest' }]),
      };
      vi.mocked(db.select).mockReturnValue(selectChain as any);
    });

    it('creates a chat-sourced action intent and blocks on waitForIntentDecision, even under auto-approve', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3,
        requiresApproval: true,
        description: 'Execute command',
      } as any);
      mockInsertReturning({ id: 'exec-1' });
      mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-1', approvalRequestIds: ['appr-1'] }));
      mockWaitForIntentDecision.mockResolvedValue('rejected');
      const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);
      const session = makeActiveSession({ approvalMode: 'auto_approve' });

      const result = await createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });

      expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected, cancelled, or expired' });
      expect(mockCreateActionIntent).toHaveBeenCalledWith(session.auth, expect.objectContaining({
        toolName: 'execute_command',
        input: { deviceId: 'd-1' },
        source: 'chat',
        reason: 'Execute command',
        orgId: 'org-1',
      }));
      // The ledger row is stamped with the intent id so handleApproval can
      // detect it's intent-backed (CRITICAL-3).
      expect(mockSet).toHaveBeenCalledWith({ intentId: 'intent-1' });
      expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
        type: 'approval_required',
        executionId: 'exec-1',
        approvalRequestId: 'appr-1',
        toolName: 'execute_command',
        intentBacked: true,
      }));
      expect(mockWaitForIntentDecision).toHaveBeenCalledWith('intent-1', 300_000, expect.any(AbortSignal));
      // The old direct approval_requests bridge + push are gone — createActionIntent owns both now.
      expect(mockGetUserPushTokens).not.toHaveBeenCalled();
      expect(mockDispatchApprovalPushToTokens).not.toHaveBeenCalled();
    });

    it('four-eyes: publishes NO selfApprovalRequestId when the requester holds no approval row', async () => {
      // The requester must never be handed a self-approve button (nor another
      // approver's row id) in a multi-approver org. objectContaining cannot
      // fail on a wrong value here, so assert the exact field.
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3,
        requiresApproval: true,
        description: 'Execute command',
      } as any);
      mockInsertReturning({ id: 'exec-fe' });
      mockCreateActionIntent.mockResolvedValue(
        makeIntentSnapshot({
          id: 'intent-fe',
          approvalRequestIds: ['appr-a', 'appr-b'],
          requesterApprovalRequestId: null,
        }),
      );
      mockWaitForIntentDecision.mockResolvedValue('rejected');
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      } as any);
      const session = makeActiveSession({ approvalMode: 'per_step' });

      await createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });

      const event = publishedApprovalRequired(session);
      expect(event.intentBacked).toBe(true);
      expect(event.selfApprovalRequestId).toBeUndefined();
    });

    it('sole operator: publishes the REQUESTER’s row id, not the first fanned-out row', async () => {
      // The two ids differ deliberately: with identical values this assertion
      // would still pass against `approvalRequestIds[0]`, which is exactly the
      // four-eyes-breaking mutation this test exists to kill.
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3,
        requiresApproval: true,
        description: 'Execute command',
      } as any);
      mockInsertReturning({ id: 'exec-solo' });
      mockCreateActionIntent.mockResolvedValue(
        makeIntentSnapshot({
          id: 'intent-solo',
          approvalRequestIds: ['appr-1'],
          requesterApprovalRequestId: 'appr-solo',
        }),
      );
      mockWaitForIntentDecision.mockResolvedValue('rejected');
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      } as any);
      const session = makeActiveSession({ approvalMode: 'per_step' });

      await createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });

      const event = publishedApprovalRequired(session);
      expect(event.selfApprovalRequestId).toBe('appr-solo');
      expect(event.approvalRequestId).toBe('appr-1');
    });

    it('executes inline when the session wins the approved -> executing release CAS', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3,
        requiresApproval: true,
        description: 'Execute command on host-1',
      } as any);
      mockInsertReturning({ id: 'exec-2' });
      mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-2', approvalRequestIds: ['appr-2'] }));
      mockWaitForIntentDecision.mockResolvedValue('approved');
      mockTransitionIntent.mockResolvedValue(true);
      const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);
      const session = makeActiveSession({ approvalMode: 'per_step' });

      const result = await createSessionPreToolUse(session)('execute_command', { deviceId: 'd-1' });

      // The tier-3 branch now threads the created intent id back on the
      // terminal return (Task 6) — this is what lets postToolUse seal
      // against the right intent without relying solely on the WeakMap.
      expect(result).toEqual({ allowed: true, intentId: 'intent-2' });
      expect(mockTransitionIntent).toHaveBeenCalledWith('intent-2', 'approved', 'executing', expect.objectContaining({ executedAt: null, executionStartedAt: expect.any(Date) }), { requireNotExpired: true });
      // ai_tool_executions ledger row marked executing (the inline path today's UX).
      expect(mockSet).toHaveBeenCalledWith({ status: 'executing' });
    });

    it('does NOT execute inline when the session loses the release CAS to the durable worker (no double execution)', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3,
        requiresApproval: true,
        description: 'Execute command',
      } as any);
      mockInsertReturning({ id: 'exec-3' });
      mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-3', approvalRequestIds: ['appr-3'] }));
      mockWaitForIntentDecision.mockResolvedValue('approved');
      mockTransitionIntent.mockResolvedValue(false);
      const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);
      const session = makeActiveSession({ approvalMode: 'per_step' });

      const result = await createSessionPreToolUse(session)('execute_command', {});

      expect(result).toEqual({
        allowed: false,
        error: 'This action is already being completed by the approval worker; it will not run twice.',
      });
      expect(mockTransitionIntent).toHaveBeenCalledWith('intent-3', 'approved', 'executing', expect.objectContaining({ executedAt: null, executionStartedAt: expect.any(Date) }), { requireNotExpired: true });
      // The intent-id link stamp (unconditional, ahead of the release CAS)
      // still happens, but no inline execution: the "mark as executing"
      // update never fires.
      expect(mockSet).toHaveBeenCalledWith({ intentId: 'intent-3' });
      expect(mockSet).not.toHaveBeenCalledWith({ status: 'executing' });
    });

    it('returns allowed:false without touching the intent when rejected/cancelled/expired', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3,
        requiresApproval: true,
        description: 'Execute command',
      } as any);
      mockInsertReturning({ id: 'exec-4' });
      mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-4', approvalRequestIds: ['appr-4'] }));
      mockWaitForIntentDecision.mockResolvedValue('expired');
      const session = makeActiveSession({ approvalMode: 'per_step' });

      const result = await createSessionPreToolUse(session)('execute_command', {});

      expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected, cancelled, or expired' });
      expect(mockTransitionIntent).not.toHaveBeenCalled();
    });

    it('leaves the intent pending_approval on a chat timeout — durable, no mutation', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3,
        requiresApproval: true,
        description: 'Execute command',
      } as any);
      mockInsertReturning({ id: 'exec-5' });
      mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-5', approvalRequestIds: ['appr-5'] }));
      mockWaitForIntentDecision.mockResolvedValue('pending_approval');
      const session = makeActiveSession({ approvalMode: 'per_step' });

      const result = await createSessionPreToolUse(session)('execute_command', {});

      // No plan is active on this session, so nothing was stopped — the
      // "plan has been stopped" clause must NOT appear (Important 1 fix:
      // that sentence is now appended only when failMatchedPlanStep actually
      // aborts a plan).
      expect(result).toEqual({
        allowed: false,
        error: 'Approval still pending; this action will complete once approved.',
      });
      // The intent is left exactly as-is: no release CAS attempted.
      expect(mockTransitionIntent).not.toHaveBeenCalled();
    });

    it('CASes the intent executing -> completed once the inline tool call finishes successfully', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3,
        requiresApproval: true,
        description: 'Execute command',
      } as any);
      mockInsertReturning({ id: 'exec-6' });
      mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-6', approvalRequestIds: ['appr-6'] }));
      mockWaitForIntentDecision.mockResolvedValue('approved');
      mockTransitionIntent.mockResolvedValue(true);
      const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);
      const session = makeActiveSession({ approvalMode: 'per_step' });

      const preResult = await createSessionPreToolUse(session)('execute_command', {});
      expect(preResult).toEqual({ allowed: true, intentId: 'intent-6' });

      mockTransitionIntent.mockClear();
      const postToolUse = createSessionPostToolUse(session);
      await postToolUse('execute_command', {}, JSON.stringify({ status: 'completed' }), false, 10);

      expect(mockTransitionIntent).toHaveBeenCalledWith('intent-6', 'executing', 'completed', expect.objectContaining({
        executedAt: expect.any(Date),
        result: expect.objectContaining({ status: 'completed' }),
      }));
    });

    it('CASes the intent executing -> failed with an error code when the inline tool call fails', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3,
        requiresApproval: true,
        description: 'Execute command',
      } as any);
      mockInsertReturning({ id: 'exec-7' });
      mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-7', approvalRequestIds: ['appr-7'] }));
      mockWaitForIntentDecision.mockResolvedValue('approved');
      mockTransitionIntent.mockResolvedValue(true);
      const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);
      const session = makeActiveSession({ approvalMode: 'per_step' });

      const preResult = await createSessionPreToolUse(session)('execute_command', {});
      expect(preResult).toEqual({ allowed: true, intentId: 'intent-7' });

      mockTransitionIntent.mockClear();
      const postToolUse = createSessionPostToolUse(session);
      await postToolUse('execute_command', {}, JSON.stringify({ error: 'boom' }), true, 10);

      // error_code is a stable, categorized short code (matches the durable
      // release worker's vocabulary) — never the raw, unbounded tool error
      // text. The raw message still lands in `result` for diagnosis.
      expect(mockTransitionIntent).toHaveBeenCalledWith('intent-7', 'executing', 'failed', expect.objectContaining({
        executedAt: expect.any(Date),
        errorCode: 'tool_execution_failed',
        result: expect.objectContaining({ error: 'boom' }),
      }));
    });

    it('does not touch any intent from postToolUse when this session never won an inline release CAS', async () => {
      // Tier >= 2 so postToolUse takes the update branch that checks
      // pendingIntentBySession — but preToolUse was never called on this
      // session (e.g. a Tier-2 auto-approve execution, or a Tier-3 call that
      // lost the CAS / timed out earlier), so nothing should have been
      // tracked for it.
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 2,
        requiresApproval: false,
      } as any);
      const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);
      mockInsertValues();
      const session = makeActiveSession();
      const postToolUse = createSessionPostToolUse(session);

      await postToolUse('take_screenshot', {}, JSON.stringify({ status: 'completed' }), false, 5);

      expect(mockTransitionIntent).not.toHaveBeenCalled();
    });
  });

  describe('Tier 2 per_step: legacy lightweight approval bridge (regression fix)', () => {
    beforeEach(() => {
      mockCreateActionIntent.mockReset();
      mockWaitForIntentDecision.mockReset();
      mockTransitionIntent.mockReset();
    });

    it('inserts a linked approval_requests row, waits via waitForApproval, and executes on approve — WITHOUT creating an action intent', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 2,
        requiresApproval: false,
        description: 'Take screenshot',
      } as any);
      const { values } = mockInsertReturning({ id: 'exec-2' });
      mockGetUserPushTokens.mockResolvedValue([
        { token: 'ExponentPushToken[abc]', platform: 'ios', provider: 'expo' },
      ]);
      mockDispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 1, dispatched: 1, errors: 0 });
      vi.mocked(waitForApproval).mockResolvedValue(true);
      const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);
      const session = makeActiveSession({ approvalMode: 'per_step' });

      const result = await createSessionPreToolUse(session)('take_screenshot', { deviceId: 'd-1' });

      expect(result).toEqual({ allowed: true });

      // Both inserts fire: ai_tool_executions THEN approval_requests (old
      // direct bridge — NOT createActionIntent).
      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        toolName: 'take_screenshot',
        status: 'pending',
      }));
      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        executionId: 'exec-2',
        requestingClientLabel: 'Breeze AI',
        actionToolName: 'take_screenshot',
        riskTier: 'medium',
        status: 'pending',
      }));

      // Push dispatched (best-effort), same as the pre-Task-8 behavior.
      expect(mockGetUserPushTokens).toHaveBeenCalledWith('user-1');
      expect(mockDispatchApprovalPushToTokens).toHaveBeenCalled();

      expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
        type: 'approval_required',
        executionId: 'exec-2',
        toolName: 'take_screenshot',
        description: 'Take screenshot',
      }));
      // Legacy Tier-2 per_step bridge is NOT intent-backed — the web chat
      // card must still show a normal self-approve button for this one.
      const publishedEvent = vi.mocked(session.eventBus.publish).mock.calls
        .map(([evt]: [any]) => evt)
        .find((evt: any) => evt.type === 'approval_required');
      expect((publishedEvent as any)?.intentBacked).toBeUndefined();

      expect(waitForApproval).toHaveBeenCalledWith('exec-2', 300_000, expect.any(AbortSignal));
      expect(mockSet).toHaveBeenCalledWith({ status: 'executing' });

      // THE REGRESSION: Tier 2 under per_step must never route through the
      // durable action-intents layer — createActionIntent throws
      // ActionIntentTierError('tool_not_tier3') for anything below Tier 3.
      expect(mockCreateActionIntent).not.toHaveBeenCalled();
      expect(mockWaitForIntentDecision).not.toHaveBeenCalled();
      expect(mockTransitionIntent).not.toHaveBeenCalled();
    });

    it('returns allowed:false without creating an action intent when rejected or timed out', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 2,
        requiresApproval: false,
        description: 'Take screenshot',
      } as any);
      mockInsertReturning({ id: 'exec-3' });
      mockGetUserPushTokens.mockResolvedValue([]);
      vi.mocked(waitForApproval).mockResolvedValue(false);
      const session = makeActiveSession({ approvalMode: 'per_step' });

      const result = await createSessionPreToolUse(session)('take_screenshot', {});

      expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
      expect(mockCreateActionIntent).not.toHaveBeenCalled();
    });

    it('does not register the session in pendingIntentBySession, so the postToolUse completion-CAS stays a no-op', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 2,
        requiresApproval: false,
        description: 'Take screenshot',
      } as any);
      mockInsertReturning({ id: 'exec-4' });
      mockGetUserPushTokens.mockResolvedValue([]);
      vi.mocked(waitForApproval).mockResolvedValue(true);
      const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);
      const session = makeActiveSession({ approvalMode: 'per_step' });

      const preResult = await createSessionPreToolUse(session)('take_screenshot', {});
      expect(preResult).toEqual({ allowed: true });

      mockTransitionIntent.mockClear();
      const postToolUse = createSessionPostToolUse(session);
      await postToolUse('take_screenshot', {}, JSON.stringify({ status: 'completed' }), false, 5);

      expect(mockTransitionIntent).not.toHaveBeenCalled();
    });
  });

  it('blocks tools outside the session allowlist before approval handling', async () => {
    const session = makeActiveSession({
      approvalMode: 'auto_approve',
      allowedTools: ['mcp__breeze__query_devices'],
    });

    const result = await createSessionPreToolUse(session)('execute_command', {});

    expect(result).toEqual({
      allowed: false,
      error: "Tool 'execute_command' is not allowed for this session",
    });
    expect(checkGuardrails).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  describe('helper sessions (PAM governance, Phase 1)', () => {
    function makeHelperSession(overrides: Record<string, unknown> = {}) {
      return makeActiveSession({
        auth: makeAuth({
          scope: 'organization',
          helperDeviceId: 'device-7',
          user: { id: 'device-7', email: 'helper@host-01', name: 'HOST-01' },
        } as any),
        approvalMode: 'per_step',
        ...overrides,
      });
    }

    it('routes tier-2 tools through PAM governance, skipping the approval_requests bridge and push', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 2,
        requiresApproval: false,
        description: 'Take screenshot',
      } as any);
      const { values } = mockInsertReturning({ id: 'exec-h1' });
      mockDecideHelperToolAction.mockResolvedValue('pending');
      vi.mocked(waitForApproval).mockResolvedValue(true);
      const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);
      const session = makeHelperSession();

      const result = await createSessionPreToolUse(session)('take_screenshot', { deviceId: 'forged' });

      expect(result).toEqual({ allowed: true });
      // Only the ai_tool_executions insert — NO approval_requests row.
      expect(values).toHaveBeenCalledTimes(1);
      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        toolName: 'take_screenshot',
        status: 'pending',
      }));
      expect(mockGetUserPushTokens).not.toHaveBeenCalled();
      expect(mockDispatchApprovalPushToTokens).not.toHaveBeenCalled();

      expect(mockDecideHelperToolAction).toHaveBeenCalledWith({
        orgId: 'org-1',
        deviceId: 'device-7',
        executionId: 'exec-h1',
        toolName: 'take_screenshot',
        toolInput: { deviceId: 'forged' },
        riskTier: 2,
        subjectUsername: 'HOST-01',
      });

      // SSE event marks the approval as admin-side.
      expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
        type: 'approval_required',
        executionId: 'exec-h1',
        requiresAdminApproval: true,
      }));

      expect(waitForApproval).toHaveBeenCalledWith('exec-h1', 300_000, expect.any(AbortSignal));
      // Marked executing after approval.
      expect(mockSet).toHaveBeenCalledWith({ status: 'executing' });
    });

    it('policy auto-deny short-circuits without waiting', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3,
        requiresApproval: true,
        description: 'Execute command',
      } as any);
      mockInsertReturning({ id: 'exec-h2' });
      mockDecideHelperToolAction.mockResolvedValue('denied');
      const session = makeHelperSession();

      const result = await createSessionPreToolUse(session)('execute_command', {});

      expect(result).toEqual({
        allowed: false,
        error: 'This action was denied by organization policy',
      });
      expect(waitForApproval).not.toHaveBeenCalled();
    });

    it('rejection or timeout after pending decision denies the tool', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3,
        requiresApproval: true,
        description: 'Execute command',
      } as any);
      mockInsertReturning({ id: 'exec-h3' });
      mockDecideHelperToolAction.mockResolvedValue('pending');
      vi.mocked(waitForApproval).mockResolvedValue(false);
      const session = makeHelperSession();

      const result = await createSessionPreToolUse(session)('execute_command', {});

      expect(result).toEqual({
        allowed: false,
        error: 'Tool execution was rejected or timed out awaiting administrator approval',
      });
    });

    it('auto_approve session mode cannot bypass PAM for helper sessions', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 2,
        requiresApproval: false,
        description: 'Take screenshot',
      } as any);
      const { values } = mockInsertReturning({ id: 'exec-h4' });
      mockDecideHelperToolAction.mockResolvedValue('auto_approved');
      vi.mocked(waitForApproval).mockResolvedValue(true);
      const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);
      const session = makeHelperSession({ approvalMode: 'auto_approve' });

      const result = await createSessionPreToolUse(session)('take_screenshot', {});

      expect(result).toEqual({ allowed: true });
      // Went through governance, not the auto-approve 'executing' fast path.
      expect(mockDecideHelperToolAction).toHaveBeenCalled();
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
      expect(waitForApproval).toHaveBeenCalled();
    });
  });

  it('matches session allowlists across MCP server prefixes', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 2,
      requiresApproval: false,
      description: 'Execute allowed custom tool',
    } as any);
    const values = mockInsertValues();
    const session = makeActiveSession({
      approvalMode: 'auto_approve',
      allowedTools: ['mcp__script_builder__take_screenshot'],
    });

    const result = await createSessionPreToolUse(session)('take_screenshot', {});

    expect(result).toEqual({ allowed: true });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'take_screenshot',
      status: 'executing',
    }));
  });

  describe('plan-step shortcut is gated on effective tier', () => {
    // A "still shortcuts an effective-tier-1 step" case originally lived here.
    // Removed: tier 1 never enters the `guardrailCheck.tier >= 2` block at
    // all (:313), so the whole plan-shortcut code path — gate included — is
    // unreached. The assertions (`allowed:true`, createActionIntent not
    // called) would pass identically with the gate deleted, the plan block
    // deleted, or the gate set to `tier < 0`; it proved nothing about this
    // change. The real "shortcut still works for an eligible tool" case is
    // covered below by "still takes the plan shortcut for a non-secret,
    // effective-tier-2 tool".
    it.each(['action_plan', 'hybrid_plan'] as const)(
      'does NOT shortcut a statically-tier-3 step in %s mode',
      async (mode) => {
        vi.mocked(checkGuardrails).mockReturnValue({
          allowed: true,
          tier: 3,
          requiresApproval: true,
          description: 'Execute command',
        } as any);
        mockInsertReturning({ id: 'exec-gate-1' });
        mockCreateActionIntent.mockResolvedValue(
          makeIntentSnapshot({ id: 'intent-gate-1', approvalRequestIds: ['appr-gate-1'] }),
        );
        mockWaitForIntentDecision.mockResolvedValue('rejected');
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
        } as any);
        const session = makeActiveSession({
          approvalMode: mode,
          activePlanId: 'plan-1',
          approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
        });

        await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

        expect(mockCreateActionIntent).toHaveBeenCalled();
      },
    );

    // THE test that distinguishes a correct implementation from one that reads
    // the base TOOL_TIERS map: file_operations is tier 1 statically and tier 3
    // only because action === 'read' is in TIER3_ACTIONS (aiGuardrails.ts:89-126).
    it('does NOT shortcut an ACTION-ESCALATED tier-3 step', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3, // effective tier, post action-escalation
        requiresApproval: true,
        description: 'Read file',
      } as any);
      mockInsertReturning({ id: 'exec-gate-2' });
      mockCreateActionIntent.mockResolvedValue(
        makeIntentSnapshot({ id: 'intent-gate-2', approvalRequestIds: ['appr-gate-2'] }),
      );
      mockWaitForIntentDecision.mockResolvedValue('rejected');
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      } as any);
      const session = makeActiveSession({
        approvalMode: 'action_plan',
        activePlanId: 'plan-1',
        approvedPlanSteps: new Map([
          [0, { toolName: 'file_operations', input: { action: 'read', path: '/etc/shadow' } }],
        ]),
      });

      await createSessionPreToolUse(session)('file_operations', { action: 'read', path: '/etc/shadow' });

      expect(mockCreateActionIntent).toHaveBeenCalled();
    });

    // Proves the retained `!isSecretBearingTool(toolName)` clause actually
    // discriminates: every other secret-bearing test in this file runs at
    // effective tier 3, where `guardrailCheck.tier < 3` alone already blocks
    // the shortcut (design doc
    // docs/superpowers/specs/ai-mcp/2026-07-27-tier3-plan-mode-approval-parity-design.md
    // §3.1) — deleting `&& !isSecretBearingTool(toolName)` would leave every
    // one of them green. Tier 2 here is the only tier at which the clause is
    // the SOLE thing standing between a secret-bearing tool and the
    // shortcut — exactly the "future mis-tiering" defence-in-depth scenario
    // it exists for.
    it('declines the shortcut for a secret-bearing tool even at an eligible (non-tier-3) effective tier', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 2,
        requiresApproval: true,
        description: 'Reset password',
      } as any);
      mockInsertReturning({ id: 'exec-gate-secret-tier2' });
      vi.mocked(waitForApproval).mockResolvedValue(false);
      const session = makeActiveSession({
        approvalMode: 'action_plan',
        activePlanId: 'plan-1',
        approvedPlanSteps: new Map([
          [0, { toolName: 'm365_reset_password', input: { userIdentifier: 'a@b.com' } }],
        ]),
      });

      const result = await createSessionPreToolUse(session)('m365_reset_password', { userIdentifier: 'a@b.com' });

      // tier < 3, so if the isSecretBearingTool clause were removed the
      // shortcut WOULD fire here — this is exactly the case it guards.
      // Tier 2 also never reaches the tier-3 createActionIntent branch (that
      // branch is gated on guardrailCheck.tier >= 3), so the decline falls
      // through to the tier-2 legacy approval bridge instead.
      expect(mockCreateActionIntent).not.toHaveBeenCalled();
      expect(waitForApproval).toHaveBeenCalled();
      expect(session.eventBus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'plan_step_start' }),
      );
      expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
    });
  });
});

// ============================================
// createSessionPostToolUse
// ============================================

describe('createSessionPostToolUse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 1,
      requiresApproval: false,
    } as any);
    mockInsertValues();
  });

  it('sanitizes tool output before SSE, message persistence, and execution persistence', async () => {
    const session = makeActiveSession();
    const callback = createSessionPostToolUse(session);

    await callback('execute_command', { deviceId: 'device-1' }, JSON.stringify({
      status: 'completed',
      stdout: 'token=abc123 password=hunter2',
      secret: 'raw-secret',
    }), false, 12);

    expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result',
      output: expect.objectContaining({
        stdout: expect.stringContaining('[REDACTED]'),
      }),
    }));
    const insertedPayloads = vi.mocked(db.insert).mock.results
      .map((result) => (result.value as any)?.values?.mock?.calls?.[0]?.[0])
      .filter(Boolean);
    expect(JSON.stringify(insertedPayloads)).not.toContain('abc123');
    expect(JSON.stringify(insertedPayloads)).not.toContain('hunter2');
    expect(JSON.stringify(insertedPayloads)).not.toContain('raw-secret');
  });

  // Pull every persisted insert payload (the same `values` mock backs every
  // db.insert() call, so its calls list holds both the aiMessages row and the
  // aiToolExecutions row).
  function persistedInsertPayloads(): any[] {
    const valuesMock = vi.mocked(db.insert).mock.results[0]?.value?.values;
    return (valuesMock?.mock.calls ?? []).map((c: unknown[]) => c[0]);
  }

  // The single tool_result SSE event published to the client.
  function publishedToolResult(session: any): any {
    return vi.mocked(session.eventBus.publish).mock.calls
      .map((c: unknown[]) => c[0] as any)
      .find((e: any) => e?.type === 'tool_result');
  }

  it('re-attaches the raw apply payload to the SSE tool_result for apply_script_code (editor insert), but keeps it out of the LLM-context chat row', async () => {
    const session = makeActiveSession();
    const callback = createSessionPostToolUse(session);
    const code = 'Write-Host "hello from breeze"';

    // makeApplyHandler hands postToolUse the raw args as `input` and a
    // code-less compacted string as `output` (see scriptBuilderTools.ts).
    await callback('apply_script_code', { code, language: 'powershell' }, JSON.stringify({
      applied: true,
      toolName: 'apply_script_code',
      language: 'powershell',
      codeOmitted: true,
      codeChars: code.length,
    }), false, 5);

    // The editor reads `output.code` from this event to insert the script.
    expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result',
      output: expect.objectContaining({ code, language: 'powershell' }),
    }));

    // The aiMessages "tool_result" row is what gets replayed into the LLM
    // context, so it must stay compacted (#568) — the re-attached code lives on
    // the SSE/editor channel only, never the persisted chat row. (The raw body
    // still lives in aiToolExecutions.toolInput for audit; that row is never
    // fed back to the model, so it is out of scope for #568.)
    const chatRow = persistedInsertPayloads().find((p) => p?.role === 'tool_result');
    expect(chatRow, 'aiMessages tool_result row should be persisted').toBeDefined();
    expect(JSON.stringify(chatRow.toolOutput)).not.toContain('hello from breeze');
    expect(chatRow.toolOutput).toMatchObject({ codeOmitted: true });
  });

  it('re-attaches the raw apply payload to the SSE tool_result for apply_script_metadata', async () => {
    const session = makeActiveSession();
    const callback = createSessionPostToolUse(session);

    await callback('apply_script_metadata', { name: 'Disk Cleanup', category: 'Maintenance' }, JSON.stringify({
      applied: true,
      toolName: 'apply_script_metadata',
    }), false, 5);

    expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result',
      output: expect.objectContaining({ name: 'Disk Cleanup', category: 'Maintenance' }),
    }));
  });

  it('resolves MCP-prefixed apply tool names when re-attaching the payload', async () => {
    const session = makeActiveSession();
    const callback = createSessionPostToolUse(session);
    const code = 'Get-Process | Sort-Object CPU';

    await callback('mcp__script_builder__apply_script_code', { code, language: 'powershell' }, JSON.stringify({
      applied: true,
      codeOmitted: true,
      codeChars: code.length,
    }), false, 5);

    expect(publishedToolResult(session)?.output).toMatchObject({ code });
  });

  it('does NOT re-attach the payload when an apply tool result is an error', async () => {
    const session = makeActiveSession();
    const callback = createSessionPostToolUse(session);
    const code = 'irreversible-destructive-command';

    await callback('apply_script_code', { code, language: 'bash' }, JSON.stringify({
      error: 'apply failed',
    }), true, 5);

    // A failed apply must not push code into the editor.
    expect(JSON.stringify(publishedToolResult(session)?.output)).not.toContain(code);
  });

  it('does NOT re-attach input for non-apply tools (the guard is apply-only)', async () => {
    const session = makeActiveSession();
    const callback = createSessionPostToolUse(session);

    await callback('query_devices', { marker: 'NON_APPLY_INPUT_MARKER' }, JSON.stringify({
      status: 'completed',
      total: 0,
    }), false, 5);

    // Raw tool input must never bleed into a non-apply tool's SSE output —
    // only the compacted parsedOutput is published.
    const output = publishedToolResult(session)?.output;
    expect(JSON.stringify(output)).not.toContain('NON_APPLY_INPUT_MARKER');
    expect(output).toMatchObject({ status: 'completed' });
  });

  it('persists delegantToolCallId on the inserted execution row (tier < 2)', async () => {
    const session = makeActiveSession();
    const values = mockInsertValues();
    const callback = createSessionPostToolUse(session);

    await callback('m365_lookup_user', { userIdentifier: 'u1' }, JSON.stringify({
      message: 'M365 user profile: {"id":"u1"}',
      delegantToolCallId: 'tc-123',
    }), false, 12);

    // Two inserts fire (aiMessages then aiToolExecutions); the execution row is
    // the one carrying toolInput.
    const execInsert = values.mock.calls
      .map((c) => c[0])
      .find((v) => v && typeof v === 'object' && 'toolInput' in v);
    expect(execInsert).toBeDefined();
    expect((execInsert as any).delegantToolCallId).toBe('tc-123');
  });

  it('omits delegantToolCallId for non-M365 tool output (no key present)', async () => {
    const session = makeActiveSession();
    const values = mockInsertValues();
    const callback = createSessionPostToolUse(session);

    await callback('execute_command', { deviceId: 'device-1' }, JSON.stringify({
      status: 'completed',
    }), false, 12);

    const execInsert = values.mock.calls
      .map((c) => c[0])
      .find((v) => v && typeof v === 'object' && 'toolInput' in v);
    expect(execInsert).toBeDefined();
    expect((execInsert as any).delegantToolCallId).toBeUndefined();
  });

  it('persists delegantToolCallId on the updated execution row (tier >= 2)', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
    } as any);
    const session = makeActiveSession();
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    vi.mocked(db.update).mockReturnValue({ set } as any);
    const callback = createSessionPostToolUse(session);

    await callback('m365_reset_password', { userIdentifier: 'u1', reason: 'forgot' }, JSON.stringify({
      message: 'Reset the password for u1.',
      delegantToolCallId: 'tc-456',
    }), false, 12);

    const setCall = set.mock.calls.find((c) => c[0] && 'status' in c[0]);
    expect(setCall).toBeDefined();
    expect((setCall![0] as any).delegantToolCallId).toBe('tc-456');
  });
});

// ============================================
// Task 6: routing the sealed secret-bearing result to the intent write
// ============================================

describe('inline secret-bearing completion (Task 6)', () => {
  let mockSet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
    } as any);
    vi.mocked(checkToolPermission).mockResolvedValue(null);
    vi.mocked(checkToolRateLimit).mockResolvedValue(null);
    mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);
    mockInsertValues();
    mockTransitionIntent.mockResolvedValue(true);
  });

  /** Every `db.update(...).set(...)` payload — the aiToolExecutions ledger row. */
  function updateSetPayloads(): unknown[] {
    return mockSet.mock.calls.map((c) => c[0]);
  }

  /** Every SSE event published to the client for this session. */
  function publishedPayloads(session: { eventBus: { publish: ReturnType<typeof vi.fn> } }): unknown[] {
    return vi.mocked(session.eventBus.publish).mock.calls.map((c) => c[0]);
  }

  it('writes the sealed blob to the intent, and never to the chat row, the execution ledger row, or the SSE stream', async () => {
    const session = makeActiveSession();
    const callback = createSessionPostToolUse(session);

    await callback(
      'm365_reset_password',
      { userIdentifier: 'a@b.com' },
      'Reset done; credential available for one-time reveal.',
      false,
      12,
      { intentId: 'intent-1', sealedResult: { temporaryPasswordEnc: 'enc:v3:abc' } },
    );

    // The intent write gets the sealed ciphertext, keyed off sealed.intentId
    // (not pendingIntentBySession — preToolUse never ran on this session).
    expect(mockTransitionIntent).toHaveBeenCalledWith(
      'intent-1',
      'executing',
      'completed',
      expect.objectContaining({ result: { temporaryPasswordEnc: 'enc:v3:abc' } }),
    );

    // Sink 1: aiMessages (db.insert) — the chat-context row fed back to the model.
    const insertedAiMessages = vi.mocked(db.insert).mock.results
      .map((r) => (r.value as any)?.values?.mock?.calls?.[0]?.[0])
      .filter(Boolean);
    expect(JSON.stringify(insertedAiMessages)).not.toContain('enc:v3:abc');

    // Sink 2: aiToolExecutions (db.update(...).set(...)) — the execution ledger
    // row. A prior version of this test only swept db.insert, so a bug that
    // set `toolOutput: sealed?.sealedResult ?? parsedOutput` here instead of
    // `parsedOutput` would have passed silently.
    expect(JSON.stringify(updateSetPayloads())).not.toContain('enc:v3:abc');

    // Sink 3: the SSE tool_result event streamed to the browser/mobile client.
    expect(JSON.stringify(publishedPayloads(session))).not.toContain('enc:v3:abc');
  });

  it('CASes the intent to failed (with the stable error code) when the sealed tool call itself errored', async () => {
    const session = makeActiveSession();
    const callback = createSessionPostToolUse(session);

    await callback(
      'm365_reset_password',
      { userIdentifier: 'a@b.com' },
      'The password reset failed.',
      true,
      8,
      { intentId: 'intent-err', sealedResult: { raw: 'The password reset failed.' } },
    );

    expect(mockTransitionIntent).toHaveBeenCalledWith(
      'intent-err',
      'executing',
      'failed',
      expect.objectContaining({
        errorCode: 'tool_execution_failed',
        result: { raw: 'The password reset failed.' },
      }),
    );
  });

  it('prefers sealed.intentId over pendingIntentBySession when both are present (genuine tier-3 run, not an empty map)', async () => {
    // A prior version of this test called preToolUse with a tool name absent
    // from the TOOL_TIERS mock, so it hit the very first "Unknown tool" guard
    // and never created an intent — pendingIntentBySession stayed empty and
    // the `not.toHaveBeenCalledWith('intent-legacy', ...)` assertion passed
    // trivially, even against the regression it claimed to catch (flipping
    // the `??` precedence). Fixed by registering m365_reset_password as a
    // tier-3 tool in the TOOL_TIERS mock (below) and driving the full tier-3
    // release-CAS path so the WeakMap is genuinely populated.
    const selectChain: Record<string, unknown> = {
      from: vi.fn(() => selectChain),
      where: vi.fn(() => selectChain),
      limit: vi.fn(async () => [{ id: 'intent-legacy', boundArgumentDigest: 'digest' }]),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as any);
    mockInsertReturning({ id: 'exec-legacy' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-legacy', approvalRequestIds: ['appr-legacy'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('approved');
    const session = makeActiveSession({ approvalMode: 'per_step' });

    const preResult = await createSessionPreToolUse(session)('m365_reset_password', { userIdentifier: 'a@b.com' });

    // Proves the tier-3 branch genuinely ran (created a real intent and won
    // the release CAS) rather than being refused as an unknown tool.
    expect(preResult).toEqual({ allowed: true, intentId: 'intent-legacy' });
    expect(mockCreateActionIntent).toHaveBeenCalled();

    mockTransitionIntent.mockClear();
    const callback = createSessionPostToolUse(session);
    await callback(
      'm365_reset_password',
      { userIdentifier: 'a@b.com' },
      'Reset done.',
      false,
      12,
      { intentId: 'intent-sealed', sealedResult: { temporaryPasswordEnc: 'enc:v3:xyz' } },
    );

    expect(mockTransitionIntent).toHaveBeenCalledWith(
      'intent-sealed',
      'executing',
      'completed',
      expect.objectContaining({ result: { temporaryPasswordEnc: 'enc:v3:xyz' } }),
    );
    expect(mockTransitionIntent).not.toHaveBeenCalledWith(
      'intent-legacy',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('applies the size cap AFTER sealing — an oversize sealed result is truncated, with a warn, not dropped silently or stored whole', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = makeActiveSession();
    const callback = createSessionPostToolUse(session);
    const oversizeCiphertext = `enc:v3:${'a'.repeat(70 * 1024)}`;

    await callback(
      'm365_reset_password',
      { userIdentifier: 'a@b.com' },
      'Reset done.',
      false,
      12,
      { intentId: 'intent-big', sealedResult: { temporaryPasswordEnc: oversizeCiphertext } },
    );

    expect(mockTransitionIntent).toHaveBeenCalledWith(
      'intent-big',
      'executing',
      'completed',
      expect.objectContaining({ result: { truncated: true } }),
    );
    // Mirrors intentReleaseWorker.ts's warn: dropping the only copy of an
    // irreversibly-reset credential for size reasons must leave a forensic
    // trail, not vanish silently.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Dropping sealed credential for intent intent-big'));
    warnSpy.mockRestore();
  });

  it('does NOT warn when a non-secret oversize result is truncated (no credential was dropped)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = makeActiveSession();
    const callback = createSessionPostToolUse(session);

    await callback(
      'execute_command',
      { deviceId: 'd-1' },
      JSON.stringify({ stdout: 'x'.repeat(70 * 1024) }),
      false,
      12,
      { intentId: 'intent-nonsecret-big', sealedResult: { stdout: 'x'.repeat(70 * 1024) } },
    );

    expect(mockTransitionIntent).toHaveBeenCalledWith(
      'intent-nonsecret-big',
      'executing',
      'completed',
      expect.objectContaining({ result: { truncated: true } }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('CASes the intent straight to failed (no result body) and reports to Sentry when a plaintext credential slips through as the sealed result, without aborting the rest of postToolUse', async () => {
    // assertNoPlaintextSecret is the real (unmocked) Task-1 guard — this
    // proves it is actually wired into the inline write path, not just
    // imported. Confidentiality is preserved either way (the write is
    // refused); what's under test here is availability/forensics: the
    // intent must not be stranded in `executing`, and the guard tripping
    // must be reported, not silently swallowed by safePostToolUse upstream.
    const session = makeActiveSession({ auditSnapshot: { requestId: 'req-1' } as any });
    const callback = createSessionPostToolUse(session);

    await callback(
      'm365_reset_password',
      { userIdentifier: 'a@b.com' },
      'Reset done.',
      false,
      12,
      { intentId: 'intent-leak', sealedResult: { temporaryPassword: 'hunter2-plaintext' } },
    );

    // CASed to failed with the SAME error_code the durable worker uses
    // (jobs/intentReleaseWorker.ts's failOnPlaintextSecretGuard), and no
    // `result` key at all — the guarded plaintext value must never reach
    // the result column, not even as {truncated:true}.
    expect(mockTransitionIntent).toHaveBeenCalledTimes(1);
    const call = mockTransitionIntent.mock.calls[0] as unknown[] | undefined;
    expect(call).toBeDefined();
    const details = call?.[3];
    expect(mockTransitionIntent).toHaveBeenCalledWith(
      'intent-leak',
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'secret_seal_invariant_violated' }),
    );
    expect(details).not.toHaveProperty('result');

    // Reported for forensics, not just console-logged.
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const captureCall = mockCaptureException.mock.calls[0] as unknown[] | undefined;
    expect(captureCall?.[0]).toBeInstanceOf(Error);

    // The callback did NOT throw/reject — steps 2c-2e (session auto-flag,
    // plan completion, audit event) still ran for this postToolUse call
    // instead of being aborted by an uncaught throw.
    expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_result' }));
  });

  describe('Important 4: PAM-helper tier-3-but-intentless path pins intentId===undefined (deliberately out of scope for the plan-step fix below — PAM/helper sessions use their own elevation governance, not durable action-intents; see design doc docs/superpowers/specs/ai-mcp/2026-07-27-tier3-plan-mode-approval-parity-design.md §1.5)', () => {
    it('PAM-helper session: intentId is undefined for a secret-bearing tool auto-approved by organization policy', async () => {
      vi.mocked(checkGuardrails).mockReturnValue({
        allowed: true,
        tier: 3,
        requiresApproval: true,
        description: 'Reset password',
      } as any);
      mockInsertReturning({ id: 'exec-helper' });
      mockDecideHelperToolAction.mockResolvedValue('auto_approved');
      vi.mocked(waitForApproval).mockResolvedValue(true);
      const session = makeActiveSession({
        auth: makeAuth({
          scope: 'organization',
          helperDeviceId: 'device-9',
          user: { id: 'device-9', email: 'helper@host-09', name: 'HOST-09' },
        } as any),
        approvalMode: 'per_step',
      });

      const result = await createSessionPreToolUse(session)('m365_reset_password', { userIdentifier: 'a@b.com' });

      expect(result).toEqual({ allowed: true });
      expect((result as { intentId?: string }).intentId).toBeUndefined();
      // No durable intent was ever created on this path — confirms this is
      // the PAM-governed helper path, not the tier-3 durable-intent flow.
      expect(mockCreateActionIntent).not.toHaveBeenCalled();
    });
  });

  describe('Task 7: plan-step shortcut excludes secret-bearing tools', () => {
    beforeEach(() => {
      // The plan-secret and plan-decision-blocking assertions below only need
      // createActionIntent to have been reached, not the full release CAS —
      // stop right after it via a 'rejected' decision, same shortcut the
      // existing Tier-3 tests above use to avoid re-driving revalidation/CAS
      // plumbing that is orthogonal to what this describe is proving.
      mockWaitForIntentDecision.mockResolvedValue('rejected');
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      } as any);
    });

    it.each(['action_plan', 'hybrid_plan'] as const)(
      'does not take the plan shortcut for a secret-bearing tool matched against an approved plan step in %s mode — falls through to createActionIntent',
      async (mode) => {
        vi.mocked(checkGuardrails).mockReturnValue({
          allowed: true,
          tier: 3,
          requiresApproval: true,
          description: 'Reset password',
        } as any);
        mockInsertReturning({ id: 'exec-plan-secret' });
        mockCreateActionIntent.mockResolvedValue(
          makeIntentSnapshot({ id: 'intent-plan-secret', approvalRequestIds: ['appr-plan-secret'] }),
        );
        const session = makeActiveSession({
          approvalMode: mode,
          activePlanId: 'plan-1',
          approvedPlanSteps: new Map([
            [0, { toolName: 'm365_reset_password', input: { userIdentifier: 'a@b.com', reason: 'r' } }],
          ]),
        });

        const result = await createSessionPreToolUse(session)(
          'm365_reset_password',
          { userIdentifier: 'a@b.com', reason: 'r' },
        );

        // The matched plan step is proof the shortcut's own matching logic
        // would have fired here — reaching createActionIntent anyway (rather
        // than the plan_step_start/short-circuit `{allowed:true}` the
        // shortcut returns) is the direct evidence the gate excluded this
        // tool from taking it.
        expect(mockCreateActionIntent).toHaveBeenCalledWith(session.auth, expect.objectContaining({
          toolName: 'm365_reset_password',
        }));
        expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected, cancelled, or expired' });
        expect(session.eventBus.publish).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'plan_step_start' }),
        );
      },
    );

    it.each(['action_plan', 'hybrid_plan'] as const)(
      // NOTE: this originally used execute_command at (mocked) tier 3,
      // asserting the shortcut still fires. That is exactly the bypass this
      // branch closes (design doc §5: "All paths fail closed — no tier-3
      // action runs without a durable approval.") — keeping it as-written
      // would pin the vulnerability as "correct". Swapped to an effective-tier-2 tool so
      // this test still guards its original, valid intent: the gate must not
      // broaden beyond secret-bearing tools for tools that ARE eligible for
      // the shortcut.
      'still takes the plan shortcut for a non-secret, effective-tier-2 tool in %s mode (regression guard: the gate must not broaden beyond secret-bearing tools)',
      async (mode) => {
        vi.mocked(checkGuardrails).mockReturnValue({
          allowed: true,
          tier: 2,
          requiresApproval: true,
          description: 'Take screenshot',
        } as any);
        const values = mockInsertValues();
        const session = makeActiveSession({
          approvalMode: mode,
          activePlanId: 'plan-1',
          approvedPlanSteps: new Map([[0, { toolName: 'take_screenshot', input: { deviceId: 'd-1' } }]]),
        });

        const result = await createSessionPreToolUse(session)('take_screenshot', { deviceId: 'd-1' });

        expect(result).toEqual({ allowed: true });
        expect(mockCreateActionIntent).not.toHaveBeenCalled();
        expect(values).toHaveBeenCalledWith(expect.objectContaining({
          sessionId: 'session-1',
          toolName: 'take_screenshot',
          status: 'executing',
        }));
        expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'plan_step_start' }));
      },
    );

    describe('plan bookkeeping stays coherent when a secret-bearing tool declines the shortcut', () => {
      // NOTE: the two tests in this block previously asserted
      // `session.currentPlanStepIndex` advanced synchronously on decline, and
      // that a REJECTED terminal step still completed the plan. Deferring the
      // index advance until the step is genuinely authorized (design doc
      // docs/superpowers/specs/ai-mcp/2026-07-27-tier3-plan-mode-approval-parity-design.md
      // §3.2 — "do not advance on the decline path at all... advance only
      // once the step is genuinely authorized") removes exactly that early advance — it was the
      // mechanism by which a rejected/never-run step could get silently
      // marked `plan_step_complete`/`completed`. The advance now happens only
      // once the step is genuinely authorized (at the release-CAS-won +
      // revalidated point) — which these tests, using a REJECTED decision
      // throughout, never reach. Rewritten below to assert the new, correct
      // behavior instead of the old (buggy) one.
      it('a secret-bearing step that declines the shortcut aborts the plan (Task 3) — a retry no longer matches any plan step', async () => {
        // Pre-Task-3, this test asserted the plan SLOT survived a decline
        // (the index didn't advance, so the same step "still matched" on a
        // retry). Task 3 changes the outcome: a matched-and-declined tier-3
        // step now aborts the WHOLE plan on the first rejection, not just
        // leaves its one slot open. A reviewer probing the old assertions
        // found they never actually checked `session.activePlanId` and so
        // passed even though the plan is now gone (`expected null to be
        // 'plan-1'` when checked). Rewritten to assert the post-abort truth.
        vi.mocked(checkGuardrails).mockReturnValue({
          allowed: true,
          tier: 3,
          requiresApproval: true,
          description: 'Reset password',
        } as any);
        mockInsertReturning({ id: 'exec-plan-first-secret' });
        mockCreateActionIntent.mockResolvedValue(
          makeIntentSnapshot({ id: 'intent-plan-first-secret', approvalRequestIds: ['appr-1'] }),
        );
        const session = makeActiveSession({
          approvalMode: 'action_plan',
          activePlanId: 'plan-1',
          approvedPlanSteps: new Map([
            [0, { toolName: 'm365_reset_password', input: { userIdentifier: 'a@b.com' } }],
          ]),
        });

        // First attempt: matches plan step 0 but declines the shortcut
        // (secret-bearing); the durable decision comes back rejected. Task 3
        // aborts the plan on this exit.
        const first = await createSessionPreToolUse(session)('m365_reset_password', { userIdentifier: 'a@b.com' });
        expect(mockCreateActionIntent).toHaveBeenCalledTimes(1);
        expect(first).toEqual({ allowed: false, error: 'Tool execution was rejected, cancelled, or expired' });
        expect(session.currentPlanStepIndex).toBe(0);
        expect(session.activePlanId).toBeNull();
        expect(session.approvedPlanSteps.size).toBe(0);

        // Second attempt (same tool, same args): activePlanId is now null,
        // so the plan-matching block is skipped entirely — this is a fresh,
        // plan-less tier-3 call, NOT a retry against a still-open slot. It
        // still reaches createActionIntent (m365_reset_password is
        // unconditionally tier 3, independent of any plan) and still gets
        // rejected — but not because it matched a plan step; there is no
        // plan left to match against.
        const second = await createSessionPreToolUse(session)('m365_reset_password', { userIdentifier: 'a@b.com' });
        expect(mockCreateActionIntent).toHaveBeenCalledTimes(2);
        expect(second).toEqual({ allowed: false, error: 'Tool execution was rejected, cancelled, or expired' });
        expect(session.eventBus.publish).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'plan_step_start' }),
        );
        expect(session.activePlanId).toBeNull();
      });

      it('a plan ENDING on a secret-bearing tool aborts (Task 3) rather than completing or staying dangling when the approval is rejected', async () => {
        vi.mocked(checkGuardrails).mockReturnValue({
          allowed: true,
          tier: 3,
          requiresApproval: true,
          description: 'Reset password',
        } as any);
        mockInsertReturning({ id: 'exec-plan-last-secret' });
        mockCreateActionIntent.mockResolvedValue(
          makeIntentSnapshot({ id: 'intent-plan-last-secret', approvalRequestIds: ['appr-last-secret'] }),
        );
        const session = makeActiveSession({
          approvalMode: 'action_plan',
          activePlanId: 'plan-1',
          approvedPlanSteps: new Map([
            [0, { toolName: 'google_reset_password', input: { userIdentifier: 'a@b.com' } }],
          ]),
        });

        await createSessionPreToolUse(session)('google_reset_password', { userIdentifier: 'a@b.com' });
        // Pre-Task-3 this plan was left dangling (activePlanId still 'plan-1',
        // the slot still occupied) because nothing aborted it on a rejected
        // tier-3 step. Task 3 stops the plan outright instead — matches
        // failMatchedPlanStep's abort, since this call matched plan step 0.
        expect(session.currentPlanStepIndex).toBe(0);
        expect(session.activePlanId).toBeNull();
        expect(session.approvedPlanSteps.size).toBe(0);
        expect(session.eventBus.publish).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'plan_complete', planId: 'plan-1', status: 'aborted' }),
        );

        await createSessionPostToolUse(session)(
          'google_reset_password',
          { userIdentifier: 'a@b.com' },
          'Reset done.',
          false,
          10,
        );

        // No spurious "completed" plan_complete once the plan has already
        // been aborted — the completion check is gated on session.activePlanId,
        // which is now null.
        expect(session.eventBus.publish).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'plan_complete', status: 'completed' }),
        );
        expect(session.activePlanId).toBeNull();
        expect(session.approvedPlanSteps.size).toBe(0);
        expect(session.currentPlanStepIndex).toBe(0);
      });

      it('does not create a duplicate ai_tool_executions row when a secret-bearing tool falls through from a matched plan step', async () => {
        vi.mocked(checkGuardrails).mockReturnValue({
          allowed: true,
          tier: 3,
          requiresApproval: true,
          description: 'Reset password',
        } as any);
        const insertValues = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'exec-once' }]) });
        vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);
        mockCreateActionIntent.mockResolvedValue(
          makeIntentSnapshot({ id: 'intent-once', approvalRequestIds: ['appr-once'] }),
        );
        const session = makeActiveSession({
          approvalMode: 'action_plan',
          activePlanId: 'plan-1',
          approvedPlanSteps: new Map([
            [0, { toolName: 'm365_reset_password', input: { userIdentifier: 'a@b.com' } }],
          ]),
        });

        await createSessionPreToolUse(session)('m365_reset_password', { userIdentifier: 'a@b.com' });

        // Exactly one aiToolExecutions row for this call — the tier-3
        // approval record. A regression that let the shortcut ALSO fire
        // (e.g. forgetting to gate the early-return branch, only the
        // bookkeeping one) would insert a second row here.
        expect(insertValues).toHaveBeenCalledTimes(1);
        expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
          toolName: 'm365_reset_password',
          status: 'pending',
        }));
      });
    });
  });
});

// ============================================
// Task 2: advance the plan index and emit plan_step_start only once the
// step is genuinely authorized (release CAS won + revalidated), never
// before.
// ============================================

describe('Task 2: plan index advances only once the step is authorized', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateActionIntent.mockReset();
    mockWaitForIntentDecision.mockReset();
    mockTransitionIntent.mockReset();
    mockRevalidateApprovedIntentForRelease.mockReset();
    mockRevalidateApprovedIntentForRelease.mockResolvedValue({ ok: true, auth: {} } as IntentReleaseRevalidation);
    // Default chainable for the inline release-win system read (loads the
    // intent row + winning approval before revalidation) — same shape as the
    // Tier 3 describe's beforeEach above.
    const selectChain: Record<string, unknown> = {
      from: vi.fn(() => selectChain),
      where: vi.fn(() => selectChain),
      limit: vi.fn(async () => [{ id: 'intent', boundArgumentDigest: 'digest' }]),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    } as any);
  });

  it('advances and emits plan_step_start after the release CAS is won', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-plan-adv' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-plan-adv', approvalRequestIds: ['appr-plan-adv'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('approved');
    mockTransitionIntent.mockResolvedValue(true);
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });

    const result = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(result).toEqual({ allowed: true, intentId: 'intent-plan-adv' });
    expect(session.currentPlanStepIndex).toBe(1);
    expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'plan_step_start',
      planId: 'plan-1',
      stepIndex: 0,
      toolName: 'execute_command',
    }));
  });

  it('a durable-release-only tool never attempts the inline approved->executing CAS', async () => {
    // The guard's whole purpose: an approved intent for a tool whose safety
    // depends on the worker-only transport must be left for the durable
    // worker. Asserting on transitionIntent is what makes this real — a
    // source-order check would still pass if the early return were deleted
    // while the call text remained.
    // Once, not permanently: a leaked `true` silently diverts every later
    // tier-3 test in this file away from the release path.
    mockRequiresDurableRelease.mockReturnValueOnce(true);
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Send mail',
    } as any);
    mockInsertReturning({ id: 'exec-durable-only' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-durable-only', approvalRequestIds: ['appr-durable-only'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('approved');
    mockTransitionIntent.mockResolvedValue(true);
    const session = makeActiveSession({});

    // A REGISTERED tier-3 tool: an unknown tool name short-circuits with
    // "Unknown tool" long before the release path, which would make this test
    // pass for entirely the wrong reason.
    const result = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    // Not executed inline...
    expect(result).toEqual(expect.objectContaining({ allowed: false }));
    // ...and critically, the CAS was never even attempted, so the worker's
    // claim is still available and the intent is not stranded in `executing`.
    expect(mockTransitionIntent).not.toHaveBeenCalledWith(
      expect.anything(),
      'approved',
      'executing',
      expect.anything(),
      expect.anything(),
    );
  });

  it('does NOT advance when the approval is denied', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-plan-deny' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-plan-deny', approvalRequestIds: ['appr-plan-deny'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });

    await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(session.currentPlanStepIndex).toBe(0);
    expect(session.eventBus.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plan_step_start' }),
    );
  });

  it('does NOT advance when the release CAS is lost to the worker', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-plan-lost' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-plan-lost', approvalRequestIds: ['appr-plan-lost'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('approved');
    mockTransitionIntent.mockResolvedValue(false);
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });

    const result = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(result).toEqual({
      allowed: false,
      error: 'This action is already being completed by the approval worker; it will not run twice.',
    });
    expect(session.currentPlanStepIndex).toBe(0);
  });

  // The release CAS win alone is NOT authorization — the requester's access
  // must also be re-proved by revalidateApprovedIntentForRelease before the
  // step counts as run. Winning the CAS but failing revalidation must not
  // advance the plan.
  it('does NOT advance when the release CAS is won but revalidation fails', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-plan-revalidate-fail' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-plan-revalidate-fail', approvalRequestIds: ['appr-plan-revalidate-fail'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('approved');
    mockTransitionIntent.mockResolvedValue(true); // wins the release CAS
    mockRevalidateApprovedIntentForRelease.mockResolvedValue({ ok: false, errorCode: 'actor_invalid' });
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });

    const result = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(result).toEqual({
      allowed: false,
      error: 'Authorization for this action could no longer be verified; it was not executed.',
    });
    expect(session.currentPlanStepIndex).toBe(0);
    expect(session.eventBus.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plan_step_start' }),
    );
  });

  // Regression guards restored from PR #2853. Task 1 necessarily inverted the
  // originals (they asserted the pre-Task-1 early-advance behavior); they
  // become meaningful again now that the advance happens at the authorize
  // point instead of being removed outright.
  it('a following step still matches after an earlier tier-3 step was authorized (regression guard restored from PR #2853)', async () => {
    vi.mocked(checkGuardrails).mockReturnValueOnce({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-plan-seq-0' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-plan-seq-0', approvalRequestIds: ['appr-plan-seq-0'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('approved');
    mockTransitionIntent.mockResolvedValue(true);
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([
        [0, { toolName: 'execute_command', input: { command: 'whoami' } }],
        [1, { toolName: 'take_screenshot', input: { deviceId: 'd-1' } }],
      ]),
    });

    // Step 0: effective tier 3 — goes through the durable intent, wins the
    // release CAS, and is authorized. The index must land on 1.
    const first = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });
    expect(first).toEqual({ allowed: true, intentId: 'intent-plan-seq-0' });
    expect(session.currentPlanStepIndex).toBe(1);

    // Step 1: effective tier 2, non-secret — eligible for the plan shortcut.
    // If the plan desynced (e.g. treated every later call as a deviation
    // because it stopped reading matchPlanStep against the advanced index),
    // this would fall through to the per-step approval bridge instead of
    // matching step 1 and taking the shortcut.
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 2,
      requiresApproval: true,
      description: 'Take screenshot',
    } as any);
    const values = mockInsertValues();

    const second = await createSessionPreToolUse(session)('take_screenshot', { deviceId: 'd-1' });

    expect(second).toEqual({ allowed: true });
    expect(mockCreateActionIntent).toHaveBeenCalledTimes(1); // not called again for step 1
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'take_screenshot',
      status: 'executing',
    }));
    expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'plan_step_start',
      stepIndex: 1,
      toolName: 'take_screenshot',
    }));
    expect(session.currentPlanStepIndex).toBe(2);
  });

  it('a plan ENDING on an approved tier-3 step reaches completion (regression guard restored from PR #2853)', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-plan-end' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-plan-end', approvalRequestIds: ['appr-plan-end'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('approved');
    mockTransitionIntent.mockResolvedValue(true);
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });

    const preResult = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });
    expect(preResult).toEqual({ allowed: true, intentId: 'intent-plan-end' });
    expect(session.currentPlanStepIndex).toBe(1);

    mockTransitionIntent.mockClear();
    const postToolUse = createSessionPostToolUse(session);
    await postToolUse(
      'execute_command',
      { command: 'whoami' },
      JSON.stringify({ status: 'completed' }),
      false,
      10,
    );

    // This is the "stranded plan" bug PR #2853 fixed: a plan whose LAST step
    // requires durable tier-3 approval must still reach plan_complete once
    // that step is genuinely authorized and finishes — not get stuck with
    // activePlanId set forever.
    expect(session.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plan_complete', planId: 'plan-1', status: 'completed' }),
    );
    expect(session.activePlanId).toBeNull();
    // Matches the original PR #2853 assertion this guard restores: the plan
    // slot map itself is cleared on completion, not just the id/index.
    expect(session.approvedPlanSteps.size).toBe(0);
    // Pins the actual defect narrative from this commit: plan_step_complete
    // must be indexed against the step that just ran (0), not a stale or
    // off-by-one index — mis-indexing this event is exactly what a
    // regressed advance point would produce.
    expect(session.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plan_step_complete', planId: 'plan-1', stepIndex: 0, toolName: 'execute_command' }),
    );
  });
});

// ============================================
// Task 3: abort the plan on every non-executing exit. Without this the plan
// stays active after a denied, timed-out, or failed tier-3 step and the
// model can proceed straight to the next step as if the refused step had
// run — exactly the shortcut Tasks 1/2 close for the EXECUTING path, left
// open here for the non-executing exits.
// ============================================

describe('Task 3: a plan aborts when a tier-3 step does not execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateActionIntent.mockReset();
    mockWaitForIntentDecision.mockReset();
    mockTransitionIntent.mockReset();
    mockRevalidateApprovedIntentForRelease.mockReset();
    mockRevalidateApprovedIntentForRelease.mockResolvedValue({ ok: true, auth: {} } as IntentReleaseRevalidation);
    // Chainable system-context select used by the inline release-win read
    // (loads the intent row + winning approval before revalidation) — same
    // shape as the Task 2 describe's beforeEach above.
    const selectChain: Record<string, unknown> = {
      from: vi.fn(() => selectChain),
      where: vi.fn(() => selectChain),
      limit: vi.fn(async () => [{ id: 'intent', boundArgumentDigest: 'digest' }]),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    } as any);
  });

  const denials: Array<[string, () => void]> = [
    ['denied', () => { mockWaitForIntentDecision.mockResolvedValue('rejected'); }],
    ['timed out', () => { mockWaitForIntentDecision.mockResolvedValue('pending_approval'); }],
    ['lost the release CAS', () => {
      mockWaitForIntentDecision.mockResolvedValue('approved');
      mockTransitionIntent.mockResolvedValue(false);
    }],
    ['intent creation failed', () => { mockCreateActionIntent.mockRejectedValue(new Error('boom')); }],
  ];

  it.each(denials)('aborts the plan when the step %s', async (_label, arrange) => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-task3-denial' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-task3-denial', approvalRequestIds: ['appr-task3-denial'] }),
    );
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });
    arrange();

    const res = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(res.allowed).toBe(false);
    // The plan must not stay active past a step nobody authorized.
    expect(session.activePlanId).toBeNull();
    expect(session.currentPlanStepIndex).toBe(0);
    expect(session.approvedPlanSteps.size).toBe(0);
    expect(session.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plan_complete', planId: 'plan-1', status: 'aborted' }),
    );
  });

  // NOTE (review finding, Important 3): a prior version of this describe
  // block had a test named "a following step does not execute after the
  // plan aborted" that called createSessionPreToolUse a second time for a
  // DIFFERENT tool at plan index 1 and asserted the second call didn't take
  // the shortcut. It was vacuous — with the abort disabled, every
  // substantive assertion in it still passed identically. The reason:
  // matchPlanStep only ever reads `session.currentPlanStepIndex`, and Task 2
  // deliberately leaves that at 0 after any non-executing exit (advancing it
  // early is exactly the bug Task 2 removes) — so a "step 1" entry can never
  // be reached from this flow, whether or not the plan aborted. The only
  // observable, abort-caused differences are `session.activePlanId`,
  // `session.approvedPlanSteps`, and the `plan_complete`/'aborted' event —
  // all already covered by the `it.each(denials)` block above and the
  // dedicated per-exit tests below. Deleted rather than kept as a test whose
  // title and comments describe a mechanism that cannot fire.

  // ----------------------------------------------------------------------
  // Per-exit coverage for sites the `it.each(denials)` block above does NOT
  // reach: the shared ledger-insert try/catch and the `!approvalExec` check
  // (both before the tier>=3 split), the `!intentRow` exit after winning the
  // release CAS, and the `!revalidation.ok` exit. A prior review unwrapped
  // all four simultaneously and the suite stayed green — these tests close
  // that gap, one exit per test.
  // ----------------------------------------------------------------------

  it('aborts the plan when creating the approval ledger record throws', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({ returning: vi.fn().mockRejectedValue(new Error('db down')) })),
    } as any);
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });

    const res = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(res).toEqual({ allowed: false, error: 'Failed to create approval record' });
    // Never reached createActionIntent — the ledger insert failed first.
    expect(mockCreateActionIntent).not.toHaveBeenCalled();
    expect(session.activePlanId).toBeNull();
    expect(session.approvedPlanSteps.size).toBe(0);
  });

  it('aborts the plan when the approval ledger insert returns no row', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
    } as any);
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });

    const res = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(res).toEqual({ allowed: false, error: 'Failed to create approval record' });
    expect(mockCreateActionIntent).not.toHaveBeenCalled();
    expect(session.activePlanId).toBeNull();
    expect(session.approvedPlanSteps.size).toBe(0);
  });

  it('aborts the plan when the intent row vanished after winning the release CAS', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-task3-vanish' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-task3-vanish', approvalRequestIds: ['appr-task3-vanish'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('approved');
    mockTransitionIntent.mockResolvedValue(true); // wins the release CAS
    // Override this test's system-context select so BOTH the intent-row and
    // approval-row reads come back empty — reaches the `!intentRow` branch.
    const vanishedSelectChain: Record<string, unknown> = {
      from: vi.fn(() => vanishedSelectChain),
      where: vi.fn(() => vanishedSelectChain),
      limit: vi.fn(async () => []),
    };
    vi.mocked(db.select).mockReturnValue(vanishedSelectChain as any);
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });

    const res = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(res).toEqual({ allowed: false, error: 'Approved action could not be revalidated for execution.' });
    expect(session.activePlanId).toBeNull();
    expect(session.approvedPlanSteps.size).toBe(0);
  });

  it('aborts the plan when the release CAS is won but revalidation fails', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-task3-revalidate' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-task3-revalidate', approvalRequestIds: ['appr-task3-revalidate'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('approved');
    mockTransitionIntent.mockResolvedValue(true); // wins the release CAS
    mockRevalidateApprovedIntentForRelease.mockResolvedValue({ ok: false, errorCode: 'actor_invalid' });
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });

    const res = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(res).toEqual({
      allowed: false,
      error: 'Authorization for this action could no longer be verified; it was not executed.',
    });
    expect(session.activePlanId).toBeNull();
    expect(session.approvedPlanSteps.size).toBe(0);
  });

  // ----------------------------------------------------------------------
  // Important 5: an uncaught throw anywhere in the tier-3 body (not just a
  // handled `allowed:false` exit) must still funnel through
  // failMatchedPlanStep, not propagate out and skip the abort entirely.
  // ----------------------------------------------------------------------

  it('aborts the plan when an uncaught error is thrown mid-flow (Important 5 — e.g. waitForIntentDecision throws)', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-task3-throw' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-task3-throw', approvalRequestIds: ['appr-task3-throw'] }),
    );
    mockWaitForIntentDecision.mockRejectedValue(new Error('boom-throw'));
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });

    const res = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(res).toEqual({
      allowed: false,
      error: 'An unexpected error occurred while processing this action; it was not executed.',
    });
    expect(session.activePlanId).toBeNull();
    expect(session.approvedPlanSteps.size).toBe(0);
  });

  it('CASes the intent executing -> failed (self-heal) when an uncaught error is thrown AFTER winning the release CAS', async () => {
    // Distinct from "aborts the plan when an uncaught error is thrown
    // mid-flow" above: that test throws from waitForIntentDecision, which
    // fires BEFORE the approved -> executing CAS is even attempted, so
    // mockTransitionIntent is only ever called once (and never wins). This
    // test throws from the post-CAS-win system-context read instead — the
    // window where `intent` (declared with `let` inside the try) has
    // already gone out of scope by the time the catch runs, so only a
    // hoisted id captured at the CAS win can be used to self-heal the row.
    // Without that self-heal the intent is stranded at `executing` until
    // the stale-execution reaper sweeps it 20 minutes later.
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-selfheal' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-selfheal', approvalRequestIds: ['appr-selfheal'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('approved');
    mockTransitionIntent.mockResolvedValue(true); // wins the approved -> executing CAS
    // Override this test's system-context select (intent-row + winning-
    // approval read) to throw synchronously, simulating a DB hiccup strictly
    // after the CAS win.
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('system-context select blew up');
    });
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });

    const res = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(res).toEqual({
      allowed: false,
      error: 'An unexpected error occurred while processing this action; it was not executed.',
    });
    // The CAS that won release ('approved' -> 'executing') is the first
    // call; the self-heal CAS ('executing' -> 'failed') must be the second.
    expect(mockTransitionIntent).toHaveBeenNthCalledWith(
      1,
      'intent-selfheal',
      'approved',
      'executing',
      expect.objectContaining({ executedAt: null, executionStartedAt: expect.any(Date) }),
      { requireNotExpired: true },
    );
    expect(mockTransitionIntent).toHaveBeenNthCalledWith(
      2,
      'intent-selfheal',
      'executing',
      'failed',
      { errorCode: 'execution_error' },
    );
    expect(session.activePlanId).toBeNull();
    expect(session.approvedPlanSteps.size).toBe(0);
  });

  // ----------------------------------------------------------------------
  // Important 2 (guard clause): only a call that MATCHED an approved plan
  // step may stop the plan. A tier-3 call that deviated from the plan
  // (never matched — `matchedPlanStepIndex` stays null) must leave a live
  // plan alone, even though it fails for the exact same underlying reason
  // (denial) as a matched step would. Deleting the
  // `matchedPlanStepIndex !== null &&` half of the guard clause makes every
  // tier-3 exit abort ANY active plan, including this one — this test is
  // what catches that regression (a prior review found removing the guard
  // clause was invisible without it).
  // ----------------------------------------------------------------------

  it('does NOT abort the plan when the tier-3 call deviated from the plan (never matched a step)', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-task3-deviate' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-task3-deviate', approvalRequestIds: ['appr-task3-deviate'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('rejected');
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      // Plan step 0 is take_screenshot — execute_command was never part of
      // this plan, so matchPlanStep returns matches:false and
      // matchedPlanStepIndex stays null.
      approvedPlanSteps: new Map([[0, { toolName: 'take_screenshot', input: { deviceId: 'd-1' } }]]),
    });

    const res = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(res).toEqual({ allowed: false, error: 'Tool execution was rejected, cancelled, or expired' });
    // The still-live plan (for its own, unrelated step) must be untouched.
    expect(session.activePlanId).toBe('plan-1');
    expect(session.approvedPlanSteps.size).toBe(1);
  });

  // ----------------------------------------------------------------------
  // Important 1: the timeout message must state "the plan has been stopped"
  // ONLY when a plan actually stopped — not unconditionally. `check.error`
  // is serialized straight into the tool result the model reads
  // (aiAgentSdkTools.ts:321-327), so a false claim here misleads the model,
  // not just an operator.
  // ----------------------------------------------------------------------

  it('states both facts in the timeout message when the plan actually aborts', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-task3-timeout-msg' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-task3-timeout-msg', approvalRequestIds: ['appr-task3-timeout-msg'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('pending_approval');
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'execute_command', input: { command: 'whoami' } }]]),
    });

    const res = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(res).toEqual({
      allowed: false,
      error: 'Approval still pending; this action will complete once approved. The plan has been stopped.',
    });
    expect(session.activePlanId).toBeNull();
  });

  it('does NOT claim the plan stopped when a deviating tier-3 call times out and the plan is still live', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    mockInsertReturning({ id: 'exec-task3-deviate-timeout' });
    mockCreateActionIntent.mockResolvedValue(
      makeIntentSnapshot({ id: 'intent-task3-deviate-timeout', approvalRequestIds: ['appr-task3-deviate-timeout'] }),
    );
    mockWaitForIntentDecision.mockResolvedValue('pending_approval');
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      // execute_command was never part of the plan (step 0 is
      // take_screenshot) — a deviation, so matchedPlanStepIndex stays null
      // and this call must not abort, or claim to have aborted, the plan.
      approvedPlanSteps: new Map([[0, { toolName: 'take_screenshot', input: { deviceId: 'd-1' } }]]),
    });

    const res = await createSessionPreToolUse(session)('execute_command', { command: 'whoami' });

    expect(res).toEqual({
      allowed: false,
      error: 'Approval still pending; this action will complete once approved.',
    });
    expect(session.activePlanId).toBe('plan-1');
  });

  // ----------------------------------------------------------------------
  // "Also fold in" item: the tier-2 legacy per-step bridge's own
  // `!approved` exit (line ~978) now also routes through
  // failMatchedPlanStep. Not reachable with a non-null matchedPlanStepIndex
  // under the REAL static TOOL_TIERS map (both secret-bearing tools are
  // statically tier 3), but exercised here by mocking checkGuardrails to
  // report tier 2 for a secret-bearing tool — proving the wrap is correct
  // and safe rather than leaving it as an unverified, "should be a no-op"
  // claim resting on two other files' tier assignments never changing.
  // ----------------------------------------------------------------------

  it('aborts the plan when a tier-2 secret-bearing step is rejected via the legacy per-step bridge (defensive coverage)', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 2,
      requiresApproval: true,
      description: 'Reset password',
    } as any);
    mockInsertReturning({ id: 'exec-task3-legacy-secret' });
    vi.mocked(waitForApproval).mockResolvedValue(false);
    const session = makeActiveSession({
      approvalMode: 'action_plan',
      activePlanId: 'plan-1',
      approvedPlanSteps: new Map([[0, { toolName: 'm365_reset_password', input: { userIdentifier: 'a@b.com' } }]]),
    });

    const res = await createSessionPreToolUse(session)('m365_reset_password', { userIdentifier: 'a@b.com' });

    expect(res).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
    // Legacy bridge, not the durable-intent flow.
    expect(mockCreateActionIntent).not.toHaveBeenCalled();
    expect(session.activePlanId).toBeNull();
    expect(session.approvedPlanSteps.size).toBe(0);
  });
});

// ============================================
// safeParseJson
// ============================================

describe('safeParseJson', () => {
  it('parses valid JSON objects', () => {
    expect(safeParseJson('{"key":"value"}')).toEqual({ key: 'value' });
  });

  it('wraps arrays in { value: ... }', () => {
    expect(safeParseJson('[1,2,3]')).toEqual({ value: [1, 2, 3] });
  });

  it('wraps primitives in { value: ... }', () => {
    expect(safeParseJson('42')).toEqual({ value: 42 });
    expect(safeParseJson('"hello"')).toEqual({ value: 'hello' });
    expect(safeParseJson('true')).toEqual({ value: true });
    expect(safeParseJson('null')).toEqual({ value: null });
  });

  it('returns { raw: ... } for invalid JSON', () => {
    expect(safeParseJson('not json')).toEqual({ raw: 'not json' });
  });
});
