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
});
