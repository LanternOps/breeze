import { beforeEach, describe, expect, it, vi } from 'vitest';

const readAgentCredentialUseMock = vi.hoisted(() => vi.fn());
const probeAgentPresenceMock = vi.hoisted(() => vi.fn());
const assertOutsideHeldDbContextMock = vi.hoisted(() => vi.fn());
vi.mock('../agentCredentialUse', () => ({
  readAgentCredentialUse: (...args: unknown[]) => readAgentCredentialUseMock(...args),
}));
vi.mock('../agentPresence', () => ({
  probeAgentPresence: (...args: unknown[]) => probeAgentPresenceMock(...args),
}));
vi.mock('../../db', () => ({
  assertOutsideHeldDbContext: (...args: unknown[]) => assertOutsideHeldDbContextMock(...args),
}));

import {
  decideTargetLiveness,
  readRedisLivenessSignals,
  targetSilenceThreshold,
  type RedisLivenessSignals,
} from './liveness';

const NOW = new Date('2026-10-24T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const quietRedis = (credentialUseAt: Date | null = null): RedisLivenessSignals =>
  ({ wsPresent: false, credentialUseAt, readAt: NOW });
const oldRow = (overrides: { lastSeenAt?: Date | null; watchdogLastSeen?: Date | null } = {}) => ({
  lastSeenAt: minutesAgo(120),
  watchdogLastSeen: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  readAgentCredentialUseMock.mockResolvedValue({ at: null });
  probeAgentPresenceMock.mockResolvedValue({ present: false });
});

describe('targetSilenceThreshold (#8318 §6.5)', () => {
  it('is now − 10 min for an intent requested less than 10 minutes ago', () => {
    expect(targetSilenceThreshold(minutesAgo(3), NOW)).toEqual(minutesAgo(10));
  });

  it('is the request time for an older intent: any use since the request counts', () => {
    expect(targetSilenceThreshold(minutesAgo(45), NOW)).toEqual(minutesAgo(45));
  });
});

describe('readRedisLivenessSignals (the Redis half, read before any lock)', () => {
  it('reads the credential-use marker by device and the presence lease by install, outside any held DB context', async () => {
    readAgentCredentialUseMock.mockResolvedValueOnce({ at: minutesAgo(3) });
    probeAgentPresenceMock.mockResolvedValueOnce({ present: true });
    const signals = await readRedisLivenessSignals({ deviceId: 'device-1', agentId: 'agent-1' });
    expect(signals).toMatchObject({ wsPresent: true, credentialUseAt: minutesAgo(3) });
    expect(readAgentCredentialUseMock).toHaveBeenCalledWith('device-1');
    expect(probeAgentPresenceMock).toHaveBeenCalledWith('agent-1');
    expect(assertOutsideHeldDbContextMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the credential-use marker', () => readAgentCredentialUseMock.mockResolvedValueOnce({ unavailable: true, cause: 'redis_unavailable' })],
    ['the presence lease', () => probeAgentPresenceMock.mockResolvedValueOnce({ unavailable: true })],
    ['a throwing read', () => readAgentCredentialUseMock.mockRejectedValueOnce(new Error('boom'))],
  ])('is unavailable (fail closed) when Redis cannot answer %s', async (_label, arrange) => {
    arrange();
    await expect(readRedisLivenessSignals({ deviceId: 'd', agentId: 'a' })).resolves.toEqual({ unavailable: true });
  });

  it('is unavailable when Redis is slower than the bound', async () => {
    probeAgentPresenceMock.mockImplementationOnce(() => new Promise(() => { /* never answers */ }));
    await expect(readRedisLivenessSignals({ deviceId: 'd', agentId: 'a' }, { timeoutMs: 20 })).resolves.toEqual({ unavailable: true });
  });
});

describe('decideTargetLiveness (§6.5 over both halves)', () => {
  it('is silent when every signal is older than the threshold', () => {
    expect(decideTargetLiveness(quietRedis(minutesAgo(90)), oldRow({ watchdogLastSeen: minutesAgo(100) }), minutesAgo(30), NOW))
      .toEqual({ state: 'silent' });
  });

  it.each([
    ['a heartbeat', quietRedis(), oldRow({ lastSeenAt: minutesAgo(5) }), 'heartbeat'],
    ['a watchdog beat', quietRedis(), oldRow({ watchdogLastSeen: minutesAgo(5) }), 'watchdog'],
    ['a credential use (REST poll, helper, WS handshake)', quietRedis(minutesAgo(5)), oldRow(), 'credential_use'],
  ])('is alive on %s inside the window', (_label, redis, row, signal) => {
    expect(decideTargetLiveness(redis, row, minutesAgo(30), NOW)).toMatchObject({ state: 'alive', signal });
  });

  it('a use after the request counts even when it is older than 10 minutes', () => {
    expect(decideTargetLiveness(quietRedis(), oldRow({ lastSeenAt: minutesAgo(20) }), minutesAgo(30), NOW))
      .toMatchObject({ state: 'alive', signal: 'heartbeat' });
  });

  it('at request (requested_at = now) only the 10-minute quiet period counts', () => {
    expect(decideTargetLiveness(quietRedis(), oldRow({ lastSeenAt: minutesAgo(9) }), NOW, NOW)).toMatchObject({ state: 'alive' });
    expect(decideTargetLiveness(quietRedis(), oldRow({ lastSeenAt: minutesAgo(11) }), NOW, NOW)).toEqual({ state: 'silent' });
  });

  it('reports the NEWEST signal', () => {
    expect(decideTargetLiveness(quietRedis(minutesAgo(1)), oldRow({ lastSeenAt: minutesAgo(4), watchdogLastSeen: minutesAgo(2) }), minutesAgo(30), NOW))
      .toEqual({ state: 'alive', signal: 'credential_use', at: minutesAgo(1) });
  });

  it('a live WebSocket lease is alive', () => {
    expect(decideTargetLiveness({ wsPresent: true, credentialUseAt: null, readAt: NOW }, oldRow(), minutesAgo(30), NOW))
      .toEqual({ state: 'alive', signal: 'ws_presence', at: NOW });
  });

  it('unavailable Redis is unknown, whatever the DB says', () => {
    expect(decideTargetLiveness({ unavailable: true }, oldRow(), minutesAgo(30), NOW)).toEqual({ state: 'unknown' });
  });

  it('a never-seen target with no marker is silent', () => {
    expect(decideTargetLiveness(quietRedis(), oldRow({ lastSeenAt: null }), minutesAgo(30), NOW)).toEqual({ state: 'silent' });
  });
});
