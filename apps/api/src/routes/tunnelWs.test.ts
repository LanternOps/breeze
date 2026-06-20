import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
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

import { rateLimiter } from '../services/rate-limit';
import { getRedis } from '../services/redis';
import { isUserTunnelWsRateLimited, validateTunnelTextRelayFrame } from './tunnelWs';

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
