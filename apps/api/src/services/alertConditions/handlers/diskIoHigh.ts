import type { ConditionHandler } from '../registry';
import type { DiskIoHighCondition, ConditionResult } from '../types';
import { compareValue, getOperatorDisplay, getRecentMetrics } from '../utils';

export const diskIoHighHandler: ConditionHandler = {
  type: 'disk_io_high',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as DiskIoHighCondition;
    const durationMinutes = cond.durationMinutes || 1;

    const metrics = await getRecentMetrics(deviceId, durationMinutes);

    if (metrics.length === 0) {
      return { passed: false, description: 'No metrics available for disk I/O' };
    }

    const allExceed = metrics.every(m => {
      let value: number;
      const readBps = m.diskReadBps !== null ? Number(m.diskReadBps) : 0;
      const writeBps = m.diskWriteBps !== null ? Number(m.diskWriteBps) : 0;

      if (cond.direction === 'read') value = readBps;
      else if (cond.direction === 'write') value = writeBps;
      else value = readBps + writeBps;

      return compareValue(value, cond.operator, cond.value);
    });

    const latest = metrics[0];
    const readBps = latest?.diskReadBps !== null && latest?.diskReadBps !== undefined ? Number(latest.diskReadBps) : 0;
    const writeBps = latest?.diskWriteBps !== null && latest?.diskWriteBps !== undefined ? Number(latest.diskWriteBps) : 0;
    const latestValue = cond.direction === 'read' ? readBps : cond.direction === 'write' ? writeBps : readBps + writeBps;

    const operatorDisplay = getOperatorDisplay(cond.operator);

    return {
      passed: allExceed,
      description: `Disk I/O ${cond.direction} ${operatorDisplay} ${cond.value} bps for ${durationMinutes}min`,
      actualValue: latestValue,
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (!['read', 'write', 'total'].includes(c.direction as string)) {
      errors.push(`${path}.direction: Must be 'read', 'write', or 'total'`);
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
