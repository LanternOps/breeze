import { describe, expect, it } from 'vitest';
import { MONITOR_KINDS, monitorConditionSchemas, compositeConditionSchema } from './monitors';

const base = { componentTypes: ['physical_disk'], minHealth: 'critical' };

describe('hardware health authoring', () => {
  it('is a root kind with defaults', () => {
    expect(MONITOR_KINDS).toContain('hardware_health');
    expect(monitorConditionSchemas.hardware_health.parse(base)).toEqual({
      ...base, includePredictiveFailure: true, consecutiveSnapshots: 2,
    });
  });

  it.each([
    { componentTypes: [] }, { componentTypes: ['bmc'] }, { componentTypes: ['disk'] },
    { minHealth: 'ok' }, { consecutiveSnapshots: 0 }, { consecutiveSnapshots: 11 },
    { consecutiveSnapshots: 1.5 }, { includePredictiveFailure: 'true' },
  ])('rejects %j', patch => {
    expect(monitorConditionSchemas.hardware_health.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it.each([1, 10])('accepts count boundary %i', consecutiveSnapshots => {
    expect(monitorConditionSchemas.hardware_health.safeParse({ ...base, consecutiveSnapshots }).success).toBe(true);
  });

  it('cannot be a composite child', () => {
    expect(compositeConditionSchema.safeParse({ match: 'all', children: [
      { kind: 'hardware_health', condition: base },
      { kind: 'cpu', condition: { operator: 'gt', value: 90 } },
    ] }).success).toBe(false);
  });
});
