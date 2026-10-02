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

// OpenAI-compatible branch harness (#3127): provider switch + session manager.
const openai = vi.hoisted(() => ({
  provider: 'anthropic' as 'anthropic' | 'openai-compatible',
  manager: {
    getOrCreate: vi.fn(),
    tryTransitionToProcessing: vi.fn(),
    startTurn: vi.fn(),
  },
}));

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
    MCP_LLM_PROVIDER: openai.provider,
    MCP_LLM_BASE_URL: 'http://llm.example.test',
    MCP_LLM_API_KEY: 'k',
    MCP_LLM_PRICE_INPUT_PER_M_USD: 1,
    MCP_LLM_PRICE_OUTPUT_PER_M_USD: 1,
  })),
}));

vi.mock('../services/llm/openaiSessionManager', () => ({
  OpenAISessionManager: vi.fn(function OpenAISessionManager() {
    return openai.manager;
  }),
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
import { reserveAiBudget } from '../services/aiBudgetReservations';
import { makeResolvedModel } from '../services/aiModels/__fixtures__/resolvedModel';
import { turnBindingFrom } from '../services/aiModels/turnBinding';
import { AiBudgetSessionBusyError } from '../services/aiBudgetReservations';
import { withCarriedRates } from '../services/aiModels/turnBinding';
import { getSessionMessages } from '../services/aiAgent';

/**
 * W05 (#7603) — the composer's model choice rides on the message (D1) and
 * passes ONE gate (planModelTransition) before anything is reserved: a
 * transcript too large for the target is a 409 continuation with no
 * reservation (spike constraint 1), a resumable switch reserves with the
 * carried rates and recreates the query as a modelSwitch (constraints 2, 4),
 * and a switch racing a turn in flight is a 409 turn_in_progress (constraint 3).
 */
const ORG_ID = 'org-111';
const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const RESERVATION_ID = '66666666-6666-4666-8666-666666666666';
const OFF = '0b8f1f2e-6a1c-4c55-9a39-6a7f1e1c0a01';

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

function postWithModel(app: Hono, model?: unknown) {
  return app.request(`/ai/sessions/${SESSION_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ content: 'hi', ...(model ? { model } : {}) }),
  });
}

describe('POST /ai/sessions/:id/messages — model switch (W05)', () => {
  let app: Hono;
  const model = makeResolvedModel('anthropic_byok', { offering: { id: OFF, displayName: 'Haiku 4.5' } });

  beforeEach(() => {
    vi.clearAllMocks();
    openai.provider = 'anthropic';
    app = new Hono();
    app.route('/ai', aiRoutes);
    vi.mocked(runPreFlightChecks).mockResolvedValue({
      ok: true, session: { ...DB_SESSION, sdkSessionId: 'sdk-1', model: 'claude-sonnet-5-5', offeringId: 'off-sonnet' } as any,
      sanitizedContent: 'hi', systemPrompt: 'sys', maxBudgetUsd: undefined, model, openaiCompatible: false,
    });
    vi.mocked(streamingSessionManager.get).mockReturnValue(undefined);
    vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(makeActiveSession());
    vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) } as any);
  });

  afterEach(() => {
    vi.mocked(runPreFlightChecks).mockReset();
  });

  it('passes the composer\'s choice to the preflight', async () => {
    await (await postWithModel(app, { offeringId: OFF, options: { effort: 'high' } })).text();
    expect(vi.mocked(runPreFlightChecks).mock.calls[0]![5]).toEqual({ offeringId: OFF, options: { effort: 'high' } });
  });

  it('a switch whose transcript does not fit returns 409 continuation_required and reserves nothing', async () => {
    tr.planModelTransition.mockResolvedValueOnce({ kind: 'continuation_required', reason: 'transcript_too_large' });
    const res = await postWithModel(app, { offeringId: OFF });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This conversation is too long for Haiku 4.5. Continue in a new chat that starts from a summary of this one.',
      code: 'continuation_required', reason: 'transcript_too_large', recoverable: true,
      target: { offeringId: OFF, displayName: 'Haiku 4.5' },
    });
    expect(reserveAiBudget).not.toHaveBeenCalled();
    expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
  });

  it('the planner sees the session\'s transcript, model, previous turn, target and prompt', async () => {
    tr.readPreviousTurn.mockResolvedValueOnce({
      reservationId: 'res-prev', wireModel: 'claude-sonnet-5-5', connectionId: 'conn-1', configVersion: 2, catalogRevisionId: null,
      funding: 'partner_key', rateSnapshot: model.rateSnapshot, carriedRates: [],
    });
    await (await postWithModel(app, { offeringId: OFF })).text();
    expect(tr.readPreviousTurn).toHaveBeenCalledWith({ orgId: ORG_ID, sessionId: SESSION_ID });
    expect(tr.planModelTransition).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID, sdkSessionId: 'sdk-1', sessionOfferingId: 'off-sonnet', target: model, systemPrompt: 'sys',
      pendingUserTurn: 'hi', previous: expect.objectContaining({ wireModel: 'claude-sonnet-5-5' }),
    }));
    expect(reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({
      sessionSwitchGuard: { expectedPreviousChatReservationId: 'res-prev' },
    }));
  });

  it('the gate runs with no request DB context held (#3127: self-managed route)', async () => {
    const depths: number[] = [];
    tr.readPreviousTurn.mockImplementationOnce(async () => { depths.push(dbCtx.depth); return null; });
    tr.planModelTransition.mockImplementationOnce(async () => { depths.push(dbCtx.depth); return { kind: 'fresh' }; });
    await (await postWithModel(app, { offeringId: OFF })).text();
    expect(depths).toEqual([0, 0]);
  });

  it('a resumable switch reserves with the carried rates and recreates the query as a modelSwitch', async () => {
    const carried = [{ wireModel: 'claude-sonnet-5-5', rateSnapshot: { source: 'linked_platform' as const, standard: { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 } } }];
    tr.planModelTransition.mockResolvedValueOnce({ kind: 'switch_resume', carriedRates: carried, fit: { kind: 'fits', countedTokens: 10, limitTokens: 100 } });
    await (await postWithModel(app, { offeringId: OFF })).text();
    const binding = withCarriedRates(turnBindingFrom(model), carried);
    expect(reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({ binding }));
    expect(vi.mocked(streamingSessionManager.getOrCreate).mock.calls[0]![9]).toMatchObject({ modelSwitch: true });
    expect(streamingSessionManager.tryTransitionToProcessing).toHaveBeenCalledWith(
      expect.anything(), RESERVATION_ID, expect.objectContaining({ turnBinding: binding }),
    );
  });

  it('the planner gets the session offering re-read AFTER resolveModel (its lazy cutover stamps it), not the preflight snapshot (M2)', async () => {
    vi.mocked(runPreFlightChecks).mockResolvedValueOnce({
      ok: true, session: { ...DB_SESSION, sdkSessionId: 'sdk-1', model: 'claude-sonnet-5-5', offeringId: null } as any,
      sanitizedContent: 'hi', systemPrompt: 'sys', maxBudgetUsd: undefined, model, openaiCompatible: false,
    });
    const depths: number[] = [];
    tr.readSessionOfferingId.mockImplementationOnce(async () => { depths.push(dbCtx.depth); return OFF; });
    await (await postWithModel(app)).text();
    expect(tr.readSessionOfferingId).toHaveBeenCalledWith({ orgId: ORG_ID, sessionId: SESSION_ID });
    expect(tr.planModelTransition).toHaveBeenCalledWith(expect.objectContaining({ sessionOfferingId: OFF }));
    // #3127: read with no request DB context held.
    expect(depths).toEqual([0]);
  });

  it('a same-model turn reserves with the carried rates of earlier switches and is NOT a modelSwitch', async () => {
    const carried = [{ wireModel: 'claude-opus-5-5', rateSnapshot: { source: 'linked_platform' as const, standard: { inputCentsPerM: 500, outputCentsPerM: 2500, cacheReadCentsPerM: 50, cacheWriteCentsPerM: 625 } } }];
    tr.planModelTransition.mockResolvedValueOnce({ kind: 'same_model', carriedRates: carried });
    await (await postWithModel(app, { offeringId: OFF })).text();
    expect(reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({ binding: withCarriedRates(turnBindingFrom(model), carried) }));
    expect(vi.mocked(streamingSessionManager.getOrCreate).mock.calls[0]![9]).toMatchObject({ modelSwitch: false });
  });

  it('a topology turn whose model changed gets a topology-specific 409 (continuations refuse topology sessions)', async () => {
    vi.mocked(runPreFlightChecks).mockResolvedValueOnce({
      ok: true, session: { ...DB_SESSION, type: 'topology', sdkSessionId: 'sdk-1', offeringId: 'off-sonnet' } as any,
      sanitizedContent: 'hi', systemPrompt: 'sys', maxBudgetUsd: undefined, model, openaiCompatible: false,
    });
    topo.prepare.mockResolvedValueOnce({
      ok: true,
      prepared: { kind: 'live', runtime: { abort: topo.abort }, prompt: 'TOPOLOGY PROMPT', systemPrompt: 'TOPOLOGY SYSTEM', allowedMcpTools: [] },
    });
    tr.planModelTransition.mockResolvedValueOnce({ kind: 'continuation_required', reason: 'cross_connection' });
    const res = await postWithModel(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'The AI model for this investigation changed. Start a new investigation to continue.',
      code: 'topology_model_changed', recoverable: true,
    });
    expect(topo.abort).toHaveBeenCalled();
    expect(reserveAiBudget).not.toHaveBeenCalled();
  });

  it('an offering change while a turn is in flight → 409 turn_in_progress (spike constraint 3)', async () => {
    vi.mocked(reserveAiBudget).mockRejectedValueOnce(new AiBudgetSessionBusyError('busy'));
    const res = await postWithModel(app, { offeringId: OFF });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'turn_in_progress' });
    expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
  });

  it('a foreign or ineligible offering in the body → the preflight\'s 409 not_permitted, no reservation', async () => {
    vi.mocked(runPreFlightChecks).mockResolvedValueOnce({
      ok: false, error: 'This AI model is not available here. Choose another model.', status: 409, code: 'not_permitted',
    });
    const res = await postWithModel(app, { offeringId: OFF });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_permitted', recoverable: true });
    expect(tr.planModelTransition).not.toHaveBeenCalled();
    expect(reserveAiBudget).not.toHaveBeenCalled();
  });

  it('a model field that is not an offering id is a 400 (never a free-form model)', async () => {
    const res = await postWithModel(app, { model: 'claude-opus-5-5' });
    expect(res.status).toBe(400);
    expect(runPreFlightChecks).not.toHaveBeenCalled();
  });

  it('the turn claim binds the display names turn_model reports (W05 Task 9)', async () => {
    await (await postWithModel(app, { offeringId: OFF })).text();
    expect(streamingSessionManager.tryTransitionToProcessing).toHaveBeenCalledWith(
      expect.anything(), RESERVATION_ID,
      expect.objectContaining({ turnDisplay: { requestedDisplayName: 'Haiku 4.5', fallbackDisplayName: null } }),
    );
  });

  it('GET /sessions/:id returns the persisted lastTurnModel (W05)', async () => {
    const lastTurnModel = { requestedModel: 'claude-opus-5-5', requestedDisplayName: 'Opus 5.5', servedModel: 'claude-opus-4-8', servedDisplayName: 'Claude Opus 4.8', fallbackUsed: true, appliedOptions: {}, fastDowngraded: false };
    vi.mocked(getSessionMessages).mockResolvedValueOnce({ session: { ...DB_SESSION, lastTurnModel }, messages: [] } as never);
    const res = await app.request(`/ai/sessions/${SESSION_ID}`, { headers: { Authorization: 'Bearer token' } });
    const body = await res.json();
    expect(body.lastTurnModel).toEqual(lastTurnModel);
    // The web store reads it off the session object (aiStore.loadSession).
    expect(body.session.lastTurnModel).toEqual(lastTurnModel);
  });

  it('GET /sessions/:id never passes an unparseable stored value through (W05)', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce({ session: { ...DB_SESSION, lastTurnModel: { servedModel: 1 } }, messages: [] } as never);
    const res = await app.request(`/ai/sessions/${SESSION_ID}`, { headers: { Authorization: 'Bearer token' } });
    const body = await res.json();
    expect(body.lastTurnModel).toBeNull();
    expect(body.session.lastTurnModel).toBeNull();
  });
});
