import { describe, expect, it } from 'vitest';
import { withoutObservedStateValues } from './complianceRuleResults';

describe('withoutObservedStateValues (#11976)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'legacy'],
    ['an array', [1, 2]],
    ['no ruleResults', { passed: true }],
    ['non-array ruleResults', { ruleResults: 'x' }],
  ])('returns %s unchanged', (_label, details) => {
    expect(withoutObservedStateValues(details)).toBe(details);
  });

  it('strips actualValue and valueType from registry_check and config_check results only, without mutating the input', () => {
    const config = { ruleType: 'config_check', passed: false, message: 'm', data: { expectedValue: 'no', actualValue: 'yes' } };
    const noData = { ruleType: 'registry_check', passed: false, message: 'not found' };
    const nullData = { ruleType: 'registry_check', passed: false, message: 'm', data: null };
    const outcomeOnly = { ruleType: 'registry_check', passed: true, message: 'm', data: { outcome: 'matched' } };
    const details = {
      passed: false,
      ruleResults: [
        { ruleType: 'registry_check', passed: false, message: 'mismatch', data: { expectedValue: '1', actualValue: 'observed', valueType: 'REG_SZ' } },
        { ruleType: 'registry_check', passed: false, message: 'mismatch', data: { valueType: 'REG_DWORD' } },
        config, noData, nullData, outcomeOnly, 'not-an-object',
      ] as unknown[],
    };
    const snapshot = JSON.parse(JSON.stringify(details));

    const out = withoutObservedStateValues(details);

    expect(out.ruleResults[0]).toEqual({ ruleType: 'registry_check', passed: false, message: 'mismatch', data: { expectedValue: '1' } });
    expect(out.ruleResults[1]).toEqual({ ruleType: 'registry_check', passed: false, message: 'mismatch', data: {} });
    // #12130: config_check results follow the registry model too.
    expect(out.ruleResults[2]).toEqual({ ruleType: 'config_check', passed: false, message: 'm', data: { expectedValue: 'no' } });
    expect(out.ruleResults[3]).toBe(noData);
    expect(out.ruleResults[4]).toBe(nullData);
    expect(out.ruleResults[5]).toBe(outcomeOnly);
    expect(out.ruleResults[6]).toBe('not-an-object');
    expect(details).toEqual(snapshot);
  });
});
