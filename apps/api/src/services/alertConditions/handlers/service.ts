import { db } from '../../../db';
import { serviceProcessCheckResults } from '../../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import type { ConditionHandler } from '../registry';
import type { ServiceCondition, ConditionResult } from '../types';

export const serviceHandler: ConditionHandler = {
  type: 'service_stopped',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as ServiceCondition;
    const threshold = cond.consecutiveFailures ?? 2;

    const [latest] = await db
      .select()
      .from(serviceProcessCheckResults)
      .where(
        and(
          eq(serviceProcessCheckResults.deviceId, deviceId),
          eq(serviceProcessCheckResults.watchType, 'service'),
          eq(serviceProcessCheckResults.name, cond.serviceName)
        )
      )
      .orderBy(desc(serviceProcessCheckResults.timestamp))
      .limit(1);

    if (!latest) {
      return { passed: false, description: `No check results for service ${cond.serviceName}` };
    }

    if (latest.status === 'running') {
      return { passed: false, description: `Service ${cond.serviceName} is running` };
    }

    const recentResults = await db
      .select({ status: serviceProcessCheckResults.status })
      .from(serviceProcessCheckResults)
      .where(
        and(
          eq(serviceProcessCheckResults.deviceId, deviceId),
          eq(serviceProcessCheckResults.watchType, 'service'),
          eq(serviceProcessCheckResults.name, cond.serviceName)
        )
      )
      .orderBy(desc(serviceProcessCheckResults.timestamp))
      .limit(threshold);

    const consecutiveFailures = recentResults.filter(r => r.status !== 'running').length;

    return {
      passed: consecutiveFailures >= threshold,
      description: `Service ${cond.serviceName} stopped (${consecutiveFailures} consecutive failures, threshold: ${threshold})`,
      actualValue: consecutiveFailures,
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (typeof c.serviceName !== 'string' || !c.serviceName) {
      errors.push(`${path}.serviceName: Must be a non-empty string`);
    }
    if (c.consecutiveFailures !== undefined && (typeof c.consecutiveFailures !== 'number' || c.consecutiveFailures < 1)) {
      errors.push(`${path}.consecutiveFailures: Must be a positive number`);
    }

    return errors;
  }
};
