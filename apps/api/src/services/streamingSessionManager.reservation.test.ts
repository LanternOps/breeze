/**
 * #5557 — a warm, reused in-memory session must pick up THIS turn's budget
 * reservation id when it doesn't already hold one, and must never overwrite
 * a reservation id that is already attached (the race guard between two
 * concurrent callers both observing `state === 'idle'`).
 *
 * Mock harness mirrors streamingSessionManager.approvalMode.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryMock, getEffectiveAiBudgetMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getEffectiveAiBudgetMock: vi.fn(),
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

import { StreamingSessionManager } from './streamingSessionManager';
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

function budget() {
  return {
    enabled: true,
    monthlyBudgetCents: null,
    dailyBudgetCents: null,
    maxTurnsPerSession: 50,
    messagesPerMinutePerUser: 20,
    messagesPerHourPerOrg: 200,
    approvalMode: 'per_step',
    alertThresholdPercents: [],
  };
}

function create(
  manager: StreamingSessionManager,
  id: string,
  budgetReservationId?: string,
) {
  return manager.getOrCreate(
    id,
    DB_SESSION,
    makeAuth(),
    undefined,
    'PROMPT',
    undefined,
    PLATFORM_CONFIG,
    undefined,
    undefined,
    budgetReservationId ? { budgetReservationId } : undefined,
  );
}

describe('getOrCreate — warm-session budget reservation attach (#5557)', () => {
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
    getEffectiveAiBudgetMock.mockResolvedValue(budget());
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  it('attaches a new reservation id to a warm, idle session that holds none', async () => {
    const first = await create(manager, 'sess-warm-attach', 'reservation-1');
    expect(first.budgetReservationId).toBe('reservation-1');
    // Simulate the route settling the first turn's reservation and going idle.
    first.state = 'idle';
    first.budgetReservationId = undefined;

    const second = await create(manager, 'sess-warm-attach', 'reservation-2');

    // Without the #5557 fix, budgetReservationId is only ever set at session
    // CREATION — the reused branch never assigns it, so this would stay
    // undefined and the reservation the route just took would never reach
    // the settle path.
    expect(second).toBe(first);
    expect(second.budgetReservationId).toBe('reservation-2');
  });

  it('does not overwrite a reservation id already held by the session', async () => {
    const first = await create(manager, 'sess-warm-race', 'reservation-a');
    expect(first.budgetReservationId).toBe('reservation-a');

    // A second caller reaches getOrCreate while the slot is still occupied
    // (before the route's tryTransitionToProcessing guard runs) with a
    // DIFFERENT reservation id — it must not clobber the winner's.
    const second = await create(manager, 'sess-warm-race', 'reservation-b');

    expect(second).toBe(first);
    expect(second.budgetReservationId).toBe('reservation-a');
  });
});
