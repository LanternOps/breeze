import { describe, expect, it } from 'vitest';
import {
  MAX_DISCOVERY_SUBNET_HOSTS,
  discoverySubnetHostCount,
  discoverySubnetTooLargeMessage,
  findOversizedDiscoverySubnet,
} from './discoverySubnetLimit';

describe('discoverySubnetLimit', () => {
  it('matches the agent limit', () => {
    expect(MAX_DISCOVERY_SUBNET_HOSTS).toBe(65_536);
  });

  it('sizes CIDRs and bare IPs', () => {
    expect(discoverySubnetHostCount('10.0.0.0/24')).toBe(256);
    expect(discoverySubnetHostCount('10.0.0.0/16')).toBe(65_536);
    expect(discoverySubnetHostCount('10.0.0.0/15')).toBe(131_072);
    expect(discoverySubnetHostCount('0.0.0.0/0')).toBe(2 ** 32);
    expect(discoverySubnetHostCount('10.0.0.5')).toBe(1);
    expect(discoverySubnetHostCount('nonsense')).toBeNull();
    expect(discoverySubnetHostCount('10.0.0.0/40')).toBeNull();
  });

  it('flags only entries above the limit (a /16 is allowed, a /15 is not)', () => {
    expect(findOversizedDiscoverySubnet(['10.0.0.0/16', '192.168.1.0/24'])).toBeNull();
    expect(findOversizedDiscoverySubnet(['192.168.1.0/24', ' 10.0.0.0/15 '])).toBe('10.0.0.0/15');
    expect(findOversizedDiscoverySubnet(['0.0.0.0/0'])).toBe('0.0.0.0/0');
  });

  it('names the limit in the message', () => {
    expect(discoverySubnetTooLargeMessage('0.0.0.0/0')).toContain('65,536');
    expect(discoverySubnetTooLargeMessage('0.0.0.0/0')).toContain('0.0.0.0/0');
  });
});
