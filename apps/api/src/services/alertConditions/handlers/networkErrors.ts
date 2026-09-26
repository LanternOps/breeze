import type { ConditionHandler } from '../registry';
import type { NetworkErrorsCondition, ConditionResult } from '../types';
import { compareValue, getOperatorDisplay, getRecentMetrics } from '../utils';

interface InterfaceStat {
  name?: string;
  inErrors?: number;
  outErrors?: number;
  [key: string]: unknown;
}

type MetricRow = Awaited<ReturnType<typeof getRecentMetrics>>[number];

/**
 * The agent's per-interface `inErrors` / `outErrors` are CUMULATIVE since-boot
 * counters (gopsutil Errin/Errout, agent/internal/collectors/metrics.go), not
 * per-interval counts. The errors that happened in the window are therefore the
 * INCREASE of each counter across it, summed per interface. A counter that goes
 * backwards means the counter reset (reboot, driver reload), so the new reading
 * is itself the increase since the reset.
 */
function errorsFor(iface: InterfaceStat, errorType: NetworkErrorsCondition['errorType']): number {
  const inErr = typeof iface.inErrors === 'number' ? iface.inErrors : 0;
  const outErr = typeof iface.outErrors === 'number' ? iface.outErrors : 0;
  if (errorType === 'in') return inErr;
  if (errorType === 'out') return outErr;
  return inErr + outErr;
}

export const networkErrorsHandler: ConditionHandler = {
  type: 'network_errors',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as NetworkErrorsCondition;
    const windowMinutes = cond.windowMinutes || 5;
    const windowStart = Date.now() - windowMinutes * 60_000;

    // Read one extra window back so the newest sample at or before the window
    // start can serve as the baseline — without it, errors between that sample
    // and the first in-window sample would be lost, and a device reporting less
    // often than the window would never have two samples to diff.
    const fetched = await getRecentMetrics(deviceId, windowMinutes * 2);

    const noData = (why: string): ConditionResult => ({
      passed: false,
      description: `No network error data available (${why})`,
      dataAvailable: false,
    });

    if (fetched.length === 0) return noData('no metrics in window');

    // Newest first → oldest first; keep in-window samples plus one baseline.
    const ascending = [...fetched].sort(
      (a: MetricRow, b: MetricRow) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    let firstInWindow = ascending.findIndex((m) => new Date(m.timestamp).getTime() > windowStart);
    if (firstInWindow === -1) firstInWindow = ascending.length;
    const samples = ascending.slice(Math.max(0, firstInWindow - 1));

    // Per interface: previous counter reading and running increase.
    const perIface = new Map<string, { prev: number; increase: number; readings: number }>();
    for (const m of samples) {
      const ifStats = m.interfaceStats as InterfaceStat[] | null;
      if (!ifStats || !Array.isArray(ifStats)) continue;

      for (const iface of ifStats) {
        const name = typeof iface.name === 'string' ? iface.name : '';
        if (cond.interfaceName && name !== cond.interfaceName) continue;

        const current = errorsFor(iface, cond.errorType);
        const state = perIface.get(name);
        if (!state) {
          perIface.set(name, { prev: current, increase: 0, readings: 1 });
          continue;
        }
        state.increase += current >= state.prev ? current - state.prev : current;
        state.prev = current;
        state.readings += 1;
      }
    }

    const measured = [...perIface.values()].filter((s) => s.readings >= 2);
    if (measured.length === 0) {
      return noData(
        cond.interfaceName
          ? `need two samples of interface ${cond.interfaceName}`
          : 'need two samples with interface counters'
      );
    }

    const totalErrors = measured.reduce((sum, s) => sum + s.increase, 0);
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
