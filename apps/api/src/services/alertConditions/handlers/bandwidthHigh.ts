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
      return { passed: false, description: 'No metrics available for bandwidth' };
    }

    // cond.value is in Mbps (user-friendly); convert to bps for DB comparison
    const thresholdBps = cond.value * 1_000_000;

    const allExceed = metrics.every(m => {
      let value: number;
      const inBps = m.bandwidthInBps !== null ? Number(m.bandwidthInBps) : 0;
      const outBps = m.bandwidthOutBps !== null ? Number(m.bandwidthOutBps) : 0;

      if (cond.direction === 'in') value = inBps;
      else if (cond.direction === 'out') value = outBps;
      else value = inBps + outBps;

      return compareValue(value, cond.operator, thresholdBps);
    });

    const latest = metrics[0];
    const inBps = latest?.bandwidthInBps !== null && latest?.bandwidthInBps !== undefined ? Number(latest.bandwidthInBps) : 0;
    const outBps = latest?.bandwidthOutBps !== null && latest?.bandwidthOutBps !== undefined ? Number(latest.bandwidthOutBps) : 0;
    const latestValue = cond.direction === 'in' ? inBps : cond.direction === 'out' ? outBps : inBps + outBps;

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
