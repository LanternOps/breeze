import { compareEvidence, maxEvidence, type EvidenceCursor } from '@breeze/shared';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { alerts } from '../../db/schema';

export type LeafCursors = Record<string, EvidenceCursor>;
export const OPEN_ALERT_STATUSES = ['active', 'acknowledged', 'suppressed'] as const;

export interface ClosedCursorEntry {
  cursors: LeafCursors | null;
  closedAt: Date;
  legacy: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function storedCursor(context: unknown): unknown {
  if (!isObject(context) || !isObject(context.lifecycle)) return undefined;
  return context.lifecycle.cursor;
}

function asCursors(value: unknown): LeafCursors | null {
  return isObject(value) ? value as LeafCursors : null;
}

/**
 * One indexed lookup for the newest non-subject closed episode per rule.
 * resolved_at/dismissed_at are tz-less and stored as UTC (as Drizzle maps
 * them); AT TIME ZONE 'UTC' hands the raw driver a timestamptz so it does not
 * parse them in the process's local zone.
 */
export async function readClosedCursors(
  deviceId: string,
  ruleIds: string[],
): Promise<Map<string, ClosedCursorEntry>> {
  if (ruleIds.length === 0) return new Map();
  const rows = await db.execute<{
    ruleId: string;
    cursor: unknown;
    closedAt: Date | string;
  }>(sql`
    SELECT DISTINCT ON (${alerts.ruleId}) ${alerts.ruleId} AS "ruleId",
      ${alerts.context}->'lifecycle'->'cursor' AS "cursor",
      COALESCE(${alerts.resolvedAt}, ${alerts.dismissedAt}) AT TIME ZONE 'UTC' AS "closedAt"
    FROM ${alerts}
    WHERE ${alerts.deviceId} = ${deviceId}
      AND ${alerts.ruleId} = ANY(${sql.param(ruleIds)}::uuid[])
      AND ${alerts.ruleId} IS NOT NULL
      AND ${alerts.status} IN ('resolved', 'dismissed')
      AND COALESCE(${alerts.subjectKey}, '') = ''
    ORDER BY ${alerts.ruleId}, COALESCE(${alerts.resolvedAt}, ${alerts.dismissedAt}) DESC
  `);
  return new Map(rows.map(row => {
    const cursors = asCursors(row.cursor);
    return [row.ruleId, {
      cursors,
      closedAt: new Date(row.closedAt),
      legacy: cursors === null,
    }];
  }));
}

async function readAlert(alertId: string) {
  const [row] = await db.select({ context: alerts.context, status: alerts.status })
    .from(alerts).where(eq(alerts.id, alertId)).limit(1);
  return row;
}

export async function readOpenCursors(alertId: string): Promise<LeafCursors> {
  const row = await readAlert(alertId);
  return asCursors(storedCursor(row?.context)) ?? {};
}

export function mergeCursors(
  prev: LeafCursors,
  next: LeafCursors,
): { merged: LeafCursors; changed: boolean } {
  const merged = { ...prev };
  let changed = false;
  for (const [path, cursor] of Object.entries(next)) {
    const previous = prev[path];
    if (previous === undefined || compareEvidence(cursor, previous) > 0) {
      merged[path] = maxEvidence(previous, cursor)!;
      changed = true;
    }
  }
  return { merged, changed };
}

/** Retry only while open; compare the exact stored JSON to avoid lost advances. */
export async function advanceOpenCursors(alertId: string, next: LeafCursors): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await readAlert(alertId);
    if (!row || !OPEN_ALERT_STATUSES.some(status => status === row.status)) return false;
    const previous = storedCursor(row.context);
    const { merged, changed } = mergeCursors(asCursors(previous) ?? {}, next);
    if (!changed) return false;
    const expected = previous === undefined ? sql`NULL` : sql`${JSON.stringify(previous)}::jsonb`;
    const updated = await db.update(alerts).set({ context: contextWithCursorSql(merged) })
      .where(and(
        eq(alerts.id, alertId),
        inArray(alerts.status, [...OPEN_ALERT_STATUSES]),
        sql`(${alerts.context}->'lifecycle'->'cursor') IS NOT DISTINCT FROM ${expected}`,
      )).returning({ id: alerts.id });
    if (updated.length > 0) return true;
  }
  return false;
}

export async function advanceOpenRuleCursors(
  ruleId: string,
  deviceId: string,
  next: LeafCursors,
): Promise<boolean> {
  if (Object.keys(next).length === 0) return false;
  const [open] = await db.select({ id: alerts.id }).from(alerts).where(and(
    eq(alerts.ruleId, ruleId),
    eq(alerts.deviceId, deviceId),
    inArray(alerts.status, [...OPEN_ALERT_STATUSES]),
    isNull(alerts.subjectKey),
  )).limit(1);
  return open ? advanceOpenCursors(open.id, next) : false;
}

export function freezeRecoveryCursor(
  current: LeafCursors,
  triggerLeafPaths: string[],
  recoveryWatermarks: LeafCursors,
): LeafCursors {
  const recoveryMax = Object.values(recoveryWatermarks)
    .reduce<EvidenceCursor | undefined>((max, cursor) => maxEvidence(max, cursor), undefined);
  const merged: LeafCursors = {};
  for (const path of new Set([...triggerLeafPaths, ...Object.keys(current)])) {
    const cursor = maxEvidence(current[path], recoveryMax);
    if (cursor !== undefined) merged[path] = cursor;
  }
  return merged;
}

export function resolveSideCursors(current: LeafCursors, recoveryLeafPaths: string[]): LeafCursors {
  const newest = Object.values(current)
    .reduce<EvidenceCursor | undefined>((max, cursor) => maxEvidence(max, cursor), undefined);
  return newest === undefined ? {} : Object.fromEntries(recoveryLeafPaths.map(path => [path, newest]));
}

export function contextWithCursorSql(cursors: LeafCursors): SQL {
  return sql`COALESCE(${alerts.context},'{}'::jsonb) || jsonb_build_object('lifecycle', COALESCE(${alerts.context}->'lifecycle','{}'::jsonb) || jsonb_build_object('cursor', ${JSON.stringify(cursors)}::jsonb))`;
}
