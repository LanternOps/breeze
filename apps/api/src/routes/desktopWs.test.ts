import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// -------------------------------------------------------------------
// Mocks — must be declared before any import that triggers the modules.
// Shapes mirror desktopWs_lifecycle.test.ts so module resolution matches.
// -------------------------------------------------------------------

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  remoteSessions: { id: 'remoteSessions.id', deviceId: 'remoteSessions.deviceId', status: 'remoteSessions.status', userId: 'remoteSessions.userId' },
  devices: { id: 'devices.id' },
  users: { id: 'users.id', status: 'users.status' },
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
}));

vi.mock('../services/remoteSessionAuth', () => ({
  consumeWsTicket: vi.fn(),
  consumeDesktopConnectCode: vi.fn(),
  createWsTicket: vi.fn(async () => ({ ticket: 'tkt' })),
  getViewerAccessTokenExpirySeconds: vi.fn(() => 900),
}));

vi.mock('../services/jwt', () => ({
  createAccessToken: vi.fn(async () => 'mock-access-token-xyz'),
  createViewerAccessToken: vi.fn(async () => 'mock-viewer-token'),
  verifyViewerAccessToken: vi.fn(),
}));

vi.mock('../services/viewerTokenRevocation', () => ({
  isViewerJtiRevoked: vi.fn(async () => false),
  isViewerSessionRevoked: vi.fn(async () => false),
  revokeViewerSession: vi.fn(async () => undefined),
}));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true),
  isAgentConnected: vi.fn(() => true),
}));

vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
  resolveDesktopSessionPolicy: vi.fn().mockResolvedValue({
    clipboard: 'both',
    idleTimeoutMinutes: 5,
    maxSessionDurationHours: 8,
  }),
}));

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({
    allowed: true,
    remaining: 9,
    resetAt: new Date(Date.now() + 60_000),
  })),
}));

vi.mock('./remote/helpers', () => ({
  logSessionAudit: vi.fn(async () => undefined),
  getIceServers: vi.fn(() => []),
}));

// Permissive offer schema so zValidator('json', webrtcOfferSchema) passes and
// the route receives { offer, displayIndex?, targetSessionId? }.
vi.mock('./remote/schemas', () => ({
  webrtcOfferSchema: z.object({
    offer: z.any(),
    displayIndex: z.number().optional(),
    targetSessionId: z.string().optional(),
  }).passthrough(),
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------
import { db } from '../db';
import { verifyViewerAccessToken } from '../services/jwt';
import { isViewerJtiRevoked, isViewerSessionRevoked } from '../services/viewerTokenRevocation';
import { sendCommandToAgent } from './agentWs';
import { checkRemoteAccess, resolveDesktopSessionPolicy } from '../services/remoteAccessPolicy';
import { createDesktopWsRoutes } from './desktopWs';

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

// desktopSessionIdParamSchema requires a UUID id.
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = 'device-xyz';
const AGENT_ID = 'agent-xyz';
const USER_ID = 'user-1';
const USER_EMAIL = 'op@example.com';

const VALID_PAYLOAD = {
  sub: USER_ID,
  email: USER_EMAIL,
  sessionId: SESSION_ID,
  jti: 'jti-1',
};

function buildApp() {
  const upgradeWebSocket = vi.fn((_factory: unknown) => (_c: unknown, _next: unknown) => {});
  return createDesktopWsRoutes(upgradeWebSocket as never);
}

function offerRequest(token = 'valid.viewer.token') {
  const app = buildApp();
  return app.request(`/${SESSION_ID}/viewer/offer`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ offer: { sdp: 'v=0', type: 'offer' } }),
  });
}

/** Single-row join select used by validateViewerSessionAccess. */
function mockViewerSelect(row: unknown) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(row === undefined ? [] : [row]),
          }),
        }),
      }),
    }),
  } as never);
}

function mockUpdateReturning(updatedRow: unknown) {
  vi.mocked(db.update).mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(updatedRow === undefined ? [] : [updatedRow]),
      }),
    }),
  } as never);
}

const ACTIVE_SESSION = {
  id: SESSION_ID,
  type: 'desktop',
  userId: USER_ID,
  status: 'active',
  deviceId: DEVICE_ID,
};

const DEVICE = {
  id: DEVICE_ID,
  agentId: AGENT_ID,
  hostname: 'host',
  osType: 'windows',
  status: 'online',
  orgId: 'org-1',
};

const USER = { id: USER_ID, email: USER_EMAIL, status: 'active' };

function primeHappyPath() {
  vi.mocked(verifyViewerAccessToken).mockResolvedValue(VALID_PAYLOAD as never);
  vi.mocked(isViewerJtiRevoked).mockResolvedValue(false);
  vi.mocked(isViewerSessionRevoked).mockResolvedValue(false);
  mockViewerSelect({ session: ACTIVE_SESSION, device: DEVICE, user: USER });
  vi.mocked(checkRemoteAccess).mockResolvedValue({ allowed: true } as never);
  vi.mocked(resolveDesktopSessionPolicy).mockResolvedValue({
    clipboard: 'both',
    idleTimeoutMinutes: 5,
    maxSessionDurationHours: 8,
  } as never);
  mockUpdateReturning({ id: SESSION_ID, status: 'connecting', webrtcOffer: { sdp: 'v=0' } });
}

// -------------------------------------------------------------------
// Tests — validateViewerSessionAccess via POST /:id/viewer/offer
// -------------------------------------------------------------------

describe('validateViewerSessionAccess (via /:id/viewer/offer)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- #5: ended session must not resurrect ---------------------------

  it("returns 401 'Session ended' and does NOT resurrect a disconnected session", async () => {
    primeHappyPath();
    mockViewerSelect({ session: { ...ACTIVE_SESSION, status: 'disconnected' }, device: DEVICE, user: USER });

    const res = await offerRequest();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Session ended' });
    expect(db.update).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it("returns 401 'Session ended' and does NOT resurrect a failed session", async () => {
    primeHappyPath();
    mockViewerSelect({ session: { ...ACTIVE_SESSION, status: 'failed' }, device: DEVICE, user: USER });

    const res = await offerRequest();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Session ended' });
    expect(db.update).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  // --- revocation branches -------------------------------------------

  it('returns 401 when the viewer JTI is revoked', async () => {
    primeHappyPath();
    vi.mocked(isViewerJtiRevoked).mockResolvedValue(true);

    const res = await offerRequest();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Viewer token revoked' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('returns 401 when the viewer session is revoked', async () => {
    primeHappyPath();
    vi.mocked(isViewerSessionRevoked).mockResolvedValue(true);

    const res = await offerRequest();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Session closed' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  // --- token / ownership / user state --------------------------------

  it('returns 401 when no Authorization header is present', async () => {
    primeHappyPath();
    const app = buildApp();
    const res = await app.request(`/${SESSION_ID}/viewer/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offer: { sdp: 'v=0' } }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Missing viewer token' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('returns 401 when the viewer token is invalid/expired', async () => {
    primeHappyPath();
    vi.mocked(verifyViewerAccessToken).mockResolvedValue(null as never);

    const res = await offerRequest();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid or expired viewer token' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('returns 404 when the session row does not exist', async () => {
    primeHappyPath();
    mockViewerSelect(undefined);

    const res = await offerRequest();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Session not found' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('returns 403 on owner mismatch (session.userId !== payload.sub)', async () => {
    primeHappyPath();
    mockViewerSelect({
      session: { ...ACTIVE_SESSION, userId: 'someone-else' },
      device: DEVICE,
      user: { ...USER, id: 'someone-else' },
    });

    const res = await offerRequest();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Viewer token does not match session owner' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('returns 403 when the owning user is inactive', async () => {
    primeHappyPath();
    mockViewerSelect({ session: ACTIVE_SESSION, device: DEVICE, user: { ...USER, status: 'suspended' } });

    const res = await offerRequest();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'User not found or inactive' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  // --- #1 (viewer path): remote-access policy gate -------------------

  it('returns 403 and sends NO start_desktop when remote access is denied', async () => {
    primeHappyPath();
    vi.mocked(checkRemoteAccess).mockResolvedValue({
      allowed: false,
      reason: 'Remote desktop is disabled by policy',
    } as never);

    const res = await offerRequest();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Remote desktop is disabled by policy' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    // Policy denial happens during validation, before any session mutation.
    expect(db.update).not.toHaveBeenCalled();
  });

  // --- happy path positive control -----------------------------------

  it('on valid + active + allowed: submits offer and sends start_desktop with the policy payload', async () => {
    primeHappyPath();

    const res = await offerRequest();
    expect(res.status).toBe(200);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(sendCommandToAgent).toHaveBeenCalledTimes(1);

    const [agentId, command] = vi.mocked(sendCommandToAgent).mock.calls[0]!;
    expect(agentId).toBe(AGENT_ID);
    expect(command).toMatchObject({
      type: 'start_desktop',
      payload: expect.objectContaining({
        sessionId: SESSION_ID,
        clipboard: 'both',
        idleTimeoutMinutes: 5,
        maxSessionDurationHours: 8,
      }),
    });
  });
});
