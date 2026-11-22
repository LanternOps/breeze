import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpectedGateway } from '@breeze/shared';

vi.mock('../../db', () => ({ db: {}, assertInTransaction: vi.fn() }));
vi.mock('./gate', () => ({ evaluateDiscoveryGate: vi.fn(), loadGateProfile: vi.fn() }));
vi.mock('./siteNetworks', () => ({ loadSiteGateState: vi.fn() }));

import * as gate from './gate';
import * as siteNetworks from './siteNetworks';
import { attemptFromRecord, verifyDiscoveryResult } from './verify';
import { GATE_FAILURE_MESSAGES } from './messages';

const O = '11111111-1111-4111-8111-111111111111';
const S = '33333333-3333-4333-8333-333333333333';
const P = '55555555-5555-4555-8555-555555555555';
const N1 = '66666666-6666-4666-8666-666666666666';
const N2 = '77777777-7777-4777-8777-777777777777';
const G1 = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const G3 = '2a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const G1_ENTRY: ExpectedGateway = { networkId: N1, gatewayId: G1, address: '192.168.1.1', mac: 'a4:2b:b0:11:22:9c' };
const G3_ENTRY: ExpectedGateway = { networkId: N1, gatewayId: G3, address: '10.1.2.100', mac: '00:1a:8c:00:00:01' };
const VN = { networkId: N1, gatewayId: G1, gatewayAddress: '192.168.1.1', gatewayMac: 'a4:2b:b0:11:22:9c', interfaceName: 'Ethernet' };
const PROFILE = { id: P, orgId: O, siteId: S, networkId: null, snmpGrantMode: 'unrestricted' as const, hasSavedSnmpSecrets: false };
const GUARDED_ATTEMPT = { mode: 'guarded' as const, allowedGatewayIds: [G1] };
const unverified = { ok: false, error: { code: 'network_unverified', message: GATE_FAILURE_MESSAGES.network_unverified } };

const verify = (o: Partial<Parameters<typeof verifyDiscoveryResult>[0]> = {}) =>
  verifyDiscoveryResult({ orgId: O, siteId: S, profileId: P, attempt: GUARDED_ATTEMPT, verifiedNetwork: VN, ...o });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(gate.loadGateProfile).mockResolvedValue(PROFILE);
  vi.mocked(gate.evaluateDiscoveryGate).mockResolvedValue({ kind: 'guarded', allowed: [G1_ENTRY, G3_ENTRY] });
});

describe('verifyDiscoveryResult (E10, spec 8.4)', () => {
  it.each([
    ['null attempt, site not gated', null, false, { ok: true, networkId: null }],
    ['null attempt, site gated', null, true, unverified],
    ['unrestricted, site not gated', { mode: 'unrestricted' as const, allowedGatewayIds: [] }, false, { ok: true, networkId: null }],
    ['unrestricted, site gated since', { mode: 'unrestricted' as const, allowedGatewayIds: [] }, true, unverified],
  ])('%s', async (_n, attempt, gated, expected) => {
    vi.mocked(siteNetworks.loadSiteGateState).mockResolvedValue({ gated, assignedNetworkIds: gated ? [N1] : [] });
    expect(await verify({ attempt, verifiedNetwork: undefined })).toEqual(expected);
    expect(gate.evaluateDiscoveryGate).not.toHaveBeenCalled();
  });

  it('guarded: a malformed verifiedNetwork is unverified', async () => {
    for (const verifiedNetwork of [undefined, null, 'x', { ...VN, gatewayMac: 'A4:2B:B0:11:22:9C' }, { ...VN, gatewayId: 'g-1' }]) {
      expect(await verify({ verifiedNetwork })).toEqual(unverified);
    }
  });

  it('guarded: a fingerprint outside the attempt is unverified', async () => {
    expect(await verify({ verifiedNetwork: { ...VN, gatewayId: G3, gatewayAddress: '10.1.2.100', gatewayMac: '00:1a:8c:00:00:01' } }))
      .toEqual(unverified);
  });

  it('guarded: a fingerprint no longer allowed now is unverified', async () => {
    vi.mocked(gate.evaluateDiscoveryGate).mockResolvedValue({ kind: 'guarded', allowed: [G3_ENTRY] });
    expect(await verify()).toEqual(unverified);
  });

  it('guarded: a current gate failure is unverified', async () => {
    vi.mocked(gate.evaluateDiscoveryGate).mockResolvedValue({ kind: 'fail', error: { code: 'no_network_assigned', message: 'x' } });
    expect(await verify()).toEqual(unverified);
    vi.mocked(gate.evaluateDiscoveryGate).mockResolvedValue({ kind: 'unrestricted' });
    expect(await verify()).toEqual(unverified);
  });

  it('guarded: an address or MAC that differs from the stored fingerprint is unverified', async () => {
    expect(await verify({ verifiedNetwork: { ...VN, gatewayAddress: '192.168.1.254' } })).toEqual(unverified);
    expect(await verify({ verifiedNetwork: { ...VN, gatewayMac: '3c:37:86:aa:bb:10' } })).toEqual(unverified);
  });

  it('guarded: a vanished profile is unverified', async () => {
    vi.mocked(gate.loadGateProfile).mockResolvedValue(null);
    expect(await verify()).toEqual(unverified);
    expect(gate.evaluateDiscoveryGate).not.toHaveBeenCalled();
  });

  it('guarded: a match returns the fingerprint\'s current network', async () => {
    vi.mocked(gate.evaluateDiscoveryGate).mockResolvedValue({ kind: 'guarded', allowed: [{ ...G1_ENTRY, networkId: N2 }] });
    expect(await verify()).toEqual({ ok: true, networkId: N2 });
    expect(gate.evaluateDiscoveryGate).toHaveBeenCalledWith({ orgId: O, siteId: S, profile: PROFILE, job: { orgId: O, siteId: S } });
  });

  it('guarded with no profile (the AI tool): the gate runs with profile null', async () => {
    expect(await verify({ profileId: null })).toEqual({ ok: true, networkId: N1 });
    expect(gate.loadGateProfile).not.toHaveBeenCalled();
    expect(gate.evaluateDiscoveryGate).toHaveBeenCalledWith({ orgId: O, siteId: S, profile: null });
  });
});

describe('attemptFromRecord', () => {
  it('null is null, an invalid record fails closed', () => {
    expect(attemptFromRecord(null)).toBeNull();
    expect(attemptFromRecord({ version: 2 })).toEqual({ mode: 'guarded', allowedGatewayIds: [] });
    expect(attemptFromRecord({
      version: 1, mode: 'guarded', agentId: 'a', deviceId: 'd', allowedNetworkIds: [N1], allowedGatewayIds: [G1], decidedAt: 'now',
    })).toEqual({ mode: 'guarded', allowedGatewayIds: [G1] });
  });
});
