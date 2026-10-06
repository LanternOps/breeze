import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #3127: depth of the (mocked) short per-phase DB contexts the message-send
// handler opens now that it no longer runs inside a request transaction.
const dbCtx = vi.hoisted(() => ({ depth: 0 }));

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(),
    update: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  aiSessions: { id: 'aiSessions.id' },
  aiMessages: { sessionId: 'aiMessages.sessionId', role: 'aiMessages.role', content: 'aiMessages.content' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
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

// Mock zValidator to parse body/query and pass through (avoids needing real Zod schemas)
vi.mock('@hono/zod-validator', () => ({
  zValidator: (target: string) => {
    const { validator } = require('hono/validator');
    return validator(target, async (value: any) => value);
  },
}));

vi.mock('../services/scriptBuilderService', () => ({
  createScriptBuilderSession: vi.fn(),
  getScriptBuilderSession: vi.fn(),
  getScriptBuilderMessages: vi.fn(),
  updateEditorContext: vi.fn(),
  closeScriptBuilderSession: vi.fn(),
}));

vi.mock('../services/aiAgentSdk', () => ({
  runPreFlightChecks: vi.fn(),
  settleBlockedTurnForNewMessage: vi.fn(() => Promise.resolve('not_blocked_on_approvals')),
}));

vi.mock('../services/streamingSessionManager', () => ({
  streamingSessionManager: {
    getOrCreate: vi.fn(),
    get: vi.fn(() => undefined),
    tryTransitionToProcessing: vi.fn(),
    remove: vi.fn(),
    interrupt: vi.fn(),
    startTurnTimeout: vi.fn(),
  },
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

vi.mock('../services/aiAgent', () => ({
  handleApproval: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('@breeze/shared/validators/ai', () => ({
  createScriptBuilderSessionSchema: {},
  sendAiMessageSchema: {
    extend: () => ({}),
  },
  approveToolSchema: {},
  scriptBuilderContextSchema: {
    optional: () => ({}),
  },
}));

vi.mock('../services/scriptBuilderTools', () => ({
  createScriptBuilderMcpServer: vi.fn(),
  SCRIPT_BUILDER_MCP_TOOL_NAMES: [],
}));

// W03 Task 9: session create resolves through the registry (not exercised here).
vi.mock('../services/aiModels/sessionModel', () => ({ chooseSessionModel: vi.fn() }));
vi.mock('../services/aiModels/candidateLoader', () => ({ readOrgPartnerId: vi.fn() }));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { authMiddleware } from '../middleware/auth';
import { scriptAiRoutes } from './scriptAi';
import {
  getScriptBuilderSession,
} from '../services/scriptBuilderService';
import { runPreFlightChecks, settleBlockedTurnForNewMessage } from '../services/aiAgentSdk';
import { reserveAiBudget } from '../services/aiBudgetReservations';
import { db } from '../db';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { LlmUnavailableError } from '../services/llm/llmConfigResolver';
import { handleApproval } from '../services/aiAgent';
import { makeResolvedModel } from '../services/aiModels/__fixtures__/resolvedModel';
import { turnBindingFrom } from '../services/aiModels/turnBinding';

// ── Constants ──────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';
const EXECUTION_ID = '33333333-3333-3333-3333-333333333333';

function setAuth(overrides: Record<string, unknown> = {}) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
      orgCondition: () => undefined,
      ...overrides,
    });
    return next();
  });
}

function makeApp() {
  const app = new Hono();
  app.route('/ai/script-builder', scriptAiRoutes);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('scriptAi routes — messages, interrupt, approve', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = makeApp();
  });

  // ────────────────────── POST /sessions/:id/messages ──────────────────────
  describe('POST /sessions/:id/messages', () => {
    it('returns ai_unavailable as 503 before touching the SDK manager', async () => {
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: false,
        error: 'ai_unavailable',
        status: 503,
      });

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'ai_unavailable' });
      expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
    });

    it('returns ai_not_configured as 503 before touching the SDK manager', async () => {
      vi.mocked(runPreFlightChecks).mockResolvedValue({ ok: false, error: 'ai_not_configured', status: 503 });

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: expect.stringMatching(/not configured/i), code: 'ai_not_configured' });
      expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
    });

    it('preserves the structured retryable 503 from resolver preflight failures', async () => {
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: false,
        error: 'AI configuration could not be loaded. Try again.',
        status: 503,
      });

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'AI configuration could not be loaded. Try again.' });
      expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
    });

    it('#3127: waits and reserves with no DB context held; reads and writes each run in a short one', async () => {
      const depths: Record<string, number> = {};
      vi.mocked(runPreFlightChecks).mockImplementation(async () => {
        depths.preflight = dbCtx.depth;
        return {
          ok: true,
          session: {
            id: SESSION_ID,
            type: 'script_builder',
            orgId: ORG_ID,
            sdkSessionId: null,
            model: 'claude-sonnet-4-6',
            maxTurns: 50,
            turnCount: 0,
            systemPrompt: 'System prompt',
            title: 'existing',
          },
          sanitizedContent: 'Hello',
          systemPrompt: 'System prompt',
          maxBudgetUsd: 1,
          model: makeResolvedModel('platform', { surface: 'script_builder' }),
        } as any;
      });
      const activeSession = {
        state: 'processing',
        inputController: { pushMessage: vi.fn() },
        eventBus: {
          subscribe: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
          unsubscribe: vi.fn(),
          publish: vi.fn(),
        },
      } as any;
      vi.mocked(streamingSessionManager.get)
        .mockReturnValueOnce(activeSession)
        .mockReturnValueOnce(undefined);
      vi.mocked(settleBlockedTurnForNewMessage).mockImplementationOnce(async () => {
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

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(200);
      await res.text();
      expect(depths).toEqual({ preflight: 1, settle: 0, reserve: 0, getOrCreate: 1, insert: 1 });
      expect(activeSession.inputController.pushMessage).toHaveBeenCalledWith('Hello');
      expect(dbCtx.depth).toBe(0);
    });

    it('#7783: subscribes to the session events BEFORE the turn is pushed: a transport that answers at once still reaches the client', async () => {
      // The real SessionEventBus has no replay: an event published while nobody
      // is subscribed is gone. Model a transport fast enough to publish the
      // whole turn synchronously when the message is pushed.
      const subscribers = new Map<string, Array<{ type: string; message?: string }>>();
      const waiters = new Map<string, () => void>();
      const bus = {
        subscribe: vi.fn((id: string) => {
          subscribers.set(id, []);
          return (async function* () {
            for (;;) {
              const queue = subscribers.get(id)!;
              while (queue.length) {
                const event = queue.shift()!;
                yield event;
                if (event.type === 'done') return;
              }
              await new Promise<void>((resolve) => { waiters.set(id, resolve); });
            }
          })();
        }),
        unsubscribe: vi.fn((id: string) => { subscribers.delete(id); }),
        publish: vi.fn((event: { type: string; message?: string }) => {
          for (const [id, queue] of subscribers) { queue.push(event); waiters.get(id)?.(); }
        }),
      };
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: true,
        session: {
          id: SESSION_ID, type: 'script_builder', orgId: ORG_ID, sdkSessionId: null,
          model: 'claude-sonnet-4-6', maxTurns: 50, turnCount: 0, systemPrompt: 'System prompt', title: 'existing',
        },
        sanitizedContent: 'Hello',
        systemPrompt: 'System prompt',
        maxBudgetUsd: 1,
        model: makeResolvedModel('platform', { surface: 'script_builder' }),
      } as any);
      const activeSession = {
        state: 'processing',
        inputController: {
          pushMessage: vi.fn(() => {
            bus.publish({ type: 'error', message: 'script builder turn failed fast' });
            bus.publish({ type: 'done' });
          }),
        },
        eventBus: bus,
      } as any;
      vi.mocked(streamingSessionManager.get).mockReturnValue(undefined);
      vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(activeSession);
      vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);
      vi.mocked(db.insert).mockImplementation(() => ({ values: vi.fn().mockResolvedValue(undefined) }) as any);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('script builder turn failed fast');
      expect(bus.unsubscribe).toHaveBeenCalled();
    });

    it('#7783: drops the pre-push subscription when the dispatch context fails', async () => {
      const bus = { subscribe: vi.fn((_id: string) => (async function* () { /* never read */ })()), unsubscribe: vi.fn(), publish: vi.fn() };
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: true,
        session: {
          id: SESSION_ID, type: 'script_builder', orgId: ORG_ID, sdkSessionId: null,
          model: 'claude-sonnet-4-6', maxTurns: 50, turnCount: 0, systemPrompt: 'System prompt', title: 'existing',
        },
        sanitizedContent: 'Hello',
        systemPrompt: 'System prompt',
        maxBudgetUsd: 1,
        model: makeResolvedModel('platform', { surface: 'script_builder' }),
      } as any);
      const activeSession = {
        state: 'processing',
        inputController: { pushMessage: vi.fn() },
        eventBus: bus,
      } as any;
      vi.mocked(streamingSessionManager.get).mockReturnValue(undefined);
      vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(activeSession);
      vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);
      vi.mocked(db.insert).mockImplementation(() => ({ values: vi.fn().mockResolvedValue(undefined) }) as any);
      vi.mocked(streamingSessionManager.startTurnTimeout).mockImplementationOnce(() => { throw new Error('timeout boom'); });

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(500);
      expect(bus.subscribe).toHaveBeenCalledTimes(1);
      expect(bus.unsubscribe).toHaveBeenCalledWith(bus.subscribe.mock.calls[0]![0]);
    });

    it('dispatches and reserves exactly the model preflight resolved (finding 13)', async () => {
      const model = makeResolvedModel('anthropic_byok', { surface: 'script_builder' });
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: true,
        session: {
          id: SESSION_ID,
          type: 'script_builder',
          orgId: ORG_ID,
          sdkSessionId: null,
          model: 'claude-sonnet-5-5',
          maxTurns: 50,
          turnCount: 0,
          systemPrompt: 'System prompt',
        },
        sanitizedContent: 'Hello',
        systemPrompt: 'System prompt',
        maxBudgetUsd: 1,
        model,
      } as any);
      vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue({ state: 'processing' } as any);
      vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(false);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(409);
      expect(streamingSessionManager.getOrCreate).toHaveBeenCalledWith(
        SESSION_ID,
        expect.not.objectContaining({ model: expect.anything() }),
        expect.anything(),
        expect.anything(),
        'System prompt',
        undefined,
        model,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ budgetReservationId: expect.any(String), ledgerUserId: expect.any(String) }),
      );
      expect(vi.mocked(streamingSessionManager.getOrCreate).mock.calls[0]![6]).toBe(model);
      expect(reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({
        billingSource: 'partner_key', binding: turnBindingFrom(model),
      }));
      expect(streamingSessionManager.tryTransitionToProcessing).toHaveBeenCalledWith(
        expect.anything(), expect.any(String), expect.objectContaining({ turnBinding: turnBindingFrom(model) }),
      );
    });

    it('an ineligible stored model is a recoverable 409 with its code and takes no reservation', async () => {
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: false, error: 'Model Opus 5.5 is no longer available — choose another.', status: 409, code: 'model_unavailable',
      });

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Model Opus 5.5 is no longer available — choose another.', code: 'model_unavailable', recoverable: true,
      });
      expect(reserveAiBudget).not.toHaveBeenCalled();
      expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
    });

    it('maps a wire-model fail-close from the SDK manager to 503 ai_unavailable', async () => {
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: true,
        session: {
          id: SESSION_ID,
          orgId: ORG_ID,
          type: 'script_builder',
          sdkSessionId: null,
          model: 'claude-sonnet-4-6',
          maxTurns: 50,
          turnCount: 0,
          systemPrompt: 'System prompt',
        },
        sanitizedContent: 'Hello',
        systemPrompt: 'System prompt',
        maxBudgetUsd: 1,
        model: makeResolvedModel('platform', { surface: 'script_builder' }),
      } as any);
      // Last-resort guard: an LlmUnavailableError from the manager (e.g. a
      // wire option the transport cannot carry) maps to 503, never a 500.
      vi.mocked(streamingSessionManager.getOrCreate).mockRejectedValue(new LlmUnavailableError());

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      // A 500 tells the UI "we broke"; a 503 ai_unavailable is the documented
      // "reconnect your AI provider" signal every other AI route already sends.
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    });

    it('returns 404 when pre-flight says session not found', async () => {
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: false,
        error: 'Session not found',
      } as any);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 429 on rate limit', async () => {
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: false,
        error: 'Rate limit exceeded',
      } as any);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(429);
    });

    it('returns 402 on budget exceeded', async () => {
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: false,
        error: 'Budget limit reached',
      } as any);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(402);
    });

    it('returns 410 on expired session', async () => {
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: false,
        error: 'Session has expired',
      } as any);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(410);
    });

    it('returns 404 when session type is not script_builder', async () => {
      vi.mocked(runPreFlightChecks).mockResolvedValue({
        ok: true,
        session: { id: SESSION_ID, type: 'chat', orgId: ORG_ID },
        sanitizedContent: 'Hello',
        systemPrompt: 'System prompt',
        maxBudgetUsd: 1.0,
      } as any);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Session not found');
    });
  });

  // ────────────────────── POST /sessions/:id/interrupt ──────────────────────
  describe('POST /sessions/:id/interrupt', () => {
    it('successfully interrupts a session', async () => {
      vi.mocked(getScriptBuilderSession).mockResolvedValue({
        id: SESSION_ID,
        orgId: ORG_ID,
      } as any);
      vi.mocked(streamingSessionManager.interrupt).mockResolvedValue({
        interrupted: true,
      });

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/interrupt`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.interrupted).toBe(true);
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(getScriptBuilderSession).mockResolvedValue(null);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/interrupt`, {
        method: 'POST',
      });

      expect(res.status).toBe(404);
    });

    it('returns 409 when session is not in a state to be interrupted', async () => {
      vi.mocked(getScriptBuilderSession).mockResolvedValue({
        id: SESSION_ID,
        orgId: ORG_ID,
      } as any);
      vi.mocked(streamingSessionManager.interrupt).mockResolvedValue({
        interrupted: false,
        reason: 'No active processing to interrupt',
      });

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/interrupt`, {
        method: 'POST',
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.interrupted).toBe(false);
    });

    it('returns 500 when interrupt throws', async () => {
      vi.mocked(getScriptBuilderSession).mockResolvedValue({
        id: SESSION_ID,
        orgId: ORG_ID,
      } as any);
      vi.mocked(streamingSessionManager.interrupt).mockRejectedValue(
        new Error('Interrupt failed')
      );

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/interrupt`, {
        method: 'POST',
      });

      expect(res.status).toBe(500);
    });
  });

  // ────────────────────── POST /sessions/:id/approve/:executionId ──────────────────────
  describe('POST /sessions/:id/approve/:executionId', () => {
    it('approves a tool execution', async () => {
      vi.mocked(getScriptBuilderSession).mockResolvedValue({
        id: SESSION_ID,
        orgId: ORG_ID,
      } as any);
      vi.mocked(handleApproval).mockResolvedValue(true);

      const res = await app.request(
        `/ai/script-builder/sessions/${SESSION_ID}/approve/${EXECUTION_ID}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.approved).toBe(true);
      expect(handleApproval).toHaveBeenCalledWith(EXECUTION_ID, true, expect.any(Object), SESSION_ID);
    });

    it('denies a tool execution', async () => {
      vi.mocked(getScriptBuilderSession).mockResolvedValue({
        id: SESSION_ID,
        orgId: ORG_ID,
      } as any);
      vi.mocked(handleApproval).mockResolvedValue(true);

      const res = await app.request(
        `/ai/script-builder/sessions/${SESSION_ID}/approve/${EXECUTION_ID}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: false }),
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.approved).toBe(false);
      expect(handleApproval).toHaveBeenCalledWith(EXECUTION_ID, false, expect.any(Object), SESSION_ID);
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(getScriptBuilderSession).mockResolvedValue(null);

      const res = await app.request(
        `/ai/script-builder/sessions/${SESSION_ID}/approve/${EXECUTION_ID}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        }
      );

      expect(res.status).toBe(404);
    });

    it('returns 404 when execution not found or already processed', async () => {
      vi.mocked(getScriptBuilderSession).mockResolvedValue({
        id: SESSION_ID,
        orgId: ORG_ID,
      } as any);
      vi.mocked(handleApproval).mockResolvedValue(false);

      const res = await app.request(
        `/ai/script-builder/sessions/${SESSION_ID}/approve/${EXECUTION_ID}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        }
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Execution not found');
    });
  });

  // ────────────────────── Multi-tenant isolation ──────────────────────
  describe('multi-tenant isolation', () => {
    const ORG_ID_2 = '99999999-9999-9999-9999-999999999999';

    it('returns 404 when interrupting session from a different org', async () => {
      // getScriptBuilderSession applies org-scoping at the DB level,
      // so a cross-org session lookup returns null
      vi.mocked(getScriptBuilderSession).mockResolvedValue(null);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}/interrupt`, {
        method: 'POST',
      });

      expect(res.status).toBe(404);
    });

    it('returns 404 when approving execution in session from a different org', async () => {
      vi.mocked(getScriptBuilderSession).mockResolvedValue({
        id: SESSION_ID,
        orgId: ORG_ID_2,
      } as any);

      const res = await app.request(
        `/ai/script-builder/sessions/${SESSION_ID}/approve/${EXECUTION_ID}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        }
      );

      expect(res.status).toBe(404);
    });
  });
});
