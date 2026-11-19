import { describe, expect, it } from 'vitest';
import {
  NETWORK_ISOLATION_CAPABILITY,
  NETWORK_ISOLATION_RELEASE_TOKEN,
  NETWORK_ISOLATION_RELEASE_TOKEN_MIN_AGENT_VERSION,
  agentAcceptsReleaseToken,
} from './networkIsolation';
import { networkIsolationDesiredSchema } from '../validators/networkIsolation';

describe('signed offline release token gate (#10102)', () => {
  it('is capability level 4, matching agent CapabilityReleaseToken', () => {
    expect(NETWORK_ISOLATION_CAPABILITY.releaseToken).toBe(4);
  });

  it('ships the fail-closed version sentinel until lab gate L4 pins a release', () => {
    expect(NETWORK_ISOLATION_RELEASE_TOKEN_MIN_AGENT_VERSION).toBe('999.0.0');
  });

  it('bounds tokens to the agent limits', () => {
    expect(NETWORK_ISOLATION_RELEASE_TOKEN).toEqual({ version: 1, validitySeconds: 7200, maxValiditySeconds: 86400 });
  });

  it('needs the capability AND an agent version at or above the gate', () => {
    expect(agentAcceptsReleaseToken(4, '999.0.0')).toBe(true);
    expect(agentAcceptsReleaseToken(5, '999.1.0')).toBe(true);
    expect(agentAcceptsReleaseToken(3, '999.0.0')).toBe(false);
    expect(agentAcceptsReleaseToken(4, '1.0.0')).toBe(false);
    expect(agentAcceptsReleaseToken(4, '998.99.99')).toBe(false);
  });

  it('fails closed on anything malformed', () => {
    for (const cap of [null, undefined, 0, 4.5, Number.NaN, '4' as never]) expect(agentAcceptsReleaseToken(cap, '999.0.0'), String(cap)).toBe(false);
    for (const version of [null, undefined, '', 'dev', 'x.y.z']) expect(agentAcceptsReleaseToken(4, version), String(version)).toBe(false);
  });
});

describe('desired block release-token fields', () => {
  const key = 'A'.repeat(43) + '=';
  const base = {
    isolationId: '6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab', generation: 1, expiresAt: '2026-01-01T00:00:00.000Z', deadManSeconds: 0, remoteRelay: false,
    desired: 'isolated' as const,
    allow: [{ kind: 'host' as const, host: 'control.example.test', proto: 'tcp' as const, ports: [443], scope: 'breeze' as const }],
  };
  const deviceId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

  it('accepts the key, the device id and the requirement together', () => {
    expect(networkIsolationDesiredSchema.safeParse({ ...base, releaseTokenPublicKey: key, releaseTokenDeviceId: deviceId, requireSignedReleaseToken: true }).success).toBe(true);
    expect(networkIsolationDesiredSchema.safeParse({ ...base, releaseTokenPublicKey: key, releaseTokenDeviceId: deviceId }).success).toBe(true);
    expect(networkIsolationDesiredSchema.safeParse(base).success).toBe(true);
  });

  it.each([
    ['key without device', { releaseTokenPublicKey: key }],
    ['device without key', { releaseTokenDeviceId: deviceId }],
    ['requirement without key', { requireSignedReleaseToken: true }],
    ['short key', { releaseTokenPublicKey: 'A'.repeat(42) + '==', releaseTokenDeviceId: deviceId }],
    ['url-safe alphabet', { releaseTokenPublicKey: '-'.repeat(43) + '=', releaseTokenDeviceId: deviceId }],
    ['device not a uuid', { releaseTokenPublicKey: key, releaseTokenDeviceId: 'device-1' }],
  ])('rejects %s', (_name, extra) => {
    expect(networkIsolationDesiredSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });

  it('never carries them on a release tombstone', () => {
    const tombstone = { ...base, desired: 'released' as const, allow: [] };
    expect(networkIsolationDesiredSchema.safeParse(tombstone).success).toBe(true);
    expect(networkIsolationDesiredSchema.safeParse({ ...tombstone, releaseTokenPublicKey: key, releaseTokenDeviceId: deviceId }).success).toBe(false);
  });
});
