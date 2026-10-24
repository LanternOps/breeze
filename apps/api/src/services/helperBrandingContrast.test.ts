import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  HELPER_CANVAS_DARK,
  HELPER_CANVAS_LIGHT,
  isReadableBrandColor,
  MIN_CONTRAST_RATIO,
  relativeLuminance,
} from './helperBrandingContrast';
import { validateBrandingValues } from './helperBranding';

describe('contrast maths (shared fixture vectors)', () => {
  it('uses WCAG AA 4.5:1 as the default threshold', () => {
    expect(MIN_CONTRAST_RATIO).toBe(4.5);
  });

  it('computes the WCAG reference values', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 3);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeLessThan(4.5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#2255AA', '#FBFAF9')).toBeCloseTo(contrastRatio('#FBFAF9', '#2255AA'), 10);
  });
});

describe('isReadableBrandColor', () => {
  it('accepts colours readable on the light canvas', () => {
    expect(contrastRatio('#112233', HELPER_CANVAS_LIGHT)).toBeGreaterThanOrEqual(4.5);
    expect(isReadableBrandColor('#112233')).toBe(true);
    expect(isReadableBrandColor('#2255AA')).toBe(true);
  });

  it('accepts colours readable only on the dark canvas', () => {
    expect(contrastRatio('#F0F0F0', HELPER_CANVAS_LIGHT)).toBeLessThan(4.5);
    expect(contrastRatio('#F0F0F0', HELPER_CANVAS_DARK)).toBeGreaterThanOrEqual(4.5);
    expect(isReadableBrandColor('#F0F0F0')).toBe(true);
  });

  it('rejects colours unreadable on both canvases', () => {
    expect(contrastRatio('#808080', HELPER_CANVAS_LIGHT)).toBeLessThan(4.5);
    expect(contrastRatio('#808080', HELPER_CANVAS_DARK)).toBeLessThan(4.5);
    expect(isReadableBrandColor('#808080')).toBe(false);
  });
});

describe('validateBrandingValues contrast', () => {
  it('rejects an unreadable colour with a contrast error', () => {
    expect(validateBrandingValues({ primaryColor: '#808080' })).toEqual({ ok: false, errors: ['contrast:primaryColor'] });
    expect(validateBrandingValues({ accentColor: '#808080' })).toEqual({ ok: false, errors: ['contrast:accentColor'] });
  });

  it('keeps a malformed colour as a format error, not a contrast error', () => {
    expect(validateBrandingValues({ primaryColor: 'red' })).toEqual({ ok: false, errors: ['color:primaryColor'] });
  });

  it('accepts readable colours', () => {
    expect(validateBrandingValues({ primaryColor: '#2255AA', accentColor: '#F0F0F0' })).toEqual({
      ok: true,
      value: { primaryColor: '#2255AA', accentColor: '#F0F0F0' },
    });
  });
});
