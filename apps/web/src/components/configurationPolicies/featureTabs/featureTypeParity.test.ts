import { describe, it, expect } from 'vitest';
import { CONFIG_FEATURE_TYPES } from '@breeze/shared';

import { FEATURE_META, EDITOR_EXCLUDED_FEATURE_TYPES } from './types';
import { FEATURE_TYPES } from '../ConfigPolicyDetailPage';

// Guards against the cross-package drift in issue #2004: the config-policy
// editor's feature tabs must stay in lockstep with the canonical
// CONFIG_FEATURE_TYPES registry (single source of truth in @breeze/shared),
// minus the documented exclusions. Mirrors the api-side enum parity test in
// apps/api/src/services/policyBaselineDefaults.test.ts.
describe('config-policy editor feature-type parity (#2004)', () => {
  const expectedEditorTypes = CONFIG_FEATURE_TYPES.filter(
    (t) => !(EDITOR_EXCLUDED_FEATURE_TYPES as readonly string[]).includes(t),
  ).sort();

  it('FEATURE_META covers exactly the canonical feature types minus the documented exclusions', () => {
    expect(Object.keys(FEATURE_META).sort()).toEqual([...expectedEditorTypes]);
  });

  it('renders a tab for exactly that set (no hand-listed partial subset)', () => {
    // The bug #2004 targets: ConfigPolicyDetailPage.FEATURE_TYPES used to be a
    // hand-listed array that had dropped `security`, so SecurityTab was
    // unreachable. It now derives from FEATURE_META; assert the rendered set is
    // complete so it can never silently become a partial subset again.
    expect([...FEATURE_TYPES].sort()).toEqual([...expectedEditorTypes]);
  });

  it('only excludes feature types that actually exist in the canonical registry', () => {
    // Keeps the Exclude<…> in types.ts honest: a typo'd or stale exclusion would
    // silently no-op at the type level, so assert each excluded name is real.
    for (const excluded of EDITOR_EXCLUDED_FEATURE_TYPES) {
      expect(CONFIG_FEATURE_TYPES).toContain(excluded);
    }
  });
});
