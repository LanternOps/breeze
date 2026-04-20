import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { tunnelRoutes, vncExchangeRoutes } from './tunnels';

// --- UUID constants ---
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_ID    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID   = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';
const SESSION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

// --- DB mock ---
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  tunnelSessions: {},
  tunnelAllowlists: {},
  devices: {},
  users: {},
}));

// --- Auth middleware ---
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      user: { id: USER_ID, email: 'test@example.com' },
      canAccessOrg: (id: string) => id === ORG_ID,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

// --- Agent WS helpers ---
vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true),
  isAgentConnected: vi.fn(() => true),
}));

// --- Remote access policy ---
vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn(async () => ({ allowed: true })),
}));

// --- Remote session auth ---
vi.mock('../services/remoteSessionAuth', () => ({
  createWsTicket: vi.fn(async () => ({ ticket: 'ws-ticket-abc', expiresInSeconds: 60 })),
  createVncConnectCode: vi.fn(async () => ({ code: 'test-connect-code-32bytes', expiresInSeconds: 60 })),
  consumeVncConnectCode: vi.fn(),
  getViewerAccessTokenExpirySeconds: vi.fn(() => 900),
}));

// --- JWT service ---
vi.mock('../services/jwt', () => ({
  createViewerAccessToken: vi.fn(async () => 'mock-viewer-access-token'),
}));

import { db } from '../db';
import { sendCommandToAgent } from './agentWs';
import { createVncConnectCode, consumeVncConnectCode } from '../services/remoteSessionAuth';
import { createViewerAccessToken } from '../services/jwt';

// Reusable device fixture (online, agent connected)
const onlineDevice = {
  id: DEVICE_ID,
  orgId: ORG_ID,
  agentId: 'agent-abc',
  status: 'online',
};

// Reusable session fixture (what the DB insert returns)
const sessionRecord = {
  id: SESSION_ID,
  deviceId: DEVICE_ID,
  userId: USER_ID,
  orgId: ORG_ID,
  type: 'vnc',
  status: 'pending',
  targetHost: '127.0.0.1',
  targetPort: 5900,
  sourceIp: '127.0.0.1',
  createdAt: new Date(),
  updatedAt: new Date(),
  endedAt: null,
  errorMessage: null,
};

/**
 * makeSelectChain — resolves `rows` for both:
 *   db.select().from(t).where(cond).limit(n)  → device lookup
 *   db.select().from(t).where(cond)            → allowlist queries (awaited directly)
 */
function makeSelectChain(rows: any[]) {
  const whereResult = Object.assign(Promise.resolve(rows), {
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
    }),
  });
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(whereResult),
    }),
  };
}

function makeInsertChain(rows: any[]) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  };
}

describe('POST /tunnels (VNC)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/tunnels', tunnelRoutes);

    // Default select: device lookup returns onlineDevice, allowlist returns []
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([onlineDevice]) as any)  // device lookup
      .mockReturnValueOnce(makeSelectChain([]) as any);              // source-IP allowlist (no rules = allowed)

    // Insert returns the session record
    vi.mocked(db.insert).mockReturnValue(makeInsertChain([sessionRecord]) as any);
  });

  it('does not include vncPassword in the 201 response body (ARD auth is used at the client)', async () => {
    const res = await app.request('/tunnels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID, type: 'vnc' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).not.toHaveProperty('vncPassword');
  });

  it('does not include vncPassword in the tunnel_open command payload sent to the agent', async () => {
    const res = await app.request('/tunnels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID, type: 'vnc' }),
    });

    expect(res.status).toBe(201);

    // Verify the command dispatched to the agent has no vncPassword
    expect(sendCommandToAgent).toHaveBeenCalledOnce();
    const [, command] = vi.mocked(sendCommandToAgent).mock.calls[0]!;
    expect(command.payload).not.toHaveProperty('vncPassword');
  });

  it('returns session fields in the 201 response body', async () => {
    const res = await app.request('/tunnels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID, type: 'vnc' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('id', SESSION_ID);
    expect(body).toHaveProperty('type', 'vnc');
    expect(body).toHaveProperty('status', 'pending');
  });
});

// ─── Malformed params/query ───────────────────────────────────────────────────

describe('Malformed UUID params and query strings', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/tunnels', tunnelRoutes);
  });

  it('returns 400 on GET /:id with malformed UUID', async () => {
    const res = await app.request('/tunnels/not-a-uuid', { method: 'GET' });
    expect(res.status).toBe(400);
  });

  it('returns 400 on DELETE /:id with malformed UUID', async () => {
    const res = await app.request('/tunnels/invalid-id-format', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('returns 400 on POST /:id/ws-ticket with malformed UUID', async () => {
    const res = await app.request('/tunnels/bad-uuid/ws-ticket', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('returns 400 on POST /:id/connect-code with malformed UUID', async () => {
    const res = await app.request('/tunnels/bad-uuid/connect-code', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('returns 400 on PUT /allowlist/:id with malformed UUID', async () => {
    const res = await app.request('/tunnels/allowlist/not-uuid', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: '10.0.0.0/8:*' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on DELETE /allowlist/:id with malformed UUID', async () => {
    const res = await app.request('/tunnels/allowlist/malformed', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('returns 400 on GET /allowlist with malformed siteId query', async () => {
    const res = await app.request('/tunnels/allowlist?siteId=not-a-uuid', { method: 'GET' });
    expect(res.status).toBe(400);
  });

  it('accepts GET /allowlist without siteId query', async () => {
    // Create fresh app to reset mocks for this test
    const testApp = new Hono();
    testApp.route('/tunnels', tunnelRoutes);
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as any);
    const res = await testApp.request('/tunnels/allowlist', { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('accepts GET /allowlist with valid UUID siteId query', async () => {
    const testApp = new Hono();
    testApp.route('/tunnels', tunnelRoutes);
    const validSiteId = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0';
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as any);
    const res = await testApp.request(`/tunnels/allowlist?siteId=${validSiteId}`, { method: 'GET' });
    expect(res.status).toBe(200);
  });
});

// ─── POST /tunnels/:id/connect-code ───────────────────────────────────────────

describe('POST /tunnels/:id/connect-code', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/tunnels', tunnelRoutes);
  });

  it('returns a code for a valid VNC tunnel the user owns', async () => {
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([sessionRecord]) as any);

    const res = await app.request(`/tunnels/${SESSION_ID}/connect-code`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('code');
    expect(typeof body.code).toBe('string');
    expect(body.code.length).toBeGreaterThanOrEqual(16);
    expect(createVncConnectCode).toHaveBeenCalledWith(expect.objectContaining({
      tunnelId: SESSION_ID,
      userId: USER_ID,
    }));
  });

  it('returns 404 when tunnel is not found or user cannot access it', async () => {
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([]) as any);

    const res = await app.request(`/tunnels/${SESSION_ID}/connect-code`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when tunnel type is not vnc', async () => {
    const proxySession = { ...sessionRecord, type: 'proxy' };
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([proxySession]) as any);

    const res = await app.request(`/tunnels/${SESSION_ID}/connect-code`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/vnc/i);
  });

  it('returns 403 when user is not the session owner', async () => {
    const otherUserSession = { ...sessionRecord, userId: 'other-user-id' };
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([otherUserSession]) as any);

    const res = await app.request(`/tunnels/${SESSION_ID}/connect-code`, { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

// ─── POST /vnc-exchange/:code ─────────────────────────────────────────────────

describe('POST /vnc-exchange/:code', () => {
  let app: Hono;

  const vncCodeRecord = {
    tunnelId: SESSION_ID,
    deviceId: DEVICE_ID,
    orgId: ORG_ID,
    userId: USER_ID,
    email: 'test@example.com',
    expiresAt: Date.now() + 60_000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/vnc-exchange', vncExchangeRoutes);
  });

  it('returns accessToken, tunnelId, wsUrl, deviceId for a valid code', async () => {
    vi.mocked(consumeVncConnectCode).mockResolvedValueOnce(vncCodeRecord);
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([sessionRecord]) as any);
    vi.mocked(createViewerAccessToken).mockResolvedValueOnce('viewer-token-xyz');

    const res = await app.request('/vnc-exchange/valid-code', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('accessToken', 'viewer-token-xyz');
    expect(body).toHaveProperty('tunnelId', SESSION_ID);
    expect(body).toHaveProperty('wsUrl');
    expect(body).toHaveProperty('deviceId', DEVICE_ID);
    expect(typeof body.wsUrl).toBe('string');
  });

  it('returns 404 for a missing or expired code (single-use)', async () => {
    vi.mocked(consumeVncConnectCode).mockResolvedValueOnce(null);

    const res = await app.request('/vnc-exchange/bad-code', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('invalidates the code on exchange (second call returns 404)', async () => {
    vi.mocked(consumeVncConnectCode)
      .mockResolvedValueOnce(vncCodeRecord)
      .mockResolvedValueOnce(null);
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([sessionRecord]) as any);
    vi.mocked(createViewerAccessToken).mockResolvedValue('tok');

    const res1 = await app.request('/vnc-exchange/dup-code', { method: 'POST' });
    expect(res1.status).toBe(200);

    const res2 = await app.request('/vnc-exchange/dup-code', { method: 'POST' });
    expect(res2.status).toBe(404);
  });

  it('returns 404 when session not found in DB', async () => {
    vi.mocked(consumeVncConnectCode).mockResolvedValueOnce(vncCodeRecord);
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([]) as any);

    const res = await app.request('/vnc-exchange/valid-code', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
