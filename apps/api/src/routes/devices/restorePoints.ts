import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { deviceRestorePointAttempts } from '../../db/schema/deviceRestorePointAttempts';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { PG_UUID_REGEX } from '../../utils/uuid';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

/**
 * Console read path for the System Restore request ledger (#4609 W08).
 *
 * The ledger records what Breeze asked for and what the device reported, never
 * a promise that a restore point exists or can be restored. A row left in
 * `requested` (the agent never reported) is returned as-is; the UI renders it
 * as pending. Read-only: no mutation, so `runAction` does not apply.
 */

export const RESTORE_POINT_ATTEMPTS_DEFAULT_LIMIT = 50;
export const RESTORE_POINT_ATTEMPTS_MAX_LIMIT = 200;

// Postgres timestamptz has microsecond precision; a JS Date has milliseconds.
// The keyset cursor therefore carries the timestamp as TEXT formatted by the
// database itself, so a round trip never truncates and equal-millisecond rows
// can neither repeat nor be skipped.
const CURSOR_TS_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function encodeBefore(ts: string, requestId: string): string {
  return Buffer.from(JSON.stringify({ t: ts, id: requestId }), 'utf8').toString('base64url');
}

function decodeBefore(raw: string): { ts: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const { t, id } = parsed as { t?: unknown; id?: unknown };
    if (typeof t !== 'string' || !CURSOR_TS_REGEX.test(t)) return null;
    if (typeof id !== 'string' || !PG_UUID_REGEX.test(id)) return null;
    return { ts: t, id };
  } catch {
    return null;
  }
}

export const deviceRestorePointAttemptsRoutes = new Hono();

deviceRestorePointAttemptsRoutes.use('*', authMiddleware);

deviceRestorePointAttemptsRoutes.get(
  '/:id/restore-point-attempts',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const deviceId = c.req.param('id')!;

    const limitRaw = c.req.query('limit');
    let limit = RESTORE_POINT_ATTEMPTS_DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) {
        return c.json({ error: 'limit must be a positive integer' }, 400);
      }
      limit = Math.min(Number(limitRaw), RESTORE_POINT_ATTEMPTS_MAX_LIMIT);
    }

    const beforeRaw = c.req.query('before');
    const before = beforeRaw === undefined ? null : decodeBefore(beforeRaw);
    if (beforeRaw !== undefined && !before) {
      return c.json({ error: 'before is not a valid cursor' }, 400);
    }

    // Device lookup first, under the request's RLS context: a device the
    // caller cannot see is a 404, never an empty list.
    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, c.get('auth'));
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const t = deviceRestorePointAttempts;
    const cursorTs = sql<string>`to_char(${t.requestedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const conditions = [eq(t.deviceId, deviceId)];
    if (before) {
      conditions.push(sql`(${t.requestedAt}, ${t.requestId}) < (${before.ts}::timestamptz, ${before.id}::uuid)`);
    }

    // One extra row tells us whether another page exists.
    const rows = await db
      .select({
        requestId: t.requestId,
        trigger: t.trigger,
        status: t.status,
        policyRevision: t.policyRevision,
        requestedAt: t.requestedAt,
        attemptedAt: t.attemptedAt,
        receivedAt: t.receivedAt,
        sequenceNumber: t.sequenceNumber,
        description: t.description,
        message: t.message,
        acceptedExistingPoint: t.acceptedExistingPoint,
        existingPointAgeMinutes: t.existingPointAgeMinutes,
        frequencyMinutes: t.frequencyMinutes,
        durationMs: t.durationMs,
        scriptExecutionId: t.scriptExecutionId,
        softwareDeploymentId: t.softwareDeploymentId,
        patchJobId: t.patchJobId,
        cursorTs,
      })
      .from(t)
      .where(and(...conditions))
      .orderBy(desc(t.requestedAt), desc(t.requestId))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    // Explicit allowlist: never spread the row, so a column added to the
    // ledger later is not exposed by accident (deviceCommandId/orgId stay internal).
    const attempts = page.map((r) => ({
      requestId: r.requestId,
      trigger: r.trigger,
      status: r.status,
      policyRevision: r.policyRevision,
      requestedAt: r.requestedAt,
      attemptedAt: r.attemptedAt,
      receivedAt: r.receivedAt,
      // bigint: JSON.stringify throws on it and Number() rounds past 2^53.
      sequenceNumber: r.sequenceNumber?.toString() ?? null,
      description: r.description,
      message: r.message,
      acceptedExistingPoint: r.acceptedExistingPoint,
      existingPointAgeMinutes: r.existingPointAgeMinutes,
      frequencyMinutes: r.frequencyMinutes,
      durationMs: r.durationMs,
      scriptExecutionId: r.scriptExecutionId,
      softwareDeploymentId: r.softwareDeploymentId,
      patchJobId: r.patchJobId,
    }));

    return c.json({
      attempts,
      ...(hasMore && last ? { nextBefore: encodeBefore(last.cursorTs, last.requestId) } : {}),
    });
  },
);
