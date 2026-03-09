import type { ConditionHandler } from '../registry';
import type { ThresholdCondition, ConditionResult } from '../types';
import { normalizeMetricName, compareValue, getOperatorDisplay, getRecentMetrics, METRIC_NAME_MAP } from '../utils';

export const thresholdHandler: ConditionHandler = {
  type: 'threshold',
  aliases: ['metric'],

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as ThresholdCondition;
    const durationMinutes = cond.durationMinutes || 1;

    const metricName = normalizeMetricName(cond.metric);
    if (!metricName) {
      return { passed: false, description: `Unknown metric: ${cond.metric}` };
    }

    const metrics = await getRecentMetrics(deviceId, durationMinutes);

    if (metrics.length === 0) {
      return { passed: false, description: `No metrics available for ${cond.metric}` };
    }

    const allExceed = metrics.every(m => {
      const value = m[metricName];
      if (value === null || value === undefined) return false;
      return compareValue(value, cond.operator, cond.value);
    });

    const latestValue = metrics[0]?.[metricName] ?? undefined;
    const operatorDisplay = getOperatorDisplay(cond.operator);

    return {
      passed: allExceed,
      description: `${cond.metric} ${operatorDisplay} ${cond.value} for ${durationMinutes}min`,
      actualValue: latestValue ?? undefined
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    const validMetrics = [...Object.keys(METRIC_NAME_MAP), ...Object.values(METRIC_NAME_MAP)];
    if (!validMetrics.includes(c.metric as string)) {
      errors.push(`${path}.metric: Invalid metric name`);
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
