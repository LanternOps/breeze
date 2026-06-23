import { describe, it, expect } from 'vitest';
import { computeFdbAttachments, MAX_MACS_PER_ACCESS_PORT } from './reconcileTopology';
import type { DeviceAdjacency } from './discoveryWorker';

function makeAdj(overrides: Partial<DeviceAdjacency>): DeviceAdjacency {
  return {
    sourceDeviceIp: '10.0.0.1',
    lldp: [],
    cdp: [],
    fdb: [],
    ...overrides,
  };
}

describe('computeFdbAttachments', () => {
  it('attaches a host on a non-uplink access port', () => {
    const adj = makeAdj({
      fdb: [{ mac: 'aa:bb:cc:dd:ee:ff', bridgePort: 5, ifName: 'Gi0/5', vlan: 100 }],
    });
    const macToAssetId = new Map<string, string>([['aabbccddeeff', 'host-1']]);

    const r = computeFdbAttachments(adj, 'switch-1', macToAssetId);

    expect(r.attachments).toEqual([
      { switchAssetId: 'switch-1', hostAssetId: 'host-1', interfaceName: 'Gi0/5', vlan: 100 },
    ]);
    expect(r.skippedUnknownMac).toBe(0);
    expect(r.skippedUplinkPort).toBe(0);
    expect(r.skippedOverThreshold).toBe(0);
  });

  it('excludes FDB rows on an uplink port (LLDP neighbor on that port)', () => {
    const adj = makeAdj({
      lldp: [
        { localPort: '5', localIfName: 'Gi0/5', remoteChassisId: 'aa:11', remotePortId: 'p1' },
      ],
      fdb: [{ mac: 'aa:bb:cc:dd:ee:ff', bridgePort: 5, ifName: 'Gi0/5', vlan: 100 }],
    });
    const macToAssetId = new Map<string, string>([['aabbccddeeff', 'host-1']]);

    const r = computeFdbAttachments(adj, 'switch-1', macToAssetId);

    expect(r.attachments).toHaveLength(0);
    expect(r.skippedUplinkPort).toBe(1);
  });

  it('excludes FDB rows on a CDP uplink port', () => {
    const adj = makeAdj({
      cdp: [{ localPort: 'Gi0/5', remoteDeviceId: 'sw2', remotePortId: 'Gi0/1' }],
      fdb: [{ mac: 'aa:bb:cc:dd:ee:ff', bridgePort: 5, ifName: 'Gi0/5', vlan: 100 }],
    });
    const macToAssetId = new Map<string, string>([['aabbccddeeff', 'host-1']]);

    const r = computeFdbAttachments(adj, 'switch-1', macToAssetId);

    expect(r.attachments).toHaveLength(0);
    expect(r.skippedUplinkPort).toBe(1);
  });

  it('skips a MAC that is not in the asset inventory', () => {
    const adj = makeAdj({
      fdb: [{ mac: 'aa:bb:cc:dd:ee:ff', bridgePort: 5, ifName: 'Gi0/5' }],
    });
    const macToAssetId = new Map<string, string>();

    const r = computeFdbAttachments(adj, 'switch-1', macToAssetId);

    expect(r.attachments).toHaveLength(0);
    expect(r.skippedUnknownMac).toBe(1);
  });

  it('skips a port whose MAC count exceeds the threshold (latent uplink)', () => {
    const fdb = [];
    const macToAssetId = new Map<string, string>();
    for (let i = 0; i < 17; i++) {
      const mac = `aa:bb:cc:dd:ee:${i.toString(16).padStart(2, '0')}`;
      fdb.push({ mac, bridgePort: 24, ifName: 'Gi0/24' });
      macToAssetId.set(mac.replace(/[^0-9a-f]/g, ''), `host-${i}`);
    }
    const adj = makeAdj({ fdb });

    const r = computeFdbAttachments(adj, 'switch-1', macToAssetId, 16);

    expect(r.attachments).toHaveLength(0);
    expect(r.skippedOverThreshold).toBe(1);
    expect(r.skippedUnknownMac).toBe(0);
  });

  it('matches a MAC regardless of separator format', () => {
    const adj = makeAdj({
      fdb: [{ mac: 'AA-BB-CC-DD-EE-FF', bridgePort: 5, ifName: 'Gi0/5' }],
    });
    const macToAssetId = new Map<string, string>([['aabbccddeeff', 'host-1']]);

    const r = computeFdbAttachments(adj, 'switch-1', macToAssetId);

    expect(r.attachments).toEqual([
      { switchAssetId: 'switch-1', hostAssetId: 'host-1', interfaceName: 'Gi0/5', vlan: null },
    ]);
  });

  it('returns no attachments and does not throw when the switch is not in inventory', () => {
    const adj = makeAdj({
      fdb: [{ mac: 'aa:bb:cc:dd:ee:ff', bridgePort: 5, ifName: 'Gi0/5' }],
    });
    const macToAssetId = new Map<string, string>([['aabbccddeeff', 'host-1']]);

    const r = computeFdbAttachments(adj, null, macToAssetId);

    expect(r.attachments).toHaveLength(0);
  });

  it('exports a sane default threshold', () => {
    expect(MAX_MACS_PER_ACCESS_PORT).toBe(16);
  });
});
