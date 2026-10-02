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
}));
vi.mock('../services/aiModels/modelTransition', async (orig) => ({
  ...(await orig<typeof import('../services/aiModels/modelTransition')>()),
  readPreviousTurn: tr.readPreviousTurn,
  planModelTransition: tr.planModelTransition,
  readSessionOfferingId: vi.fn(async () => undefined),
}));

import { aiRoutes } from './ai';
import { db } from '../db';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { runPreFlightChecks } from '../services/aiAgentSdk';
import { reserveAiBudget } from '../services/aiBudgetReservations';
import { makeResolvedModel } from '../services/aiModels/__fixtures__/resolvedModel';
import { turnBindingFrom } from '../services/aiModels/turnBinding';

/**
 * W03 Task 7 — the chat message route consumes the preflight's resolved
 * model: an ineligible stored model is a recoverable 409 with NO reservation
 * (Review Focus 1), and the reservation, the dispatch and the turn claim all
 * carry exactly that model (finding 13).
 */
const ORG_ID = 'org-111';
const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const RESERVATION_ID = '66666666-6666-4666-8666-666666666666';

function postMessage(app: Hono) {
  return app.request(`/ai/sessions/${SESSION_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ content: 'hi' }),
  });
}

const DB_SESSION = {
  id: SESSION_ID, orgId: ORG_ID, sdkSessionId: null, maxTurns: 50, turnCount: 0,
  systemPrompt: 'sp', title: 'existing title', type: 'general', deviceId: null,
};

function makeActiveSession() {
  return {
    breezeSessionId: SESSION_ID,
    orgId: ORG_ID,
    state: 'idle',
    inputController: { pushMessage: vi.fn() },
    eventBus: {
      subscribe: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
      unsubscribe: vi.fn(),
      publish: vi.fn(),
    },
  } as any;
}

describe('POST /ai/sessions/:id/messages — model resolution (W03 Task 7)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/ai', aiRoutes);
  });

  afterEach(() => {
    vi.mocked(runPreFlightChecks).mockReset();
  });

  it('a turn whose model went ineligible returns 409 with the recoverable message and takes NO reservation', async () => {
    vi.mocked(runPreFlightChecks).mockResolvedValue({
      ok: false, error: 'Model Opus 5.5 is no longer available — choose another.', status: 409, code: 'model_unavailable',
    });
    const res = await postMessage(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Model Opus 5.5 is no longer available — choose another.', code: 'model_unavailable', recoverable: true,
    });
    expect(reserveAiBudget).not.toHaveBeenCalled();
    expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
  });

  it('the cutover gate (registry_unavailable) is a retryable 503 with its code and no reservation', async () => {
    vi.mocked(runPreFlightChecks).mockResolvedValue({
      ok: false, error: 'AI configuration is being upgraded. Try again in a moment.', status: 503, code: 'registry_unavailable',
    });
    const res = await postMessage(app);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'registry_unavailable', recoverable: true });
    expect(reserveAiBudget).not.toHaveBeenCalled();
  });

  it('the reservation, the dispatch and the turn claim carry exactly the resolved model (finding 13)', async () => {
    const model = makeResolvedModel('anthropic_byok');
    vi.mocked(runPreFlightChecks).mockResolvedValue({
      ok: true, session: DB_SESSION as any, sanitizedContent: 'hi', systemPrompt: 's',
      maxBudgetUsd: undefined, model,
    });
    const active = makeActiveSession();
    vi.mocked(streamingSessionManager.get).mockReturnValue(undefined);
    vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(active);
    vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) } as any);

    const res = await postMessage(app);
    expect(res.status).toBe(200);
    await res.text();

    expect(reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID, billingSource: 'partner_key', sessionId: SESSION_ID, binding: turnBindingFrom(model),
    }));
    const call = vi.mocked(streamingSessionManager.getOrCreate).mock.calls[0]!;
    expect(call[6]).toBe(model);
    expect(call[1]).not.toHaveProperty('model');
    expect(call[9]).toMatchObject({ ledgerUserId: 'user-1', toolSearch: true });
    expect(streamingSessionManager.tryTransitionToProcessing).toHaveBeenCalledWith(
      active, RESERVATION_ID, expect.objectContaining({ turnBinding: turnBindingFrom(model) }),
    );
  });
});

