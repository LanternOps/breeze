import { describe, it, expect } from 'vitest';
import {
  APPLIES_TO_SUMMARY_TARGET_LIMIT,
  TARGET_LEVEL_ORDER,
  appliesToState,
  type ConfigPolicyAppliesToSummary,
} from './configPolicyAppliesTo';

function summary(overrides: Partial<ConfigPolicyAppliesToSummary> = {}): ConfigPolicyAppliesToSummary {
  return { assignmentCount: 0, allOrganizations: false, targets: [], childPolicyCount: 0, ...overrides };
}

describe('appliesToState', () => {
  it('appliesToState is applied when assignmentCount > 0, whatever childPolicyCount says', () => {
    expect(appliesToState(summary({ assignmentCount: 1 }))).toBe('applied');
    expect(appliesToState(summary({ assignmentCount: 4, childPolicyCount: 2 }))).toBe('applied');
    // A row the caller may not list still counts (D2): no targets, but applied.
    expect(appliesToState(summary({ assignmentCount: 1, targets: [] }))).toBe('applied');
  });

  it('appliesToState is in_use_through_children when there are no rows but there are children', () => {
    expect(appliesToState(summary({ childPolicyCount: 2 }))).toBe('in_use_through_children');
  });

  it('appliesToState is not_applied when there are no rows and no children', () => {
    expect(appliesToState(summary())).toBe('not_applied');
  });
});

describe('TARGET_LEVEL_ORDER', () => {
  it('TARGET_LEVEL_ORDER runs from most general to most specific', () => {
    expect(TARGET_LEVEL_ORDER).toEqual(['partner', 'organization', 'site', 'device_group', 'device']);
  });

  it('caps the summary at three targets', () => {
    expect(APPLIES_TO_SUMMARY_TARGET_LIMIT).toBe(3);
  });
});
