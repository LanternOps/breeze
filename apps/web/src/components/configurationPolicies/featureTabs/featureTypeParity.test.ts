import { describe, it, expect } from 'vitest';
import { CONFIG_FEATURE_TYPES } from '@breeze/shared';

import { FEATURE_META, EDITOR_EXCLUDED_FEATURE_TYPES } from './types';

// Guards against the cross-package drift in issue #2004: the config-policy
// editor's feature tabs must stay in lockstep with the canonical
// CONFIG_FEATURE_TYPES registry (single source of truth in @breeze/shared),
// minus the documented exclusions. Mirrors the api-side enum parity test in
// apps/api/src/services/policyBaselineDefaults.test.ts.
describe('config-policy editor feature-type parity (#2004)', () => {
  it('renders exactly the canonical feature types minus the documented exclusions', () => {
    const expected = CONFIG_FEATURE_TYPES.filter(
      (t) => !(EDITOR_EXCLUDED_FEATURE_TYPES as readonly string[]).includes(t),
    ).sort();
    const actual = Object.keys(FEATURE_META).sort();
    expect(actual).toEqual([...expected]);
  });

  it('only excludes feature types that actually exist in the canonical registry', () => {
    // Keeps the Exclude<…> in types.ts honest: a typo'd or stale exclusion would
    // silently no-op at the type level, so assert each excluded name is real.
    for (const excluded of EDITOR_EXCLUDED_FEATURE_TYPES) {
      expect(CONFIG_FEATURE_TYPES).toContain(excluded);
    }
  });
});
