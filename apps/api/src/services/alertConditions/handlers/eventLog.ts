import { db } from '../../../db';
import { deviceEventLogs } from '../../../db/schema';
import { eq, and, gte, ilike, sql } from 'drizzle-orm';
import type { ConditionHandler } from '../registry';
import type { EventLogCondition, ConditionResult } from '../types';

function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, '\\$&');
}

export const eventLogHandler: ConditionHandler = {
  type: 'event_log',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as EventLogCondition;
    const windowStart = new Date(Date.now() - cond.windowMinutes * 60 * 1000);

    const conditions: ReturnType<typeof eq>[] = [
      eq(deviceEventLogs.deviceId, deviceId),
      eq(deviceEventLogs.category, cond.category),
      gte(deviceEventLogs.timestamp, windowStart),
    ];

    const levelOrder = ['info', 'warning', 'error', 'critical'];
    const minLevelIdx = levelOrder.indexOf(cond.level);
    if (minLevelIdx >= 0) {
      const matchLevels = levelOrder.slice(minLevelIdx);
      conditions.push(
        sql`${deviceEventLogs.level} = ANY(ARRAY[${sql.raw(matchLevels.map(l => `'${l}'`).join(','))}]::event_log_level[])`
      );
    }

    if (cond.sourcePattern) {
      conditions.push(ilike(deviceEventLogs.source, `%${escapeLikePattern(cond.sourcePattern)}%`));
    }

    if (cond.messagePattern) {
      conditions.push(ilike(deviceEventLogs.message, `%${escapeLikePattern(cond.messagePattern)}%`));
    }

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceEventLogs)
      .where(and(...conditions));

    const matchCount = Number(countResult[0]?.count ?? 0);
    const passed = matchCount >= cond.countThreshold;

    return {
      passed,
      description: `${cond.category}/${cond.level} events >= ${cond.countThreshold} in ${cond.windowMinutes}min (found ${matchCount})`,
      actualValue: matchCount,
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (!['security', 'hardware', 'application', 'system'].includes(c.category as string)) {
      errors.push(`${path}.category: Invalid category`);
    }
    if (!['warning', 'error', 'critical'].includes(c.level as string)) {
      errors.push(`${path}.level: Invalid level`);
    }
    if (typeof c.countThreshold !== 'number' || c.countThreshold < 1) {
      errors.push(`${path}.countThreshold: Must be a positive number`);
    }
    if (typeof c.windowMinutes !== 'number' || c.windowMinutes < 1) {
      errors.push(`${path}.windowMinutes: Must be a positive number`);
    }

    return errors;
  }
};
