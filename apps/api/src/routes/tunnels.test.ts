import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { tunnelRoutes, vncExchangeRoutes, vncViewerRoutes } from './tunnels';

// --- UUID constants ---
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_ID    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID   = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';
const SESSION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PARTNER_ID = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp';

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
  tunnelAllowlists: { orgId: 'tunnelAllowlists.orgId', siteId: 'tunnelAllowlists.siteId', createdAt: 'tunnelAllowlists.createdAt' },
  devices: {},
  users: {},
  remoteSessions: {},
}));

// --- Auth middleware ---
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    // Partner-scope callers (MSP users with an org selected in the picker) send
    // their org via the `?orgId=` query param, NOT a JWT org claim. Tests opt
    // into that shape with `x-test-scope: partner` + `x-test-accessible-orgs`
    // (comma-separated), mirroring how the web client scopes API calls.
    const testScope = c.req.header('x-test-scope');
    if (testScope === 'partner') {
      const accessibleOrgIds = (c.req.header('x-test-accessible-orgs') || '')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
      c.set('auth', {
        scope: 'partner',
        partnerId: PARTNER_ID,
        orgId: null,
        accessibleOrgIds,
        user: { id: USER_ID, email: 'test@example.com' },
        canAccessOrg: (id: string) => accessibleOrgIds.includes(id),
      });
    } else {
      c.set('auth', {
        scope: 'organization',
        partnerId: null,
        orgId: ORG_ID,
        accessibleOrgIds: [ORG_ID],
        user: { id: USER_ID, email: 'test@example.com' },
        canAccessOrg: (id: string) => id === ORG_ID,
      });
    }
    // NOTE: authMiddleware does NOT populate `permissions` in production — only
    // requirePermission does. Keep it out here so a route relying on permissions
    // for site-scoping but lacking a permission gate fails its tests (not masks).
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    // Mirror prod: requirePermission is the gate that populates `permissions`.
    const restrict = c.req.header('x-restrict-site');
    c.set('permissions', restrict ? {
      permissions: [{ resource: 'devices', action: 'read' }],
      partnerId: null,
      orgId: ORG_ID,
      roleId: 'role-1',
      scope: 'organization',
      allowedSiteIds: restrict === '__empty__' ? [] : [restrict],
    } : undefined);
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
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
  verifyViewerAccessToken: vi.fn(async () => null),
}));

// --- Redis (used by requireViewerToken session-revoke check) ---
vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => ({
    set: vi.fn(async () => 'OK'),
    get: vi.fn(async () => null),
  })),
}));

// --- Viewer token revocation ---
vi.mock('../services/viewerTokenRevocation', () => ({
  isViewerJtiRevoked: vi.fn(async () => false),
  isViewerSessionRevoked: vi.fn(async () => false),
  revokeViewerJti: vi.fn(async () => undefined),
  revokeViewerSession: vi.fn(async () => undefined),
}));

import { db } from '../db';
import { sendCommandToAgent } from './agentWs';
import { createVncConnectCode, consumeVncConnectCode } from '../services/remoteSessionAuth';
import { createViewerAccessToken, verifyViewerAccessToken } from '../services/jwt';

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

function makeJoinedSelectChain(rows: any[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
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

  it('returns 403 when GET /allowlist filters to a site outside the allowlist', async () => {
    const deniedSiteId = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0';
    const res = await app.request(`/tunnels/allowlist?siteId=${deniedSiteId}`, {
      method: 'GET',
      headers: { 'x-restrict-site': 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0' },
    });

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});

// ─── Site-scope enforcement on tunnel session reads ──────────────────────────

describe('GET /tunnels — site-scope enforcement (partner-scope callers)', () => {
  let app: Hono;
  const SITE_A = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0';
  const SITE_B = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0';
  const DEVICE_IN_A = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
  const DEVICE_IN_B = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    app = new Hono();
    app.route('/tunnels', tunnelRoutes);
  });

  // List flow when site-restricted: 1st select resolves org devices (id+siteId),
  // 2nd select returns the (already narrowed) sessions list.
  function rigListNarrowing(orgDevices: Array<{ id: string; siteId: string | null }>, sessions: any[]) {
    const deviceWhere = vi.fn().mockResolvedValue(orgDevices);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: deviceWhere }),
    } as any);
    const listWhere = vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(sessions) }),
    });
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: listWhere }),
    } as any);
    return { deviceWhere, listWhere };
  }

  it('narrows the session list to allowed-site devices for a site-restricted caller', async () => {
    const { listWhere } = rigListNarrowing(
      [
        { id: DEVICE_IN_A, siteId: SITE_A },
        { id: DEVICE_IN_B, siteId: SITE_B },
      ],
      [{ ...sessionRecord, deviceId: DEVICE_IN_A }]
    );

    const res = await app.request('/tunnels', {
      method: 'GET',
      headers: { 'x-restrict-site': SITE_A },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].deviceId).toBe(DEVICE_IN_A);
    expect(listWhere).toHaveBeenCalledTimes(1);
  });

  it('returns an empty session list when a site-restricted caller has no in-scope devices', async () => {
    const deviceWhere = vi.fn().mockResolvedValue([{ id: DEVICE_IN_B, siteId: SITE_B }]);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: deviceWhere }),
    } as any);

    const res = await app.request('/tunnels', {
      method: 'GET',
      headers: { 'x-restrict-site': SITE_A },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    // Only the org-device narrowing select ran; the sessions query was skipped.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('does not narrow the session list for an unrestricted caller', async () => {
    const listWhere = vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([sessionRecord]) }),
    });
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: listWhere }),
    } as any);

    const res = await app.request('/tunnels', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

describe('GET /tunnels/:id — site-scope enforcement', () => {
  let app: Hono;
  const SITE_A = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0';
  const SITE_B = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0';
  const DEVICE_IN_B = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    app = new Hono();
    app.route('/tunnels', tunnelRoutes);
  });

  it('returns 403 when a site-restricted caller reads a tunnel whose device is out-of-site', async () => {
    // 1st select: tunnel session (joins userId); 2nd select: device siteId.
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ ...sessionRecord, deviceId: DEVICE_IN_B }]) as any)
      .mockReturnValueOnce(makeSelectChain([{ siteId: SITE_B }]) as any);

    const res = await app.request(`/tunnels/${SESSION_ID}`, {
      method: 'GET',
      headers: { 'x-restrict-site': SITE_A },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).not.toHaveProperty('targetHost');
  });

  it('returns 403 when a site-restricted caller reads a tunnel whose device has a null siteId', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ ...sessionRecord, deviceId: DEVICE_IN_B }]) as any)
      .mockReturnValueOnce(makeSelectChain([{ siteId: null }]) as any);

    const res = await app.request(`/tunnels/${SESSION_ID}`, {
      method: 'GET',
      headers: { 'x-restrict-site': SITE_A },
    });

    expect(res.status).toBe(403);
  });

  it('returns the tunnel when a site-restricted caller reads a tunnel whose device is in-site', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ ...sessionRecord, deviceId: DEVICE_IN_B }]) as any)
      .mockReturnValueOnce(makeSelectChain([{ siteId: SITE_A }]) as any);

    const res = await app.request(`/tunnels/${SESSION_ID}`, {
      method: 'GET',
      headers: { 'x-restrict-site': SITE_A },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(SESSION_ID);
  });

  it('returns the tunnel for an unrestricted caller without a device-site lookup', async () => {
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([sessionRecord]) as any);

    const res = await app.request(`/tunnels/${SESSION_ID}`, { method: 'GET' });

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(SESSION_ID);
    expect(db.select).toHaveBeenCalledTimes(1);
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

  it('rejects connect codes for closed VNC tunnels', async () => {
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([{ ...sessionRecord, status: 'disconnected' }]) as any);

    const res = await app.request(`/tunnels/${SESSION_ID}/connect-code`, { method: 'POST' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({
      error: 'Cannot mint VNC connect code for tunnel in current state',
      status: 'disconnected',
    }));
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

  it('rejects VNC exchange when the tunnel has already closed', async () => {
    vi.mocked(consumeVncConnectCode).mockResolvedValueOnce(vncCodeRecord);
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([{ ...sessionRecord, status: 'disconnected' }]) as any);

    const res = await app.request('/vnc-exchange/closed-code', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({
      error: 'Tunnel session is not available for connection',
      status: 'disconnected',
    }));
    expect(createViewerAccessToken).not.toHaveBeenCalled();
  });
});

// ─── POST /vnc-viewer/upgrade-to-webrtc ──────────────────────────────────────

describe('POST /vnc-viewer/upgrade-to-webrtc', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/vnc-viewer', vncViewerRoutes);
  });

  it('rejects upgrade when the bound VNC tunnel has closed', async () => {
    vi.mocked(verifyViewerAccessToken).mockResolvedValueOnce({
      sub: USER_ID,
      email: 'test@example.com',
      sessionId: SESSION_ID,
      purpose: 'viewer',
      jti: 'viewer-jti-1',
    });
    vi.mocked(db.select).mockReturnValueOnce(makeJoinedSelectChain([{
      tunnelUserId: USER_ID,
      tunnelOrgId: ORG_ID,
      deviceId: DEVICE_ID,
      tunnelType: 'vnc',
      tunnelStatus: 'disconnected',
      deviceStatus: 'online',
      agentId: 'agent-abc',
      userEmail: 'test@example.com',
    }]) as any);

    const res = await app.request('/vnc-viewer/upgrade-to-webrtc', {
      method: 'POST',
      headers: { Authorization: 'Bearer viewer-token' },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({
      error: 'Tunnel session is not available for upgrade',
      status: 'disconnected',
    }));
    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ─── Allowlist routes — partner-scope org resolution ─────────────────────────
// Regression for "Failed to create allowlist entry" (Enable Proxy Access on the
// discovery page): partner-scope sessions carry no JWT org claim and pass the
// target org via `?orgId=`. The routes must resolve that, not reject with 400.

describe('Allowlist routes — partner-scope org resolution', () => {
  let app: Hono;
  const ORG_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'; // accessible to the partner
  const ORG_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'; // NOT accessible
  const RULE_ID = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';

  const ruleBody = {
    direction: 'destination',
    pattern: '10.1.2.50/32:80-443',
    description: 'Auto-created for Printer',
    source: 'discovery',
    discoveredAssetId: '99999999-9999-4999-8999-999999999999',
  };

  // Capture the values passed to db.insert(...).values(...) so we can assert the
  // resolved orgId is persisted.
  function rigInsertCapture(returned: any) {
    const valuesSpy = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([returned]),
    });
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any);
    return valuesSpy;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    app = new Hono();
    app.route('/tunnels', tunnelRoutes);
  });

  it('POST /allowlist resolves the org from ?orgId= for a partner caller (201)', async () => {
    const valuesSpy = rigInsertCapture({ id: RULE_ID, orgId: ORG_A, ...ruleBody });

    const res = await app.request(`/tunnels/allowlist?orgId=${ORG_A}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-scope': 'partner',
        'x-test-accessible-orgs': ORG_A,
      },
      body: JSON.stringify(ruleBody),
    });

    expect(res.status).toBe(201);
    expect(valuesSpy).toHaveBeenCalledTimes(1);
    expect(valuesSpy.mock.calls[0]![0]).toEqual(expect.objectContaining({ orgId: ORG_A }));
  });

  it('POST /allowlist returns 403 when the partner cannot access the requested org', async () => {
    rigInsertCapture({ id: RULE_ID });

    const res = await app.request(`/tunnels/allowlist?orgId=${ORG_B}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-scope': 'partner',
        'x-test-accessible-orgs': ORG_A,
      },
      body: JSON.stringify(ruleBody),
    });

    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('POST /allowlist auto-resolves the single accessible org when no ?orgId= is given', async () => {
    const valuesSpy = rigInsertCapture({ id: RULE_ID, orgId: ORG_A, ...ruleBody });

    const res = await app.request('/tunnels/allowlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-scope': 'partner',
        'x-test-accessible-orgs': ORG_A,
      },
      body: JSON.stringify(ruleBody),
    });

    expect(res.status).toBe(201);
    expect(valuesSpy.mock.calls[0]![0]).toEqual(expect.objectContaining({ orgId: ORG_A }));
  });

  it('POST /allowlist returns 400 when a multi-org partner omits ?orgId=', async () => {
    rigInsertCapture({ id: RULE_ID });

    const res = await app.request('/tunnels/allowlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-scope': 'partner',
        'x-test-accessible-orgs': `${ORG_A},${ORG_B}`,
      },
      body: JSON.stringify(ruleBody),
    });

    expect(res.status).toBe(400);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('GET /allowlist scopes to the resolved org for a partner caller (200)', async () => {
    const where = vi.fn().mockReturnValue({
      orderBy: vi.fn().mockResolvedValue([{ id: RULE_ID, orgId: ORG_A }]),
    });
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where }),
    } as any);

    const res = await app.request(`/tunnels/allowlist?orgId=${ORG_A}`, {
      method: 'GET',
      headers: {
        'x-test-scope': 'partner',
        'x-test-accessible-orgs': ORG_A,
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it('DELETE /allowlist/:id resolves the org for a partner caller (404 when no row)', async () => {
    // No matching row in the resolved org → 404 (NOT the old 400 org-context error).
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as any);

    const res = await app.request(`/tunnels/allowlist/${RULE_ID}?orgId=${ORG_A}`, {
      method: 'DELETE',
      headers: {
        'x-test-scope': 'partner',
        'x-test-accessible-orgs': ORG_A,
      },
    });

    expect(res.status).toBe(404);
  });
});
