import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionPostToolUse, createSessionPreToolUse, runPreFlightChecks, safeParseJson } from './aiAgentSdk';
import { db } from '../db';
import { checkGuardrails, checkToolPermission, checkToolRateLimit } from './aiGuardrails';
import { waitForApproval } from './aiAgent';

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
  TOOL_TIERS: { query_devices: 1, take_screenshot: 2, execute_command: 3 },
  BREEZE_MCP_TOOL_NAMES: [],
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

  it('keeps Tier 3 tools pending under auto-approve', async () => {
    vi.mocked(checkGuardrails).mockReturnValue({
      allowed: true,
      tier: 3,
      requiresApproval: true,
      description: 'Execute command',
    } as any);
    const { values } = mockInsertReturning({ id: 'exec-1' });
    vi.mocked(waitForApproval).mockResolvedValue(false);
    const session = makeActiveSession({ approvalMode: 'auto_approve' });

    const result = await createSessionPreToolUse(session)('execute_command', {});

    expect(result).toEqual({ allowed: false, error: 'Tool execution was rejected or timed out' });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      toolName: 'execute_command',
      status: 'pending',
    }));
    expect(session.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'approval_required',
      executionId: 'exec-1',
      toolName: 'execute_command',
    }));
    expect(waitForApproval).toHaveBeenCalledWith('exec-1', 300_000, expect.any(AbortSignal));
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
