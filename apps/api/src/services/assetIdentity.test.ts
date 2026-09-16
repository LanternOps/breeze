import { describe, expect, it } from 'vitest';
import { maskOidShapedModel, nicVendorFromMac } from './assetIdentity';

describe('maskOidShapedModel', () => {
  it.each([
    ['.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1'],
    ['1.3.6.1.4.1.253.8.62.1.37.1.4.1.1'],
    ['1.3.6.1.4.1.9.1.1745'],
    ['1.2'],
  ])('masks the raw sysObjectID %s', (model) => {
    expect(maskOidShapedModel(model)).toBeNull();
  });

  it.each([
    ['Xerox C325 Color MFP'],
    ['C3750'],
    // A real model number that merely contains digits and dots must survive.
    ['HL-L2350DW'],
    ['UAP-AC-PRO'],
    ['ET-2.5G'],
    // Only OIDs rooted at 1 (iso) are masked; a version-looking string is not.
    ['2.4.1'],
    ['1'],
  ])('keeps the real model %s', (model) => {
    expect(maskOidShapedModel(model)).toBe(model);
  });

  it('passes null and empty through', () => {
    expect(maskOidShapedModel(null)).toBeNull();
    expect(maskOidShapedModel('')).toBeNull();
  });
});

describe('nicVendorFromMac', () => {
  it('returns the OUI vendor', () => {
    expect(nicVendorFromMac('00:20:00:11:22:33')).toMatch(/LEXMARK/i);
  });

  it('returns null for null, a malformed MAC and a sentinel', () => {
    expect(nicVendorFromMac(null)).toBeNull();
    expect(nicVendorFromMac('not-a-mac')).toBeNull();
    expect(nicVendorFromMac('')).toBeNull();
  });
});
