import type { ConditionHandler } from '../registry';
import type { NetworkErrorsCondition, ConditionResult } from '../types';
import { compareValue, getOperatorDisplay, getRecentMetrics } from '../utils';

interface InterfaceStat {
  name?: string;
  inErrors?: number;
  outErrors?: number;
  [key: string]: unknown;
}

export const networkErrorsHandler: ConditionHandler = {
  type: 'network_errors',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as NetworkErrorsCondition;
    const windowMinutes = cond.windowMinutes || 5;

    const metrics = await getRecentMetrics(deviceId, windowMinutes);

    if (metrics.length === 0) {
      return { passed: false, description: 'No metrics available for network errors' };
    }

    // Sum errors across all metrics in the window
    let totalErrors = 0;
    for (const m of metrics) {
      const ifStats = m.interfaceStats as InterfaceStat[] | null;
      if (!ifStats || !Array.isArray(ifStats)) continue;

      for (const iface of ifStats) {
        // Filter by interface name if specified
        if (cond.interfaceName && iface.name !== cond.interfaceName) continue;

        const inErr = typeof iface.inErrors === 'number' ? iface.inErrors : 0;
        const outErr = typeof iface.outErrors === 'number' ? iface.outErrors : 0;

        if (cond.errorType === 'in') totalErrors += inErr;
        else if (cond.errorType === 'out') totalErrors += outErr;
        else totalErrors += inErr + outErr;
      }
    }

    const passed = compareValue(totalErrors, cond.operator, cond.value);
    const operatorDisplay = getOperatorDisplay(cond.operator);

    return {
      passed,
      description: `Network ${cond.errorType} errors ${operatorDisplay} ${cond.value} in ${windowMinutes}min (found ${totalErrors})`,
      actualValue: totalErrors,
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (!['in', 'out', 'total'].includes(c.errorType as string)) {
      errors.push(`${path}.errorType: Must be 'in', 'out', or 'total'`);
    }
    if (!['gt', 'gte', 'lt', 'lte', 'eq', 'neq'].includes(c.operator as string)) {
      errors.push(`${path}.operator: Invalid operator`);
    }
    if (typeof c.value !== 'number') {
      errors.push(`${path}.value: Must be a number`);
    }
    if (c.windowMinutes !== undefined && typeof c.windowMinutes !== 'number') {
      errors.push(`${path}.windowMinutes: Must be a number`);
    }

    return errors;
  }
};
