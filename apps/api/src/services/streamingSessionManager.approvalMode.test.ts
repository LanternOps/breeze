/**
 * #5593 — approval mode must come from the EFFECTIVE AI budget (partner JSONB
 * `aiBudgets.approvalMode` override → org `ai_budgets` row → `per_step`), not
 * from a raw `ai_budgets` select on the session org, and it must be re-read
 * when an in-memory session is reused so a settings change applies to the next
 * message instead of only to a brand-new session.
 *
 * Mock harness mirrors streamingSessionManager.deviceBoundAuth.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryMock, getEffectiveAiBudgetMock, loadApprovalWaitBudgetMsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getEffectiveAiBudgetMock: vi.fn(),
  loadApprovalWaitBudgetMsMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

const dbSelectMock = vi.fn(() => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
  })),
}));

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelectMock(...(args as [])),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
  },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('./effectiveSettings', () => ({
  getEffectiveAiBudget: (...args: unknown[]) => getEffectiveAiBudgetMock(...args),
}));

vi.mock('./aiApprovalTimeout', () => ({
  DEFAULT_APPROVAL_WAIT_BUDGET_MS: 300_000,
  loadApprovalWaitBudgetMs: (...args: unknown[]) => loadApprovalWaitBudgetMsMock(...args),
}));

vi.mock('./aiCostTracker', () => ({
  recordUsageFromSdkResult: vi.fn(() => Promise.resolve()),
  sumInputTokens: () => 0,
}));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
  settleApprovalWaits: vi.fn(),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: (s: unknown) => s,
}));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

import {
  StreamingSessionManager,
  PROCESSING_STALL_TIMEOUT_MS,
  processingStallTimeoutMsFor,
  turnTimeoutMsFor,
} from './streamingSessionManager';
import { buildOrgAccessClosures } from '../middleware/auth';
import type { AuthContext } from '../middleware/auth';

const ORG_ID = 'aaaaaaaa-1111-4222-8333-444455556666';
const USER_ID = 'eeeeeeee-1111-4222-8333-444455556666';

const DB_SESSION = {
  orgId: ORG_ID,
  sdkSessionId: null,
  model: 'claude-sonnet-4-5-20250929',
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null,
  deviceId: null,
};

const PLATFORM_CONFIG = {
  source: 'platform' as const,
  apiKey: 'platform-key',
  model: 'claude-sonnet-4-6',
};

function makeAuth(): AuthContext {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: null,
    accessibleOrgIds: [ORG_ID],
    ...buildOrgAccessClosures([ORG_ID]),
    user: { id: USER_ID, email: 'tech@msp.example' },
  } as unknown as AuthContext;
}

function budget(approvalMode: string) {
  return {
    enabled: true,
    monthlyBudgetCents: null,
    dailyBudgetCents: null,
    maxTurnsPerSession: 50,
    messagesPerMinutePerUser: 20,
    messagesPerHourPerOrg: 200,
    approvalMode,
    alertThresholdPercents: [],
  };
}

function create(manager: StreamingSessionManager, id: string) {
  return manager.getOrCreate(id, DB_SESSION, makeAuth(), undefined, 'PROMPT', undefined, PLATFORM_CONFIG);
}

describe('getOrCreate — effective approval mode (#5593)', () => {
  let manager: StreamingSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined);
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    }));
    getEffectiveAiBudgetMock.mockResolvedValue(budget('per_step'));
    loadApprovalWaitBudgetMsMock.mockResolvedValue(300_000);
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  it('honours a partner-level override when the org row says per_step', async () => {
    // getEffectiveAiBudget merges partner JSONB over the org row; the raw
    // ai_budgets select this replaced only ever saw the org row.
    getEffectiveAiBudgetMock.mockResolvedValue(budget('auto_approve'));

    const session = await create(manager, 'sess-partner-override');

    expect(getEffectiveAiBudgetMock).toHaveBeenCalledWith(ORG_ID);
    expect(session.approvalMode).toBe('auto_approve');
    // No direct ai_budgets read remains on this path.
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it('reloads the approval mode when an in-memory session is reused', async () => {
    const first = await create(manager, 'sess-reuse');
    expect(first.approvalMode).toBe('per_step');

    getEffectiveAiBudgetMock.mockResolvedValue(budget('hybrid_plan'));
    const second = await create(manager, 'sess-reuse');

    expect(second).toBe(first);
    expect(second.approvalMode).toBe('hybrid_plan');
  });

  it('does not swap the mode under a turn that is already running', async () => {
    const first = await create(manager, 'sess-in-flight');
    expect(first.approvalMode).toBe('per_step');

    // A turn started (or starts while the lookup is outstanding): the gate the
    // running turn began under must not change beneath it.
    first.state = 'processing';
    getEffectiveAiBudgetMock.mockResolvedValue(budget('auto_approve'));
    await create(manager, 'sess-in-flight');

    expect(first.approvalMode).toBe('per_step');
  });

  it('falls back to per_step for an unrecognized partner override value', async () => {
    getEffectiveAiBudgetMock.mockResolvedValue(budget('yolo_approve'));

    const session = await create(manager, 'sess-bogus-mode');

    expect(session.approvalMode).toBe('per_step');
  });

  it('falls back to per_step (strictest) when resolution fails', async () => {
    getEffectiveAiBudgetMock.mockRejectedValue(new Error('db down'));

    const session = await create(manager, 'sess-error');

    expect(session.approvalMode).toBe('per_step');
  });
});

describe('interactive approval timeout (#6475)', () => {
  let manager: StreamingSessionManager;
  const MIN = 60_000;

  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined);
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    }));
    getEffectiveAiBudgetMock.mockResolvedValue(budget('per_step'));
    loadApprovalWaitBudgetMsMock.mockResolvedValue(300_000);
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    manager.shutdown();
  });

  it('turn timeout and stall window keep their old values at the 5-minute default', () => {
    expect(turnTimeoutMsFor(5 * MIN)).toBe(6 * MIN);
    expect(processingStallTimeoutMsFor(5 * MIN)).toBe(PROCESSING_STALL_TIMEOUT_MS);
  });

  it('turn timeout and stall window scale past a longer configured wait', () => {
    expect(turnTimeoutMsFor(60 * MIN)).toBe(61 * MIN);
    expect(processingStallTimeoutMsFor(60 * MIN)).toBe(65 * MIN);
  });

  it('loads the budget for a new session and refreshes it on reuse between turns only', async () => {
    loadApprovalWaitBudgetMsMock.mockResolvedValue(30 * MIN);
    const session = await create(manager, 'sess-budget');
    expect(loadApprovalWaitBudgetMsMock).toHaveBeenCalledWith(ORG_ID);
    expect(session.approvalWaitBudgetMs).toBe(30 * MIN);

    loadApprovalWaitBudgetMsMock.mockResolvedValue(45 * MIN);
    await create(manager, 'sess-budget');
    expect(session.approvalWaitBudgetMs).toBe(45 * MIN);

    session.state = 'processing';
    loadApprovalWaitBudgetMsMock.mockResolvedValue(10 * MIN);
    await create(manager, 'sess-budget');
    expect(session.approvalWaitBudgetMs).toBe(45 * MIN);
  });

  it('the per-turn timeout does not fire at 6 minutes when the org allows a 30-minute wait', async () => {
    loadApprovalWaitBudgetMsMock.mockResolvedValue(30 * MIN);
    const session = await create(manager, 'sess-long-turn');
    const publish = vi.spyOn(session.eventBus, 'publish');
    const errored = () => publish.mock.calls.some(([e]) => e.type === 'error');
    vi.useFakeTimers();
    session.state = 'processing';
    manager.startTurnTimeout(session);

    vi.advanceTimersByTime(6 * MIN + 1);
    expect(errored()).toBe(false);

    vi.advanceTimersByTime(25 * MIN);
    expect(errored()).toBe(true);
  });
});
