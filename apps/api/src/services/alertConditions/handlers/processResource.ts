import { db } from '../../../db';
import { serviceProcessCheckResults } from '../../../db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import type { ConditionHandler } from '../registry';
import type { ProcessResourceCondition, ConditionResult } from '../types';
import { compareValue, getOperatorDisplay } from '../utils';

function createProcessResourceHandler(handlerType: 'process_cpu_high' | 'process_memory_high'): ConditionHandler {
  return {
    type: handlerType,

    async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
      const cond = condition as ProcessResourceCondition;
      const durationMinutes = cond.durationMinutes || 5;
      const windowStart = new Date(Date.now() - durationMinutes * 60 * 1000);

      const column = cond.type === 'process_cpu_high'
        ? serviceProcessCheckResults.cpuPercent
        : serviceProcessCheckResults.memoryMb;

      const results = await db
        .select({ value: column })
        .from(serviceProcessCheckResults)
        .where(
          and(
            eq(serviceProcessCheckResults.deviceId, deviceId),
            eq(serviceProcessCheckResults.watchType, 'process'),
            eq(serviceProcessCheckResults.name, cond.processName),
            gte(serviceProcessCheckResults.timestamp, windowStart)
          )
        )
        .orderBy(desc(serviceProcessCheckResults.timestamp));

      if (results.length === 0) {
        return { passed: false, description: `No recent results for process ${cond.processName}` };
      }

      const allExceed = results.every(r => {
        if (r.value === null) return false;
        return compareValue(r.value, cond.operator, cond.value);
      });

      const latestValue = results[0]?.value ?? undefined;
      const metricLabel = cond.type === 'process_cpu_high' ? 'CPU%' : 'Memory MB';
      const operatorDisplay = getOperatorDisplay(cond.operator);

      return {
        passed: allExceed,
        description: `Process ${cond.processName} ${metricLabel} ${operatorDisplay} ${cond.value} for ${durationMinutes}min`,
        actualValue: latestValue ?? undefined,
      };
    },

    validate(condition: unknown, path: string): string[] {
      const errors: string[] = [];
      const c = condition as Record<string, unknown>;

      if (typeof c.processName !== 'string' || !c.processName) {
        errors.push(`${path}.processName: Must be a non-empty string`);
      }
      if (!['gt', 'gte', 'lt', 'lte', 'eq', 'neq'].includes(c.operator as string)) {
        errors.push(`${path}.operator: Invalid operator`);
      }
      if (typeof c.value !== 'number') {
        errors.push(`${path}.value: Must be a number`);
      }

      return errors;
    }
  };
}

export const processCpuHighHandler = createProcessResourceHandler('process_cpu_high');
export const processMemoryHighHandler = createProcessResourceHandler('process_memory_high');
