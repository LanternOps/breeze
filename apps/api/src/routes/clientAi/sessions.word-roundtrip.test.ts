import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ============================================================================
// Phase 4 end-to-end seam proof (Step 5, part 2): a MUTATING Word tool round-
// trips through the SAME server seam Excel's write_range uses —
//   makeClientToolHandler('word', 'insert_text') → requestClientToolExecution
//   (publishes a `tool_request` with mutating:true) → the add-in POSTs a
//   `tool-result` → resolveClientToolResult resolves the PARKED handler promise.
//
// Unlike sessions.events-toolresults.test.ts (which stubs the bridge), this
// test uses the REAL clientAiToolBridge so the park/resolve handshake is
// genuine — the route POST /tool-results must actually unblock the handler.
// The MCP-prefixed name (mcp__word__insert_text) is pinned from the registry.
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

const WORD_SESSION_ROW = {
  id: SESSION_ID, orgId: ORG_ID, clientUserId: CLIENT_USER_ID, type: 'word_client',
  status: 'active', title: 'Doc edit', model: 'claude-sonnet-4-5-20250929',
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

/** A minimal ActiveSession the Word MCP handler can drive (mirrors the Excel
 *  write_range handler harness in clientAiTools.handler.test.ts). */
function makeWordSession() {
  const publish = vi.fn();
  const session = {
    breezeSessionId: SESSION_ID,
    orgId: ORG_ID,
    eventBus: { publish },
    toolUseIdQueue: ['toolu_word_insert'],
    auditSnapshot: { ip: '203.0.113.7', userAgent: 'word-addin' },
    auth: { user: { id: CLIENT_USER_ID, email: 'finance.user@contoso.com' } },
    clientWriteMode: 'readwrite' as const,
    clientDlpConfig: {},
  } as unknown as ActiveSession;
  return { session, publish };
}

beforeEach(() => {
  vi.clearAllMocks();
  policyState.policy = { ...defaultClientAiPolicy(ORG_ID), enabled: true };
  dbSelectMock.mockImplementation(() => selectChain([WORD_SESSION_ROW]));
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn(() => Promise.resolve()),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
  // Pass-through DLP so a successful Word tool_result reaches the model intact.
  applyDlpMock.mockImplementation(async (input: { text?: string; cells?: unknown[][] }) => ({
    action: 'allow',
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.cells !== undefined ? { cells: input.cells.map((r) => [...r]) } : {}),
    redactions: [],
  }));
});

describe('Word insert_text mutating round-trip (mcp__word__ seam proof)', () => {
  it('publishes a mutating tool_request and a posted tool-result resolves the parked handler', async () => {
    const { session, publish } = makeWordSession();

    // insert_text is registered as a MUTATING Word tool — its MCP-exposed name
    // is mcp__word__insert_text (the SDK toolset prefix), distinct from Excel's.
    expect(CLIENT_TOOL_REGISTRIES.word.insert_text!.mutating).toBe(true);
    expect(clientMcpToolNames('word')).toContain('mcp__word__insert_text');

    // 1) Drive the Word insert_text handler — this PARKS in the real bridge and
    //    publishes the tool_request event the add-in's pane renders.
    const handler = makeClientToolHandler('word', 'insert_text', () => session);
    const handlerPromise = handler({ text: 'Hello, world.', location: 'End' });

    // The bridge published the tool_request with the bare tool name + mutating:true.
    expect(publish).toHaveBeenCalledWith({
      type: 'tool_request',
      toolUseId: 'toolu_word_insert',
      toolName: 'insert_text',
      input: { text: 'Hello, world.', location: 'End' },
      mutating: true,
    });
    expect(_pendingCountForTests()).toBe(1); // genuinely parked, awaiting the pane

    // 2) The Word add-in POSTs the tool-result for the parked request.
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/tool-results`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({
        toolUseId: 'toolu_word_insert',
        status: 'success',
        output: { inserted: true, location: 'End', charactersInserted: 13 },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // 3) The posted result UNBLOCKS the parked handler (real bridge resolution).
    const result = await handlerPromise;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('"inserted":true');
    expect(_pendingCountForTests()).toBe(0); // nothing left parked

    // The handler also published a success tool_completed for the Word tool.
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_completed', toolName: 'insert_text', status: 'success' }),
    );
  });

  it('a tool-result for a different session does NOT resolve this session (cross-session guard)', async () => {
    const { session } = makeWordSession();
    const handler = makeClientToolHandler('word', 'insert_text', () => session);
    const handlerPromise = handler({ text: 'x', location: 'Replace' });
    expect(_pendingCountForTests()).toBe(1);

    // A POST scoped to a DIFFERENT session id can't see THIS session's parked
    // request — loadClientSession resolves it but resolveClientToolResult is
    // keyed by sessionId, so the bridge returns false → 404 unknown_tool_request.
    const otherId = 'b2b2b2b2-1111-4222-8333-444455556666';
    dbSelectMock.mockImplementation(() =>
      selectChain([{ ...WORD_SESSION_ROW, id: otherId }]),
    );
    const res = await buildApp().request(`/client-ai/sessions/${otherId}/tool-results`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ toolUseId: 'toolu_word_insert', status: 'success', output: null }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('unknown_tool_request');
    expect(_pendingCountForTests()).toBe(1); // still parked

    // Clean up the parked request so its timer doesn't leak into other tests.
    failPendingForSession(SESSION_ID);
    await handlerPromise;
  });
});
