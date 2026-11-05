import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { authorizeLiveRemoteSessionAccessMock, findEpisode, tx, context } = vi.hoisted(() => ({
  findEpisode: vi.fn(), tx: { marker: 'system transaction' }, context: { system: false },
  authorizeLiveRemoteSessionAccessMock: vi.fn(),
}));

// -------------------------------------------------------------------
// Mocks — must be declared before any import that triggers the modules.
// Shapes mirror desktopWs_lifecycle.test.ts so module resolution matches.
// -------------------------------------------------------------------

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    context.system = true;
    try { return await fn(); } finally { context.system = false; }
  }),
  db: {
    transaction: vi.fn(async (fn: (handle: typeof tx) => unknown) => {
      expect(context.system).toBe(true);
      return fn(tx);
    }),
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
  // remoteDesktopStartIntent.ts (real impl, not mocked in this file) throws
  // unless this reports an open db access context.
  hasDbAccessContext: vi.fn(() => true),
}));

vi.mock('../db/schema', () => ({
  remoteSessions: {
    id: 'remoteSessions.id',
    deviceId: 'remoteSessions.deviceId',
    status: 'remoteSessions.status',
    userId: 'remoteSessions.userId',
    desktopStartCommandId: 'remoteSessions.desktopStartCommandId',
    desktopPromptMode: 'remoteSessions.desktopPromptMode',
    desktopStartGeneration: 'remoteSessions.desktopStartGeneration',
    terminalGeneration: 'remoteSessions.terminalGeneration',
    terminationPhase: 'remoteSessions.terminationPhase',
    type: 'remoteSessions.type',
    iceCandidates: 'remoteSessions.iceCandidates',
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
  sendDesktopIceCandidateToAgent: vi.fn(() => true),
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

vi.mock('./remote/helpers', async (importOriginal) => ({
  ...await importOriginal<typeof import('./remote/helpers')>(),
  logSessionAudit: vi.fn(async () => undefined),
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
  getTrustedClientIp: vi.fn(() => '192.0.2.1'),
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

vi.mock('../services/networkIsolation/episodeStore', () => ({ findUnresolvedEpisode: findEpisode }));
vi.mock('../services/remoteDesktopStartIntent', () => ({
  commitDesktopStartIntent: vi.fn(async () => ({ ok: true, generation: 1n })),
  assertDesktopStartIntentCurrent: vi.fn(async () => ({ ok: true })),
  formatDesktopGeneration: (value: bigint) => value.toString(),
  boundConsentUnavailableBehavior: vi.fn(),
}));
import { createDesktopWsRoutes } from './desktopWs';
import { verifyViewerAccessToken } from '../services/jwt';
import { sendCommandToAgent } from './agentWs';
import { prepareRevocationLeaseForStart } from '../services/remoteRevocationLease';
import { commitDesktopStartIntent } from '../services/remoteDesktopStartIntent';

const sessionId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const session = { id: sessionId, deviceId, userId, type: 'desktop', status: 'pending' };
const device = { id: deviceId, agentId: 'agent', orgId: '44444444-4444-4444-8444-444444444444' };
const user = { id: userId, email: 'tech@example.test', status: 'active' };
function request(kind: 'ice-servers' | 'offer', token = true) {
  const app = createDesktopWsRoutes(vi.fn() as never);
  return app.request(`/${sessionId}/viewer/${kind}`, {
    method: kind === 'offer' ? 'POST' : 'GET',
    headers: { ...(token ? { Authorization: 'Bearer viewer' } : {}), 'content-type': 'application/json' },
    ...(kind === 'offer' ? { body: JSON.stringify({ offer: { type: 'offer', sdp: 'v=0' } }) } : {}),
  });
}
async function iceResult(kind: 'ice-servers' | 'offer') {
  const response = await request(kind);
  expect(response.status).toBe(200);
  if (kind === 'ice-servers') return response.json();
  expect(sendCommandToAgent).toHaveBeenCalledTimes(1);
  return vi.mocked(sendCommandToAgent).mock.calls[0]![1].payload!;
}
describe('viewer relay-only desktop admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findEpisode.mockResolvedValue(null);
    vi.stubEnv('TURN_HOST', 'relay.example.test');
    vi.stubEnv('TURN_SECRET', 'secret');
    vi.stubEnv('TURN_TLS_HOST', '');
    vi.mocked(verifyViewerAccessToken).mockResolvedValue({ sub: userId, email: user.email, sessionId, jti: 'token' } as never);
    authorizeLiveRemoteSessionAccessMock.mockResolvedValue({ ok: true, session, device, user });
  });
  afterEach(() => vi.unstubAllEnvs());

  for (const kind of ['ice-servers', 'offer'] as const) {
    describe(kind, () => {
      it.each(['applying', 'applied', 'verified', 'release_requested', 'future_state_from_a_newer_api'])('enforces TURN-only for %s', async (state) => {
        findEpisode.mockResolvedValue({ state, remoteRelay: true });
        const result = await iceResult(kind);
        expect(result.relayOnly).toBe(true);
        expect(result.iceServers).toEqual([{ urls: [
          'turn:relay.example.test:3478?transport=udp', 'turn:relay.example.test:3478?transport=tcp',
        ], username: expect.any(String), credential: expect.any(String) }]);
        expect(findEpisode).toHaveBeenCalledWith(tx, deviceId);
      });
      it.each([null, 'released', 'expired'])('preserves the wire format with episode state %s', async (state) => {
        findEpisode.mockResolvedValue(state ? { state, remoteRelay: false } : null);
        const result = await iceResult(kind);
        expect(result).not.toHaveProperty('relayOnly');
        expect(result.iceServers).toEqual([
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: ['turn:relay.example.test:3478?transport=udp', 'turn:relay.example.test:3478?transport=tcp'], username: expect.any(String), credential: expect.any(String) },
        ]);
        if (kind === 'ice-servers') expect(Object.keys(result)).toEqual(['iceServers']);
      });
      it.each([
        [false, true, 'isolation_relay_not_permitted', 'Remote desktop over WebRTC is unavailable: this device was isolated without permitting the TURN relay'],
        [true, false, 'isolation_relay_unavailable', 'Remote desktop needs the TURN relay while this device is isolated'],
      ] as const)('refuses remoteRelay=%s TURN=%s before start side effects', async (remoteRelay, turn, code, error) => {
        findEpisode.mockResolvedValue({ state: 'applied', remoteRelay });
        if (!turn) vi.stubEnv('TURN_HOST', '');
        const response = await request(kind);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ code, error });
        expect(sendCommandToAgent).not.toHaveBeenCalled();
        expect(prepareRevocationLeaseForStart).not.toHaveBeenCalled();
        expect(commitDesktopStartIntent).not.toHaveBeenCalled();
      });
      it('fails closed on database errors before start side effects', async () => {
        findEpisode.mockRejectedValueOnce(new Error('database unavailable'));
        expect((await request(kind)).status).toBe(500);
        expect(sendCommandToAgent).not.toHaveBeenCalled();
        expect(prepareRevocationLeaseForStart).not.toHaveBeenCalled();
        expect(commitDesktopStartIntent).not.toHaveBeenCalled();
      });
      it('retains unauthenticated denial before resolving isolation', async () => {
        expect((await request(kind, false)).status).toBe(401);
        expect(findEpisode).not.toHaveBeenCalled();
      });
      it('retains org/capability denial before resolving isolation', async () => {
        authorizeLiveRemoteSessionAccessMock.mockResolvedValue({ ok: false, reason: 'policy_denied', status: 403 });
        expect((await request(kind)).status).toBe(403);
        expect(findEpisode).not.toHaveBeenCalled();
      });
    });
  }
});
