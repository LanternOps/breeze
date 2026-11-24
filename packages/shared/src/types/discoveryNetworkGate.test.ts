import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_GATE_FAILURE_CODES, EXPECTED_GATEWAYS_MAX, GUARDED_COMMAND_TYPES,
  isSharedVirtualRouterMac, verifiedNetworkSchema,
} from '../index';

const N = '7f6d2c1e-3b4a-4c5d-8e9f-0a1b2c3d4e5f', G = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const valid = { networkId: N, gatewayId: G, gatewayAddress: '192.168.1.1', gatewayMac: 'a4:2b:b0:11:22:9c', interfaceName: 'Ethernet' };

describe('discoveryNetworkGate shared contract', () => {
  it('fixes the codes, the cap and the guarded type name', () => {
    expect(DISCOVERY_GATE_FAILURE_CODES).toEqual(['profile_moved', 'network_not_assigned', 'credentials_need_reentry',
      'no_network_assigned', 'no_agent_on_network', 'agent_not_eligible', 'network_mismatch', 'network_changed', 'network_unverified']);
    expect(EXPECTED_GATEWAYS_MAX).toBe(64);
    expect(GUARDED_COMMAND_TYPES).toEqual({ network_discovery: 'network_discovery_guarded' });
  });
  it('isSharedVirtualRouterMac matches the VRRP and HSRP prefixes in any case or separator', () => {
    expect(isSharedVirtualRouterMac('00:00:5e:00:01:0a')).toBe(true);
    expect(isSharedVirtualRouterMac('00-00-0C-07-AC-01')).toBe(true);
    expect(isSharedVirtualRouterMac('a4:2b:b0:11:22:9c')).toBe(false);
    expect(isSharedVirtualRouterMac('00:00:5e:00:02:0a')).toBe(false);
    expect(isSharedVirtualRouterMac('not-a-mac')).toBe(false);
  });
  it('verifiedNetworkSchema accepts the C3 shape and nothing looser', () => {
    expect(verifiedNetworkSchema.safeParse(valid).success).toBe(true);
    for (const bad of [{ ...valid, networkId: 'x' }, { ...valid, gatewayAddress: '::1' },
      { ...valid, gatewayAddress: '192.168.1.0/24' }, { ...valid, gatewayMac: 'A4:2B:B0:11:22:9C' },
      { ...valid, gatewayMac: 'a4-2b-b0-11-22-9c' }, { ...valid, interfaceName: '' },
      { ...valid, interfaceName: 'x'.repeat(129) }, { ...valid, gatewayId: undefined }, null, 'x'])
      expect(verifiedNetworkSchema.safeParse(bad).success).toBe(false);
  });
});
