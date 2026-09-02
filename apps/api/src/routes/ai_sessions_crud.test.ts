import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const configRef = vi.hoisted(() => ({
  provider: 'anthropic' as 'anthropic' | 'openai-compatible',
}));

vi.mock('../config/validate', () => ({
  getConfig: vi.fn(() => ({ MCP_LLM_PROVIDER: configRef.provider })),
}));

vi.mock('../services/llm/llmConfigResolver', () => ({
  LlmUnavailableError: class LlmUnavailableError extends Error {
    readonly status = 503;
    readonly code = 'ai_unavailable';
    constructor() {
      super('AI unavailable');
      this.name = 'LlmUnavailableError';
    }
  },
  resolveLlmConfigForOrg: vi.fn(),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
}));

vi.mock('../services/aiAgent', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  closeSession: vi.fn(),
  getSessionMessages: vi.fn(),
  handleApproval: vi.fn(),
  searchSessions: vi.fn(),
}));

vi.mock('../services/aiCostTracker', () => ({
  getSessionHistory: vi.fn(),
  getUsageSummary: vi.fn(),
  updateBudget: vi.fn(),
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
  searchSessions,
} from '../services/aiAgent';
import { getUsageSummary, updateBudget, getSessionHistory } from '../services/aiCostTracker';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { runPreFlightChecks, abortActivePlan } from '../services/aiAgentSdk';
import { LlmUnavailableError } from '../services/llm/llmConfigResolver';

const ORG_ID = 'org-111';
const SESSION_ID = '11111111-1111-1111-1111-111111111111';


describe('AI routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    configRef.provider = 'anthropic';
    app = new Hono();
    app.route('/ai', aiRoutes);
  });

  // ============================================
  // POST /sessions
  // ============================================
  describe('POST /ai/sessions', () => {
    it('creates a new session and returns 201', async () => {
      const session = { id: SESSION_ID, orgId: ORG_ID, title: 'Test Chat' };
      vi.mocked(createSession).mockResolvedValueOnce(session as any);

      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'Test Chat' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(SESSION_ID);
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it('returns 400 when organization context is required', async () => {
      vi.mocked(createSession).mockRejectedValueOnce(new Error('Organization context required'));

      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'Test' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Organization context required');
    });

    it('returns 403 when access denied to org', async () => {
      vi.mocked(createSession).mockRejectedValueOnce(new Error('Access denied to this organization'));

      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'Test' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Access denied to this organization');
    });

    it('returns ai_unavailable as 503 when session creation rejects a broken partner key', async () => {
      vi.mocked(createSession).mockRejectedValueOnce(new LlmUnavailableError());

      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'Test' }),
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    });

    it('returns 500 on unexpected creation error', async () => {
      vi.mocked(createSession).mockRejectedValueOnce(new Error('DB connection failed'));

      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'Test' }),
      });

      expect(res.status).toBe(500);
    });
  });

  // ============================================
  // GET /sessions
  // ============================================
  describe('GET /ai/sessions', () => {
    it('lists sessions with defaults', async () => {
      vi.mocked(listSessions).mockResolvedValueOnce([
        { id: SESSION_ID, title: 'Chat 1' },
      ] as any);

      const res = await app.request('/ai/sessions', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(listSessions).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ page: 1, limit: 20 })
      );
    });

    it('passes pagination params', async () => {
      vi.mocked(listSessions).mockResolvedValueOnce([]);

      const res = await app.request('/ai/sessions?page=2&limit=5', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(listSessions).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ page: 2, limit: 5 })
      );
    });
  });

  // ============================================
  // GET /sessions/search
  // ============================================
  describe('GET /ai/sessions/search', () => {
    it('searches sessions with valid query', async () => {
      vi.mocked(searchSessions).mockResolvedValueOnce([
        { id: SESSION_ID, title: 'Disk cleanup chat' },
      ] as any);

      const res = await app.request('/ai/sessions/search?q=disk', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(searchSessions).toHaveBeenCalledWith(
        expect.any(Object),
        'disk',
        expect.objectContaining({ limit: 20 })
      );
    });

    it('returns 400 when query is too short', async () => {
      const res = await app.request('/ai/sessions/search?q=d', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('at least 2 characters');
    });

    it('returns 400 when query is missing', async () => {
      const res = await app.request('/ai/sessions/search', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // GET /sessions/:id
  // ============================================
  describe('GET /ai/sessions/:id', () => {
    it('returns session with messages', async () => {
      vi.mocked(getSessionMessages).mockResolvedValueOnce({
        session: { id: SESSION_ID },
        messages: [{ role: 'user', content: 'hello' }],
      } as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.id).toBe(SESSION_ID);
      expect(body.messages).toHaveLength(1);
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(getSessionMessages).mockResolvedValueOnce(null);

      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Session not found');
    });
  });

  // ============================================
  // DELETE /sessions/:id
  // ============================================
  describe('DELETE /ai/sessions/:id', () => {
    it('closes a session successfully', async () => {
      vi.mocked(closeSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(streamingSessionManager.remove).toHaveBeenCalledWith(SESSION_ID);
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(closeSession).mockResolvedValueOnce(null as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // POST /sessions/:id/messages
  // ============================================
  describe('POST /ai/sessions/:id/messages', () => {
    it('returns ai_unavailable as 503 before touching the SDK manager', async () => {
      vi.mocked(runPreFlightChecks).mockResolvedValueOnce({
        ok: false,
        error: 'ai_unavailable',
        status: 503,
      });

      const res = await app.request(`/ai/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ content: 'hello there' }),
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'ai_unavailable' });
      expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
    });

    it('preserves the structured retryable 503 from resolver preflight failures', async () => {
      vi.mocked(runPreFlightChecks).mockResolvedValueOnce({
        ok: false,
        error: 'AI configuration could not be loaded. Try again.',
        status: 503,
      });

      const res = await app.request(`/ai/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ content: 'hello there' }),
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'AI configuration could not be loaded. Try again.' });
      expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
    });

    it('refuses partner-key traffic before entering the instance OpenAI-compatible path', async () => {
      configRef.provider = 'openai-compatible';
      vi.mocked(runPreFlightChecks).mockResolvedValueOnce({
        ok: true,
        session: {
          id: SESSION_ID,
          orgId: ORG_ID,
          sdkSessionId: null,
          model: 'claude-opus-4-6',
          maxTurns: 50,
          turnCount: 0,
          systemPrompt: null,
          title: 'Existing title',
        } as any,
        sanitizedContent: 'hello',
        systemPrompt: 'SYSTEM PROMPT',
        maxBudgetUsd: undefined,
        resolved: {
          source: 'partner',
          partnerId: 'partner-1',
          apiKey: 'partner-key',
          model: 'claude-opus-4-6',
          configId: 'config-1',
          configVersion: 3,
          endpoint: { kind: 'anthropic' as const },
        },
      });

      const res = await app.request(`/ai/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ content: 'hello there' }),
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'ai_unavailable' });
      expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('passes the bound device id from the DB session into streamingSessionManager.getOrCreate (#3087 route wiring)', async () => {
      // This is the seam that arms the #3087 fix: getOrCreate uses `deviceId`
      // to decide whether to narrow tool execution to the device's org. If
      // this route ever stops forwarding it, the whole narrowing mechanism in
      // streamingSessionManager goes dark even though its unit tests stay green.
      vi.mocked(runPreFlightChecks).mockResolvedValueOnce({
        ok: true,
        session: {
          id: SESSION_ID,
          orgId: ORG_ID,
          sdkSessionId: null,
          model: 'claude-sonnet-4-5-20250929',
          maxTurns: 50,
          turnCount: 0,
          systemPrompt: null,
          title: 'Existing title', // truthy — skips the auto-title-generation branch
          deviceId: 'device-42',
        } as any,
        sanitizedContent: 'hello there',
        systemPrompt: 'SYSTEM PROMPT',
        maxBudgetUsd: undefined,
        resolved: {
          source: 'partner',
          partnerId: 'partner-1',
          apiKey: 'partner-key',
          model: 'claude-sonnet-4-6',
          configId: 'config-1',
          configVersion: 3,
          endpoint: { kind: 'anthropic' as const },
        },
      });

      const fakeActiveSession = {
        state: 'ready',
        eventBus: {
          subscribe: vi.fn(() => (async function* () {})()),
          unsubscribe: vi.fn(),
        },
        inputController: { pushMessage: vi.fn() },
      };
      vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValueOnce(fakeActiveSession as any);
      vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValueOnce(true);

      const valuesSpy = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any);

      await app.request(`/ai/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ content: 'hello there' }),
      });

      expect(streamingSessionManager.getOrCreate).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({ deviceId: 'device-42' }),
        expect.anything(),
        expect.anything(),
        'SYSTEM PROMPT',
        undefined,
        expect.objectContaining({ source: 'partner', configId: 'config-1', configVersion: 3 }),
      );
    });
  });

});
