import type { ConditionHandler } from '../registry';
import type { BandwidthHighCondition, ConditionResult } from '../types';
import { compareValue, getOperatorDisplay, getRecentMetrics } from '../utils';

export const bandwidthHighHandler: ConditionHandler = {
  type: 'bandwidth_high',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as BandwidthHighCondition;
    const durationMinutes = cond.durationMinutes || 1;

    const metrics = await getRecentMetrics(deviceId, durationMinutes);

    if (metrics.length === 0) {
      return { passed: false, description: 'No metrics available for bandwidth', dataAvailable: false };
    }

    // The agent reports bandwidth in BYTES per second
    // (agent/internal/collectors/metrics.go: BandwidthInBps = bytes / elapsed),
    // while cond.value is authored in megaBITS per second. Convert each sample
    // to Mbps rather than scaling the threshold, so actualValue is in the same
    // unit the monitor template renders ("{{actualValue}} Mbps").
    // A null rate reads as 0: the agent serialises these with `omitempty`, so a
    // genuine zero-traffic interval arrives as null (the column is nullable).
    const sampleMbps = (m: (typeof metrics)[number]): number => {
      const inBps = m.bandwidthInBps !== null ? Number(m.bandwidthInBps) : 0;
      const outBps = m.bandwidthOutBps !== null ? Number(m.bandwidthOutBps) : 0;
      const bytesPerSec = cond.direction === 'in' ? inBps : cond.direction === 'out' ? outBps : inBps + outBps;
      return (bytesPerSec * 8) / 1_000_000;
    };

    const allExceed = metrics.every(m => compareValue(sampleMbps(m), cond.operator, cond.value));

    // metrics are newest-first (getRecentMetrics orders by timestamp desc).
    const latestValue = Math.round(sampleMbps(metrics[0]!) * 100) / 100;

    const operatorDisplay = getOperatorDisplay(cond.operator);

    return {
      passed: allExceed,
      description: `Bandwidth ${cond.direction} ${operatorDisplay} ${cond.value} Mbps for ${durationMinutes}min`,
      actualValue: latestValue,
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (!['in', 'out', 'total'].includes(c.direction as string)) {
      errors.push(`${path}.direction: Must be 'in', 'out', or 'total'`);
    }
    if (!['gt', 'gte', 'lt', 'lte', 'eq', 'neq'].includes(c.operator as string)) {
      errors.push(`${path}.operator: Invalid operator`);
    }
    if (typeof c.value !== 'number') {
      errors.push(`${path}.value: Must be a number`);
    }
    if (c.durationMinutes !== undefined && typeof c.durationMinutes !== 'number') {
      errors.push(`${path}.durationMinutes: Must be a number`);
    }

    return errors;
  }
};
