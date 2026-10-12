import { describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()) }));
vi.mock('../db/schema', () => ({ tunnelSessions: {}, devices: {} }));
vi.mock('./agentWs', () => ({ isAgentConnected: vi.fn(() => true) }));
vi.mock('../services/agentCommandAwait', () => ({ sendCommandToAgentAwaitResult: vi.fn() }));
vi.mock('../services/remoteAccessPolicy', () => ({ checkRemoteAccess: vi.fn() }));
vi.mock('../services/remoteWsAuthorization', () => ({ authorizeRemoteSessionContinuation: vi.fn() }));
vi.mock('../services/tunnelAllowlist', () => ({ getActiveAllowlistPatterns: vi.fn() }));

import {
  HOST_COOKIE_AUDIENCE,
  collectForwardableHeaders,
  decodeUpstreamBody,
  deviceTargetOrigin,
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
});
