import { describe, expect, it } from 'vitest';
import { buildSecurityProductInventory } from './securityComplianceReportProducts';

describe('buildSecurityProductInventory', () => {
  it('includes native Defender and endpoint-only SentinelOne', () => {
    const result = buildSecurityProductInventory([
      { product: 'Defender', category: 'antivirus', active: true, deviceIds: ['d1', 'd2'] },
      { product: 'SentinelOne', category: 'edr', active: true, deviceIds: ['d3'] },
    ]);

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ product: 'Defender', category: 'antivirus', deviceCoverage: 2 }),
        expect.objectContaining({ product: 'SentinelOne', category: 'edr', deviceCoverage: 1 }),
      ]),
    );
  });

  it('deduplicates managed and endpoint evidence by unique device id', () => {
    const [sentinelOne] = buildSecurityProductInventory([
      { product: 'SentinelOne', category: 'edr', active: true, deviceIds: ['d1', 'd2'] },
      { product: 'sentinel one', category: 'edr', active: false, deviceIds: ['d2', 'd3'] },
    ]);

    expect(sentinelOne).toMatchObject({
      product: 'SentinelOne',
      active: true,
      deviceCoverage: 3,
    });
  });

  it('keeps RTP-off endpoint evidence visible as inactive', () => {
    expect(
      buildSecurityProductInventory([
        { product: 'Defender', category: 'antivirus', active: false, deviceIds: ['d1'] },
      ]),
    ).toEqual([
      expect.objectContaining({ product: 'Defender', active: false, deviceCoverage: 1 }),
    ]);
  });

  it('reports RTP-on device count separately from install count (issue #2517)', () => {
    // Defender installed on 4 devices, real-time protection on for only 1.
    const [defender] = buildSecurityProductInventory([
      { product: 'Defender', category: 'antivirus', active: true, deviceIds: ['d1'] },
      { product: 'Defender', category: 'antivirus', active: false, deviceIds: ['d2'] },
      { product: 'Defender', category: 'antivirus', active: false, deviceIds: ['d3'] },
      { product: 'Defender', category: 'antivirus', active: false, deviceIds: ['d4'] },
    ]);

    // The OR-merged dot stays green (product IS in use) but the active-device
    // count is the honest coverage signal — 1, not 4.
    expect(defender).toMatchObject({
      product: 'Defender',
      active: true,
      deviceCoverage: 4,
      activeDeviceCoverage: 1,
    });
  });

  it('reports zero active devices when every device has RTP off', () => {
    const [defender] = buildSecurityProductInventory([
      { product: 'Defender', category: 'antivirus', active: false, deviceIds: ['d1'] },
      { product: 'Defender', category: 'antivirus', active: false, deviceIds: ['d2'] },
    ]);

    expect(defender).toMatchObject({
      active: false,
      deviceCoverage: 2,
      activeDeviceCoverage: 0,
    });
  });

  it('leaves activeDeviceCoverage null for integration evidence with no per-device data', () => {
    expect(
      buildSecurityProductInventory([
        { product: 'DNSFilter', category: 'dns_filtering', active: true, lastSyncStatus: 'ok' },
      ]),
    ).toEqual([
      expect.objectContaining({
        product: 'DNSFilter',
        active: true,
        deviceCoverage: null,
        activeDeviceCoverage: null,
      }),
    ]);
  });

  it('counts fully-active integration evidence as all devices active (no misleading subset)', () => {
    // SentinelOne is active on its whole managed set — active count equals install
    // count, so the renderer will not append an "N with real-time protection on"
    // subset note.
    const [sentinelOne] = buildSecurityProductInventory([
      { product: 'SentinelOne', category: 'edr', active: true, deviceIds: ['d1', 'd2', 'd3'] },
    ]);

    expect(sentinelOne).toMatchObject({
      product: 'SentinelOne',
      deviceCoverage: 3,
      activeDeviceCoverage: 3,
    });
  });
});
