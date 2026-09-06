import { describe, expect, it } from 'vitest';
import { portalLandingPath } from './landing';

describe('portalLandingPath', () => {
  it('uses dashboard only when explicitly enabled', () => {
    expect(portalLandingPath({
      enableDashboard: true,
    })).toBe('/dashboard');
    expect(portalLandingPath({
      enableDashboard: false,
    })).toBe('/quotes');
    expect(portalLandingPath({})).toBe('/quotes');
  });
});
