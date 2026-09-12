import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { authorizeLiveRemoteSessionAccessMock } = vi.hoisted(() => ({
  authorizeLiveRemoteSessionAccessMock: vi.fn(),
}));

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
  remoteSessions: {
    id: 'remoteSessions.id',
    deviceId: 'remoteSessions.deviceId',
    status: 'remoteSessions.status',
    userId: 'remoteSessions.userId',
    desktopStartCommandId: 'remoteSessions.desktopStartCommandId',
    desktopPromptMode: 'remoteSessions.desktopPromptMode',
  },
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
  buildRemoteSessionPromptPayload: vi.fn(async () => undefined),
  createDesktopStartCommandId: vi.fn((sessionId: string) =>
    `desk-start-${sessionId}-22222222-2222-4222-8222-222222222222`
  ),
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

vi.mock('../services/remoteRevocationLease', () => ({
  AGENT_UPGRADE_REQUIRED_CODE: 'agent_upgrade_required',
  AGENT_UPGRADE_REQUIRED_MESSAGE: 'agent update required',
  prepareRevocationLeaseForStart: vi.fn(async () => ({
    ok: true,
    lease: {
      token: 'lease-token',
      expiresAt: 1_000_060_000,
      hardDeadline: 1_000_600_000,
      renewEverySec: 25,
      graceSec: 90,
    },
  })),
  renewRevocationLease: vi.fn(async () => ({
    status: 'renewed',
    expiresAt: 1_000_060_000,
    hardDeadline: 1_000_600_000,
    renewEverySec: 25,
    graceSec: 90,
  })),
}));

vi.mock('../services/remoteWsAuthorization', () => ({
  authorizeConsumedRemoteWsTicket: vi.fn(),
  authorizeLiveRemoteSessionAccess: authorizeLiveRemoteSessionAccessMock,
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
  if (row === undefined) {
    authorizeLiveRemoteSessionAccessMock.mockResolvedValue({ ok: false, status: 404, reason: 'session_missing' });
  } else {
    const live = row as { session: typeof ACTIVE_SESSION; device: typeof DEVICE; user: typeof USER };
    authorizeLiveRemoteSessionAccessMock.mockImplementation(async (_subject, accessMode = 'live') => {
      const session = live.session as typeof ACTIVE_SESSION & { errorMessage?: string | null };
      const readingFailure = accessMode === 'failure-diagnostics' &&
        (session.status === 'failed' || (session.status === 'disconnected' && !!session.errorMessage));
      const reason = live.user.status !== 'active' ? 'user_inactive'
        : live.session.userId !== USER_ID ? 'session_not_owned'
          : live.session.type !== 'desktop' ? 'session_missing'
            : ['disconnected', 'failed'].includes(live.session.status) && !readingFailure ? 'session_inactive' : null;
      if (reason) return { ok: false, status: reason === 'session_missing' ? 404 : 403, reason };
      const policy = await checkRemoteAccess(live.device.id, 'webrtcDesktop');
      return policy.allowed ? { ok: true, ...live } : { ok: false, status: 403, reason: 'policy_denied' };
    });
  }
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
    authorizeLiveRemoteSessionAccessMock.mockResolvedValue({ ok: false, status: 403, reason: 'policy_denied' });

    const res = await offerRequest();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Remote desktop is disabled by policy' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    // Policy denial happens during validation, before any session mutation.
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([
    ['site_denied', 'Access to this site denied'],
    ['permission_denied', 'Remote access permission denied'],
  ] as const)('returns 403 for live %s and performs no offer side effects', async (reason, error) => {
    primeHappyPath();
    authorizeLiveRemoteSessionAccessMock.mockResolvedValue({ ok: false, status: 403, reason });

    const res = await offerRequest();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error });
    expect(db.update).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('rejects a signed viewer email that no longer matches the live user', async () => {
    primeHappyPath();
    authorizeLiveRemoteSessionAccessMock.mockResolvedValue({
      ok: true,
      session: ACTIVE_SESSION,
      device: DEVICE,
      user: { ...USER, email: 'renamed@example.com' },
    });

    const res = await offerRequest();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Viewer token does not match session owner' });
    expect(db.update).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  // --- happy path positive control -----------------------------------

  it('ships the consent/banner prompt block in the viewer-token start_desktop payload', async () => {
    primeHappyPath();
    const { buildRemoteSessionPromptPayload } = await import('./remote/helpers');
    const prompt = {
      mode: 'notify',
      technicianName: 'Billy Tech',
      technicianEmail: null,
      orgName: 'Olive Technology',
      consentUnavailableBehavior: 'proceed',
      consentTimeoutMs: 30000,
      notifyOnEnd: true,
      showIndicator: true,
    };
    vi.mocked(buildRemoteSessionPromptPayload).mockResolvedValueOnce(prompt);

    const res = await offerRequest();
    expect(res.status).toBe(200);

    const [, command] = vi.mocked(sendCommandToAgent).mock.calls[0]!;
    // Regression: the viewer-token WS path used to ship NO prompt block at
    // all, so the agent never showed the session notice or on-screen banner.
    expect((command as { payload: Record<string, unknown> }).payload.prompt).toEqual(prompt);
  });

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


// A failed capture revokes the session before the viewer polls its result.
// Only this read-only endpoint may retrieve that diagnostic (#4162).
describe('GET /:id/viewer/session failure diagnostics', () => {
  const errorMessage = 'no display attached — open the lid or attach an external display';
  const failedSession = { ...ACTIVE_SESSION, status: 'failed', errorMessage, webrtcAnswer: 'v=0 stale-answer' };
  const request = () => buildApp().request(`/${SESSION_ID}/viewer/session`, {
    headers: { Authorization: 'Bearer valid.viewer.token' },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    primeHappyPath();
    vi.mocked(isViewerSessionRevoked).mockResolvedValue(true);
    mockViewerSelect({ session: failedSession, device: DEVICE, user: USER });
  });

  it.each([true, false])('returns the capture diagnosis with session revocation=%s', async (revoked) => {
    vi.mocked(isViewerSessionRevoked).mockResolvedValue(revoked);
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: SESSION_ID, status: 'failed', errorMessage, webrtcAnswer: null });
    expect(checkRemoteAccess).toHaveBeenCalledWith(DEVICE_ID, 'webrtcDesktop');
    expect(db.update).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  // 'disconnected' is deliberately excluded here (see the two #5300 tests
  // below): a 'disconnected' session WITH a recorded errorMessage is now the
  // mid-session counterpart to 'failed' and must return the diagnosis too —
  // only a 'disconnected' session with NO recorded reason still rejects.
  it.each(['pending', 'connecting', 'active', 'denied'])('still rejects a revoked %s session', async (status) => {
    mockViewerSelect({ session: { ...failedSession, status }, device: DEVICE, user: USER });
    const res = await request();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Session closed' });
  });

  // #5300: the no-video watchdog's swallowed capture error reaches
  // remote_sessions.errorMessage via the peer-disconnect command_result
  // (agentWs.desktop.peerDisconnected), landing the session in 'disconnected'
  // — not 'failed'. Extends the same failure-diagnostics exception above so a
  // mid-session capture failure is shown the same way a failed start already
  // is (#5284/#5295).
  it('returns the capture diagnosis for a disconnected session carrying a #5300 stop reason', async () => {
    mockViewerSelect({ session: { ...failedSession, status: 'disconnected' }, device: DEVICE, user: USER });
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: SESSION_ID, status: 'disconnected', errorMessage, webrtcAnswer: null });
    expect(db.update).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('preserves the negotiated answer for an authorized active status response', async () => {
    vi.mocked(isViewerSessionRevoked).mockResolvedValue(false);
    mockViewerSelect({ session: { ...failedSession, status: 'active', errorMessage: null }, device: DEVICE, user: USER });
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'active', webrtcAnswer: 'v=0 stale-answer' });
    expect(db.update).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('still rejects a revoked disconnected session with no recorded reason', async () => {
    mockViewerSelect({
      session: { ...failedSession, status: 'disconnected', errorMessage: null },
      device: DEVICE,
      user: USER,
    });
    const res = await request();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Session closed' });
  });

  // The gate is "any recorded errorMessage on a disconnected row", not
  // "a #5300 reason specifically" (see the comment above readingFailure) —
  // staleCommandReaper.ts's reapStaleRemoteSessions also writes errorMessage
  // on a 'disconnected' transition for its own routine timeouts. Documented
  // here as accepted, not a regression: the reaper's text is benign/user-safe
  // and this still never grants live access.
  it('also returns a reaper-written timeout reason on a disconnected session', async () => {
    mockViewerSelect({
      session: {
        ...failedSession,
        status: 'disconnected',
        errorMessage: 'Session timed out: exceeded maximum session duration',
      },
      device: DEVICE,
      user: USER,
    });
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: SESSION_ID,
      status: 'disconnected',
      errorMessage: 'Session timed out: exceeded maximum session duration',
    });
  });

  it.each([
    ['offer', 'POST'], ['ws-ticket', 'POST'], ['ice-servers', 'GET'],
  ])('does not grant live access to %s', async (route, method) => {
    const res = route === 'offer' ? await offerRequest() : await buildApp().request(`/${SESSION_ID}/viewer/${route}`, {
      method, headers: { Authorization: 'Bearer valid.viewer.token' },
    });
    expect(res.status).toBe(401);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('rejects missing authentication', async () => {
    expect((await buildApp().request(`/${SESSION_ID}/viewer/session`)).status).toBe(401);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects expired or invalid tokens', async () => {
    vi.mocked(verifyViewerAccessToken).mockResolvedValue(null);
    expect((await request()).status).toBe(401);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('honors individual token revocation even for failure diagnostics', async () => {
    vi.mocked(isViewerJtiRevoked).mockResolvedValue(true);
    expect((await request()).status).toBe(401);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects a token bound to another session', async () => {
    vi.mocked(verifyViewerAccessToken).mockResolvedValue({ ...VALID_PAYLOAD, sessionId: '22222222-2222-4222-8222-222222222222' } as never);
    expect((await request()).status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('does not expose another tenant owner’s failure', async () => {
    mockViewerSelect({
      session: { ...failedSession, userId: 'another-user' },
      device: { ...DEVICE, orgId: '22222222-2222-4222-8222-222222222222' },
      user: { ...USER, id: 'another-user' },
    });
    const res = await request();
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty('errorMessage');
  });

  it('rejects inactive owners', async () => {
    mockViewerSelect({ session: failedSession, device: DEVICE, user: { ...USER, status: 'disabled' } });
    expect((await request()).status).toBe(403);
  });

  it('rechecks device access policy', async () => {
    vi.mocked(checkRemoteAccess).mockResolvedValue({ allowed: false, reason: 'Disabled by policy' });
    const res = await request();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Remote desktop is disabled by policy' });
  });

  it('rejects a missing session', async () => {
    mockViewerSelect(undefined);
    expect((await request()).status).toBe(404);
  });

  it('rejects non-desktop sessions', async () => {
    mockViewerSelect({ session: { ...failedSession, type: 'terminal' }, device: DEVICE, user: USER });
    expect((await request()).status).toBe(404);
  });
});
