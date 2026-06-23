import { describe, it, expect } from 'vitest';
import { buildInfraEdges, computeWalkedSourceIds } from './reconcileTopology';
import type { DeviceAdjacency } from './discoveryWorker';

const idx = {
  byMac: new Map([['aabbccddeeff', 'asset-core'], ['112233445566', 'asset-edge']]),
  byIp: new Map([['10.0.0.1', 'asset-edge'], ['10.0.0.254', 'asset-core']]),
  bySysName: new Map([['core', 'asset-core']]),
};

describe('buildInfraEdges', () => {
  it('builds an LLDP infra edge matched by chassis MAC', () => {
    const adj: DeviceAdjacency[] = [{
      sourceDeviceIp: '10.0.0.1', lldp: [{ localPort: '1', localIfName: 'Gi0/1', remoteChassisId: 'aa:bb:cc:dd:ee:ff', remotePortId: 'Gi0/24', remoteSysName: 'core' }],
      cdp: [], fdb: [],
    }];
    const edges = buildInfraEdges('org-1', 'site-1', adj, idx as any);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceId: 'asset-edge', targetId: 'asset-core',
      method: 'lldp', confidence: 'high', connectionType: 'infra', interfaceName: 'Gi0/1',
    });
  });
  it('skips neighbors not in inventory', () => {
    const adj: DeviceAdjacency[] = [{
      sourceDeviceIp: '10.0.0.1', lldp: [{ localPort: '2', remoteChassisId: 'de:ad:be:ef:00:00', remotePortId: 'x' }], cdp: [], fdb: [],
    }];
    expect(buildInfraEdges('org-1', 'site-1', adj, idx as any)).toHaveLength(0);
  });
  it('skips the whole block when the source IP is unresolved', () => {
    const adj: DeviceAdjacency[] = [{
      sourceDeviceIp: '192.168.99.99', lldp: [{ localPort: '1', remoteChassisId: 'aa:bb:cc:dd:ee:ff', remotePortId: 'y' }], cdp: [], fdb: [],
    }];
    expect(buildInfraEdges('org-1', 'site-1', adj, idx as any)).toHaveLength(0);
  });
  it('builds a CDP edge matched by remote address IP', () => {
    const adj: DeviceAdjacency[] = [{
      sourceDeviceIp: '10.0.0.1', lldp: [], cdp: [{ localPort: '3', remoteDeviceId: 'core', remotePortId: 'Gi0/2', remoteAddress: '10.0.0.254' }], fdb: [],
    }];
    const edges = buildInfraEdges('org-1', 'site-1', adj, idx as any);
    expect(edges[0]).toMatchObject({ sourceId: 'asset-edge', targetId: 'asset-core', method: 'cdp', confidence: 'high' });
  });
  it('dedupes identical source/target/method within one scan', () => {
    const adj: DeviceAdjacency[] = [{
      sourceDeviceIp: '10.0.0.1',
      lldp: [
        { localPort: '1', remoteChassisId: 'aa:bb:cc:dd:ee:ff', remotePortId: 'a' },
        { localPort: '1', remoteChassisId: 'aa:bb:cc:dd:ee:ff', remotePortId: 'a' },
      ], cdp: [], fdb: [],
    }];
    expect(buildInfraEdges('org-1', 'site-1', adj, idx as any)).toHaveLength(1);
  });
});

describe('computeWalkedSourceIds', () => {
  it('resolves a walked source by mgmt IP even when it reported zero neighbors', () => {
    const adj: DeviceAdjacency[] = [{ sourceDeviceIp: '10.0.0.1', lldp: [], cdp: [], fdb: [] }];
    const walked = computeWalkedSourceIds(adj, idx as any);
    expect(walked.has('asset-edge')).toBe(true);
    expect(walked.size).toBe(1);
  });

  it('resolves a walked source by chassis MAC when the IP is unknown', () => {
    const adj: DeviceAdjacency[] = [{
      sourceDeviceIp: '192.168.99.99', sourceChassisId: 'aa:bb:cc:dd:ee:ff',
      lldp: [], cdp: [], fdb: [],
    }];
    const walked = computeWalkedSourceIds(adj, idx as any);
    expect(walked.has('asset-core')).toBe(true);
  });

  it('contributes nothing for a source that resolves to no asset', () => {
    const adj: DeviceAdjacency[] = [{ sourceDeviceIp: '192.168.99.99', lldp: [], cdp: [], fdb: [] }];
    expect(computeWalkedSourceIds(adj, idx as any).size).toBe(0);
  });

  it('is empty for an empty scan', () => {
    expect(computeWalkedSourceIds([], idx as any).size).toBe(0);
  });
});
