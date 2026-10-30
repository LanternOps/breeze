import { isAfterCursor, maxEvidence, type EvidenceCursor } from '@breeze/shared';
import { db } from '../../../db';
import { deviceEventLogs } from '../../../db/schema';
import { eq, and, gt, gte, desc, ilike, sql } from 'drizzle-orm';
import type { ConditionHandler } from '../registry';
import type { EventLogCondition, ConditionResult, ConditionEvalContext } from '../types';

function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, '\\$&');
}

interface EvidenceRow {
  id: string;
  timestamp: Date;
  createdAt: Date;
  logName: string | null;
  recordId: string | null;
}

function toCursor(row: EvidenceRow): EvidenceCursor {
  const recordId = Number(row.recordId);
  return {
    ts: row.timestamp.toISOString(),
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    ...(typeof row.logName === 'string' && row.logName.length > 0 ? { logName: row.logName } : {}),
    ...(row.recordId != null && Number.isFinite(recordId) ? { recordId } : {}),
  };
}

export const eventLogHandler: ConditionHandler = {
  type: 'event_log',
  evidence: true,

  async evaluate(condition: unknown, deviceId: string, ctx?: ConditionEvalContext): Promise<ConditionResult> {
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

    // #5290 — deliberately NO `dataAvailable: false` here. This is a
    // count-over-threshold condition, so zero matching events is a real, healthy
    // observation ("the device logged no errors"), not an absence of data.
    // Flagging it as no-data would make every quiet device report `unknown`
    // forever and no breach episode would ever close. A device that has stopped
    // reporting entirely is covered by the `offline` monitor kind.
    const matchCount = Number(countResult[0]?.count ?? 0);
    const thresholdMet = matchCount >= cond.countThreshold;
    let evidenceWatermark: EvidenceCursor | undefined;
    let someRowAfter = !ctx?.evidenceAfter && !ctx?.legacyIngestedBefore;
    const evidenceColumns = {
      id: deviceEventLogs.id,
      timestamp: deviceEventLogs.timestamp,
      createdAt: deviceEventLogs.createdAt,
      logName: sql<string | null>`${deviceEventLogs.details}->>'logName'`,
      recordId: sql<string | null>`${deviceEventLogs.details}->>'recordId'`,
    };
    const newestFirst = [desc(deviceEventLogs.timestamp), desc(deviceEventLogs.createdAt), desc(deviceEventLogs.id)];

    if (matchCount > 0) {
      const [newest] = await db.select(evidenceColumns)
        .from(deviceEventLogs)
        .where(and(...conditions))
        .orderBy(...newestFirst)
        .limit(1);
      if (newest) evidenceWatermark = toCursor(newest);
    }

    if (thresholdMet && ctx?.evidenceAfter) {
      const candidates = await db.select(evidenceColumns)
        .from(deviceEventLogs)
        .where(and(...conditions, gte(deviceEventLogs.timestamp, new Date(Date.parse(ctx.evidenceAfter.ts) - 1000))))
        .orderBy(...newestFirst)
        .limit(50);
      const cursors = candidates.map(toCursor);
      someRowAfter = cursors.some(candidate => isAfterCursor(candidate, ctx.evidenceAfter, ctx.side ?? 'trigger'));
      for (const candidate of cursors) evidenceWatermark = maxEvidence(evidenceWatermark, candidate);
    } else if (thresholdMet && ctx?.legacyIngestedBefore) {
      const rows = await db.select({ exists: sql<number>`1` })
        .from(deviceEventLogs)
        .where(and(...conditions, gt(deviceEventLogs.createdAt, ctx.legacyIngestedBefore)))
        .limit(1);
      someRowAfter = rows.length > 0;
    }
    const passed = thresholdMet && someRowAfter;

    return {
      passed,
      description: `${cond.category}/${cond.level} events >= ${cond.countThreshold} in ${cond.windowMinutes}min (found ${matchCount})${thresholdMet && !someRowAfter ? ' (no new evidence since last episode)' : ''}`,
      actualValue: matchCount,
      ...(evidenceWatermark ? { evidenceWatermark } : {}),
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (!['security', 'hardware', 'application', 'system'].includes(c.category as string)) {
      errors.push(`${path}.category: Invalid category`);
    }
    if (!['info', 'warning', 'error', 'critical'].includes(c.level as string)) {
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
