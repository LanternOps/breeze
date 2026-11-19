import { describe, expect, it } from 'vitest';
import { containmentDesiredBlockSchema } from '@breeze/shared';
import type { DeviceNetworkIsolation } from '../../db/schema';
import { storedContainmentHeartbeatBlock } from './reconcile';

const KEY = Buffer.alloc(32, 9).toString('base64');
const deviceId = '22222222-2222-4222-8222-222222222222';
const allow = [{ kind: 'host' as const, host: 'control.example.test', proto: 'tcp' as const, ports: [443], scope: 'breeze' as const }];
function row(extra: Partial<DeviceNetworkIsolation> = {}): DeviceNetworkIsolation {
  return {
    id: '11111111-1111-4111-8111-111111111111', deviceId, orgId: '33333333-3333-4333-8333-333333333333', generation: 2,
    desiredState: 'isolated', state: 'verified', expiresAt: new Date('2027-01-01T00:00:00.000Z'), deadManSeconds: 0, remoteRelay: false,
    allowSnapshot: allow, allowSnapshotRevision: null, releaseConfirmedAt: null, releaseTokenPublicKey: KEY, releaseTokenRequired: true, ...extra,
  } as unknown as DeviceNetworkIsolation;
}
const tokenAgent = { networkIsolationVersion: 4, agentVersion: '999.0.0' };

describe('heartbeat block release-token fields (#10102)', () => {
  it('re-sends the pinned key, the device and the requirement to an agent that takes them', () => {
    const block = storedContainmentHeartbeatBlock(row(), tokenAgent);
    expect(block.networkIsolation).toMatchObject({ releaseTokenPublicKey: KEY, releaseTokenDeviceId: deviceId, requireSignedReleaseToken: true });
    expect(containmentDesiredBlockSchema.safeParse(block).success).toBe(true);
  });

  it('omits the requirement when the policy did not ask for it', () => {
    const block = storedContainmentHeartbeatBlock(row({ releaseTokenRequired: false }), tokenAgent).networkIsolation!;
    expect(block).toMatchObject({ releaseTokenPublicKey: KEY, releaseTokenDeviceId: deviceId });
    expect(block).not.toHaveProperty('requireSignedReleaseToken');
  });

  it.each([
    ['capability 3', { networkIsolationVersion: 3, agentVersion: '999.0.0' }],
    ['below the token version gate', { networkIsolationVersion: 4, agentVersion: '1.0.0' }],
    ['unknown agent', undefined],
  ])('sends none of them to an agent that would refuse the block (%s)', (_name, who) => {
    const block = storedContainmentHeartbeatBlock(row(), who).networkIsolation!;
    for (const key of ['releaseTokenPublicKey', 'releaseTokenDeviceId', 'requireSignedReleaseToken']) expect(block).not.toHaveProperty(key);
    expect(containmentDesiredBlockSchema.safeParse({ networkIsolation: block }).success).toBe(true);
  });

  it('sends none of them for an episode that pinned no key', () => {
    const block = storedContainmentHeartbeatBlock(row({ releaseTokenPublicKey: null, releaseTokenRequired: false }), tokenAgent).networkIsolation!;
    expect(block).not.toHaveProperty('releaseTokenPublicKey');
  });

  it('never puts them on a release tombstone', () => {
    const block = storedContainmentHeartbeatBlock(row({ state: 'release_requested', desiredState: 'released' }), tokenAgent).networkIsolation!;
    expect(block).toMatchObject({ desired: 'released', allow: [] });
    expect(block).not.toHaveProperty('releaseTokenPublicKey');
  });
});
