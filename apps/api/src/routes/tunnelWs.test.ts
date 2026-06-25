import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DB mock supporting both the simple user-status select and the
// tunnelSessions⋈devices join used by `revalidateTunnelSession`. Tests drive
// the returned rows via the setters below.
let userRow: { id: string; status: string } | undefined = { id: 'user-1', status: 'active' };
let joinRow:
  | { session: { userId: string; status: string; deviceId: string }; device: { id: string; status: string } }
  | undefined = {
  session: { userId: 'user-1', status: 'active', deviceId: 'dev-1' },
  device: { id: 'dev-1', status: 'online' },
};
let throwOnJoin = false;

function setUserRow(row: typeof userRow) {
  userRow = row;
}
function setJoinRow(row: typeof joinRow) {
  joinRow = row;
}
function setThrowOnJoin(v: boolean) {
  throwOnJoin = v;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        // Plain user-status query: .from().where().limit()
        where: vi.fn(() => ({
          limit: vi.fn(async () => (userRow ? [userRow] : [])),
        })),
        // Join query: .from().innerJoin().where().limit()
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              if (throwOnJoin) throw new Error('db down');
              return joinRow ? [joinRow] : [];
            }),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/schema', () => ({
  tunnelSessions: {},
  devices: {},
  users: {},
}));

vi.mock('../services/remoteSessionAuth', () => ({
  consumeWsTicket: vi.fn(),
}));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../services/viewerTokenRevocation', () => ({
  revokeViewerSession: vi.fn(async () => undefined),
  isViewerSessionRevoked: vi.fn(async () => false),
}));

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => 'redis-client'),
}));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({
    allowed: true,
    remaining: 9,
    resetAt: new Date(),
  })),
}));

import { sendCommandToAgent } from './agentWs';
import { rateLimiter } from '../services/rate-limit';
import { getRedis } from '../services/redis';
import { checkRemoteAccess } from '../services/remoteAccessPolicy';
import { isViewerSessionRevoked, revokeViewerSession } from '../services/viewerTokenRevocation';
import {
  __setTunnelConnectionForTest,
  enforceTunnelRevocation,
  isUserTunnelWsRateLimited,
  revalidateTunnelSession,
  validateTunnelTextRelayFrame,
} from './tunnelWs';

const liveConn = { userId: 'user-1', deviceId: 'dev-1', tunnelType: 'vnc' as const };

// Minimal fake WSContext: only `close` is exercised by enforceTunnelRevocation.
function makeFakeWs() {
  return { close: vi.fn(), send: vi.fn() } as const;
}

// A registered active connection, as `onOpen` would have stored. The revocation
// gate only acts when a connection is present in the module map, so tests seed
// one via the test-only helper.
function registerLiveConnection(tunnelId: string, ws: { close: ReturnType<typeof vi.fn> }) {
  __setTunnelConnectionForTest(tunnelId, {
    userWs: ws as never,
    agentId: 'agent-1',
    userId: 'user-1',
    deviceId: 'dev-1',
    orgId: 'org-1',
    tunnelType: 'vnc',
    startedAt: new Date(),
    lastPongAt: Date.now(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setUserRow({ id: 'user-1', status: 'active' });
  setJoinRow({
    session: { userId: 'user-1', status: 'active', deviceId: 'dev-1' },
    device: { id: 'dev-1', status: 'online' },
  });
  setThrowOnJoin(false);
  vi.mocked(checkRemoteAccess).mockResolvedValue({ allowed: true });
  vi.mocked(isViewerSessionRevoked).mockResolvedValue(false);
});

describe('isUserTunnelWsRateLimited', () => {
  it('uses the shared Redis-backed limiter for tunnel websocket upgrades', async () => {
    await expect(isUserTunnelWsRateLimited('user-1')).resolves.toBe(false);

    expect(getRedis).toHaveBeenCalled();
    expect(rateLimiter).toHaveBeenCalledWith('redis-client', 'tunnelws:conn:user-1', 10, 60);
  });

  it('fails closed when the shared limiter denies the tunnel websocket upgrade', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(),
    });

    await expect(isUserTunnelWsRateLimited('user-1')).resolves.toBe(true);
  });
});

describe('validateTunnelTextRelayFrame', () => {
  it('accepts base64 data within the binary frame cap', () => {
    const encoded = Buffer.from('hello').toString('base64');
    const result = validateTunnelTextRelayFrame(JSON.stringify({ type: 'data', data: encoded }));

    expect(result).toEqual({ ok: true, data: encoded });
  });

  it('rejects malformed base64 text relay data', () => {
    const result = validateTunnelTextRelayFrame(JSON.stringify({ type: 'data', data: 'not base64!' }));

    expect(result.ok).toBe(false);
  });

  it('rejects decoded data larger than the binary frame cap', () => {
    const encoded = Buffer.from(new Uint8Array(1_000_001)).toString('base64');
    const result = validateTunnelTextRelayFrame(JSON.stringify({ type: 'data', data: encoded }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/decoded|encoded/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Mid-session revalidation (revocation gap): an active tunnel must be torn
// down when the user/device/session/policy access that authorised it is
// revoked. The ping loop calls this on each interval; it must FAIL CLOSED.
// ---------------------------------------------------------------------------

describe('revalidateTunnelSession', () => {
  it('keeps a still-valid tunnel (active user, online device, owned session, policy allowed)', async () => {
    await expect(revalidateTunnelSession('tunnel-1', liveConn)).resolves.toEqual({ ok: true });
  });

  it('revokes when the user is no longer active', async () => {
    setUserRow({ id: 'user-1', status: 'suspended' });
    const result = await revalidateTunnelSession('tunnel-1', liveConn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/user/i);
  });

  it('revokes when the user row is gone (deleted)', async () => {
    setUserRow(undefined);
    const result = await revalidateTunnelSession('tunnel-1', liveConn);
    expect(result.ok).toBe(false);
  });

  it('revokes when the tunnel session no longer belongs to the user', async () => {
    setJoinRow({
      session: { userId: 'someone-else', status: 'active', deviceId: 'dev-1' },
      device: { id: 'dev-1', status: 'online' },
    });
    const result = await revalidateTunnelSession('tunnel-1', liveConn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/owned/i);
  });

  it('revokes when the session has been ended/disconnected elsewhere', async () => {
    setJoinRow({
      session: { userId: 'user-1', status: 'disconnected', deviceId: 'dev-1' },
      device: { id: 'dev-1', status: 'online' },
    });
    const result = await revalidateTunnelSession('tunnel-1', liveConn);
    expect(result.ok).toBe(false);
  });

  it('revokes when the device has gone offline/quarantined', async () => {
    setJoinRow({
      session: { userId: 'user-1', status: 'active', deviceId: 'dev-1' },
      device: { id: 'dev-1', status: 'offline' },
    });
    const result = await revalidateTunnelSession('tunnel-1', liveConn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/device/i);
  });

  it('revokes when the remote-access policy is disabled mid-session', async () => {
    vi.mocked(checkRemoteAccess).mockResolvedValue({ allowed: false, reason: 'Disabled by policy' });
    const result = await revalidateTunnelSession('tunnel-1', liveConn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/policy/i);

    // Uses the capability matching the tunnel type.
    expect(checkRemoteAccess).toHaveBeenCalledWith('dev-1', 'vncRelay');
  });

  it('checks the proxy capability for proxy tunnels', async () => {
    vi.mocked(checkRemoteAccess).mockResolvedValue({ allowed: false, reason: 'Disabled by policy' });
    await revalidateTunnelSession('tunnel-1', { ...liveConn, tunnelType: 'proxy' });
    expect(checkRemoteAccess).toHaveBeenCalledWith('dev-1', 'proxy');
  });
});

// ---------------------------------------------------------------------------
// Mid-session revocation TEARDOWN: enforceTunnelRevocation is what the ping
// loop actually calls each interval to close a live socket. It must close with
// 4003 and run the lifecycle teardown (notify agent + revoke viewer session)
// for ALL THREE triggers, and FAIL CLOSED if the check throws. A still-valid
// tunnel must be left open.
// ---------------------------------------------------------------------------

describe('enforceTunnelRevocation', () => {
  afterEach(() => {
    // Drop any seeded connection so cross-test state never leaks.
    __setTunnelConnectionForTest('tunnel-1', undefined);
  });

  it('returns false and leaves the socket open when access is still valid', async () => {
    const ws = makeFakeWs();
    registerLiveConnection('tunnel-1', ws);

    const closed = await enforceTunnelRevocation('tunnel-1', ws as never);

    expect(closed).toBe(false);
    expect(ws.close).not.toHaveBeenCalled();
    // No teardown: agent is not notified and the viewer session is not revoked.
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(revokeViewerSession).not.toHaveBeenCalled();
  });

  it('returns false without closing when no connection is registered', async () => {
    const ws = makeFakeWs();
    // No registerLiveConnection — the map has no entry for this tunnel.

    const closed = await enforceTunnelRevocation('tunnel-1', ws as never);

    expect(closed).toBe(false);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('closes 4003 and tears down on the cross-instance Redis revoke flag', async () => {
    // The currently-dead branch: isViewerSessionRevoked → true. This must close
    // even though the DB revalidation would otherwise pass.
    vi.mocked(isViewerSessionRevoked).mockResolvedValue(true);
    const ws = makeFakeWs();
    registerLiveConnection('tunnel-1', ws);

    const closed = await enforceTunnelRevocation('tunnel-1', ws as never);

    expect(closed).toBe(true);
    expect(ws.close).toHaveBeenCalledWith(4003, 'Tunnel revoked');
    // Lifecycle teardown fired: agent notified of close + viewer session revoked.
    expect(sendCommandToAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ type: 'tunnel_close', payload: { tunnelId: 'tunnel-1' } }),
    );
    expect(revokeViewerSession).toHaveBeenCalledWith('tunnel-1');
  });

  it('closes 4003 and tears down when the DB predicate revokes (device offline)', async () => {
    // Redis flag clear, but revalidateTunnelSession returns not-ok.
    vi.mocked(isViewerSessionRevoked).mockResolvedValue(false);
    setJoinRow({
      session: { userId: 'user-1', status: 'active', deviceId: 'dev-1' },
      device: { id: 'dev-1', status: 'offline' },
    });
    const ws = makeFakeWs();
    registerLiveConnection('tunnel-1', ws);

    const closed = await enforceTunnelRevocation('tunnel-1', ws as never);

    expect(closed).toBe(true);
    expect(ws.close).toHaveBeenCalledWith(4003, 'Access revoked');
    expect(sendCommandToAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ type: 'tunnel_close', payload: { tunnelId: 'tunnel-1' } }),
    );
    expect(revokeViewerSession).toHaveBeenCalledWith('tunnel-1');
  });

  it('closes 4003 and tears down when the DB predicate revokes (user inactive)', async () => {
    vi.mocked(isViewerSessionRevoked).mockResolvedValue(false);
    setUserRow({ id: 'user-1', status: 'suspended' });
    const ws = makeFakeWs();
    registerLiveConnection('tunnel-1', ws);

    const closed = await enforceTunnelRevocation('tunnel-1', ws as never);

    expect(closed).toBe(true);
    expect(ws.close).toHaveBeenCalledWith(4003, 'Access revoked');
    expect(revokeViewerSession).toHaveBeenCalledWith('tunnel-1');
  });

  it('FAILS CLOSED: closes 4003 when the revalidation lookup throws', async () => {
    // A DB error mid-check must NOT leave the tunnel relaying.
    vi.mocked(isViewerSessionRevoked).mockResolvedValue(false);
    setThrowOnJoin(true);
    const ws = makeFakeWs();
    registerLiveConnection('tunnel-1', ws);

    const closed = await enforceTunnelRevocation('tunnel-1', ws as never);

    expect(closed).toBe(true);
    expect(ws.close).toHaveBeenCalledWith(4003, 'Revocation check failed');
    // Even on the fail-closed path the lifecycle teardown runs.
    expect(sendCommandToAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ type: 'tunnel_close', payload: { tunnelId: 'tunnel-1' } }),
    );
    expect(revokeViewerSession).toHaveBeenCalledWith('tunnel-1');
  });
});
