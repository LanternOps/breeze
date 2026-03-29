import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  aiSessions: { id: 'aiSessions.id' },
  aiMessages: { sessionId: 'aiMessages.sessionId', role: 'aiMessages.role', content: 'aiMessages.content' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
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
}));

vi.mock('../services/streamingSessionManager', () => ({
  streamingSessionManager: {
    getOrCreate: vi.fn(),
    tryTransitionToProcessing: vi.fn(),
    remove: vi.fn(),
    interrupt: vi.fn(),
    startTurnTimeout: vi.fn(),
  },
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

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { authMiddleware } from '../middleware/auth';
import { scriptAiRoutes } from './scriptAi';
import {
  getScriptBuilderSession,
} from '../services/scriptBuilderService';
import { runPreFlightChecks } from '../services/aiAgentSdk';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { handleApproval } from '../services/aiAgent';

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
