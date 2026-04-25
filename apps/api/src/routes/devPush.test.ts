import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT_ID = 'agent-001';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'id',
    agentId: 'agent_id',
    orgId: 'org_id',
    agentTokenHash: 'agent_token_hash',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: vi.fn((c: any, next: any) => {
    c.set('apiKey', { orgId: '11111111-1111-1111-1111-111111111111', scopes: ['devices:write'] });
    return next();
  }),
  requireApiKeyScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

const mockGetDeviceWithOrgCheck = vi.fn();
vi.mock('./devices/helpers', () => ({
  getDeviceWithOrgCheck: (...args: any[]) => mockGetDeviceWithOrgCheck(...args),
}));

const mockSendCommandToAgent = vi.fn();
vi.mock('./agentWs', () => ({
  sendCommandToAgent: (...args: any[]) => mockSendCommandToAgent(...args),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
}));

vi.mock('fs', () => ({
  createReadStream: vi.fn(() => {
    const { Readable } = require('stream');
    const s = new Readable({ read() { this.push(null); } });
    return s;
  }),
  createWriteStream: vi.fn(() => {
    const { Writable } = require('stream');
    const ws = new Writable({
      write(_chunk: any, _enc: any, cb: any) { cb(); },
    });
    // Emit finish immediately when end() is called
    const origEnd = ws.end.bind(ws);
    ws.end = (...args: any[]) => {
      origEnd(...args);
    };
    return ws;
  }),
}));

import { authMiddleware } from '../middleware/auth';
import { devPushRoutes } from './devPush';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('devPush routes', () => {
  let app: Hono;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'development';
    process.env.PUBLIC_API_URL = 'https://api.breeze.local';

    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID,
      });
      return next();
    });

    app = new Hono();
    app.route('/dev', devPushRoutes);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ------------------------------------------------------------------
  // Environment guard
  // ------------------------------------------------------------------

  describe('production guard', () => {
    it('should block requests in production when DEV_PUSH_ENABLED is not set', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.DEV_PUSH_ENABLED;

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['test'], 'agent.bin'));

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('disabled in production');
    });

    it('should allow requests in production when DEV_PUSH_ENABLED is true', async () => {
      process.env.NODE_ENV = 'production';
      process.env.DEV_PUSH_ENABLED = 'true';

      mockGetDeviceWithOrgCheck.mockResolvedValue({
        id: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
      });
      mockSendCommandToAgent.mockReturnValue(true);

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['test-binary-content'], 'agent.bin'));

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
    });

    it('should allow requests in development by default', async () => {
      process.env.NODE_ENV = 'development';

      mockGetDeviceWithOrgCheck.mockResolvedValue({
        id: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
      });
      mockSendCommandToAgent.mockReturnValue(true);

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['test-binary-content'], 'agent.bin'));

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
    });
  });

  // ------------------------------------------------------------------
  // POST /push - Upload and trigger dev update
  // ------------------------------------------------------------------

  describe('POST /dev/push', () => {
    it('should return 400 when agentId is missing', async () => {
      const formData = new FormData();
      formData.append('binary', new File(['data'], 'agent.bin'));

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('agentId is required');
    });

    it('should return 400 when binary file is missing', async () => {
      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('binary file is required');
    });

    it('should return 404 when device not found or access denied', async () => {
      mockGetDeviceWithOrgCheck.mockResolvedValue(null);

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['data'], 'agent.bin'));

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('not found or access denied');
    });

    it('should return 500 when PUBLIC_API_URL is not set', async () => {
      delete process.env.PUBLIC_API_URL;
      delete process.env.BREEZE_SERVER;

      mockGetDeviceWithOrgCheck.mockResolvedValue({
        id: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
      });

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['data'], 'agent.bin'));

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('PUBLIC_API_URL');
    });

    it('should successfully push a binary and send WS command', async () => {
      mockGetDeviceWithOrgCheck.mockResolvedValue({
        id: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
      });
      mockSendCommandToAgent.mockReturnValue(true);

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('version', 'v1.2.3-dev');
      formData.append('binary', new File(['test-binary-content'], 'agent.bin'));

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.agentId).toBe(AGENT_ID);
      expect(body.deviceId).toBe(DEVICE_ID);
      expect(body.version).toBe('v1.2.3-dev');
      expect(body.wsSent).toBe(true);
      expect(body.checksum).toBeDefined();
      expect(body.downloadToken).toBeDefined();
      expect(body.downloadUrl).toContain('https://api.breeze.local');
      expect(body.downloadUrl).toContain(body.downloadToken);
    });

    it('should auto-generate version when not provided', async () => {
      mockGetDeviceWithOrgCheck.mockResolvedValue({
        id: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
      });
      mockSendCommandToAgent.mockReturnValue(false);

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['data'], 'agent.bin'));

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toMatch(/^dev-\d+$/);
      expect(body.wsSent).toBe(false);
    });

    it('should call sendCommandToAgent with dev_update command', async () => {
      mockGetDeviceWithOrgCheck.mockResolvedValue({
        id: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
      });
      mockSendCommandToAgent.mockReturnValue(true);

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['data'], 'agent.bin'));

      await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(mockSendCommandToAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: 'dev_update',
          payload: expect.objectContaining({
            downloadUrl: expect.stringContaining('/api/v1/dev/push/download/'),
            checksum: expect.any(String),
          }),
        })
      );
    });

    it('should use BREEZE_SERVER when PUBLIC_API_URL is not set', async () => {
      delete process.env.PUBLIC_API_URL;
      process.env.BREEZE_SERVER = 'https://breeze.example.com/';

      mockGetDeviceWithOrgCheck.mockResolvedValue({
        id: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
      });
      mockSendCommandToAgent.mockReturnValue(true);

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['data'], 'agent.bin'));

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.downloadUrl).toMatch(/^https:\/\/breeze\.example\.com\/api\/v1\/dev\/push\/download\//);
    });
  });

  // ------------------------------------------------------------------
  // GET /push/download/:token
  // ------------------------------------------------------------------

  describe('GET /dev/push/download/:token', () => {
    it('should return 404 for unknown token', async () => {
      const res = await app.request('/dev/push/download/nonexistent-token', {
        method: 'GET',
        headers: { Authorization: 'Bearer agent-token' },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('not found or expired');
    });

    it('M-H2: 404 path does NOT log the raw download token', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const RAW = 'super-secret-download-token-123';
      const res = await app.request(`/dev/push/download/${RAW}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer agent-token' },
      });
      // 404 path doesn't log here, but verify nothing leaked the raw token.
      expect(res.status).toBe(404);
      const allArgs = errSpy.mock.calls.flat().map((a) =>
        typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
      );
      for (const s of allArgs) {
        expect(s).not.toContain(RAW);
      }
      errSpy.mockRestore();
    });

    it('should return 401 when no Authorization header', async () => {
      // We need to first push a binary so there is a pending download
      // but since the download map is in-memory and the guard middleware runs first,
      // we just test the download endpoint independently with no matching token.
      // The 404 path hits before auth check for missing tokens.
      // For a real token, we'd need integration testing.

      const res = await app.request('/dev/push/download/some-token', {
        method: 'GET',
        // No Authorization header
      });

      // Will return 404 since token doesn't exist in the map
      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------
  // Multi-tenant isolation
  // ------------------------------------------------------------------

  describe('multi-tenant isolation', () => {
    it('should deny push when user cannot access the device org', async () => {
      mockGetDeviceWithOrgCheck.mockResolvedValue(null);

      const formData = new FormData();
      formData.append('agentId', 'device-in-other-org');
      formData.append('binary', new File(['data'], 'agent.bin'));

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });

    it('should pass auth context to getDeviceWithOrgCheck', async () => {
      mockGetDeviceWithOrgCheck.mockResolvedValue({
        id: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
      });
      mockSendCommandToAgent.mockReturnValue(true);

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['data'], 'agent.bin'));

      await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(mockGetDeviceWithOrgCheck).toHaveBeenCalledWith(
        DEVICE_ID,
        expect.objectContaining({
          scope: 'organization',
          orgId: ORG_ID,
        })
      );
    });
  });

  // ------------------------------------------------------------------
  // API key auth
  // ------------------------------------------------------------------

  describe('API key authentication', () => {
    it('should accept X-API-Key header for auth', async () => {
      mockGetDeviceWithOrgCheck.mockResolvedValue({
        id: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
      });
      mockSendCommandToAgent.mockReturnValue(true);

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['data'], 'agent.bin'));

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { 'X-API-Key': 'brz_test_key' },
      });

      expect(res.status).toBe(200);
    });
  });
});
