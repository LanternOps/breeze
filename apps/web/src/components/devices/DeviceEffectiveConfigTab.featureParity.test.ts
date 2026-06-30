import { describe, it, expect } from 'vitest';
import { CONFIG_FEATURE_TYPES } from '@breeze/shared';

import { ALL_FEATURE_TYPES, EFFECTIVE_CONFIG_EXCLUDED_FEATURE_TYPES } from './DeviceEffectiveConfigTab';

// Guards against the cross-package drift in issue #2004: the device Effective
// Configuration tab must render exactly the canonical CONFIG_FEATURE_TYPES
// (single source of truth in @breeze/shared) minus remote_access/pam, which it
// can't represent (they apply a value even when unassigned — see the FeatureType
// comment in DeviceEffectiveConfigTab.tsx). Mirrors the api-side enum parity test.
describe('device Effective Config tab feature-type parity (#2004)', () => {
  it('renders exactly the canonical feature types minus the documented exclusions', () => {
    const expected = CONFIG_FEATURE_TYPES.filter(
      (t) => !(EFFECTIVE_CONFIG_EXCLUDED_FEATURE_TYPES as readonly string[]).includes(t),
    ).sort();
    const actual = [...ALL_FEATURE_TYPES].sort();
    expect(actual).toEqual([...expected]);
  });

  it('only excludes feature types that actually exist in the canonical registry', () => {
    // Keeps the Exclude<…> in DeviceEffectiveConfigTab.tsx honest: a typo'd or
    // stale exclusion would silently no-op at the type level.
    for (const excluded of EFFECTIVE_CONFIG_EXCLUDED_FEATURE_TYPES) {
      expect(CONFIG_FEATURE_TYPES).toContain(excluded);
    }
  });
});
