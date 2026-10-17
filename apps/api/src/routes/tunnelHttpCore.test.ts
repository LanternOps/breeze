import { describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

const { whereMock, rereadRows } = vi.hoisted(() => ({
  whereMock: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'x' }]) })),
  rereadRows: { value: [] as unknown[] },
}));
vi.mock('../db', () => ({
  db: {
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: whereMock })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ innerJoin: vi.fn(() => ({ where: vi.fn(() => ({
      limit: vi.fn(async () => rereadRows.value),
    })) })) })) })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));
vi.mock('../db/schema', () => ({ tunnelSessions: { id: 'ts.id', status: 'ts.status' }, devices: {} }));
vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((...a: unknown[]) => ({ op: 'eq', a })),
    inArray: vi.fn((...a: unknown[]) => ({ op: 'inArray', a })),
    and: vi.fn((...a: unknown[]) => ({ op: 'and', a })),
  };
});
vi.mock('./agentWs', () => ({ isAgentConnected: vi.fn(() => true) }));
const { sendCommandMock } = vi.hoisted(() => ({ sendCommandMock: vi.fn() }));
vi.mock('../services/agentCommandAwait', () => ({ sendCommandToAgentAwaitResult: sendCommandMock }));
vi.mock('../services/remoteAccessPolicy', () => ({ checkRemoteAccess: vi.fn() }));
vi.mock('../services/remoteWsAuthorization', () => ({ authorizeRemoteSessionContinuation: vi.fn() }));
vi.mock('../services/tunnelAllowlist', () => ({ getActiveAllowlistPatterns: vi.fn(async () => []) }));

import {
  CONNECTABLE_TUNNEL_STATUSES,
  activateTunnelSessionOnExchange,
  HOST_COOKIE_AUDIENCE,
  collectForwardableHeaders,
  decodeUpstreamBody,
  deviceTargetOrigin,
  dispatchTunnelHttpRequest,
  type ReachableTunnel,
  signTunnelCookie,
  verifyTunnelCookie,
} from './tunnelHttpCore';

const TUNNEL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_TUNNEL = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const USER_ID = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';

describe('tunnelHttpCore', () => {
  it('decodes gzip, passes unknown encodings through untouched, and fails a bomb closed', async () => {
    const gz = await decodeUpstreamBody(gzipSync(Buffer.from('<p>hi</p>')), 'gzip');
    expect(gz).toEqual({ ok: true, body: Buffer.from('<p>hi</p>'), decoded: true });

    const raw = Buffer.from('opaque');
    expect(await decodeUpstreamBody(raw, 'gzip, zstd')).toEqual({ ok: true, body: raw, decoded: false });

    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024));
    expect(await decodeUpstreamBody(bomb, 'gzip')).toEqual({ ok: false });
  });

  it('brackets IPv6 device hosts and keeps the explicit port', () => {
    expect(deviceTargetOrigin({ scheme: null, targetPort: 443, targetHost: 'fe80::1' })).toBe('https://[fe80::1]:443');
    expect(deviceTargetOrigin({ scheme: 'http', targetPort: 8080, targetHost: '192.168.1.5' })).toBe('http://192.168.1.5:8080');
  });

  it('never forwards Breeze credentials to the device', () => {
    expect(collectForwardableHeaders({ accept: 'text/html', cookie: 'a=b', authorization: 'Bearer x', 'x-api-key': 'k' }))
      .toEqual({ accept: ['text/html'] });
  });

  it('binds cookies to tunnel, audience and context', async () => {
    const pathCookie = await signTunnelCookie(USER_ID, TUNNEL_ID);
    expect(await verifyTunnelCookie(pathCookie, TUNNEL_ID)).toBe(USER_ID);
    expect(await verifyTunnelCookie(pathCookie, OTHER_TUNNEL)).toBeNull();
    // A path-mode cookie can never authenticate host mode, and vice versa.
    expect(await verifyTunnelCookie(pathCookie, TUNNEL_ID, { audience: HOST_COOKIE_AUDIENCE, context: 'frame' })).toBeNull();

    const frame = await signTunnelCookie(USER_ID, TUNNEL_ID, { audience: HOST_COOKIE_AUDIENCE, context: 'frame' });
    expect(await verifyTunnelCookie(frame, TUNNEL_ID, { audience: HOST_COOKIE_AUDIENCE, context: 'frame' })).toBe(USER_ID);
    expect(await verifyTunnelCookie(frame, TUNNEL_ID, { audience: HOST_COOKIE_AUDIENCE, context: 'tab' })).toBeNull();
    expect(await verifyTunnelCookie(frame, TUNNEL_ID)).toBeNull();
  });

  it('activation constrains the UPDATE to the id AND connectable statuses', async () => {
    await expect(activateTunnelSessionOnExchange(TUNNEL_ID, true)).resolves.toBe(true);
    const cond = (whereMock.mock.calls as unknown as unknown[][])[0]![0] as { op: string; a: Array<{ op: string; a: unknown[] }> };
    expect(cond.op).toBe('and');
    expect(cond.a).toContainEqual({ op: 'eq', a: ['ts.id', TUNNEL_ID] });
    expect(cond.a).toContainEqual({ op: 'inArray', a: ['ts.status', [...CONNECTABLE_TUNNEL_STATUSES]] });
  });

  describe('dispatch re-reads the row status (replica-safe Close, amended 2026-10-12b item 4)', () => {
    const session = {
      agentId: 'agent-1', deviceId: 'dev-1', deviceStatus: 'online', deviceSiteId: null, targetHost: '192.168.1.50',
      targetPort: 80, scheme: 'http', skipTlsVerify: false, orgId: 'org-1', type: 'proxy', createdAt: new Date(),
      startedAt: null, lastActivityAt: null,
    } as ReachableTunnel;
    const request = { method: 'GET', path: '/', headers: {}, bodyB64: '' };
    const rowWithStatus = (status: string) => [{ session: { status }, device: {} }];

    it('refuses with 502 Tunnel closed, without contacting the agent, once the row is no longer connectable', async () => {
      sendCommandMock.mockClear();
      for (const rows of [rowWithStatus('disconnected'), rowWithStatus('failed'), []]) {
        rereadRows.value = rows;
        await expect(dispatchTunnelHttpRequest(TUNNEL_ID, session, request))
          .resolves.toEqual({ ok: false, status: 502, message: 'Tunnel closed', reason: 'tunnel_closed' });
      }
      expect(sendCommandMock).not.toHaveBeenCalled();
    });

    it('dispatches while the row is still connectable', async () => {
      sendCommandMock.mockReset();
      sendCommandMock.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ status: 200, headers: {}, bodyB64: '' }) });
      for (const status of CONNECTABLE_TUNNEL_STATUSES) {
        rereadRows.value = rowWithStatus(status);
        await expect(dispatchTunnelHttpRequest(TUNNEL_ID, session, request)).resolves.toMatchObject({ ok: true });
      }
      expect(sendCommandMock).toHaveBeenCalledTimes(CONNECTABLE_TUNNEL_STATUSES.length);
    });
  });
});
