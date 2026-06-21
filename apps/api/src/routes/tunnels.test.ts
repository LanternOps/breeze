import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { tunnelRoutes, vncExchangeRoutes, vncViewerRoutes } from './tunnels';

// --- UUID constants ---
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_ID    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID   = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';
const SESSION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PARTNER_ID = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp';

const { rateLimiterMock } = vi.hoisted(() => ({
  rateLimiterMock: vi.fn(async () => ({
    allowed: true,
    remaining: 19,
    resetAt: new Date(Date.now() + 60_000),
  })),
}));

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
  sites: { id: 'sites.id', orgId: 'sites.orgId' },
  auditLogs: {},
}));

// --- Sentry (audit-write failures escalate here) ---
vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
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
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    // Mirror prod: requirePermission is the gate that populates `permissions`.
    // A caller lacking the required grant is rejected with 403. Tests opt into
    // that via `x-deny-permission: <resource>:<action>` (e.g. devices:execute).
    const denied = c.req.header('x-deny-permission');
    if (denied && denied === `${resource}:${action}`) {
      return c.json({ error: 'Insufficient permissions' }, 403);
    }
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

vi.mock('../services/rate-limit', () => ({
  rateLimiter: rateLimiterMock,
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '127.0.0.1'),
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
import { captureException } from '../services/sentry';

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

// Audit inserts call `db.insert(auditLogs).values({...})` and await the result
// directly (no `.returning()`). This chain supports BOTH that and the
// `.values().returning()` shape used for the primary row insert, so a single
// mock can stand in for every db.insert call a handler makes.
function makeAuditAwareInsertChain(returningRows: any[]) {
  const values = vi.fn().mockImplementation(() => {
    const p: any = Promise.resolve(undefined);
    p.returning = vi.fn().mockResolvedValue(returningRows);
    return p;
  });
  return { values };
}

// Pull the audit-row payload out of the db.insert(...).values(...) calls.
// Returns every values() arg whose object carries an `action` field.
function auditCalls(insertMock: any): any[] {
  const calls: any[] = [];
  const seen = new Set<any>();
  for (const result of insertMock.mock.results) {
    const chain = result.value;
    if (!chain?.values?.mock || seen.has(chain)) continue;
    seen.add(chain);
    for (const call of chain.values.mock.calls) {
      const arg = call[0];
      if (arg && typeof arg === 'object' && 'action' in arg) calls.push(arg);
    }
  }
  return calls;
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
    rateLimiterMock.mockResolvedValue({
      allowed: true,
      remaining: 19,
      resetAt: new Date(Date.now() + 60_000),
    });
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

  it('rate limits VNC exchange attempts before consuming the code', async () => {
    rateLimiterMock.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });

    const res = await app.request('/vnc-exchange/valid-code', { method: 'POST' });

    expect(res.status).toBe(429);
    expect(consumeVncConnectCode).not.toHaveBeenCalled();
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
    // Two values() calls now: the rule insert (first) + the additive audit_logs
    // write. The first carries the resolved org.
    expect(valuesSpy).toHaveBeenCalledTimes(2);
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

  it('GET /allowlist binds the RESOLVED org (not the null JWT org) into the WHERE clause', async () => {
    // drizzle-orm is unmocked and schema columns are mocked as strings, so the
    // org value is inlined as a raw chunk — JSON of the WHERE node contains it.
    // This proves the route filters by the resolved ORG_A, not auth.orgId (null
    // for partners), which a status-only assertion can't distinguish.
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
    expect(where).toHaveBeenCalledTimes(1);
    const whereSql = JSON.stringify(where.mock.calls[0]![0]);
    expect(whereSql).toContain(ORG_A);
  });

  it('POST /allowlist rejects an ORG-scope caller passing a foreign ?orgId= (403)', async () => {
    // Regression guard for resolveOrgId's org-scope branch: an org-scoped user
    // must not be able to redirect a write into another org via the query param.
    // Default auth mock (no x-test-scope header) is org-scoped to ORG_ID.
    rigInsertCapture({ id: RULE_ID });

    const res = await app.request(`/tunnels/allowlist?orgId=${ORG_B}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ruleBody),
    });

    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('POST /allowlist resolves an explicit ?orgId= for a MULTI-org partner (201, binds ORG_A)', async () => {
    // Distinct from the single-org auto-resolve path: a partner managing many
    // orgs picks one in the UI. canAccessOrg must admit it and it must persist.
    const valuesSpy = rigInsertCapture({ id: RULE_ID, orgId: ORG_A, ...ruleBody });

    const res = await app.request(`/tunnels/allowlist?orgId=${ORG_A}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-scope': 'partner',
        'x-test-accessible-orgs': `${ORG_A},${ORG_B}`,
      },
      body: JSON.stringify(ruleBody),
    });

    expect(res.status).toBe(201);
    expect(valuesSpy.mock.calls[0]![0]).toEqual(expect.objectContaining({ orgId: ORG_A }));
  });

  it('PUT /allowlist/:id resolves the org for a partner caller, binding ORG_A (404 when no row)', async () => {
    // PUT got the identical resolveOrgId treatment as POST/GET/DELETE; cover its
    // partner path and prove the existence check filters by the resolved org.
    const existsWhere = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) });
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where: existsWhere }),
    } as any);

    const res = await app.request(`/tunnels/allowlist/${RULE_ID}?orgId=${ORG_A}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-test-scope': 'partner',
        'x-test-accessible-orgs': ORG_A,
      },
      body: JSON.stringify({ pattern: '10.1.2.50/32:80-443' }),
    });

    expect(res.status).toBe(404);
    expect(JSON.stringify(existsWhere.mock.calls[0]![0])).toContain(ORG_A);
  });

  it('PUT /allowlist/:id rejects a partner passing an inaccessible ?orgId= (403)', async () => {
    const res = await app.request(`/tunnels/allowlist/${RULE_ID}?orgId=${ORG_B}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-test-scope': 'partner',
        'x-test-accessible-orgs': ORG_A,
      },
      body: JSON.stringify({ pattern: '10.1.2.50/32:80-443' }),
    });

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
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

// ─── Allowlist mutation routes — RBAC (DEVICES_EXECUTE) + MFA gate ────────────
// Finding #7: the allowlist is consulted by isTargetAllowed() when a proxy
// tunnel opens. A low-privilege same-org user must NOT be able to widen,
// disable, or delete rules — those routes now require DEVICES_EXECUTE + MFA,
// matching POST /tunnels.

describe('Allowlist mutation routes — DEVICES_EXECUTE gate', () => {
  let app: Hono;
  const RULE_ID = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
  const DENY = 'devices:execute';

  const ruleBody = {
    direction: 'destination',
    pattern: '10.0.0.0/8:*',
    description: 'overly broad rule',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    app = new Hono();
    app.route('/tunnels', tunnelRoutes);
  });

  it('POST /allowlist returns 403 when caller lacks DEVICES_EXECUTE', async () => {
    const res = await app.request('/tunnels/allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-deny-permission': DENY },
      body: JSON.stringify(ruleBody),
    });

    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('POST /allowlist succeeds (201) for a caller WITH DEVICES_EXECUTE', async () => {
    vi.mocked(db.insert).mockReturnValue(makeInsertChain([{ id: RULE_ID, orgId: ORG_ID, ...ruleBody }]) as any);

    const res = await app.request('/tunnels/allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ruleBody),
    });

    expect(res.status).toBe(201);
    // Rule insert + additive audit_logs write.
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it('PUT /allowlist/:id returns 403 when caller lacks DEVICES_EXECUTE', async () => {
    const res = await app.request(`/tunnels/allowlist/${RULE_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-deny-permission': DENY },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('PUT /allowlist/:id succeeds for a caller WITH DEVICES_EXECUTE', async () => {
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([{ id: RULE_ID, orgId: ORG_ID }]) as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: RULE_ID, enabled: false }]),
        }),
      }),
    } as any);

    const res = await app.request(`/tunnels/allowlist/${RULE_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('DELETE /allowlist/:id returns 403 when caller lacks DEVICES_EXECUTE', async () => {
    const res = await app.request(`/tunnels/allowlist/${RULE_ID}`, {
      method: 'DELETE',
      headers: { 'x-deny-permission': DENY },
    });

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('DELETE /allowlist/:id succeeds for a caller WITH DEVICES_EXECUTE', async () => {
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([{ id: RULE_ID, orgId: ORG_ID }]) as any);
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as any);

    const res = await app.request(`/tunnels/allowlist/${RULE_ID}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});

// ─── POST /allowlist — siteId cross-org validation ───────────────────────────
// Secondary hardening for Finding #7: a body.siteId is an arbitrary uuid until
// proven to belong to the resolved org. A site from another org is rejected
// before any rule is inserted.

describe('POST /allowlist — siteId belongs-to-org validation', () => {
  let app: Hono;
  const RULE_ID = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
  const SITE_IN_ORG = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0';
  const FOREIGN_SITE = 'c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c9c9c9';

  const baseBody = {
    direction: 'destination',
    pattern: '10.1.2.50/32:80-443',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    app = new Hono();
    app.route('/tunnels', tunnelRoutes);
  });

  it('rejects a siteId that does not belong to the resolved org (404, no insert)', async () => {
    // siteBelongsToOrg select returns no rows → site not in this org.
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([]) as any);

    const res = await app.request('/tunnels/allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseBody, siteId: FOREIGN_SITE }),
    });

    expect(res.status).toBe(404);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('accepts a siteId that belongs to the resolved org (201)', async () => {
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([{ id: SITE_IN_ORG }]) as any);
    vi.mocked(db.insert).mockReturnValue(makeInsertChain([{ id: RULE_ID, orgId: ORG_ID, siteId: SITE_IN_ORG }]) as any);

    const res = await app.request('/tunnels/allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseBody, siteId: SITE_IN_ORG }),
    });

    expect(res.status).toBe(201);
    // Rule insert + additive audit_logs write.
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it('skips the site lookup entirely when no siteId is provided (201)', async () => {
    vi.mocked(db.insert).mockReturnValue(makeInsertChain([{ id: RULE_ID, orgId: ORG_ID }]) as any);

    const res = await app.request('/tunnels/allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseBody),
    });

    expect(res.status).toBe(201);
    expect(db.select).not.toHaveBeenCalled();
    // Rule insert + additive audit_logs write.
    expect(db.insert).toHaveBeenCalledTimes(2);
  });
});

// ─── Audit logging on mutating tunnel endpoints (Finding R1) ─────────────────
// Every mutating tunnel handler must write an audit_logs row so tunnel opens,
// closes, and allowlist changes are attributable. Sibling remote/sessions.ts
// audits its lifecycle via logSessionAudit; tunnels.ts did not.

describe('Audit logging — mutating tunnel endpoints', () => {
  let app: Hono;
  const RULE_ID = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    app = new Hono();
    app.route('/tunnels', tunnelRoutes);
  });

  it('POST /tunnels writes a tunnel.open audit row with actor/resource/details', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([onlineDevice]) as any) // device lookup
      .mockReturnValueOnce(makeSelectChain([]) as any);            // source-IP allowlist
    const insertMock = vi.fn().mockReturnValue(makeAuditAwareInsertChain([sessionRecord]));
    vi.mocked(db.insert).mockImplementation(insertMock as any);

    const res = await app.request('/tunnels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID, type: 'vnc' }),
    });

    expect(res.status).toBe(201);
    const audits = auditCalls(insertMock);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(expect.objectContaining({
      action: 'tunnel.open',
      resourceType: 'tunnel_session',
      resourceId: SESSION_ID,
      orgId: ORG_ID,
      actorId: USER_ID,
      result: 'success',
    }));
    expect(audits[0].details).toEqual(expect.objectContaining({
      deviceId: DEVICE_ID,
      type: 'vnc',
    }));
  });

  it('DELETE /tunnels/:id writes a tunnel.close audit row including the closed session owner', async () => {
    const otherOwnerSession = { ...sessionRecord, userId: 'owner-9999' };
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([otherOwnerSession]) as any) // session lookup
      .mockReturnValueOnce(makeSelectChain([onlineDevice]) as any);     // device lookup
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    const insertMock = vi.fn().mockReturnValue(makeAuditAwareInsertChain([]));
    vi.mocked(db.insert).mockImplementation(insertMock as any);

    const res = await app.request(`/tunnels/${SESSION_ID}`, {
      method: 'DELETE',
      headers: { 'x-test-scope': 'partner', 'x-test-accessible-orgs': ORG_ID },
    });

    expect(res.status).toBe(200);
    const audits = auditCalls(insertMock);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(expect.objectContaining({
      action: 'tunnel.close',
      resourceType: 'tunnel_session',
      resourceId: SESSION_ID,
      actorId: USER_ID,
    }));
    // The session owner must be attributable when a partner tears down someone
    // else's tunnel.
    expect(audits[0].details).toEqual(expect.objectContaining({ sessionUserId: 'owner-9999' }));
  });

  it('POST /allowlist writes a tunnel.allowlist.create audit row with the rule', async () => {
    const insertMock = vi.fn().mockReturnValue(
      makeAuditAwareInsertChain([{ id: RULE_ID, orgId: ORG_ID }])
    );
    vi.mocked(db.insert).mockImplementation(insertMock as any);

    const res = await app.request('/tunnels/allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction: 'destination', pattern: '10.0.0.0/8:*' }),
    });

    expect(res.status).toBe(201);
    const audits = auditCalls(insertMock);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(expect.objectContaining({
      action: 'tunnel.allowlist.create',
      resourceType: 'tunnel_allowlist',
      resourceId: RULE_ID,
      actorId: USER_ID,
    }));
    expect(audits[0].details).toEqual(expect.objectContaining({
      direction: 'destination',
      pattern: '10.0.0.0/8:*',
    }));
  });

  it('PUT /allowlist/:id writes a tunnel.allowlist.update audit row', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      makeSelectChain([{ id: RULE_ID, orgId: ORG_ID, pattern: '10.0.0.0/8:*' }]) as any
    );
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: RULE_ID, pattern: '192.168.0.0/16:*' }]),
        }),
      }),
    } as any);
    const insertMock = vi.fn().mockReturnValue(makeAuditAwareInsertChain([]));
    vi.mocked(db.insert).mockImplementation(insertMock as any);

    const res = await app.request(`/tunnels/allowlist/${RULE_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: '192.168.0.0/16:*' }),
    });

    expect(res.status).toBe(200);
    const audits = auditCalls(insertMock);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(expect.objectContaining({
      action: 'tunnel.allowlist.update',
      resourceType: 'tunnel_allowlist',
      resourceId: RULE_ID,
      actorId: USER_ID,
    }));
  });

  it('DELETE /allowlist/:id writes a tunnel.allowlist.delete audit row', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      makeSelectChain([{ id: RULE_ID, orgId: ORG_ID, direction: 'destination', pattern: '10.0.0.0/8:*' }]) as any
    );
    vi.mocked(db.delete).mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) } as any);
    const insertMock = vi.fn().mockReturnValue(makeAuditAwareInsertChain([]));
    vi.mocked(db.insert).mockImplementation(insertMock as any);

    const res = await app.request(`/tunnels/allowlist/${RULE_ID}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    const audits = auditCalls(insertMock);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(expect.objectContaining({
      action: 'tunnel.allowlist.delete',
      resourceType: 'tunnel_allowlist',
      resourceId: RULE_ID,
      actorId: USER_ID,
    }));
  });

  it('an audit-insert failure escalates to captureException without failing the operation', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([onlineDevice]) as any)
      .mockReturnValueOnce(makeSelectChain([]) as any);
    // Primary session insert succeeds; the audit insert throws.
    let call = 0;
    vi.mocked(db.insert).mockImplementation((() => {
      call += 1;
      if (call === 1) return makeInsertChain([sessionRecord]) as any;
      return { values: vi.fn().mockImplementation(() => { throw new Error('audit boom'); }) } as any;
    }) as any);

    const res = await app.request('/tunnels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID, type: 'vnc' }),
    });

    // Primary operation still succeeds.
    expect(res.status).toBe(201);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

// ─── Audit logging on credential-minting tunnel endpoints (Finding R1b) ──────
// The three credential-mint / redeem handlers issue the actual access
// credentials (viewer WS ticket, VNC connect code, and the code redemption
// that hands back a viewer access token + ws-ticket). These are the most
// security-relevant tunnel events and must be attributable in audit_logs.

describe('Audit logging — credential-minting tunnel endpoints', () => {
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
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    rateLimiterMock.mockResolvedValue({
      allowed: true,
      remaining: 19,
      resetAt: new Date(Date.now() + 60_000),
    });
    app = new Hono();
    app.route('/tunnels', tunnelRoutes);
    app.route('/vnc-exchange', vncExchangeRoutes);
    app.route('/vnc-viewer', vncViewerRoutes);
  });

  it('POST /:id/ws-ticket writes a tunnel.ws_ticket.mint audit row', async () => {
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([sessionRecord]) as any);
    const insertMock = vi.fn().mockReturnValue(makeAuditAwareInsertChain([]));
    vi.mocked(db.insert).mockImplementation(insertMock as any);

    const res = await app.request(`/tunnels/${SESSION_ID}/ws-ticket`, { method: 'POST' });

    expect(res.status).toBe(200);
    const audits = auditCalls(insertMock);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(expect.objectContaining({
      action: 'tunnel.ws_ticket.mint',
      resourceType: 'tunnel_session',
      resourceId: SESSION_ID,
      orgId: ORG_ID,
      actorId: USER_ID,
      result: 'success',
    }));
    expect(audits[0].details).toEqual(expect.objectContaining({ deviceId: DEVICE_ID }));
  });

  it('POST /:id/connect-code writes a tunnel.connect_code.mint audit row', async () => {
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([sessionRecord]) as any);
    const insertMock = vi.fn().mockReturnValue(makeAuditAwareInsertChain([]));
    vi.mocked(db.insert).mockImplementation(insertMock as any);

    const res = await app.request(`/tunnels/${SESSION_ID}/connect-code`, { method: 'POST' });

    expect(res.status).toBe(200);
    const audits = auditCalls(insertMock);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(expect.objectContaining({
      action: 'tunnel.connect_code.mint',
      resourceType: 'tunnel_session',
      resourceId: SESSION_ID,
      orgId: ORG_ID,
      actorId: USER_ID,
      result: 'success',
    }));
    expect(audits[0].details).toEqual(expect.objectContaining({ deviceId: DEVICE_ID }));
  });

  it('POST /vnc-exchange/:code writes a tunnel.vnc_exchange.redeem audit row attributed to the code owner', async () => {
    vi.mocked(consumeVncConnectCode).mockResolvedValueOnce(vncCodeRecord);
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([sessionRecord]) as any);
    vi.mocked(createViewerAccessToken).mockResolvedValueOnce('viewer-token-xyz');
    const insertMock = vi.fn().mockReturnValue(makeAuditAwareInsertChain([]));
    vi.mocked(db.insert).mockImplementation(insertMock as any);

    const res = await app.request('/vnc-exchange/valid-code', { method: 'POST' });

    expect(res.status).toBe(200);
    const audits = auditCalls(insertMock);
    expect(audits).toHaveLength(1);
    // No bearer auth on this route — the actor is the code-bound userId.
    expect(audits[0]).toEqual(expect.objectContaining({
      action: 'tunnel.vnc_exchange.redeem',
      resourceType: 'tunnel_session',
      resourceId: SESSION_ID,
      orgId: ORG_ID,
      actorId: USER_ID,
      result: 'success',
    }));
    expect(audits[0].details).toEqual(expect.objectContaining({ deviceId: DEVICE_ID }));
  });

  it('POST /vnc-viewer/upgrade-to-webrtc writes a tunnel.upgrade_webrtc audit row attributed to the tunnel owner', async () => {
    const NEW_SESSION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    vi.mocked(verifyViewerAccessToken).mockResolvedValueOnce({
      sub: USER_ID,
      email: 'test@example.com',
      sessionId: SESSION_ID,
      purpose: 'viewer',
      jti: 'viewer-jti-up',
    });
    vi.mocked(db.select).mockReturnValueOnce(makeJoinedSelectChain([{
      tunnelUserId: USER_ID,
      tunnelOrgId: ORG_ID,
      deviceId: DEVICE_ID,
      tunnelType: 'vnc',
      tunnelStatus: 'pending',
      deviceStatus: 'online',
      agentId: 'agent-abc',
      userEmail: 'test@example.com',
    }]) as any);
    // db.update (terminate stragglers) then db.insert (new desktop session)
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    const insertMock = vi.fn().mockReturnValue(makeAuditAwareInsertChain([{ id: NEW_SESSION_ID }]));
    vi.mocked(db.insert).mockImplementation(insertMock as any);
    vi.mocked(createViewerAccessToken).mockResolvedValueOnce('viewer-token-up');

    const res = await app.request('/vnc-viewer/upgrade-to-webrtc', {
      method: 'POST',
      headers: { Authorization: 'Bearer viewer-token' },
    });

    expect(res.status).toBe(200);
    const audits = auditCalls(insertMock);
    expect(audits).toHaveLength(1);
    // Viewer-token auth — actor is the tunnel-bound owner, not a JWT subject.
    expect(audits[0]).toEqual(expect.objectContaining({
      action: 'tunnel.upgrade_webrtc',
      resourceType: 'tunnel_session',
      resourceId: NEW_SESSION_ID,
      orgId: ORG_ID,
      actorId: USER_ID,
      result: 'success',
    }));
    expect(audits[0].details).toEqual(expect.objectContaining({ deviceId: DEVICE_ID, type: 'desktop' }));
  });

  it('POST /vnc-viewer/downgrade-to-vnc writes a tunnel.open audit row for the newly created tunnel', async () => {
    const NEW_TUNNEL_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    vi.mocked(verifyViewerAccessToken).mockResolvedValueOnce({
      sub: USER_ID,
      email: 'test@example.com',
      sessionId: SESSION_ID,
      purpose: 'viewer',
      jti: 'viewer-jti-down',
    });
    vi.mocked(db.select).mockReturnValueOnce(makeJoinedSelectChain([{
      userId: USER_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      deviceStatus: 'online',
      agentId: 'agent-abc',
      userEmail: 'test@example.com',
    }]) as any);
    const insertMock = vi.fn().mockReturnValue(makeAuditAwareInsertChain([{ id: NEW_TUNNEL_ID }]));
    vi.mocked(db.insert).mockImplementation(insertMock as any);
    vi.mocked(createViewerAccessToken).mockResolvedValueOnce('viewer-token-down');

    const res = await app.request('/vnc-viewer/downgrade-to-vnc', {
      method: 'POST',
      headers: { Authorization: 'Bearer viewer-token' },
    });

    expect(res.status).toBe(200);
    const audits = auditCalls(insertMock);
    expect(audits).toHaveLength(1);
    // New tunnel created under viewer-token auth — actor is the session-bound owner.
    expect(audits[0]).toEqual(expect.objectContaining({
      action: 'tunnel.open',
      resourceType: 'tunnel_session',
      resourceId: NEW_TUNNEL_ID,
      orgId: ORG_ID,
      actorId: USER_ID,
      result: 'success',
    }));
    expect(audits[0].details).toEqual(expect.objectContaining({ deviceId: DEVICE_ID, type: 'vnc', via: 'downgrade_vnc' }));
  });
});
