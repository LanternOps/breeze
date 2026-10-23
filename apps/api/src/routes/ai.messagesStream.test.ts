import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// routes/ai.ts reaches the model registry (ticket-draft) -> candidateLoader,
// which this file's partial schema mock does not cover. Not under test here.
vi.mock('../services/aiModels/sessionModel', () => ({
  resolveSessionTurn: vi.fn(),
}));
import { Hono } from 'hono';

// #3127: depth of the (mocked) short per-phase DB contexts the message-send
// handler opens now that it no longer runs inside a request transaction.
const dbCtx = vi.hoisted(() => ({ depth: 0 }));

// Topology M4 turn harness (#6000 on #3127): the lazily-imported route half.
const topo = vi.hoisted(() => ({
  prepare: vi.fn(),
  abort: vi.fn(async () => undefined),
  cachedEventsDepth: [] as number[],
}));

vi.mock('./aiTopologyTurn', () => ({
  prepareTopologyTurn: topo.prepare,
  cachedTopologyEvents: vi.fn((explanation: unknown) => {
    topo.cachedEventsDepth.push(dbCtx.depth);
    return [
      { type: 'topology_progress', phase: 'validating' },
      { type: 'topology_explanation', explanation },
      { type: 'done' },
    ];
  }),
  topologyMcpServerFactory: vi.fn(),
}));

vi.mock('../config/validate', () => ({
  getConfig: vi.fn(() => ({
    MCP_LLM_PROVIDER: 'anthropic',
    MCP_LLM_BASE_URL: 'http://llm.example.test',
    MCP_LLM_API_KEY: 'k',
    MCP_LLM_PRICE_INPUT_PER_M_USD: 1,
    MCP_LLM_PRICE_OUTPUT_PER_M_USD: 1,
  })),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  aiSessions: {
    id: 'aiSessions.id',
    orgId: 'aiSessions.orgId',
    flaggedAt: 'aiSessions.flaggedAt',
    flaggedBy: 'aiSessions.flaggedBy',
    flagReason: 'aiSessions.flagReason',
  },
  aiMessages: {
    id: 'aiMessages.id',
    sessionId: 'aiMessages.sessionId',
  },
  aiToolExecutions: {
    id: 'aiToolExecutions.id',
    sessionId: 'aiToolExecutions.sessionId',
    status: 'aiToolExecutions.status',
    toolName: 'aiToolExecutions.toolName',
    createdAt: 'aiToolExecutions.createdAt',
    durationMs: 'aiToolExecutions.durationMs',
    toolInput: 'aiToolExecutions.toolInput',
    approvedBy: 'aiToolExecutions.approvedBy',
    approvedAt: 'aiToolExecutions.approvedAt',
    errorMessage: 'aiToolExecutions.errorMessage',
    completedAt: 'aiToolExecutions.completedAt',
  },
  auditLogs: {
    id: 'auditLogs.id',
    orgId: 'auditLogs.orgId',
    action: 'auditLogs.action',
    timestamp: 'auditLogs.timestamp',
    actorType: 'auditLogs.actorType',
    actorEmail: 'auditLogs.actorEmail',
    resourceType: 'auditLogs.resourceType',
    resourceId: 'auditLogs.resourceId',
    result: 'auditLogs.result',
    errorMessage: 'auditLogs.errorMessage',
    details: 'auditLogs.details',
  },
  aiActionPlans: {
    id: 'aiActionPlans.id',
    status: 'aiActionPlans.status',
    approvedBy: 'aiActionPlans.approvedBy',
    approvedAt: 'aiActionPlans.approvedAt',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => {
    dbCtx.depth += 1;
    try {
      return await fn();
    } finally {
      dbCtx.depth -= 1;
    }
  }),
}));

vi.mock('../services/aiAgent', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  closeSession: vi.fn(),
  getSessionMessages: vi.fn(),
  handleApproval: vi.fn(),
  isIntentBackedExecution: vi.fn(),
  searchSessions: vi.fn(),
}));

vi.mock('../services/aiCostTracker', () => ({
  getSessionHistory: vi.fn(),
  getUsageSummary: vi.fn(),
  updateBudget: vi.fn(),
}));

vi.mock('../services/aiBudgetReservations', () => ({
  reserveAiBudget: vi.fn(async () => ({
    kind: 'unlimited',
    reservationId: '66666666-6666-4666-8666-666666666666',
    dailyPeriodKey: '2026-09-06',
    monthlyPeriodKey: '2026-09-01',
    status: 'active',
  })),
  releaseUnusedAiBudgetReservation: vi.fn(async () => ({
    kind: 'released', reservationId: '66666666-6666-4666-8666-666666666666',
  })),
  markAiBudgetReservationIndeterminate: vi.fn(async () => ({
    kind: 'indeterminate', reservationId: '66666666-6666-4666-8666-666666666666',
  })),
  AiBudgetSessionBusyError: class AiBudgetSessionBusyError extends Error {},
}));

vi.mock('../services/streamingSessionManager', () => ({
  streamingSessionManager: {
    getOrCreate: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
    tryTransitionToProcessing: vi.fn(),
    interrupt: vi.fn(),
    startTurnTimeout: vi.fn(),
  },
}));

vi.mock('../services/aiAgentSdk', () => ({
  runPreFlightChecks: vi.fn(),
  settleBlockedTurnForNewMessage: vi.fn(() => Promise.resolve('not_blocked_on_approvals')),
  abortActivePlan: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

// W05 (#7603): the transition gate. Typed against the real signatures (Codex
// review finding 21): an inferred `{ kind: string }` return would reject the
// later `reason` / `carriedRates` mocks.
const tr = vi.hoisted(() => ({
  readPreviousTurn: vi.fn<(...a: unknown[]) => Promise<import('../services/aiModels/modelTransition').PreviousTurn | null>>(async () => null),
  planModelTransition: vi.fn<(...a: unknown[]) => Promise<import('../services/aiModels/modelTransition').ModelTransition>>(async () => ({ kind: 'fresh' })),
  // undefined = no row: the route keeps the preflight snapshot.
  readSessionOfferingId: vi.fn<(...a: unknown[]) => Promise<string | null | undefined>>(async () => undefined),
}));
vi.mock('../services/aiModels/modelTransition', async (orig) => ({
  ...(await orig<typeof import('../services/aiModels/modelTransition')>()),
  readPreviousTurn: tr.readPreviousTurn,
  planModelTransition: tr.planModelTransition,
  readSessionOfferingId: tr.readSessionOfferingId,
}));

import { aiRoutes } from './ai';
import { db } from '../db';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { runPreFlightChecks } from '../services/aiAgentSdk';
import { makeResolvedModel } from '../services/aiModels/__fixtures__/resolvedModel';

import { settleBlockedTurnForNewMessage } from '../services/aiAgentSdk';
import { getSession } from '../services/aiAgent';
import { SessionEventBus } from '../services/sessionEventBus';

/**
 * #9427 W1 T3 — `/messages` gives each turn an identity an attaching client
 * can anchor on (`turnUserMessageId` from the user-row insert), codes every
 * "another turn is running" refusal as `turn_in_progress` (so a client can
 * attach instead of failing), and drops its bus subscription the moment the
 * client goes away — without interrupting the turn.
 */
const ORG_ID = 'org-111';
const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const USER_ROW_ID = '77777777-7777-4777-8777-777777777777';

const DB_SESSION = {
  id: SESSION_ID, orgId: ORG_ID, sdkSessionId: null, maxTurns: 50, turnCount: 0,
  systemPrompt: 'sp', title: 'existing title', type: 'general', deviceId: null,
};

function makeActiveSession() {
  return {
    breezeSessionId: SESSION_ID,
    orgId: ORG_ID,
    state: 'processing',
    turnId: 'turn-1',
    turnUserMessageId: null as string | null,
    inputController: { pushMessage: vi.fn() },
    eventBus: new SessionEventBus(),
  } as any;
}

function post(app: Hono) {
  return app.request(`/ai/sessions/${SESSION_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ content: 'hi' }),
  });
}

/** Poll until `fn()` is true. */
async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('until(): condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('POST /ai/sessions/:id/messages — turn identity, coded 409s, abort teardown (#9427)', () => {
  let app: Hono;
  let insertValues: ReturnType<typeof vi.fn>;
  let insertReturning: ReturnType<typeof vi.fn>;
  const model = makeResolvedModel('anthropic_byok');

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/ai', aiRoutes);
    vi.mocked(runPreFlightChecks).mockResolvedValue({
      ok: true, session: { ...DB_SESSION } as any,
      sanitizedContent: 'hi', systemPrompt: 'sys', maxBudgetUsd: undefined, model,
    });
    vi.mocked(streamingSessionManager.get).mockReturnValue(undefined);
    vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);
    insertReturning = vi.fn().mockResolvedValue([{ id: USER_ROW_ID }]);
    insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);
  });

  afterEach(() => {
    vi.mocked(runPreFlightChecks).mockReset();
  });

  it('settle finds no approval wait → 409 turn_in_progress with the existing text', async () => {
    vi.mocked(streamingSessionManager.get).mockReturnValue({ state: 'processing' } as any);
    vi.mocked(settleBlockedTurnForNewMessage).mockResolvedValueOnce('not_blocked_on_approvals');
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'A message is already being processed for this session',
      code: 'turn_in_progress',
    });
    expect(streamingSessionManager.remove).not.toHaveBeenCalled();
  });

  it('settle times out → 409 turn_in_progress with the "wrapping up" text', async () => {
    vi.mocked(streamingSessionManager.get).mockReturnValue({ state: 'processing' } as any);
    vi.mocked(settleBlockedTurnForNewMessage).mockResolvedValueOnce('still_processing');
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'The assistant is wrapping up the previous turn — please try again in a moment',
      code: 'turn_in_progress',
    });
  });

  it('losing the processing slot → 409 turn_in_progress', async () => {
    vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(makeActiveSession());
    vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(false);
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'A message is already being processed for this session',
      code: 'turn_in_progress',
    });
  });

  it('still tears the prior in-memory session down before every turn (one bus per turn)', async () => {
    const prior = { state: 'idle' };
    vi.mocked(streamingSessionManager.get).mockReturnValue(prior as any);
    const active = makeActiveSession();
    vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(active);
    active.inputController.pushMessage = vi.fn(() => active.eventBus.publish({ type: 'done' }));
    await (await post(app)).text();
    expect(streamingSessionManager.remove).toHaveBeenCalledWith(SESSION_ID);
  });

  it('records the inserted user row id as the turn anchor', async () => {
    const active = makeActiveSession();
    vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(active);
    active.inputController.pushMessage = vi.fn(() => {
      // Set before the turn is pushed, so an attach during the turn sees it.
      expect(active.turnUserMessageId).toBe(USER_ROW_ID);
      active.eventBus.publish({ type: 'done' });
    });
    const res = await post(app);
    expect(res.status).toBe(200);
    await res.text();
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_ID, role: 'user' }));
    expect(insertReturning).toHaveBeenCalled();
    expect(active.turnUserMessageId).toBe(USER_ROW_ID);
    expect(active.inputController.pushMessage).toHaveBeenCalledTimes(1);
  });

  it('a client abort drops its subscription at once; the turn keeps running and publishing', async () => {
    const active = makeActiveSession();
    vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(active);
    active.inputController.pushMessage = vi.fn(() => {
      active.eventBus.publish({ type: 'message_start', messageId: 'm1' });
    });
    const res = await post(app);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('message_start');
    expect(active.eventBus.subscriberCount).toBe(1);

    await reader.cancel();

    // Before any further event — not on the next publish.
    await until(() => active.eventBus.subscriberCount === 0);
    expect(active.eventBus.closed).toBe(false);
    expect(active.state).toBe('processing');
    expect(streamingSessionManager.interrupt).not.toHaveBeenCalled();
    // The turn goes on publishing for anyone else (attach).
    active.eventBus.publish({ type: 'content_delta', delta: 'still going' });
    active.eventBus.publish({ type: 'done' });
    expect(active.eventBus.snapshot()).toMatchObject({ lastSeq: 3, sawDone: true });
  });
});

describe('GET /ai/sessions/:id/stream is mounted on aiRoutes (#9427)', () => {
  it('answers through the owner-bound getSession: 404 when it finds no row', async () => {
    vi.clearAllMocks();
    const app = new Hono();
    app.route('/ai', aiRoutes);
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await app.request(`/ai/sessions/${SESSION_ID}/stream`, { headers: { Authorization: 'Bearer token' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Session not found' });
    expect(getSession).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ user: expect.objectContaining({ id: 'user-1' }) }));
    expect(vi.mocked(getSession).mock.calls[0]).toHaveLength(2);
  });
});
