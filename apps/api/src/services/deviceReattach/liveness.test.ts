import { beforeEach, describe, expect, it, vi } from 'vitest';

const readAgentCredentialUseMock = vi.hoisted(() => vi.fn());
const probeAgentPresenceMock = vi.hoisted(() => vi.fn());
vi.mock('../agentCredentialUse', () => ({
  readAgentCredentialUse: (...args: unknown[]) => readAgentCredentialUseMock(...args),
}));
vi.mock('../agentPresence', () => ({
  probeAgentPresence: (...args: unknown[]) => probeAgentPresenceMock(...args),
}));

import { readTargetLiveness, targetSilenceThreshold } from './liveness';

const NOW = new Date('2026-10-24T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const target = (overrides: { lastSeenAt?: Date | null; watchdogLastSeen?: Date | null } = {}) => ({
  id: 'device-1',
  agentId: 'agent-1',
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

describe('readTargetLiveness', () => {
  it('is silent when every signal is older than the threshold', async () => {
    readAgentCredentialUseMock.mockResolvedValueOnce({ at: minutesAgo(90) });
    await expect(readTargetLiveness(target({ watchdogLastSeen: minutesAgo(100) }), minutesAgo(30), NOW))
      .resolves.toEqual({ state: 'silent' });
    expect(readAgentCredentialUseMock).toHaveBeenCalledWith('device-1');
    expect(probeAgentPresenceMock).toHaveBeenCalledWith('agent-1');
  });

  it.each([
    ['a heartbeat', { lastSeenAt: minutesAgo(5) }, undefined, 'heartbeat'],
    ['a watchdog beat', { watchdogLastSeen: minutesAgo(5) }, undefined, 'watchdog'],
    ['a credential use (REST poll, helper, WS handshake)', {}, minutesAgo(5), 'credential_use'],
  ])('is alive on %s inside the window', async (_label, row, credentialUseAt, signal) => {
    if (credentialUseAt) readAgentCredentialUseMock.mockResolvedValueOnce({ at: credentialUseAt });
    await expect(readTargetLiveness(target(row), minutesAgo(30), NOW))
      .resolves.toMatchObject({ state: 'alive', signal });
  });

  it('a use after the request counts even when it is older than 10 minutes', async () => {
    await expect(readTargetLiveness(target({ lastSeenAt: minutesAgo(20) }), minutesAgo(30), NOW))
      .resolves.toMatchObject({ state: 'alive', signal: 'heartbeat' });
  });

  it('reports the NEWEST signal', async () => {
    readAgentCredentialUseMock.mockResolvedValueOnce({ at: minutesAgo(1) });
    await expect(readTargetLiveness(target({ lastSeenAt: minutesAgo(4), watchdogLastSeen: minutesAgo(2) }), minutesAgo(30), NOW))
      .resolves.toEqual({ state: 'alive', signal: 'credential_use', at: minutesAgo(1) });
  });

  it('a live WebSocket lease is alive now', async () => {
    probeAgentPresenceMock.mockResolvedValueOnce({ present: true });
    await expect(readTargetLiveness(target(), minutesAgo(30), NOW))
      .resolves.toEqual({ state: 'alive', signal: 'ws_presence', at: NOW });
  });

  it.each([
    ['the credential-use marker', () => readAgentCredentialUseMock.mockResolvedValueOnce({ unavailable: true, cause: 'redis_unavailable' })],
    ['the presence lease', () => probeAgentPresenceMock.mockResolvedValueOnce({ unavailable: true })],
  ])('fails closed (unknown) when Redis cannot answer %s', async (_label, arrange) => {
    arrange();
    await expect(readTargetLiveness(target(), minutesAgo(30), NOW)).resolves.toEqual({ state: 'unknown' });
  });

  it('a never-seen target with no marker is silent', async () => {
    await expect(readTargetLiveness(target({ lastSeenAt: null }), minutesAgo(30), NOW)).resolves.toEqual({ state: 'silent' });
  });
});
