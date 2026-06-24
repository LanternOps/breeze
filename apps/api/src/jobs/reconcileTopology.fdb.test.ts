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

  it('boundary: attaches exactly maxMacsPerPort MACs but skips at maxMacsPerPort+1', () => {
    const N = MAX_MACS_PER_ACCESS_PORT;
    const makeFdb = (count: number) => {
      const fdb = [];
      const macToAssetId = new Map<string, string>();
      for (let i = 0; i < count; i++) {
        const mac = `aa:bb:cc:dd:ee:${i.toString(16).padStart(2, '0')}`;
        fdb.push({ mac, bridgePort: 24, ifName: 'Gi0/24' });
        macToAssetId.set(mac.replace(/[^0-9a-f]/g, ''), `host-${i}`);
      }
      return { fdb, macToAssetId };
    };

    // Exactly N MACs on one port → all N attach (N is allowed, not over-threshold).
    const atLimit = makeFdb(N);
    const rAt = computeFdbAttachments(makeAdj({ fdb: atLimit.fdb }), 'switch-1', atLimit.macToAssetId);
    expect(rAt.skippedOverThreshold).toBe(0);
    expect(rAt.attachments).toHaveLength(N);

    // N+1 MACs on one port → whole port skipped as a latent uplink.
    const overLimit = makeFdb(N + 1);
    const rOver = computeFdbAttachments(makeAdj({ fdb: overLimit.fdb }), 'switch-1', overLimit.macToAssetId);
    expect(rOver.skippedOverThreshold).toBe(1);
    expect(rOver.attachments).toHaveLength(0);
  });

  it('uplink mismatch: bridge-port number must NOT match an ifIndex-style localIfName (cross-space false positive)', () => {
    // Regression for the numbering bug: the uplink is declared on ifName "Gi0/2"
    // but the LLDP agent ALSO resolved that uplink's ifName-space token to the
    // numeric string "5" via localIfName (some agents fill localIfName with an
    // ifIndex/dot1d index). An UNRELATED access host sits on a different port
    // that happens to carry dot1d bridgePort=5 with its own ifName "Gi0/9".
    // The old matcher put localIfName "5" into the same flat set it tested
    // String(bridgePort)="5" against → the access host was wrongly suppressed.
    // The robust matcher only tests the bare bridgePort against the raw
    // localPort space, never against localIfName, so the host attaches.
    const adj = makeAdj({
      lldp: [{ localPort: 'Gi0/2', localIfName: '5', remoteChassisId: 'aa:11', remotePortId: 'p1' }],
      fdb: [{ mac: 'aa:bb:cc:dd:ee:ff', bridgePort: 5, ifName: 'Gi0/9' }],
    });
    const macToAssetId = new Map<string, string>([['aabbccddeeff', 'host-1']]);

    const r = computeFdbAttachments(adj, 'switch-1', macToAssetId);

    expect(r.skippedUplinkPort).toBe(0);
    expect(r.attachments).toEqual([
      { switchAssetId: 'switch-1', hostAssetId: 'host-1', interfaceName: 'Gi0/9', vlan: null },
    ]);
  });

  it('uplink match: FDB resolved ifName matches an LLDP localIfName uplink (consistent ifName space)', () => {
    // The robust matcher must catch an uplink declared via localIfName even when
    // the FDB row carries a bridgePort that has no relation to the LLDP localPort.
    const adj = makeAdj({
      lldp: [{ localPort: '99', localIfName: 'Gi0/5', remoteChassisId: 'aa:11', remotePortId: 'p1' }],
      fdb: [{ mac: 'aa:bb:cc:dd:ee:ff', bridgePort: 12, ifName: 'Gi0/5' }],
    });
    const macToAssetId = new Map<string, string>([['aabbccddeeff', 'host-1']]);

    const r = computeFdbAttachments(adj, 'switch-1', macToAssetId);

    expect(r.skippedUplinkPort).toBe(1);
    expect(r.attachments).toHaveLength(0);
  });

  it('uplink match: bridge-port number matches an LLDP localPort reported in bridge-port space', () => {
    // Some agents report the LLDP local port AS the dot1d bridge-port number and
    // do not resolve an ifName. An FDB row with that same bridgePort and no
    // ifName must be suppressed via the consistent localPort space.
    const adj = makeAdj({
      lldp: [{ localPort: '5', remoteChassisId: 'aa:11', remotePortId: 'p1' }],
      fdb: [{ mac: 'aa:bb:cc:dd:ee:ff', bridgePort: 5 }],
    });
    const macToAssetId = new Map<string, string>([['aabbccddeeff', 'host-1']]);

    const r = computeFdbAttachments(adj, 'switch-1', macToAssetId);

    expect(r.skippedUplinkPort).toBe(1);
    expect(r.attachments).toHaveLength(0);
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
