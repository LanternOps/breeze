import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ============================================================================
// Phase 5 end-to-end seam proof (S3, part 2): a MUTATING PowerPoint tool round-
// trips through the SAME server seam Excel's write_range and Word's insert_text
// use —
//   makeClientToolHandler('powerpoint', 'format_selection') →
//   requestClientToolExecution (publishes a `tool_request` with mutating:true) →
//   the add-in POSTs a `tool-result` → resolveClientToolResult resolves the
//   PARKED handler promise.
//
// Unlike sessions.events-toolresults.test.ts (which stubs the bridge), this
// test uses the REAL clientAiToolBridge so the park/resolve handshake is
// genuine — the route POST /tool-results must actually unblock the handler.
// The MCP-prefixed name (mcp__powerpoint__format_selection) is pinned from the
// registry, distinct from Excel's and Word's.
// ============================================================================

const {
  CLIENT_USER_ID, ORG_ID, SESSION_ID,
  policyState,
  dbSelectMock, dbInsertMock, dbUpdateMock,
  managerMock,
  writeAuditEventMock,
  recordClientUsageMock, checkClientBudgetMock, getRemainingBudgetMock,
  checkBillingCreditsMock, rateLimiterMock,
  applyDlpMock,
} = vi.hoisted(() => ({
  CLIENT_USER_ID: 'beefbeef-1111-4222-8333-444455556666',
  ORG_ID: '0c0c0c0c-1111-4222-8333-444455556666',
  SESSION_ID: 'a1a1a1a1-1111-4222-8333-444455556666',
  policyState: { policy: {} as Record<string, unknown> },
  dbSelectMock: vi.fn(),
  dbInsertMock: vi.fn(),
  dbUpdateMock: vi.fn(),
  managerMock: {
    getOrCreate: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
    tryTransitionToProcessing: vi.fn(() => true),
    startTurnTimeout: vi.fn(),
  },
  writeAuditEventMock: vi.fn(),
  recordClientUsageMock: vi.fn(() => Promise.resolve()),
  checkClientBudgetMock: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  getRemainingBudgetMock: vi.fn(() => Promise.resolve(undefined)),
  checkBillingCreditsMock: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  rateLimiterMock: vi.fn(() => Promise.resolve({ allowed: true, remaining: 9, resetAt: new Date() })),
  applyDlpMock: vi.fn(),
}));

vi.mock('../../middleware/clientAiAuth', () => ({
  clientAiAuthMiddleware: (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('clientAiAuth', {
      clientUserId: CLIENT_USER_ID, orgId: ORG_ID,
      email: 'finance.user@contoso.com', name: 'Finance User', token: 'tok',
    });
    return next();
  },
  requireClientAiEnabledMiddleware: (c: any, next: any) => {
    c.set('clientAiPolicy', policyState.policy);
    return next();
  },
}));

vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: dbInsertMock, update: dbUpdateMock },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../../services/streamingSessionManager', () => ({ streamingSessionManager: managerMock }));
vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: (s: { ip?: string; userAgent?: string }) => ({
    req: { header: () => s.userAgent },
  }),
}));
vi.mock('../../services/clientAiUsage', () => ({
  recordClientUsage: recordClientUsageMock,
  checkClientBudget: checkClientBudgetMock,
  getRemainingClientBudgetUsd: getRemainingBudgetMock,
}));
vi.mock('../../services/aiCostTracker', () => ({ checkBillingCredits: checkBillingCreditsMock }));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => ({}) as never) }));
vi.mock('../../services/clientAiDlp', () => ({ applyDlp: applyDlpMock }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

// NB: clientAiToolBridge is intentionally NOT mocked — the real park/resolve
// handshake is the thing under test.

import { clientAiSessionRoutes } from './sessions';
import { defaultClientAiPolicy } from '../../services/clientAiPolicy';
import {
  makeClientToolHandler,
  clientMcpToolNames,
  CLIENT_TOOL_REGISTRIES,
} from '../../services/clientAiTools';
import { failPendingForSession, _pendingCountForTests } from '../../services/clientAiToolBridge';
import type { ActiveSession } from '../../services/streamingSessionManager';

const POWERPOINT_SESSION_ROW = {
  id: SESSION_ID, orgId: ORG_ID, clientUserId: CLIENT_USER_ID, type: 'powerpoint_client',
  status: 'active', title: 'Deck polish', model: 'claude-sonnet-4-5-20250929',
  systemPrompt: 'P', sdkSessionId: null, maxTurns: 50, turnCount: 0,
  totalInputTokens: 0, totalOutputTokens: 0, totalCostCents: 0,
  createdAt: new Date(), lastActivityAt: new Date(),
};

function selectChain(rows: unknown[]) {
  const limit = vi.fn(() => Promise.resolve(rows));
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ limit, orderBy }));
  return { from: vi.fn(() => ({ where })) };
}

function buildApp() {
  const app = new Hono();
  app.route('/client-ai/sessions', clientAiSessionRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' };

/** A minimal ActiveSession the PowerPoint MCP handler can drive (mirrors the
 *  Word format/insert handler harness in clientAiTools.handler.test.ts). */
function makePptSession() {
  const publish = vi.fn();
  const session = {
    breezeSessionId: SESSION_ID,
    orgId: ORG_ID,
    eventBus: { publish },
    toolUseIdQueue: ['toolu_ppt_format'],
    auditSnapshot: { ip: '203.0.113.7', userAgent: 'powerpoint-addin' },
    auth: { user: { id: CLIENT_USER_ID, email: 'finance.user@contoso.com' } },
    clientWriteMode: 'readwrite' as const,
    clientDlpConfig: {},
  } as unknown as ActiveSession;
  return { session, publish };
}

beforeEach(() => {
  vi.clearAllMocks();
  policyState.policy = { ...defaultClientAiPolicy(ORG_ID), enabled: true };
  dbSelectMock.mockImplementation(() => selectChain([POWERPOINT_SESSION_ROW]));
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn(() => Promise.resolve()),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
  // Pass-through DLP so a successful PowerPoint tool_result reaches the model intact.
  applyDlpMock.mockImplementation(async (input: { text?: string; cells?: unknown[][] }) => ({
    action: 'allow',
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.cells !== undefined ? { cells: input.cells.map((r) => [...r]) } : {}),
    redactions: [],
  }));
});

describe('PowerPoint format_selection mutating round-trip (mcp__powerpoint__ seam proof)', () => {
  it('publishes a mutating tool_request and a posted tool-result resolves the parked handler', async () => {
    const { session, publish } = makePptSession();

    // format_selection is registered as a MUTATING PowerPoint tool — its MCP-
    // exposed name is mcp__powerpoint__format_selection (the SDK toolset prefix),
    // distinct from Excel's and Word's.
    expect(CLIENT_TOOL_REGISTRIES.powerpoint.format_selection!.mutating).toBe(true);
    expect(clientMcpToolNames('powerpoint')).toContain('mcp__powerpoint__format_selection');

    // 1) Drive the PowerPoint format_selection handler — this PARKS in the real
    //    bridge and publishes the tool_request event the add-in's pane renders.
    const handler = makeClientToolHandler('powerpoint', 'format_selection', () => session);
    const input = { format: { bold: true, fontColor: '#1F4E79', fontSize: 28 } };
    const handlerPromise = handler(input);

    // The bridge published the tool_request with the bare tool name + mutating:true.
    expect(publish).toHaveBeenCalledWith({
      type: 'tool_request',
      toolUseId: 'toolu_ppt_format',
      toolName: 'format_selection',
      input,
      mutating: true,
    });
    expect(_pendingCountForTests()).toBe(1); // genuinely parked, awaiting the pane

    // 2) The PowerPoint add-in POSTs the tool-result for the parked request.
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/tool-results`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({
        toolUseId: 'toolu_ppt_format',
        status: 'success',
        output: { applied: ['Shape 1'] },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // 3) The posted result UNBLOCKS the parked handler (real bridge resolution).
    const result = await handlerPromise;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('"applied"');
    expect(_pendingCountForTests()).toBe(0); // nothing left parked

    // The handler also published a success tool_completed for the PowerPoint tool.
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_completed', toolName: 'format_selection', status: 'success' }),
    );
  });

  it('a tool-result for a different session does NOT resolve this session (cross-session guard)', async () => {
    const { session } = makePptSession();
    const handler = makeClientToolHandler('powerpoint', 'format_selection', () => session);
    const handlerPromise = handler({ format: { italic: true } });
    expect(_pendingCountForTests()).toBe(1);

    // A POST scoped to a DIFFERENT session id can't see THIS session's parked
    // request — loadClientSession resolves it but resolveClientToolResult is
    // keyed by sessionId, so the bridge returns false → 404 unknown_tool_request.
    const otherId = 'b2b2b2b2-1111-4222-8333-444455556666';
    dbSelectMock.mockImplementation(() =>
      selectChain([{ ...POWERPOINT_SESSION_ROW, id: otherId }]),
    );
    const res = await buildApp().request(`/client-ai/sessions/${otherId}/tool-results`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ toolUseId: 'toolu_ppt_format', status: 'success', output: null }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('unknown_tool_request');
    expect(_pendingCountForTests()).toBe(1); // still parked

    // Clean up the parked request so its timer doesn't leak into other tests.
    failPendingForSession(SESSION_ID);
    await handlerPromise;
  });
});
