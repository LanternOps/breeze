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
      return { passed: false, description: 'No metrics available for disk I/O', dataAvailable: false };
    }

    // The agent reports disk rates in BYTES per second; cond.value is authored
    // in MB/s (10^6 bytes). Convert each sample to MB/s so actualValue is in the
    // unit the monitor template renders ("{{actualValue}} MB/s").
    const sampleMBps = (m: (typeof metrics)[number]): number => {
      const readBps = m.diskReadBps !== null ? Number(m.diskReadBps) : 0;
      const writeBps = m.diskWriteBps !== null ? Number(m.diskWriteBps) : 0;
      const bytesPerSec = cond.direction === 'read' ? readBps : cond.direction === 'write' ? writeBps : readBps + writeBps;
      return bytesPerSec / 1_000_000;
    };

    const allExceed = metrics.every(m => compareValue(sampleMBps(m), cond.operator, cond.value));

    // metrics are newest-first (getRecentMetrics orders by timestamp desc).
    const latestValue = Math.round(sampleMBps(metrics[0]!) * 100) / 100;

    const operatorDisplay = getOperatorDisplay(cond.operator);

    return {
      passed: allExceed,
      description: `Disk I/O ${cond.direction} ${operatorDisplay} ${cond.value} MB/s for ${durationMinutes}min`,
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
