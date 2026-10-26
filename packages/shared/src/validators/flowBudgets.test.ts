import { describe, it, expect } from 'vitest';
import {
  FLOW_ADMISSION_REFUSALS,
  FLOW_LIMIT_CEILINGS,
  FLOW_LIMIT_DEFAULTS,
  flowLimitsSettingsSchema,
  flowUsagePeriodKey,
} from './flowBudgets';

describe('flow budgets (#5220)', () => {
  it('flowUsagePeriodKey uses UTC', () => {
    expect(flowUsagePeriodKey(new Date('2027-01-31T23:30:00-05:00'))).toBe('2027-02');
    expect(flowUsagePeriodKey(new Date('2027-12-31T23:59:59.999Z'))).toBe('2027-12');
    expect(flowUsagePeriodKey(new Date('2028-01-01T00:00:00Z'))).toBe('2028-01');
  });

  it('limits above the ceiling are invalid', () => {
    for (const k of Object.keys(FLOW_LIMIT_CEILINGS) as Array<keyof typeof FLOW_LIMIT_CEILINGS>) {
      expect(flowLimitsSettingsSchema.safeParse({ [k]: FLOW_LIMIT_CEILINGS[k] }).success).toBe(true);
      expect(flowLimitsSettingsSchema.safeParse({ [k]: FLOW_LIMIT_CEILINGS[k] + 1 }).success).toBe(false);
      expect(flowLimitsSettingsSchema.safeParse({ [k]: 0 }).success).toBe(false);
      expect(flowLimitsSettingsSchema.safeParse({ [k]: 1.5 }).success).toBe(false);
    }
    expect(flowLimitsSettingsSchema.safeParse({}).success).toBe(true);
    expect(flowLimitsSettingsSchema.safeParse({ monthlyRuns: 5 }).success).toBe(false);
  });

  it('defaults never exceed ceilings', () => {
    for (const k of Object.keys(FLOW_LIMIT_DEFAULTS) as Array<keyof typeof FLOW_LIMIT_DEFAULTS>) {
      expect(FLOW_LIMIT_DEFAULTS[k]).toBeLessThanOrEqual(FLOW_LIMIT_CEILINGS[k]);
    }
    expect(FLOW_LIMIT_DEFAULTS).toEqual({ monthlyRunsPerOwner: 100_000, monthlyRunsPerFlow: 10_000, aiTokensPerRun: 100_000 });
  });

  it('lists the admission refusals', () => {
    expect([...FLOW_ADMISSION_REFUSALS]).toEqual(['flow_queue_full', 'flow_monthly_cap_reached', 'owner_monthly_cap_reached']);
  });
});
