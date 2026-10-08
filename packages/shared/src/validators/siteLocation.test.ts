import { describe, it, expect } from 'vitest';
import { siteLocationPinSchema, siteLocationFieldsSchema } from './siteLocation';

describe('siteLocationPinSchema', () => {
  it.each([
    [{ latitude: 41.5, longitude: -81.7 }, true],
    [{ latitude: 90, longitude: 180, geofenceRadiusM: 1000 }, true],
    [{ latitude: 90.0001, longitude: 0 }, false],
    [{ latitude: 0, longitude: -180.5 }, false],
    [{ latitude: 0, longitude: 0, geofenceRadiusM: 49 }, false],
    [{ latitude: 0, longitude: 0, geofenceRadiusM: 150.5 }, false],
    [{ latitude: 'nope', longitude: 0 }, false],
    [{ latitude: 1 }, false],
    [{ latitude: 1, longitude: 2, extra: true }, false],
  ])('%j → %s', (input, ok) => {
    expect(siteLocationPinSchema.safeParse(input).success).toBe(ok);
  });
  it('rounds to 6 decimals', () => {
    expect(siteLocationPinSchema.parse({ latitude: 41.12345678, longitude: -81.98765432 }))
      .toEqual({ latitude: 41.123457, longitude: -81.987654 });
  });
});

describe('siteLocationFieldsSchema', () => {
  it('rejects only one of the pair', () => {
    expect(siteLocationFieldsSchema.safeParse({ latitude: 1 }).success).toBe(false);
    expect(siteLocationFieldsSchema.safeParse({ latitude: null, longitude: 2 }).success).toBe(false);
  });
  it('accepts clearing both', () => {
    expect(siteLocationFieldsSchema.safeParse({ latitude: null, longitude: null }).success).toBe(true);
  });
  it('accepts neither (partial update of other site fields)', () => {
    expect(siteLocationFieldsSchema.safeParse({}).success).toBe(true);
  });
});
