import { describe, expect, it } from 'vitest';
import type { ExpectedGateway, ExpectedNetwork } from '@breeze/shared';
import { buildDiscoveryScanCommand, DISCOVERY_SCAN_FAMILY } from './scanCommand';

const J = '9c1d2e3f-4a5b-4c6d-8e7f-001122334455';
const payload = { jobId: J, subnets: ['192.168.1.0/24'], snmpCommunities: [] as string[] };
const gw = (i: number): ExpectedGateway => ({
  networkId: 'n-1', gatewayId: `g-${String(i).padStart(2, '0')}`, address: '192.168.1.1', mac: 'a4:2b:b0:11:22:9c',
});

describe('buildDiscoveryScanCommand (E8)', () => {
  it('names the base family callers pass', () => {
    expect(DISCOVERY_SCAN_FAMILY).toBe('network_discovery');
  });

  it('unrestricted: the unchanged network_discovery command', () => {
    expect(buildDiscoveryScanCommand({ commandId: J, payload, decision: { kind: 'unrestricted' } }))
      .toEqual({ id: J, type: 'network_discovery', payload });
  });

  it('guarded: the guarded type, the same payload plus expectedNetwork, input untouched', () => {
    const before = structuredClone(payload);
    const cmd = buildDiscoveryScanCommand({ commandId: J, payload, decision: { kind: 'guarded', allowed: [gw(1)] } });
    expect(cmd).toEqual({ id: J, type: 'network_discovery_guarded', payload: { ...payload, expectedNetwork: { gateways: [gw(1)] } } });
    expect(payload).toEqual(before);
  });

  it('cuts to 64, the agent\'s current fingerprints first, each group by gateway id', () => {
    const allowed = Array.from({ length: 70 }, (_, i) => gw(69 - i));
    const cmd = buildDiscoveryScanCommand({
      commandId: J, payload, decision: { kind: 'guarded', allowed: [...allowed, gw(3)] }, agentGatewayIds: ['g-68', 'g-05'],
    });
    const ids = (cmd.payload.expectedNetwork as ExpectedNetwork).gateways.map((g) => g.gatewayId);
    expect(ids).toHaveLength(64);
    expect(ids.slice(0, 4)).toEqual(['g-05', 'g-68', 'g-00', 'g-01']);
    expect(new Set(ids).size).toBe(64);
  });

  it('refuses a guarded decision with no allowed fingerprint', () => {
    expect(() => buildDiscoveryScanCommand({ commandId: J, payload, decision: { kind: 'guarded', allowed: [] } })).toThrow();
  });
});
