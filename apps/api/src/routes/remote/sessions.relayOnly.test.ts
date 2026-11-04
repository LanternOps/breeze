import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type MiddlewareHandler } from 'hono';

const mocks = vi.hoisted(() => ({
  findUnresolvedEpisode: vi.fn(),
  getSessionWithOrgCheck: vi.fn(),
  hasSessionOwnership: vi.fn(),
  checkRemoteAccess: vi.fn(),
  checkTurnCredentialMintRateLimit: vi.fn(),
  sendCommandToAgent: vi.fn(),
  commitDesktopStartIntent: vi.fn(),
  prepareRevocationLeaseForStart: vi.fn(),
  transaction: vi.fn(async (fn: (tx: { context: string }) => unknown) => fn({ context: 'request' })),
}));

vi.mock('../../db', () => ({
  db: {
    transaction: mocks.transaction,
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })),
  },
  hasDbAccessContext: () => true,
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../../services/networkIsolation/episodeStore', () => ({
  findUnresolvedEpisode: mocks.findUnresolvedEpisode,
}));
vi.mock('../../middleware/auth', () => ({
  requireScope: (): MiddlewareHandler => async (c, next) => {
    if (c.req.header('Authorization') !== 'Bearer test') return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      user: { id: '33333333-3333-4333-8333-333333333333', email: 'tech@example.test', name: 'Tech', isPlatformAdmin: false },
      principal: { kind: 'user_session' },
      token: null,
      partnerId: null,
      accessibleOrgIds: ['44444444-4444-4444-8444-444444444444'],
      orgCondition: () => undefined,
      scope: 'organization',
      orgId: '44444444-4444-4444-8444-444444444444',
      canAccessOrg: (orgId: string) => orgId === '44444444-4444-4444-8444-444444444444',
    });
    const site = c.req.header('x-site');
    c.set('permissions', {
      permissions: [], partnerId: null, orgId: '44444444-4444-4444-8444-444444444444',
      roleId: 'role-test', scope: 'organization', allowedSiteIds: site ? [site] : undefined,
    });
    await next();
  },
  requirePermission: (): MiddlewareHandler => async (_c, next) => next(),
}));
vi.mock('./helpers', async (importOriginal) => ({
  ...await importOriginal<typeof import('./helpers')>(),
  getSessionWithOrgCheck: mocks.getSessionWithOrgCheck,
  hasSessionOwnership: mocks.hasSessionOwnership,
  checkTurnCredentialMintRateLimit: mocks.checkTurnCredentialMintRateLimit,
  logSessionAudit: vi.fn(),
  buildRemoteSessionPromptPayload: vi.fn(async () => undefined),
  createDesktopStartCommandId: () => 'start-command',
}));
vi.mock('../../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: mocks.checkRemoteAccess,
  resolveDesktopSessionPolicy: vi.fn(async () => ({ clipboard: 'both', idleTimeoutMinutes: 0, maxSessionDurationHours: 0 })),
}));
vi.mock('../agentWs', () => ({ sendCommandToAgent: mocks.sendCommandToAgent, sendDesktopIceCandidateToAgent: vi.fn() }));
vi.mock('../../services/remoteDesktopStartIntent', () => ({
  commitDesktopStartIntent: mocks.commitDesktopStartIntent,
  assertDesktopStartIntentCurrent: vi.fn(async () => ({ ok: true })),
  boundConsentUnavailableBehavior: () => undefined,
  formatDesktopGeneration: () => '1',
  startIntentDenialCode: vi.fn(),
  startIntentDenialMessage: vi.fn(),
}));
vi.mock('../../services/desktopStartInFlight', () => ({ releaseDesktopStartInFlight: vi.fn() }));
vi.mock('../../services/remoteRevocationLease', () => ({
  AGENT_UPGRADE_REQUIRED_CODE: 'agent_upgrade_required',
  AGENT_UPGRADE_REQUIRED_MESSAGE: 'upgrade required',
  isDesktopStartCapable: vi.fn(async () => true),
  prepareRevocationLeaseForStart: mocks.prepareRevocationLeaseForStart,
  renewRevocationLease: vi.fn(),
}));
vi.mock('../../services/remoteSessionAuth', () => ({ createDesktopConnectCode: vi.fn(), createWsTicket: vi.fn() }));
vi.mock('../../services/remoteSessionCreate', () => ({ createRemoteSession: vi.fn(), RemoteSessionDeniedError: class extends Error {} }));
vi.mock('../../services/remoteSessionTeardown', () => ({
  ACTIVE_REMOTE_SESSION_STATUSES: ['pending', 'connecting', 'active'],
  teardownDisconnectedSessions: vi.fn(),
}));
vi.mock('../../services/agentCommandRelay', () => ({ dispatchCommandToAgent: vi.fn() }));
vi.mock('../../services/viewerTokenRevocation', () => ({ revokeViewerSession: vi.fn() }));

import { sessionRoutes } from './sessions';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '55555555-5555-4555-8555-555555555555';
const notPermitted = {
  code: 'isolation_relay_not_permitted',
  error: 'Remote desktop over WebRTC is unavailable: this device was isolated without permitting the TURN relay',
};
const unavailable = {
  code: 'isolation_relay_unavailable',
  error: 'Remote desktop needs the TURN relay while this device is isolated',
};
const app = new Hono().route('/remote', sessionRoutes);
app.onError(() => new Response('Internal Server Error', { status: 500 }));

type IceServer = { urls: string | string[]; username?: string; credential?: string };
type WirePlan = { iceServers: IceServer[]; relayOnly?: boolean };

function fixture() {
  return {
    session: { id: SESSION_ID, deviceId: DEVICE_ID, userId: USER_ID, type: 'desktop', status: 'pending' },
    device: { id: DEVICE_ID, agentId: 'agent-test', orgId: '44444444-4444-4444-8444-444444444444', siteId: SITE_ID },
  };
}
function request(kind: 'ice' | 'offer', headers: Record<string, string> = {}) {
  return app.request(kind === 'ice' ? `/remote/ice-servers?sessionId=${SESSION_ID}` : `/remote/sessions/${SESSION_ID}/offer`, {
    method: kind === 'ice' ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json', ...headers },
    ...(kind === 'offer' ? { body: JSON.stringify({ offer: 'v=0\r\n' }) } : {}),
  });
}
function assertNoStart() {
  expect(mocks.sendCommandToAgent).not.toHaveBeenCalled();
  expect(mocks.commitDesktopStartIntent).not.toHaveBeenCalled();
  expect(mocks.prepareRevocationLeaseForStart).not.toHaveBeenCalled();
}
function offerPayload(): WirePlan {
  const command = mocks.sendCommandToAgent.mock.calls[0]?.[1] as { payload: WirePlan };
  return command.payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TURN_HOST', 'relay.example.test');
  vi.stubEnv('TURN_SECRET', 'test-secret');
  vi.stubEnv('TURN_PORT', '3478');
  vi.stubEnv('TURN_TLS_HOST', '');
  mocks.findUnresolvedEpisode.mockResolvedValue(null);
  mocks.getSessionWithOrgCheck.mockResolvedValue(fixture());
  mocks.hasSessionOwnership.mockReturnValue(true);
  mocks.checkRemoteAccess.mockResolvedValue({ allowed: true });
  mocks.checkTurnCredentialMintRateLimit.mockResolvedValue({ allowed: true });
  mocks.sendCommandToAgent.mockReturnValue(true);
  mocks.commitDesktopStartIntent.mockResolvedValue({ ok: true, generation: 1n });
  mocks.prepareRevocationLeaseForStart.mockResolvedValue({ ok: true, lease: { token: 'lease' } });
});
afterEach(() => vi.unstubAllEnvs());

describe.each(['ice', 'offer'] as const)('JWT desktop %s relay policy', (kind) => {
  it.each(['applying', 'applied', 'verified', 'release_requested'])('uses TURN only for %s isolation', async (state) => {
    mocks.findUnresolvedEpisode.mockResolvedValue({ state, remoteRelay: true });
    const response = await request(kind);
    expect(response.status).toBe(200);
    const plan: WirePlan = kind === 'ice' ? await response.json() : offerPayload();
    expect(plan.relayOnly).toBe(true);
    expect(plan.iceServers).toHaveLength(1);
    expect(plan.iceServers.flatMap((server) => server.urls)).toEqual([
      'turn:relay.example.test:3478?transport=udp',
      'turn:relay.example.test:3478?transport=tcp',
    ]);
    expect(mocks.findUnresolvedEpisode).toHaveBeenCalledWith({ context: 'request' }, DEVICE_ID);
  });

  it.each(['applying', 'applied', 'verified', 'release_requested'])('refuses %s isolation without the relay opt-in before starting', async (state) => {
    mocks.findUnresolvedEpisode.mockResolvedValue({ state, remoteRelay: false });
    const response = await request(kind);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(notPermitted);
    assertNoStart();
  });

  it.each(['TURN_HOST', 'TURN_SECRET'])('refuses when %s is unavailable before starting', async (name) => {
    mocks.findUnresolvedEpisode.mockResolvedValue({ state: 'verified', remoteRelay: true });
    vi.stubEnv(name, '');
    const response = await request(kind);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(unavailable);
    assertNoStart();
  });

  it.each([null, 'released', 'expired'])('preserves ordinary wire fields with episode state %s', async (state) => {
    mocks.findUnresolvedEpisode.mockResolvedValue(state ? { state, remoteRelay: false } : null);
    const response = await request(kind);
    expect(response.status).toBe(200);
    const plan: WirePlan = kind === 'ice' ? await response.json() : offerPayload();
    expect(plan).not.toHaveProperty('relayOnly');
    expect(plan.iceServers[0]).toEqual({ urls: 'stun:stun.l.google.com:19302' });
    expect(plan.iceServers).toHaveLength(2);
    if (kind === 'ice') expect(Object.keys(plan)).toEqual(['iceServers']);
    else expect(plan).toEqual({
      sessionId: SESSION_ID, startGeneration: '1', offer: 'v=0\r\n', iceServers: plan.iceServers,
      clipboard: 'both', idleTimeoutMinutes: 0, maxSessionDurationHours: 0, revocationLease: { token: 'lease' },
    });
  });

  it('fails closed on an episode database error before starting', async () => {
    mocks.findUnresolvedEpisode.mockRejectedValueOnce(new Error('database unavailable'));
    const response = await request(kind);
    expect(response.status).toBe(500);
    assertNoStart();
  });

  it.each(['auth', 'org', 'owner', 'site', 'state', 'capability'] as const)('keeps the %s gate ahead of episode reads', async (gate) => {
    let headers: Record<string, string> = {};
    let status = 403;
    if (gate === 'auth') { headers = { Authorization: '' }; status = 401; }
    if (gate === 'org') { mocks.getSessionWithOrgCheck.mockResolvedValueOnce(null); status = 404; }
    if (gate === 'owner') mocks.hasSessionOwnership.mockReturnValueOnce(false);
    if (gate === 'site') headers = { 'x-site': '66666666-6666-4666-8666-666666666666' };
    if (gate === 'state') {
      const result = fixture(); result.session.status = 'disconnected';
      mocks.getSessionWithOrgCheck.mockResolvedValueOnce(result); status = 400;
    }
    if (gate === 'capability') mocks.checkRemoteAccess.mockResolvedValueOnce({ allowed: false, reason: 'disabled' });
    const response = await request(kind, headers);
    expect(response.status).toBe(status);
    expect(mocks.findUnresolvedEpisode).not.toHaveBeenCalled();
    assertNoStart();
  });
});

it('keeps the ICE mint rate limit ahead of isolation reads', async () => {
  mocks.checkTurnCredentialMintRateLimit.mockResolvedValueOnce({ allowed: false });
  expect((await request('ice')).status).toBe(429);
  expect(mocks.findUnresolvedEpisode).not.toHaveBeenCalled();
});
