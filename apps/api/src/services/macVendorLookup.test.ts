import { describe, it, expect, vi } from 'vitest';

// `toVendor` reads a real, versioned OUI database — asserting against its live
// output would make these tests depend on that dataset's exact contents (and
// break on a routine package bump unrelated to our logic). Mock it so
// lookupMacVendor's own behaviour (trimming, sentinel filtering, error
// handling) is what's under test.
vi.mock('@network-utils/vendor-lookup', () => ({
  toVendor: vi.fn(),
}));

import { toVendor } from '@network-utils/vendor-lookup';
import { lookupMacVendor, inferAssetTypeFromVendor } from './macVendorLookup';

describe('inferAssetTypeFromVendor', () => {
  // Regression test for #3187: Ubiquiti ships switches (UniFi Switch),
  // gateways (UDM/USG), cameras (Protect) and access points all under one
  // OUI, so the vendor string alone cannot identify the product line. Mapping
  // it to 'access_point' mislabelled three product lines out of four, and
  // because the UniFi sync stamps manufacturer='Ubiquiti' on every row it
  // touches, this rule fired on gear the UniFi controller had already
  // classified correctly — flapping detected_asset_type indefinitely.
  it('returns null for Ubiquiti — a multi-line vendor removed by #3187', () => {
    expect(inferAssetTypeFromVendor('Ubiquiti Inc')).toBeNull();
    expect(inferAssetTypeFromVendor('Ubiquiti Networks')).toBeNull();
  });

  it('still maps the remaining single-purpose vendors', () => {
    expect(inferAssetTypeFromVendor('Ruckus Wireless')).toBe('access_point');
    expect(inferAssetTypeFromVendor('Fortinet')).toBe('firewall');
    expect(inferAssetTypeFromVendor('Synology')).toBe('nas');
    expect(inferAssetTypeFromVendor('Hikvision')).toBe('camera');
    expect(inferAssetTypeFromVendor('Brother Industries')).toBe('printer');
    expect(inferAssetTypeFromVendor('Yealink')).toBe('phone');
    expect(inferAssetTypeFromVendor('Espressif')).toBe('iot');
  });

  it('is case-insensitive', () => {
    expect(inferAssetTypeFromVendor('ruckus wireless')).toBe('access_point');
    expect(inferAssetTypeFromVendor('FORTINET')).toBe('firewall');
    expect(inferAssetTypeFromVendor('HiKvIsIoN')).toBe('camera');
  });

  it('matches on a substring, not just an exact vendor string', () => {
    expect(inferAssetTypeFromVendor('Fortinet Inc.')).toBe('firewall');
    expect(inferAssetTypeFromVendor('Hangzhou Hikvision Digital Technology')).toBe('camera');
  });

  it('returns null for an unrecognised vendor', () => {
    expect(inferAssetTypeFromVendor('Acme Networking Corp')).toBeNull();
  });

  it('returns null for null, undefined, and empty string', () => {
    expect(inferAssetTypeFromVendor(null)).toBeNull();
    expect(inferAssetTypeFromVendor(undefined)).toBeNull();
    expect(inferAssetTypeFromVendor('')).toBeNull();
  });
});

describe('lookupMacVendor', () => {
  it('returns null without calling toVendor for null, undefined, or empty input', () => {
    expect(lookupMacVendor(null)).toBeNull();
    expect(lookupMacVendor(undefined)).toBeNull();
    expect(lookupMacVendor('')).toBeNull();
    expect(toVendor).not.toHaveBeenCalled();
  });

  it('trims the MAC before looking it up', () => {
    vi.mocked(toVendor).mockReturnValue('Cisco Systems');

    lookupMacVendor('  aa:bb:cc:dd:ee:ff  ');

    expect(toVendor).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff');
  });

  it('returns the vendor string for a real vendor', () => {
    vi.mocked(toVendor).mockReturnValue('Cisco Systems');

    expect(lookupMacVendor('aa:bb:cc:dd:ee:ff')).toBe('Cisco Systems');
  });

  it('returns null when toVendor finds no match', () => {
    vi.mocked(toVendor).mockReturnValue(undefined as unknown as string);

    expect(lookupMacVendor('aa:bb:cc:dd:ee:ff')).toBeNull();
  });

  it.each(['<random MAC>', '<unknown>', '<private>'])(
    'filters out the sentinel value %s',
    (sentinel) => {
      vi.mocked(toVendor).mockReturnValue(sentinel);

      expect(lookupMacVendor('02:00:00:00:00:00')).toBeNull();
    },
  );

  it('returns null instead of throwing when toVendor throws', () => {
    vi.mocked(toVendor).mockImplementation(() => {
      throw new Error('malformed MAC');
    });

    expect(lookupMacVendor('not-a-mac')).toBeNull();
  });
});
