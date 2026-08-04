import { describe, expect, it } from 'vitest';
import { vendorIdentityFromAttributes } from './catalogVendorIdentity';

describe('vendorIdentityFromAttributes', () => {
  it('normalizes an EC Express / nightly distributor shape', () => {
    expect(vendorIdentityFromAttributes({
      distributor: {
        source: 'td_synnex_price_file', synnexSku: '7724459', mfgPartNo: 'JL679A',
        manufacturer: 'HPE Aruba', raw: { manufacturer: 'IGNORED when top-level set' },
      },
    })).toEqual({ procurementSource: 'td_synnex', vendorSku: '7724459', manufacturer: 'HPE Aruba', mfgPartNo: 'JL679A' });
  });

  it('falls back to raw.manufacturer for pre-Task-4 EC imports', () => {
    expect(vendorIdentityFromAttributes({
      distributor: { source: 'td_synnex_ec_express', synnexSku: '123', mfgPartNo: null, raw: { manufacturer: 'Lenovo' } },
    })).toEqual({ procurementSource: 'td_synnex', vendorSku: '123', manufacturer: 'Lenovo', mfgPartNo: null });
  });

  it('normalizes the Digital Bridge provider shape', () => {
    expect(vendorIdentityFromAttributes({
      distributor: { provider: 'td_synnex_digital_bridge', sku: 'DB-1', manufacturerPartNumber: 'MPN-9', vendor: 'Cisco' },
    })).toEqual({ procurementSource: 'td_synnex', vendorSku: 'DB-1', manufacturer: 'Cisco', mfgPartNo: 'MPN-9' });
  });

  it('normalizes the Pax8 shape', () => {
    expect(vendorIdentityFromAttributes({
      pax8: { source: 'pax8', vendorName: 'Microsoft', vendorSku: 'CFQ7TTC0LH18' },
    })).toEqual({ procurementSource: 'pax8', vendorSku: 'CFQ7TTC0LH18', manufacturer: 'Microsoft', mfgPartNo: null });
  });

  it('returns all-null for manual/absent/malformed attributes', () => {
    const empty = { procurementSource: null, vendorSku: null, manufacturer: null, mfgPartNo: null };
    expect(vendorIdentityFromAttributes(null)).toEqual(empty);
    expect(vendorIdentityFromAttributes({})).toEqual(empty);
    expect(vendorIdentityFromAttributes({ distributor: 'not-an-object' })).toEqual(empty);
    expect(vendorIdentityFromAttributes(42)).toEqual(empty);
  });

  it('clamps values to the column widths', () => {
    const out = vendorIdentityFromAttributes({ pax8: { vendorName: 'x'.repeat(300), vendorSku: 'y'.repeat(150) } });
    expect(out.manufacturer!.length).toBe(255);
    expect(out.vendorSku!.length).toBe(100);
  });

  it('rejects whitespace-only strings as null', () => {
    const empty = { procurementSource: null, vendorSku: null, manufacturer: null, mfgPartNo: null };
    expect(vendorIdentityFromAttributes({
      pax8: { vendorName: '   ', vendorSku: '\t\n  ' },
    })).toEqual(empty);
    expect(vendorIdentityFromAttributes({
      distributor: { source: 'td_synnex_ec_express', synnexSku: '  ', mfgPartNo: null, raw: { manufacturer: '' } },
    })).toEqual(empty);
  });

  it('rejects non-string values in vendor fields as null', () => {
    const empty = { procurementSource: null, vendorSku: null, manufacturer: null, mfgPartNo: null };
    expect(vendorIdentityFromAttributes({
      pax8: { vendorName: 12345, vendorSku: ['array'] },
    })).toEqual(empty);
    expect(vendorIdentityFromAttributes({
      distributor: { source: 'td_synnex_ec_express', synnexSku: null, mfgPartNo: { object: true }, raw: { manufacturer: 42 } },
    })).toEqual(empty);
    expect(vendorIdentityFromAttributes({
      distributor: { provider: 'td_synnex_digital_bridge', sku: undefined, vendor: false, manufacturerPartNumber: 99.9 },
    })).toEqual(empty);
  });

  it('rejects arrays as containers and returns all-null', () => {
    const empty = { procurementSource: null, vendorSku: null, manufacturer: null, mfgPartNo: null };
    expect(vendorIdentityFromAttributes({
      pax8: ['not', 'an', 'object'],
    })).toEqual(empty);
    expect(vendorIdentityFromAttributes({
      distributor: ['also', 'not', 'an', 'object'],
    })).toEqual(empty);
  });
});
