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
  createScriptBuilderSession,
  getScriptBuilderSession,
  getScriptBuilderMessages,
  closeScriptBuilderSession,
} from '../services/scriptBuilderService';
import { streamingSessionManager } from '../services/streamingSessionManager';

// ── Constants ──────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';

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

describe('scriptAi routes — session CRUD', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = makeApp();
  });

  // ────────────────────── POST /sessions ──────────────────────
  describe('POST /sessions (create session)', () => {
    it('creates a new session', async () => {
      const session = {
        id: SESSION_ID,
        orgId: ORG_ID,
        type: 'script_builder',
        model: 'claude-sonnet-4-20250514',
      };
      vi.mocked(createScriptBuilderSession).mockResolvedValue(session as any);

      const res = await app.request('/ai/script-builder/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Build a backup script' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(SESSION_ID);
    });

    it('returns 400 when organization context is missing', async () => {
      vi.mocked(createScriptBuilderSession).mockRejectedValue(
        new Error('Organization context required')
      );

      const res = await app.request('/ai/script-builder/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Organization context required');
    });

    it('returns 500 on unexpected error', async () => {
      vi.mocked(createScriptBuilderSession).mockRejectedValue(new Error('DB connection failed'));

      const res = await app.request('/ai/script-builder/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test' }),
      });

      expect(res.status).toBe(500);
    });
  });

  // ────────────────────── GET /sessions/:id ──────────────────────
  describe('GET /sessions/:id (get session)', () => {
    it('returns session with messages', async () => {
      const session = { id: SESSION_ID, orgId: ORG_ID, type: 'script_builder' };
      const messages = [
        { id: 'msg-1', role: 'user', content: 'Write a disk cleanup script' },
        { id: 'msg-2', role: 'assistant', content: 'Here is the script...' },
      ];
      vi.mocked(getScriptBuilderSession).mockResolvedValue(session as any);
      vi.mocked(getScriptBuilderMessages).mockResolvedValue(messages as any);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.id).toBe(SESSION_ID);
      expect(body.messages).toHaveLength(2);
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(getScriptBuilderSession).mockResolvedValue(null);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Session not found');
    });

    it('returns 500 on service error', async () => {
      vi.mocked(getScriptBuilderSession).mockRejectedValue(new Error('DB error'));

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Failed to load session');
    });
  });

  // ────────────────────── DELETE /sessions/:id ──────────────────────
  describe('DELETE /sessions/:id (close session)', () => {
    it('closes a session successfully', async () => {
      vi.mocked(closeScriptBuilderSession).mockResolvedValue(undefined);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(vi.mocked(streamingSessionManager.remove)).toHaveBeenCalledWith(SESSION_ID);
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(closeScriptBuilderSession).mockRejectedValue(new Error('Session not found'));

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Session not found');
    });

    it('returns 500 on unexpected close error', async () => {
      vi.mocked(closeScriptBuilderSession).mockRejectedValue(new Error('Connection reset'));

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(500);
    });
  });

  // ────────────────────── Auth middleware ──────────────────────
  describe('authentication', () => {
    it('all routes require auth middleware', async () => {
      const res = await app.request('/ai/script-builder/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test' }),
      });

      expect(vi.mocked(authMiddleware)).toHaveBeenCalled();
    });
  });

  // ────────────────────── Multi-tenant isolation ──────────────────────
  describe('multi-tenant isolation', () => {
    const ORG_ID_2 = '99999999-9999-9999-9999-999999999999';

    it('returns 404 when session belongs to a different org', async () => {
      vi.mocked(getScriptBuilderSession).mockResolvedValue({
        id: SESSION_ID,
        orgId: ORG_ID_2,
        type: 'script_builder',
      } as any);

      const res = await app.request(`/ai/script-builder/sessions/${SESSION_ID}`);
      expect(res.status).toBe(404);
    });
  });
});
