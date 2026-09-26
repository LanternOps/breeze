import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { aiRoutes } from './ai';
import { db } from '../db';
import {
  createSession,
  getSession,
  listSessions,
  closeSession,
  getSessionMessages,
  handleApproval,
  isIntentBackedExecution,
  searchSessions,
} from '../services/aiAgent';
import { getUsageSummary, updateBudget, getSessionHistory } from '../services/aiCostTracker';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { runPreFlightChecks, abortActivePlan, settleBlockedTurnForNewMessage } from '../services/aiAgentSdk';
import { reserveAiBudget, releaseUnusedAiBudgetReservation } from '../services/aiBudgetReservations';

const ORG_ID = 'org-111';
const SESSION_ID = '11111111-1111-1111-1111-111111111111';


describe('AI routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/ai', aiRoutes);
  });

  // ============================================
  // PATCH /sessions/:id
  // ============================================
  describe('PATCH /ai/sessions/:id', () => {
    it('updates session title', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'Renamed Chat' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.title).toBe('Renamed Chat');
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(getSession).mockResolvedValueOnce(null);

      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'New Title' }),
      });

      expect(res.status).toBe(404);
    });

    it('rejects empty title', async () => {
      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: '' }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // POST /sessions/:id/interrupt
  // ============================================
  describe('POST /ai/sessions/:id/interrupt', () => {
    it('interrupts an active session', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(streamingSessionManager.interrupt).mockResolvedValueOnce({
        interrupted: true,
      });

      const res = await app.request(`/ai/sessions/${SESSION_ID}/interrupt`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.interrupted).toBe(true);
    });

    it('returns 409 when session is not processing', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(streamingSessionManager.interrupt).mockResolvedValueOnce({
        interrupted: false,
        reason: 'Session is not processing',
      });

      const res = await app.request(`/ai/sessions/${SESSION_ID}/interrupt`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.interrupted).toBe(false);
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(getSession).mockResolvedValueOnce(null);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/interrupt`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // POST /sessions/:id/messages — concurrent-message guard settle path (#3089)
  // ============================================
  describe('POST /ai/sessions/:id/messages — approval-blocked turn settling', () => {
    function mockPreflightOk(sessionOverrides: Record<string, unknown> = {}) {
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: true,
        session: {
          id: SESSION_ID,
          orgId: ORG_ID,
          sdkSessionId: null,
          model: 'claude-sonnet-4-5-20250929',
          maxTurns: 50,
          turnCount: 0,
          systemPrompt: 'sp',
          title: 'existing title',
          ...sessionOverrides,
        },
        sanitizedContent: 'hello there',
        systemPrompt: 'sp',
        maxBudgetUsd: undefined,
        resolved: {
          source: 'platform',
          apiKey: 'platform-key',
          model: 'claude-sonnet-4-5-20250929',
        },
      } as any);
    }

    function makeActiveSession() {
      return {
        breezeSessionId: SESSION_ID,
        orgId: ORG_ID,
        state: 'processing',
        inputController: { pushMessage: vi.fn() },
        eventBus: {
          subscribe: vi.fn(() => (async function* () {
            yield { type: 'done' };
          })()),
          unsubscribe: vi.fn(),
          publish: vi.fn(),
        },
      } as any;
    }

    function postMessage() {
      return app.request(`/ai/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ content: 'hello there' }),
      });
    }

    it('409s untouched when the session is busy for a non-approval reason', async () => {
      mockPreflightOk();
      const activeSession = makeActiveSession();
      vi.mocked(streamingSessionManager.get).mockReturnValue(activeSession);
      vi.mocked(settleBlockedTurnForNewMessage).mockResolvedValue('not_blocked_on_approvals');

      const res = await postMessage();

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('A message is already being processed for this session');
      // The message was never queued into the turn.
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('proceeds with the message when the blocked turn settles and concludes', async () => {
      mockPreflightOk();
      const activeSession = makeActiveSession();
      vi.mocked(streamingSessionManager.get)
        .mockReturnValueOnce(activeSession)
        .mockReturnValueOnce(undefined);
      vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(activeSession);
      vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);
      vi.mocked(settleBlockedTurnForNewMessage).mockResolvedValue('concluded');
      vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) } as any);

      const res = await postMessage();

      expect(res.status).toBe(200);
      await res.text(); // drain the SSE stream (generator yields done and ends)
      expect(settleBlockedTurnForNewMessage).toHaveBeenCalledWith(activeSession);
      expect(activeSession.inputController.pushMessage).toHaveBeenCalledWith('hello there');
      expect(streamingSessionManager.startTurnTimeout).toHaveBeenCalledWith(activeSession);
    });

    describe('device-page write default org (#6675)', () => {
      const DEVICE_PAGE = { type: 'device', id: '33333333-3333-4333-8333-333333333333', hostname: 'WS-01' };

      async function sendAndCaptureDbSession() {
        const activeSession = makeActiveSession();
        vi.mocked(streamingSessionManager.get).mockReturnValue(undefined);
        vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(activeSession);
        vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);
        vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) } as any);

        const res = await postMessage();
        expect(res.status).toBe(200);
        await res.text();
        return vi.mocked(streamingSessionManager.getOrCreate).mock.calls[0]![1];
      }

      it('passes the session org as the write default for a page-anchored session', async () => {
        mockPreflightOk({ deviceId: null, contextSnapshot: { ...DEVICE_PAGE, orgAnchor: 'page_context' } });
        expect(await sendAndCaptureDbSession()).toMatchObject({ orgId: ORG_ID, writeDefaultOrgId: ORG_ID });
      });

      it('passes no write default when the session org was not anchored by the page', async () => {
        mockPreflightOk({ deviceId: null, contextSnapshot: DEVICE_PAGE });
        expect((await sendAndCaptureDbSession()).writeDefaultOrgId).toBeUndefined();
      });
    });

    // #3127: the route owns its DB context (selfManagedDbContextRoutes), so the
    // settle wait must run with NO context held — before, the auth middleware's
    // request transaction pinned a pooled connection idle across the wait.
    function trackPreflightDepth(depths: Record<string, number>) {
      mockPreflightOk();
      const preflightImpl = vi.mocked(runPreFlightChecks).getMockImplementation()!;
      vi.mocked(runPreFlightChecks).mockImplementation(async (...args) => {
        depths.preflight = dbCtx.depth;
        return preflightImpl(...args);
      });
    }

    it('#3127: waits and reserves with no DB context held; reads and writes each run in a short one', async () => {
      const depths: Record<string, number> = {};
      trackPreflightDepth(depths);
      const activeSession = makeActiveSession();
      vi.mocked(streamingSessionManager.get)
        .mockReturnValueOnce(activeSession)
        .mockReturnValueOnce(undefined);
      vi.mocked(settleBlockedTurnForNewMessage).mockImplementation(async () => {
        depths.settle = dbCtx.depth;
        return 'concluded';
      });
      const reserveImpl = vi.mocked(reserveAiBudget).getMockImplementation()!;
      vi.mocked(reserveAiBudget).mockImplementationOnce(async (...args) => {
        depths.reserve = dbCtx.depth;
        return reserveImpl(...args);
      });
      vi.mocked(streamingSessionManager.getOrCreate).mockImplementation(async () => {
        depths.getOrCreate = dbCtx.depth;
        return activeSession;
      });
      vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);
      vi.mocked(db.insert).mockImplementation(() => {
        depths.insert = dbCtx.depth;
        return { values: vi.fn().mockResolvedValue(undefined) } as any;
      });

      const res = await postMessage();

      expect(res.status).toBe(200);
      await res.text();
      expect(depths).toEqual({ preflight: 1, settle: 0, reserve: 0, getOrCreate: 1, insert: 1 });
      expect(dbCtx.depth).toBe(0);
    });

    it('#3127: a refused dispatch releases its reservation after the dispatch context closes', async () => {
      trackPreflightDepth({});
      vi.mocked(streamingSessionManager.get).mockReturnValue(undefined);
      vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(makeActiveSession());
      vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(false);
      let releaseDepth = -1;
      vi.mocked(releaseUnusedAiBudgetReservation).mockImplementationOnce(async (input) => {
        releaseDepth = dbCtx.depth;
        return { kind: 'released', reservationId: input.reservationId } as any;
      });

      const res = await postMessage();

      expect(res.status).toBe(409);
      expect(releaseUnusedAiBudgetReservation).toHaveBeenCalledTimes(1);
      expect(releaseDepth).toBe(0);
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    describe('#3127: OpenAI-compatible branch', () => {
      beforeEach(() => {
        openai.provider = 'openai-compatible';
      });
      afterEach(() => {
        openai.provider = 'anthropic';
      });

      it('reads in a short context and reserves with none held', async () => {
        const depths: Record<string, number> = {};
        trackPreflightDepth(depths);
        const reserveImpl = vi.mocked(reserveAiBudget).getMockImplementation()!;
        vi.mocked(reserveAiBudget).mockImplementationOnce(async (...args) => {
          depths.reserve = dbCtx.depth;
          return reserveImpl(...args);
        });
        const openaiSession = makeActiveSession();
        openai.manager.getOrCreate.mockImplementation(() => {
          depths.getOrCreate = dbCtx.depth;
          return openaiSession;
        });
        openai.manager.tryTransitionToProcessing.mockReturnValue(true);
        vi.mocked(db.insert).mockImplementation(() => {
          depths.insert = dbCtx.depth;
          return { values: vi.fn().mockResolvedValue(undefined) } as any;
        });

        const res = await postMessage();

        expect(res.status).toBe(200);
        await res.text();
        expect(depths).toEqual({ preflight: 1, reserve: 0, getOrCreate: 1, insert: 1 });
        expect(openai.manager.startTurn).toHaveBeenCalledTimes(1);
        expect(dbCtx.depth).toBe(0);
      });

      it('releases the reservation with no context held when the session manager throws', async () => {
        trackPreflightDepth({});
        openai.manager.getOrCreate.mockImplementation(() => {
          throw new Error('manager exploded');
        });
        let releaseDepth = -1;
        vi.mocked(releaseUnusedAiBudgetReservation).mockImplementationOnce(async (input) => {
          releaseDepth = dbCtx.depth;
          return { kind: 'released', reservationId: input.reservationId } as any;
        });

        const res = await postMessage();

        expect(res.status).toBe(500);
        expect(releaseUnusedAiBudgetReservation).toHaveBeenCalledTimes(1);
        expect(releaseDepth).toBe(0);
        expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
      });

      it('releases the reservation with no context held when the turn slot is taken', async () => {
        trackPreflightDepth({});
        openai.manager.getOrCreate.mockReturnValue(makeActiveSession());
        openai.manager.tryTransitionToProcessing.mockReturnValue(false);
        let releaseDepth = -1;
        vi.mocked(releaseUnusedAiBudgetReservation).mockImplementationOnce(async (input) => {
          releaseDepth = dbCtx.depth;
          return { kind: 'released', reservationId: input.reservationId } as any;
        });

        const res = await postMessage();

        expect(res.status).toBe(409);
        expect(releaseDepth).toBe(0);
      });
    });

    it('409s with a wrapping-up message when the settled turn does not conclude in time', async () => {
      mockPreflightOk();
      vi.mocked(streamingSessionManager.get).mockReturnValue(makeActiveSession());
      vi.mocked(settleBlockedTurnForNewMessage).mockResolvedValue('still_processing');

      const res = await postMessage();

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/wrapping up the previous turn/);
      // Short-circuit: no second transition attempt once settling failed.
      expect(vi.mocked(streamingSessionManager.tryTransitionToProcessing)).not.toHaveBeenCalled();
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // POST /sessions/:id/approve/:executionId
  // ============================================
  describe('POST /ai/sessions/:id/approve/:executionId', () => {
    const EXEC_ID = '22222222-2222-2222-2222-222222222222';

    it('approves a tool execution', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(handleApproval).mockResolvedValueOnce(true);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve/${EXEC_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.approved).toBe(true);
      expect(handleApproval).toHaveBeenCalledWith(EXEC_ID, true, expect.any(Object), SESSION_ID);
    });

    it('rejects a tool execution', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(handleApproval).mockResolvedValueOnce(true);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve/${EXEC_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: false }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.approved).toBe(false);
      expect(handleApproval).toHaveBeenCalledWith(EXEC_ID, false, expect.any(Object), SESSION_ID);
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(getSession).mockResolvedValueOnce(null);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve/${EXEC_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: true }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 404 when execution not found', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(handleApproval).mockResolvedValueOnce(false);
      vi.mocked(isIntentBackedExecution).mockResolvedValueOnce(false);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve/${EXEC_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: true }),
      });

      expect(res.status).toBe(404);
    });

    // CRITICAL-3 (whole-branch review): the web chat "Approve" button must
    // never report success for a Tier-3 intent-backed execution — handleApproval
    // refuses to flip it (four-eyes model), and the route must turn that
    // refusal into an honest "pending" response, not silently claim success
    // nor collapse it into the generic "not found" 404.
    it('never reports success for an intent-backed execution — returns an honest pending response', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(handleApproval).mockResolvedValueOnce(false);
      vi.mocked(isIntentBackedExecution).mockResolvedValueOnce(true);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve/${EXEC_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: true }),
      });

      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.pending).toBe(true);
      expect(body.via).toBe('intent');
      // Never the plain "success: true" shape the non-intent branch returns.
      expect(body.approved).toBeUndefined();
    });
  });

});
