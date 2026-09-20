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

  it('attaches this turn\u2019s reservation atomically with the turn-slot claim', () => {
    const session = { state: 'idle', budgetReservationId: undefined, lastActivityAt: 0 } as unknown as
      Parameters<typeof manager.tryTransitionToProcessing>[0];

    expect(manager.tryTransitionToProcessing(session, 'reservation-1')).toBe(true);
    expect(session.budgetReservationId).toBe('reservation-1');
  });

  it('re-attaches on a SECOND turn of a warm session, which creation-time assignment never did', async () => {
    const first = await create(manager, 'sess-warm-attach', 'reservation-1');
    expect(first.budgetReservationId).toBe('reservation-1');
    // The first turn settled and cleared the slot; the session stays warm.
    first.state = 'idle';
    first.budgetReservationId = undefined;

    const second = await create(manager, 'sess-warm-attach', 'reservation-2');
    expect(second).toBe(first);
    // getOrCreate deliberately does NOT attach on reuse — that is the race the
    // fix moved away from. The reservation arrives with the slot claim.
    expect(second.budgetReservationId).toBeUndefined();

    expect(manager.tryTransitionToProcessing(second, 'reservation-2')).toBe(true);
    // Before #5557 this stayed undefined on every turn after the first, so the
    // reservation never reached the settle path and held the org's whole cap
    // until the 30-minute sweep.
    expect(second.budgetReservationId).toBe('reservation-2');
  });

  it('leaves the winner\u2019s reservation alone when a concurrent turn loses the slot', async () => {
    const session = await create(manager, 'sess-warm-race', 'reservation-a');
    session.state = 'idle';
    session.budgetReservationId = undefined;

    // A wins the slot and attaches its own reservation.
    expect(manager.tryTransitionToProcessing(session, 'reservation-a')).toBe(true);
    // B arrives after and is refused — crucially WITHOUT overwriting what the
    // live dispatch is going to settle. B then releases 'reservation-b', which
    // was never attached to anything.
    expect(manager.tryTransitionToProcessing(session, 'reservation-b')).toBe(false);
    expect(session.budgetReservationId).toBe('reservation-a');
  });
});
