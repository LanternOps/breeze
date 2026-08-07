import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { siteDenied, openContexts, contextLog, dbAccessContextFromAuthMock, PARTNER_AUTH } = vi.hoisted(() => ({
  siteDenied: Symbol('SITE_ACCESS_DENIED'),
  // A partner-scoped caller — the exact shape prod 503'd under (US prod,
  // 2026-08: `withDbAccessContext (scope=partner) held a pooled connection …
  // 10004ms`, i.e. the 10s LIST_SESSIONS_TIMEOUT_MS deadline plus overhead).
  // Hoisted so the `../../middleware/auth` mock factory can close over it.
  PARTNER_AUTH: {
    user: { id: 'user-123' },
    scope: 'partner' as const,
    orgId: null,
    partnerId: 'partner-abc',
    accessibleOrgIds: ['org-123'],
    canAccessOrg: (orgId: string) => orgId === 'org-123',
    orgCondition: () => undefined,
  },
  // Contexts currently OPEN, innermost last. Modelled as a literal stack
  // because that is the real semantics: `runOutsideDbContext` does NOT close an
  // already-open outer transaction (db/index.ts), it only exits the
  // AsyncLocalStorage stores — so an ambient request transaction stays on this
  // stack even while a handler "runs outside" it.
  openContexts: [] as Array<Record<string, unknown>>,
  // Every context ever opened, in order.
  contextLog: [] as Array<Record<string, unknown>>,
  dbAccessContextFromAuthMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  withDbAccessContext: vi.fn(async (ctx: any, fn: any) => {
    openContexts.push(ctx);
    contextLog.push(ctx);
    try {
      return await fn();
    } finally {
      openContexts.pop();
    }
  }),
  withSystemDbAccessContext: vi.fn(async (fn: any) => {
    const ctx = { scope: 'system' };
    openContexts.push(ctx);
    contextLog.push(ctx);
    try {
      return await fn();
    } finally {
      openContexts.pop();
    }
  }),
  // Faithful to the real implementation: exits the ALS stores only. It does not
  // pop `openContexts`, because it does not close the outer transaction.
  runOutsideDbContext: vi.fn((fn: any) => fn()),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', PARTNER_AUTH);
    c.set('permissions', { permissions: [], allowedSiteIds: undefined });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  dbAccessContextFromAuth: dbAccessContextFromAuthMock,
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
}));

vi.mock('../../services/agentCommandAwait', () => ({
  sendCommandToAgentAwaitResult: vi.fn(),
}));

import { withDbAccessContext } from '../../db';
import { getDeviceWithOrgAndSiteCheck } from './helpers';
import { sendCommandToAgentAwaitResult } from '../../services/agentCommandAwait';
import { isSelfManagedDbContextRoute } from '../../middleware/selfManagedDbContextRoutes';
import { parseLiveSessionsStdout, sessionsRoutes } from './sessions';

// What the REAL `dbAccessContextFromAuth` derives for PARTNER_AUTH. The
// derivation itself (buildDbAccessContext) is covered by middleware/auth tests;
// here we only need a distinguishable, correctly-scoped context object.
const PARTNER_DB_CONTEXT = {
  scope: 'partner',
  orgId: null,
  accessibleOrgIds: ['org-123'],
  accessiblePartnerIds: ['partner-abc'],
  userId: 'user-123',
  currentPartnerId: 'partner-abc',
};

const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const LIVE_PATH = `/api/v1/devices/${DEVICE_ID}/sessions/live`;

/**
 * Mirrors `authMiddleware`'s dispatch (middleware/auth.ts): every request is
 * wrapped in a request-long `withDbAccessContext` UNLESS the route is registered
 * as self-managed. Using the REAL predicate is what makes these tests bite — if
 * the route is not registered, the ambient transaction is open for the whole
 * handler, including the 10s agent await.
 */
function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (isSelfManagedDbContextRoute(c.req.method, c.req.path)) {
      return next();
    }
    return withDbAccessContext({ ...PARTNER_DB_CONTEXT, label: 'request' } as any, next as any) as any;
  });
  app.route('/api/v1/devices', sessionsRoutes);
  return app;
}

function liveRequest(app: Hono) {
  return app.request(LIVE_PATH, { headers: { Authorization: 'Bearer token' } });
}

describe('live sessions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses and validates agent stdout', () => {
    const stdout = JSON.stringify({
      sessions: [
        { sessionId: 3, username: 'alice', state: 'active', type: 'rdp', helperConnected: true, idleMinutes: 7 },
        { sessionId: 1, username: 'bob', state: 'disconnected', type: 'rdp', helperConnected: false },
      ],
    });
    const sessions = parseLiveSessionsStdout(stdout);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!).toEqual({ sessionId: 3, username: 'alice', state: 'active', type: 'rdp', helperConnected: true, idleMinutes: 7 });
    expect(sessions[1]!.idleMinutes).toBeNull();
  });

  it('drops malformed entries instead of failing the request', () => {
    const stdout = JSON.stringify({ sessions: [{ sessionId: 99999999, username: 'x' }, { sessionId: 2, username: 'ok', state: 'active', type: 'console' }] });
    const sessions = parseLiveSessionsStdout(stdout);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe(2);
  });

  it('returns [] on unparseable stdout', () => {
    expect(parseLiveSessionsStdout('not-json')).toEqual([]);
    expect(parseLiveSessionsStdout(undefined)).toEqual([]);
  });
});

describe('GET /:id/sessions/live — pool-hold contract (#1105 class)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    openContexts.length = 0;
    contextLog.length = 0;
    dbAccessContextFromAuthMock.mockReturnValue(PARTNER_DB_CONTEXT);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: 'org-123', agentId: 'agent-1' } as never);
    app = buildApp();
  });

  it('is registered as a self-managed-DB-context route, so no request transaction is opened', async () => {
    expect(isSelfManagedDbContextRoute('GET', LIVE_PATH)).toBe(true);

    vi.mocked(sendCommandToAgentAwaitResult).mockResolvedValue({ status: 'completed', stdout: '{"sessions":[]}' });
    await liveRequest(app);

    // The only context opened for the whole request is the handler's own short
    // one — never a request-long wrapper.
    expect(contextLog).toEqual([PARTNER_DB_CONTEXT]);
  });

  it('holds NO DB access context across the up-to-10s agent await', async () => {
    let heldDuringAwait: Array<Record<string, unknown>> | undefined;
    vi.mocked(sendCommandToAgentAwaitResult).mockImplementation(async () => {
      // Snapshot at the exact moment the agent round trip is in flight — this
      // is the window that pinned a pooled connection for the full timeout in
      // prod (logged at 10004ms against the 10s deadline, US prod 2026-08).
      heldDuringAwait = [...openContexts];
      return { status: 'completed', stdout: '{"sessions":[]}' };
    });

    const res = await liveRequest(app);

    expect(res.status).toBe(200);
    expect(sendCommandToAgentAwaitResult).toHaveBeenCalledTimes(1);
    // Equivalent to `hasDbAccessContext() === false` at that instant.
    expect(heldDuringAwait).toEqual([]);
  });

  it('runs the device lookup inside a correctly-scoped (NOT system) context', async () => {
    let contextAtLookup: Array<Record<string, unknown>> | undefined;
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockImplementation(async () => {
      contextAtLookup = [...openContexts];
      return { id: DEVICE_ID, orgId: 'org-123', agentId: 'agent-1' } as never;
    });
    vi.mocked(sendCommandToAgentAwaitResult).mockResolvedValue({ status: 'completed', stdout: '{"sessions":[]}' });

    await liveRequest(app);

    // The tenant read is NOT contextless (that would be a bare-pool read the
    // forced-RLS `breeze_app` role silently 0-rows) …
    expect(contextAtLookup).toHaveLength(1);
    const active = contextAtLookup![0]!;
    // … and NOT widened to system scope, which would be a cross-tenant leak.
    expect(active).toBe(PARTNER_DB_CONTEXT);
    expect(active.scope).toBe('partner');
    expect(active.scope).not.toBe('system');
    expect(active).toMatchObject({
      accessibleOrgIds: ['org-123'],
      accessiblePartnerIds: ['partner-abc'],
      currentPartnerId: 'partner-abc',
      userId: 'user-123',
    });
    // Built from the request's own AuthContext through the single source of
    // truth, so it cannot drift from what authMiddleware would have opened.
    expect(dbAccessContextFromAuthMock).toHaveBeenCalledWith(PARTNER_AUTH);
  });

  it('closes the lookup context before the agent await and opens no other', async () => {
    vi.mocked(sendCommandToAgentAwaitResult).mockResolvedValue({ status: 'completed', stdout: '{"sessions":[]}' });

    await liveRequest(app);

    expect(contextLog).toEqual([PARTNER_DB_CONTEXT]);
    expect(openContexts).toEqual([]);
  });
});

describe('GET /:id/sessions/live — response contract is unchanged', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    openContexts.length = 0;
    contextLog.length = 0;
    dbAccessContextFromAuthMock.mockReturnValue(PARTNER_DB_CONTEXT);
    app = buildApp();
  });

  it('200s with the parsed session list on success', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: 'org-123', agentId: 'agent-1' } as never);
    vi.mocked(sendCommandToAgentAwaitResult).mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ sessions: [{ sessionId: 2, username: 'ok', state: 'active', type: 'console' }] }),
    });

    const res = await liveRequest(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { deviceId: DEVICE_ID, sessions: [{ sessionId: 2, username: 'ok', state: 'active', type: 'console', helperConnected: false, idleMinutes: null }] },
    });
  });

  it('504s when the agent await times out', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: 'org-123', agentId: 'agent-1' } as never);
    vi.mocked(sendCommandToAgentAwaitResult).mockResolvedValue({ status: 'failed', error: 'timeout waiting for agent command result' });

    const res = await liveRequest(app);

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: 'timeout waiting for agent command result' });
  });

  it('502s when the agent is offline', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: 'org-123', agentId: 'agent-1' } as never);
    vi.mocked(sendCommandToAgentAwaitResult).mockResolvedValue({ status: 'failed', error: 'agent offline' });

    const res = await liveRequest(app);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'agent offline' });
  });

  it('404s when the device does not exist', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null);

    const res = await liveRequest(app);

    expect(res.status).toBe(404);
    expect(sendCommandToAgentAwaitResult).not.toHaveBeenCalled();
  });

  it('404s for a device outside the caller tenant (org check rejects → null)', async () => {
    // getDeviceWithOrgAndSiteCheck returns null for BOTH "missing" and
    // "org-scope denied" — a cross-tenant device is indistinguishable from a
    // nonexistent one, by design (no existence oracle).
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null);

    const res = await liveRequest(app);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Device not found' });
    // The tenant check still ran inside a scoped context, not on the bare pool.
    expect(contextLog).toEqual([PARTNER_DB_CONTEXT]);
    expect(sendCommandToAgentAwaitResult).not.toHaveBeenCalled();
  });

  it('403s when the site allowlist excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(siteDenied as never);

    const res = await liveRequest(app);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access to this site denied' });
    expect(sendCommandToAgentAwaitResult).not.toHaveBeenCalled();
  });

  it('409s when the device has no enrolled agent', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: 'org-123', agentId: null } as never);

    const res = await liveRequest(app);

    expect(res.status).toBe(409);
    expect(sendCommandToAgentAwaitResult).not.toHaveBeenCalled();
  });
});
