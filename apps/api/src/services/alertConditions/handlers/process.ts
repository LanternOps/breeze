import { db } from '../../../db';
import { serviceProcessCheckResults } from '../../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import type { ConditionHandler } from '../registry';
import type { ProcessCondition, ConditionResult } from '../types';

export const processHandler: ConditionHandler = {
  type: 'process_stopped',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as ProcessCondition;
    const threshold = cond.consecutiveFailures ?? 2;

    const recentResults = await db
      .select({ status: serviceProcessCheckResults.status })
      .from(serviceProcessCheckResults)
      .where(
        and(
          eq(serviceProcessCheckResults.deviceId, deviceId),
          eq(serviceProcessCheckResults.watchType, 'process'),
          eq(serviceProcessCheckResults.name, cond.processName)
        )
      )
      .orderBy(desc(serviceProcessCheckResults.timestamp))
      .limit(threshold);

    if (recentResults.length === 0) {
      return { passed: false, description: `No check results for process ${cond.processName}` };
    }

    const consecutiveFailures = recentResults.filter(r => r.status !== 'running').length;

    return {
      passed: consecutiveFailures >= threshold,
      description: `Process ${cond.processName} stopped (${consecutiveFailures} consecutive failures, threshold: ${threshold})`,
      actualValue: consecutiveFailures,
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (typeof c.processName !== 'string' || !c.processName) {
      errors.push(`${path}.processName: Must be a non-empty string`);
    }
    if (c.consecutiveFailures !== undefined && (typeof c.consecutiveFailures !== 'number' || c.consecutiveFailures < 1)) {
      errors.push(`${path}.consecutiveFailures: Must be a positive number`);
    }

    return errors;
  }
};
