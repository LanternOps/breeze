import { describe, it, expect } from 'vitest';
import {
  requiredAssurance,
  elevationRiskTierToName,
  DEFAULT_ASSURANCE_FLOOR,
} from './assuranceLevel';

describe('requiredAssurance', () => {
  it('maps each tier to the Breeze default floor', () => {
    expect(requiredAssurance('low')).toBe(1);
    expect(requiredAssurance('medium')).toBe(2);
    expect(requiredAssurance('high')).toBe(3);
    expect(requiredAssurance('critical')).toBe(4);
  });

  it('lets a partner override RAISE a rung', () => {
    expect(requiredAssurance('low', { low: 3 })).toBe(3);
    expect(requiredAssurance('medium', { medium: 4 })).toBe(4);
  });

  it('ignores an override that would LOWER below the floor', () => {
    expect(requiredAssurance('high', { high: 1 })).toBe(3);
    expect(requiredAssurance('critical', { critical: 2 })).toBe(4);
  });

  it('ignores a null/empty override map', () => {
    expect(requiredAssurance('medium', null)).toBe(2);
    expect(requiredAssurance('medium', {})).toBe(2);
  });

  it('exposes the default floor for reuse', () => {
    expect(DEFAULT_ASSURANCE_FLOOR).toEqual({ low: 1, medium: 2, high: 3, critical: 4 });
  });
});

describe('elevationRiskTierToName', () => {
  it('maps the elevation smallint to the canonical tier name', () => {
    expect(elevationRiskTierToName(1)).toBe('low');
    expect(elevationRiskTierToName(2)).toBe('medium');
    expect(elevationRiskTierToName(3)).toBe('high');
    expect(elevationRiskTierToName(4)).toBe('critical');
  });

  it('defaults null/0/out-of-range to medium (never silently low)', () => {
    expect(elevationRiskTierToName(null)).toBe('medium');
    expect(elevationRiskTierToName(undefined)).toBe('medium');
    expect(elevationRiskTierToName(0)).toBe('medium');
    expect(elevationRiskTierToName(99)).toBe('medium');
  });
});
