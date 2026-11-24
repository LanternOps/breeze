import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpectedGateway } from '@breeze/shared';

vi.mock('../../db', () => ({ db: {} }));
vi.mock('./siteNetworks', () => ({
  loadSiteGateState: vi.fn(),
  loadNetworkSiteId: vi.fn(),
  loadNetworkGateways: vi.fn(),
}));
vi.mock('./snmpGrants', () => ({ loadUsableGrantGateways: vi.fn() }));

import * as siteNetworks from './siteNetworks';
import * as snmpGrants from './snmpGrants';
import { evaluateDiscoveryGate, type GateProfile } from './gate';
import { GATE_FAILURE_MESSAGES } from './messages';

const O = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';
const S2 = '44444444-4444-4444-8444-444444444444';
const P = '55555555-5555-4555-8555-555555555555';
const N1 = '66666666-6666-4666-8666-666666666666';
const N2 = '77777777-7777-4777-8777-777777777777';

const base: GateProfile = { id: P, orgId: O, siteId: S, networkId: null, snmpGrantMode: 'unrestricted', hasSavedSnmpSecrets: false };
const gw = (id: string, net: string): ExpectedGateway => ({ networkId: net, gatewayId: id, address: '192.168.1.1', mac: 'a4:2b:b0:11:22:9c' });

function gated(flag: boolean, assignedNetworkIds: string[]) {
  vi.mocked(siteNetworks.loadSiteGateState).mockResolvedValue({ gated: flag, assignedNetworkIds });
}

beforeEach(() => {
  vi.resetAllMocks();
  gated(false, []);
  vi.mocked(siteNetworks.loadNetworkGateways).mockResolvedValue([]);
  vi.mocked(snmpGrants.loadUsableGrantGateways).mockResolvedValue([]);
});

describe('evaluateDiscoveryGate (spec 8.2 rows 1-6)', () => {
  it('row 1: a job whose org or site differs from the live profile fails profile_moved', async () => {
    for (const job of [{ orgId: O2, siteId: S }, { orgId: O, siteId: S2 }]) {
      expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: base, job }))
        .toEqual({ kind: 'fail', error: { code: 'profile_moved', message: GATE_FAILURE_MESSAGES.profile_moved } });
    }
    expect(siteNetworks.loadSiteGateState).not.toHaveBeenCalled();
    expect(siteNetworks.loadNetworkSiteId).not.toHaveBeenCalled();
  });

  it('row 2: a profile network that is unassigned or on another site fails network_not_assigned, gated or not', async () => {
    for (const flag of [true, false]) {
      for (const siteOfNetwork of [null, S2]) {
        gated(flag, [N2]);
        vi.mocked(siteNetworks.loadNetworkSiteId).mockResolvedValue(siteOfNetwork);
        expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: { ...base, networkId: N1 }, job: { orgId: O, siteId: S } }))
          .toMatchObject({ kind: 'fail', error: { code: 'network_not_assigned' } });
      }
    }
    expect(siteNetworks.loadNetworkSiteId).toHaveBeenCalledWith(O, N1);
  });

  it('row 3: a bound profile with saved secrets is guarded to its usable grants, gated or not', async () => {
    const grants = [gw('g-1', N1)];
    for (const flag of [true, false]) {
      gated(flag, flag ? [N1] : []);
      vi.mocked(snmpGrants.loadUsableGrantGateways).mockResolvedValue(grants);
      const decision = await evaluateDiscoveryGate({
        orgId: O, siteId: S, profile: { ...base, snmpGrantMode: 'bound', hasSavedSnmpSecrets: true },
      });
      expect(decision).toEqual({ kind: 'guarded', allowed: grants });
    }
    expect(snmpGrants.loadUsableGrantGateways).toHaveBeenCalledWith({ orgId: O, profileId: P, siteId: S, networkId: null });
    expect(siteNetworks.loadNetworkGateways).not.toHaveBeenCalled();
  });

  it('row 3: a bound profile with no usable grant fails credentials_need_reentry', async () => {
    gated(true, [N1]);
    vi.mocked(siteNetworks.loadNetworkGateways).mockResolvedValue([gw('g-1', N1)]);
    expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: { ...base, snmpGrantMode: 'bound', hasSavedSnmpSecrets: true } }))
      .toEqual({ kind: 'fail', error: { code: 'credentials_need_reentry', message: GATE_FAILURE_MESSAGES.credentials_need_reentry } });
  });

  it('T5 row 3a fails closed', async () => {
    gated(true, [N1]);
    expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: { ...base, hasSavedSnmpSecrets: true } }))
      .toMatchObject({ kind: 'fail', error: { code: 'credentials_need_reentry' } });
    expect(snmpGrants.loadUsableGrantGateways).not.toHaveBeenCalled();
    expect(siteNetworks.loadNetworkGateways).not.toHaveBeenCalled();
  });

  it('row 4: a site that is not gated is unrestricted', async () => {
    gated(false, []);
    for (const profile of [base, { ...base, snmpGrantMode: 'bound' as const }, { ...base, hasSavedSnmpSecrets: true }, null]) {
      expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile })).toEqual({ kind: 'unrestricted' });
    }
    expect(snmpGrants.loadUsableGrantGateways).not.toHaveBeenCalled();
  });

  it('row 5: a gated site with no assigned network fails no_network_assigned', async () => {
    gated(true, []);
    expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: base }))
      .toEqual({ kind: 'fail', error: { code: 'no_network_assigned', message: GATE_FAILURE_MESSAGES.no_network_assigned } });
  });

  it('row 6: allowed fingerprints are those of profile.networkId, else of every assigned network', async () => {
    gated(true, [N1, N2]);
    const all = [gw('g-1', N1), gw('g-2', N2)];
    vi.mocked(siteNetworks.loadNetworkGateways).mockResolvedValue(all);
    expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: base })).toEqual({ kind: 'guarded', allowed: all });
    expect(siteNetworks.loadNetworkGateways).toHaveBeenLastCalledWith(O, [N1, N2]);

    vi.mocked(siteNetworks.loadNetworkSiteId).mockResolvedValue(S);
    vi.mocked(siteNetworks.loadNetworkGateways).mockResolvedValue([all[1]!]);
    expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: { ...base, networkId: N2 } }))
      .toEqual({ kind: 'guarded', allowed: [all[1]] });
    expect(siteNetworks.loadNetworkGateways).toHaveBeenLastCalledWith(O, [N2]);
  });

  it('row 6: an assigned network with no fingerprints is guarded with nothing allowed', async () => {
    gated(true, [N1]);
    expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: base })).toEqual({ kind: 'guarded', allowed: [] });
  });

  it('S9 evaluation order decides the code', async () => {
    gated(true, []);
    vi.mocked(siteNetworks.loadNetworkSiteId).mockResolvedValue(null);
    expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: { ...base, networkId: N1 } }))
      .toMatchObject({ kind: 'fail', error: { code: 'network_not_assigned' } });
    expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: base }))
      .toMatchObject({ kind: 'fail', error: { code: 'no_network_assigned' } });
  });

  it('the AI tool (profile null) starts at row 4', async () => {
    gated(true, [N1]);
    const n1 = [gw('g-1', N1)];
    vi.mocked(siteNetworks.loadNetworkGateways).mockResolvedValue(n1);
    expect(await evaluateDiscoveryGate({ orgId: O, siteId: S, profile: null })).toEqual({ kind: 'guarded', allowed: n1 });
    expect(siteNetworks.loadNetworkGateways).toHaveBeenCalledWith(O, [N1]);
    expect(siteNetworks.loadNetworkSiteId).not.toHaveBeenCalled();
    expect(snmpGrants.loadUsableGrantGateways).not.toHaveBeenCalled();
  });
});
