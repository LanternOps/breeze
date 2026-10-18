import { describe, expect, it } from 'vitest';

import { haversineMeters } from './geo';

describe('haversineMeters', () => {
  it('1° latitude ≈ 111.2 km', () => {
    expect(
      haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })
    ).toBeCloseTo(111_195, -2);
  });

  it('identical points = 0', () => {
    expect(
      haversineMeters({ latitude: 40.7, longitude: -74 }, { latitude: 40.7, longitude: -74 })
    ).toBe(0);
  });

  it('crosses the antimeridian: 179.999 / -179.999 ≈ 222 m at the equator', () => {
    const d = haversineMeters(
      { latitude: 0, longitude: 179.999 },
      { latitude: 0, longitude: -179.999 }
    );
    expect(d).toBeGreaterThan(210);
    expect(d).toBeLessThan(235);
  });

  it('is symmetric and finite for antipodal points', () => {
    const a = { latitude: 10, longitude: 20 };
    const b = { latitude: -10, longitude: -160 };
    expect(Number.isFinite(haversineMeters(a, b))).toBe(true);
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 3);
  });
});
