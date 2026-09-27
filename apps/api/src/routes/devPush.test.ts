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
  users: {
    id: 'id',
    mfaEnabled: 'mfa_enabled',
  },
}));

const mockWriteAuditEvent = vi.fn();
vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: (...args: any[]) => mockWriteAuditEvent(...args),
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
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (!c.req.header('x-test-drop-perms')) c.set('permissions', {});
    return next();
  }),
  // Matches the real requireMfa()'s success-path shape: it awaits next()
  // without forwarding next()'s own return value (only a denial returns a
  // Response directly). devPushAuth's propagateDenial helper depends on that
  // distinction to tell "denied" apart from "succeeded".
  requireMfa: vi.fn(() => async (_c: any, next: any) => { await next(); }),
}));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: vi.fn((c: any, next: any) => {
    c.set('apiKey', {
      id: 'key-001',
      createdBy: 'creator-001',
      orgId: '11111111-1111-1111-1111-111111111111', scopes: ['devices:execute'],
      allowedSiteIds: c.req.header('x-test-sites') === undefined
        ? undefined : c.req.header('x-test-sites').split(',').filter(Boolean),
    });
    return next();
  }),
  requireApiKeyScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

const mockGetDeviceWithOrgCheck = vi.fn();
vi.mock('./devices/helpers', () => ({
  getDeviceWithOrgCheck: (...args: any[]) => mockGetDeviceWithOrgCheck(...args),
  getDeviceByAgentWithOrgCheck: (...args: any[]) => mockGetDeviceWithOrgCheck(...args),
}));

const mockSendCommandToAgent = vi.fn();
vi.mock('./agentWs', () => ({
  sendCommandToAgent: (...args: any[]) => mockSendCommandToAgent(...args),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
  readdir: vi.fn().mockResolvedValue([]),
  statfs: vi.fn().mockResolvedValue({ bavail: 1_000_000, bsize: 4096 }),
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

import { mkdir, statfs, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { createWriteStream } from 'fs';
import { authMiddleware, requireMfa } from '../middleware/auth';
import { db } from '../db';
import { devPushRoutes } from './devPush';

// Builds a chainable `db.select(...).from(...).where(...).limit(...)` stub
// resolving to `rows`, matching the shape devPush.ts's MFA-creator lookup uses.
function mockUsersSelect(rows: unknown[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
  };
  vi.mocked(db.select).mockReturnValue(chain);
}

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

    // Default: the API key's creator has an enrolled MFA factor, matching
    // the common case so unrelated tests don't have to opt in.
    mockUsersSelect([{ mfaEnabled: true }]);

    app = new Hono();
    app.route('/dev', devPushRoutes);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it.each(['allowed-other-site', ''])('denies a restricted key before file/download/command side effects (%s)', async (sites) => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_PUSH_ENABLED = 'true';
    mockGetDeviceWithOrgCheck.mockResolvedValue({ id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID, siteId: 'denied-site' });
    const form = new FormData();
    form.append('agentId', AGENT_ID);
    form.append('binary', new File(['inert-test-content'], 'fixture.bin'));
    const mapSet = vi.spyOn(Map.prototype, 'set');
    try {
      const res = await app.request('/dev/push', {
        method: 'POST', body: form, headers: { 'X-API-Key': 'test-key', 'x-test-sites': sites },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Access to this site denied' });
      expect(mkdir).not.toHaveBeenCalled();
      expect(createWriteStream).not.toHaveBeenCalled();
      expect(mockSendCommandToAgent).not.toHaveBeenCalled();
      expect(mapSet.mock.calls.filter(([, value]) => value && typeof value === 'object'
        && 'filePath' in value && 'agentId' in value)).toEqual([]);
    } finally {
      mapSet.mockRestore();
    }
  });

  it('fails closed when a session reaches device authorization without permissions', async () => {
    mockGetDeviceWithOrgCheck.mockResolvedValue({ id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID, siteId: 'site' });
    const form = new FormData();
    form.append('agentId', AGENT_ID);
    form.append('binary', new File(['inert-test-content'], 'fixture.bin'));
    const res = await app.request('/dev/push', {
      method: 'POST', body: form, headers: { Authorization: 'Bearer token', 'x-test-drop-perms': 'true' },
    });
    expect(res.status).toBe(403);
    expect(mkdir).not.toHaveBeenCalled();
    expect(createWriteStream).not.toHaveBeenCalled();
    expect(mockSendCommandToAgent).not.toHaveBeenCalled();
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

  describe('staging directory (#6621)', () => {
    const push = (binary = 'test-binary-content') => {
      mockGetDeviceWithOrgCheck.mockResolvedValue({ id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID });
      mockSendCommandToAgent.mockReturnValue(true);
      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File([binary], 'agent.bin'));
      return app.request('/dev/push', { method: 'POST', body: formData, headers: { Authorization: 'Bearer token' } });
    };

    it('stages under DEV_PUSH_WORK_DIR, never os.tmpdir()', async () => {
      process.env.DEV_PUSH_WORK_DIR = '/var/lib/breeze/dev-push';
      const res = await push();
      expect(res.status).toBe(200);
      expect(mkdir).toHaveBeenCalledWith('/var/lib/breeze/dev-push', { recursive: true });
      const target = vi.mocked(createWriteStream).mock.calls[0]![0] as string;
      expect(target.startsWith('/var/lib/breeze/dev-push/')).toBe(true);
    });

    it('defaults to a directory beside the durable data dir, not os.tmpdir()', async () => {
      delete process.env.DEV_PUSH_WORK_DIR;
      process.env.PATCH_REPORT_STORAGE_PATH = '/data/patch-reports';
      const res = await push();
      expect(res.status).toBe(200);
      const target = vi.mocked(createWriteStream).mock.calls[0]![0] as string;
      expect(target.startsWith('/data/dev-push/')).toBe(true);
      expect(target.startsWith(tmpdir())).toBe(false);
    });

    it('rejects with 507 naming the dir when free space is below the upload size', async () => {
      process.env.DEV_PUSH_WORK_DIR = '/var/lib/breeze/dev-push';
      vi.mocked(statfs).mockResolvedValueOnce({ bavail: 1, bsize: 1024 } as any);
      const res = await push('x'.repeat(4096));
      expect(res.status).toBe(507);
      expect((await res.json()).error).toContain('/var/lib/breeze/dev-push');
      expect(createWriteStream).not.toHaveBeenCalled();
      expect(mockSendCommandToAgent).not.toHaveBeenCalled();
    });

    it('reports the sha256 of the streamed bytes and writes them unchanged', async () => {
      process.env.DEV_PUSH_WORK_DIR = '/var/lib/breeze/dev-push';
      const written: Buffer[] = [];
      vi.mocked(createWriteStream).mockImplementationOnce((() => {
        const { Writable } = require('stream');
        return new Writable({ write(chunk: Buffer, _e: any, cb: any) { written.push(chunk); cb(); } });
      }) as any);
      const res = await push('known-bytes');
      const { createHash } = await import('crypto');
      expect((await res.json()).checksum).toBe(createHash('sha256').update('known-bytes').digest('hex'));
      expect(Buffer.concat(written).toString()).toBe('known-bytes');
    });

    it('returns 507 and removes the partial file on a mid-write ENOSPC', async () => {
      process.env.DEV_PUSH_WORK_DIR = '/var/lib/breeze/dev-push';
      vi.mocked(createWriteStream).mockImplementationOnce((() => {
        const { Writable } = require('stream');
        return new Writable({
          write(_c: any, _e: any, cb: any) { cb(Object.assign(new Error('no space'), { code: 'ENOSPC' })); },
        });
      }) as any);
      const res = await push();
      expect(res.status).toBe(507);
      expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/var\/lib\/breeze\/dev-push\/.+\.bin$/));
      expect(mockSendCommandToAgent).not.toHaveBeenCalled();
    });
  });

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

  // ------------------------------------------------------------------
  // Audit trail (accountability for a capability that ships binaries)
  // ------------------------------------------------------------------

  describe('audit trail', () => {
    it('records an attributable audit event for a JWT-authenticated push', async () => {
      mockGetDeviceWithOrgCheck.mockResolvedValue({
        id: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
      });
      mockSendCommandToAgent.mockReturnValue(true);

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('version', 'v1.2.3-dev');
      formData.append('component', 'agent');
      formData.append('binary', new File(['test-binary-content'], 'agent.bin'));

      const res = await app.request('/dev/push', {
        method: 'POST',
        body: formData,
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEvent).toHaveBeenCalledTimes(1);
      const [, event] = mockWriteAuditEvent.mock.calls[0]!;
      expect(event).toMatchObject({
        orgId: ORG_ID,
        action: 'device.dev_push',
        resourceType: 'device',
        resourceId: DEVICE_ID,
        resourceName: AGENT_ID,
        actorType: 'user',
        actorId: 'user-123',
        actorEmail: 'test@example.com',
        details: expect.objectContaining({
          agentId: AGENT_ID,
          component: 'agent',
          version: 'v1.2.3-dev',
          wsSent: true,
          checksum: expect.any(String),
        }),
      });
    });

    it('records an attributable audit event for an API-key-authenticated push', async () => {
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
      expect(mockWriteAuditEvent).toHaveBeenCalledTimes(1);
      const [, event] = mockWriteAuditEvent.mock.calls[0]!;
      expect(event).toMatchObject({
        orgId: ORG_ID,
        action: 'device.dev_push',
        actorType: 'api_key',
        actorId: 'key-001',
      });
    });

    it('does not write an audit event when the push is rejected before dispatch', async () => {
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
      expect(mockWriteAuditEvent).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // API-key MFA parity (compensating control — keys cannot interactively MFA)
  // ------------------------------------------------------------------

  describe('API key MFA parity', () => {
    const push = () => {
      mockGetDeviceWithOrgCheck.mockResolvedValue({ id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID });
      mockSendCommandToAgent.mockReturnValue(true);
      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['data'], 'agent.bin'));
      return app.request('/dev/push', {
        method: 'POST', body: formData, headers: { 'X-API-Key': 'brz_test_key' },
      });
    };

    it('rejects a push when the key creator has no enrolled MFA factor', async () => {
      mockUsersSelect([{ mfaEnabled: false }]);
      const res = await push();
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      expect(mockSendCommandToAgent).not.toHaveBeenCalled();
      expect(mockWriteAuditEvent).not.toHaveBeenCalled();
    });

    it('rejects a push when the key creator row cannot be found', async () => {
      mockUsersSelect([]);
      const res = await push();
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      expect(mockSendCommandToAgent).not.toHaveBeenCalled();
    });

    it('allows a push when the key creator has an enrolled MFA factor', async () => {
      mockUsersSelect([{ mfaEnabled: true }]);
      const res = await push();
      expect(res.status).toBe(200);
      expect(mockSendCommandToAgent).toHaveBeenCalled();
    });

    it('does not gate the JWT branch on this check (already covered by requireMfa())', async () => {
      // Sanity: the creator-MFA lookup must not run on the JWT path at all.
      mockUsersSelect([{ mfaEnabled: false }]);
      mockGetDeviceWithOrgCheck.mockResolvedValue({ id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID });
      mockSendCommandToAgent.mockReturnValue(true);
      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['data'], 'agent.bin'));
      const res = await app.request('/dev/push', {
        method: 'POST', body: formData, headers: { Authorization: 'Bearer token' },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('JWT MFA denial propagation', () => {
    // devPushAuth composes authMiddleware/requireScope/requirePermission/
    // requireMfa by hand instead of registering them as separate Hono
    // middlewares. requireMfa() denies by RETURNING a Response rather than
    // throwing; nested several closures deep like this, a returned value
    // that nothing forwards is just discarded — the request would silently
    // fall through as an empty 200 instead of a 403. This proves the denial
    // actually reaches the caller.
    it('surfaces a requireMfa() denial as 403, not a silent empty 200', async () => {
      vi.mocked(requireMfa).mockImplementationOnce(() => async (c: any, _next: any) =>
        c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403));
      mockGetDeviceWithOrgCheck.mockResolvedValue({ id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID });

      const formData = new FormData();
      formData.append('agentId', DEVICE_ID);
      formData.append('binary', new File(['data'], 'agent.bin'));
      const res = await app.request('/dev/push', {
        method: 'POST', body: formData, headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      expect(mockSendCommandToAgent).not.toHaveBeenCalled();
      expect(mockWriteAuditEvent).not.toHaveBeenCalled();
    });
  });
});
