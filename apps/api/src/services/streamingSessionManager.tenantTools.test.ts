/**
 * getOrCreate degrades tenant (BYO MCP) tool resolution instead of failing
 * the whole chat session — the MCP surface deliberately degrades when a
 * tenant tool source is unreachable/misconfigured (see toolSources/discovery
 * and toolSources/resolver), and an unhandled throw from `resolveTenantTools`
 * here must not take down a chat turn that has nothing to do with any
 * particular tool source.
 *
 * Mock harness mirrors streamingSessionManager.approvalMode.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryMock, getEffectiveAiBudgetMock, resolveTenantToolsMock, captureExceptionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getEffectiveAiBudgetMock: vi.fn(),
  resolveTenantToolsMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock, tool: vi.fn() }));

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
vi.mock('./sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: vi.fn(),
}));
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
  compactToolResultForChat: (_name: string, s: string) => s,
}));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

// The seam under test: a real `resolveTenantTools` failure (source
// unreachable, decrypt error, etc.) must not propagate out of `getOrCreate`.
vi.mock('./toolSources/resolver', () => ({
  resolveTenantTools: (...args: unknown[]) => resolveTenantToolsMock(...args),
}));

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

describe('getOrCreate — tenant tool resolution degrades on failure', () => {
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
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  it('degrades to no tenant tools instead of failing the whole chat session', async () => {
    resolveTenantToolsMock.mockRejectedValue(new Error('tool source unreachable'));

    const session = await create(manager, 'sess-tenant-tools-fail');

    expect(session.tenantTools.size).toBe(0);
  });

  it('still resolves tenant tools normally when resolution succeeds', async () => {
    resolveTenantToolsMock.mockResolvedValue([
      { qualifiedName: 'hudu__get_asset', id: 'tool-1' },
    ]);

    const session = await create(manager, 'sess-tenant-tools-ok');

    expect(session.tenantTools.size).toBe(1);
    expect(session.tenantTools.has('hudu__get_asset')).toBe(true);
  });

  // #6023: a partner-scoped chat session couldn't reach an org-owned tool
  // source because resolveTenantTools was called with only `toolAuth`,
  // never the session's pinned org. Pin the wiring: the session's own
  // dbSession.orgId must be forwarded as resolveTenantTools' targetOrgId.
  it('passes the session\'s pinned org as targetOrgId to resolveTenantTools for a partner-scoped session', async () => {
    resolveTenantToolsMock.mockResolvedValue([]);
    const partnerAuth: AuthContext = {
      scope: 'partner',
      orgId: null,
      partnerId: 'partner-1',
      accessibleOrgIds: [ORG_ID],
      ...buildOrgAccessClosures([ORG_ID]),
      user: { id: USER_ID, email: 'tech@msp.example' },
    } as unknown as AuthContext;

    await manager.getOrCreate(
      'sess-partner-target-org',
      DB_SESSION,
      partnerAuth,
      undefined,
      'PROMPT',
      undefined,
      PLATFORM_CONFIG,
    );

    expect(resolveTenantToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'partner', partnerId: 'partner-1' }),
      ORG_ID,
    );
  });
});
