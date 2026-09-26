import { describe, expect, it } from 'vitest';
import { CONFIG_FEATURE_TYPES, RETIRED_CONFIG_FEATURE_TYPES, isRetiredConfigFeatureType } from './configFeatureTypes';

describe('config feature types after the alerting consolidation', () => {
  it('alert_rule and monitoring are retired, not canonical', () => {
    expect([...RETIRED_CONFIG_FEATURE_TYPES]).toEqual(['alert_rule', 'monitoring']);
    for (const t of RETIRED_CONFIG_FEATURE_TYPES) expect(CONFIG_FEATURE_TYPES as readonly string[]).not.toContain(t);
  });
  it('monitors stays canonical', () => { expect(CONFIG_FEATURE_TYPES).toContain('monitors'); });
  it('isRetiredConfigFeatureType narrows', () => {
    expect(isRetiredConfigFeatureType('alert_rule')).toBe(true);
    expect(isRetiredConfigFeatureType('monitors')).toBe(false);
    expect(isRetiredConfigFeatureType(undefined)).toBe(false);
  });
});
