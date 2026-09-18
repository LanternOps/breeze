import { describe, it, expect } from 'vitest';
import {
  AI_BUDGET_DEFAULTS,
  AI_BUDGET_FIELDS,
  aiBudgetSource,
  isAiBudgetFieldLocked,
  withAiBudgetDefaults,
} from './aiBudget';

/**
 * These constants mirror `AI_BUDGET_DEFAULTS` in
 * `apps/api/src/services/effectiveSettings.ts`. Spelling them out literally
 * here (rather than importing the API's copy, which the web app cannot reach)
 * is the point: if the API's defaults move and this file is not updated, the
 * usage page starts labelling inherited values "Set by organization" and the
 * org tab starts pre-filling them. Only a hard-coded expectation catches that.
 */
describe('AI_BUDGET_DEFAULTS', () => {
  it('matches the API contract field for field', () => {
    expect(AI_BUDGET_DEFAULTS).toEqual({
      enabled: true,
      monthlyBudgetCents: null,
      dailyBudgetCents: null,
      maxTurnsPerSession: 50,
      messagesPerMinutePerUser: 20,
      messagesPerHourPerOrg: 200,
      approvalMode: 'per_step',
      alertThresholdPercents: [50, 80, 95],
    });
    expect([...AI_BUDGET_FIELDS].sort()).toEqual(Object.keys(AI_BUDGET_DEFAULTS).sort());
  });
});

describe('isAiBudgetFieldLocked', () => {
  it('reads the aiBudgets.<field> form the API emits, and nothing looser', () => {
    expect(isAiBudgetFieldLocked(['aiBudgets.monthlyBudgetCents'], 'monthlyBudgetCents')).toBe(true);
    // A bare field name, or another category's lock, must not match.
    expect(isAiBudgetFieldLocked(['monthlyBudgetCents'], 'monthlyBudgetCents')).toBe(false);
    expect(isAiBudgetFieldLocked(['security.monthlyBudgetCents'], 'monthlyBudgetCents')).toBe(false);
    expect(isAiBudgetFieldLocked(undefined, 'enabled')).toBe(false);
  });
});

describe('aiBudgetSource', () => {
  it('reports every field as Default when the merge produced exactly the defaults', () => {
    for (const field of AI_BUDGET_FIELDS) {
      expect(aiBudgetSource(field, AI_BUDGET_DEFAULTS, []), field).toBe('default');
    }
  });

  it('reports every field as Organization when the merged value differs from the default', () => {
    const orgSet = {
      enabled: false,
      monthlyBudgetCents: 5000,
      dailyBudgetCents: 100,
      maxTurnsPerSession: 12,
      messagesPerMinutePerUser: 5,
      messagesPerHourPerOrg: 42,
      approvalMode: 'auto_approve' as const,
      alertThresholdPercents: [60, 90],
    };
    for (const field of AI_BUDGET_FIELDS) {
      expect(aiBudgetSource(field, orgSet, []), field).toBe('organization');
    }
  });

  it('reports Partner for a locked field whatever its value', () => {
    // Locked AND equal to the default: `locked` must win, or a partner that
    // deliberately pins the shipped default would show up as "Default" and
    // the org form would offer to edit it.
    for (const field of AI_BUDGET_FIELDS) {
      expect(aiBudgetSource(field, AI_BUDGET_DEFAULTS, [`aiBudgets.${field}`]), field).toBe('partner');
    }
  });

  it('treats an absent field as inherited rather than as a change', () => {
    expect(aiBudgetSource('maxTurnsPerSession', {}, [])).toBe('default');
    expect(aiBudgetSource('maxTurnsPerSession', null, [])).toBe('default');
  });

  it('compares the threshold ladder element-wise, including order', () => {
    expect(aiBudgetSource('alertThresholdPercents', { alertThresholdPercents: [50, 80, 95] }, [])).toBe('default');
    // The API normalises the ladder to ascending order before storing it, so a
    // different order IS a different ladder as far as this comparison goes —
    // it can only arrive that way from a value the API did not normalise.
    expect(aiBudgetSource('alertThresholdPercents', { alertThresholdPercents: [80, 50, 95] }, [])).toBe('organization');
    expect(aiBudgetSource('alertThresholdPercents', { alertThresholdPercents: [] }, [])).toBe('organization');
    expect(aiBudgetSource('alertThresholdPercents', { alertThresholdPercents: [50, 80] }, [])).toBe('organization');
  });

  it('does not confuse a cleared cap with an inherited one', () => {
    // Both are `null` in the merged payload, so both read as Default — the
    // documented limit of deriving provenance without the raw org row.
    expect(aiBudgetSource('monthlyBudgetCents', { monthlyBudgetCents: null }, [])).toBe('default');
    expect(aiBudgetSource('monthlyBudgetCents', { monthlyBudgetCents: 0 }, [])).toBe('organization');
  });
});

describe('withAiBudgetDefaults', () => {
  it('fills every missing field and keeps the ones that are present', () => {
    expect(withAiBudgetDefaults({ maxTurnsPerSession: 12 })).toEqual({
      ...AI_BUDGET_DEFAULTS,
      maxTurnsPerSession: 12,
    });
    expect(withAiBudgetDefaults(null)).toEqual(AI_BUDGET_DEFAULTS);
  });

  it('keeps a falsy-but-set value instead of overwriting it with the default', () => {
    const merged = withAiBudgetDefaults({ enabled: false, monthlyBudgetCents: 0 });
    expect(merged.enabled).toBe(false);
    expect(merged.monthlyBudgetCents).toBe(0);
  });

  it('hands back a fresh threshold array, never the shared default instance', () => {
    const a = withAiBudgetDefaults(null);
    const b = withAiBudgetDefaults(null);
    expect(a.alertThresholdPercents).not.toBe(AI_BUDGET_DEFAULTS.alertThresholdPercents);
    expect(a.alertThresholdPercents).not.toBe(b.alertThresholdPercents);
  });
});
