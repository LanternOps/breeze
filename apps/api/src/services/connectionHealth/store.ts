import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { connectionHealthIncidents as chi } from '../../db/schema';
import type { Permission } from '../permissions';
import {
  REOPEN_WINDOW_MS,
  type ConnectionSourceKind,
  type HealthObservation,
  type TrackedIncident,
  type TransitionAction,
} from './types';

// Sole writer of connection_health_incidents. Every function runs inside the
// caller's system DB context (the reconciler wraps it) and never opens its own.
// Both time windows use the `now` argument, never the database clock.

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const permissionToText = (p: Permission): string => `${p.resource}:${p.action}`;

export function permissionFromText(s: string): Permission {
  const i = s.indexOf(':');
  if (i <= 0) throw new Error(`bad permission text: ${s}`);
  return { resource: s.slice(0, i), action: s.slice(i + 1) };
}

function observedColumns(o: HealthObservation, now: Date) {
  return {
    partnerId: o.partnerId,
    orgId: o.orgId,
    ownerUserId: o.ownerUserId,
    condition: o.condition,
    severity: o.severity,
    detail: o.detail,
    displayName: o.displayName,
    fixHref: o.fixHref,
    ownerFixHref: o.ownerFixHref,
    viewPermission: permissionToText(o.viewPermission),
    repairPermission: permissionToText(o.repairPermission),
    lastObservedAt: now,
  };
}

export async function loadTracked(kind: ConnectionSourceKind, now: Date): Promise<TrackedIncident[]> {
  // Inclusive boundary: matches planTransitions' `now - resolvedAt <= REOPEN_WINDOW_MS`.
  const since = new Date(now.getTime() - REOPEN_WINDOW_MS);
  const rows = await db
    .select({
      id: chi.id,
      sourceId: chi.sourceId,
      severity: chi.severity,
      openedAt: chi.openedAt,
      resolvedAt: chi.resolvedAt,
      healthyStreak: chi.healthyStreak,
    })
    .from(chi)
    .where(and(
      eq(chi.sourceKind, kind),
      or(isNull(chi.resolvedAt), and(gte(chi.resolvedAt, since), eq(chi.resolution, 'recovered'))),
    ));

  // A source can have one open row plus older recently-resolved rows; the open row wins,
  // then the most recently resolved.
  const bySource = new Map<string, TrackedIncident>();
  for (const r of rows) {
    const t: TrackedIncident = { ...r, severity: r.severity as TrackedIncident['severity'] };
    const prev = bySource.get(r.sourceId);
    if (
      !prev
      || (prev.resolvedAt && !t.resolvedAt)
      || (prev.resolvedAt && t.resolvedAt && t.resolvedAt > prev.resolvedAt)
    ) {
      bySource.set(r.sourceId, t);
    }
  }
  return [...bySource.values()];
}

/** Whether the kind has any incident row at all (open, pending or resolved). */
export async function hasIncidentsForKind(kind: ConnectionSourceKind): Promise<boolean> {
  const rows = await db.select({ id: chi.id }).from(chi).where(eq(chi.sourceKind, kind)).limit(1);
  return rows.length > 0;
}

export async function applyActions(
  actions: readonly TransitionAction[],
  now: Date,
): Promise<{ opened: number; resolved: number; pending: number }> {
  const counts = { opened: 0, resolved: 0, pending: 0 };
  for (const a of actions) {
    switch (a.type) {
      case 'insertPending':
        await db.insert(chi).values({
          ...observedColumns(a.obs, now),
          sourceKind: a.obs.sourceKind,
          sourceId: a.obs.sourceId,
          firstFailedAt: now,
        });
        counts.pending += 1;
        break;
      case 'insertOpen':
        await db.insert(chi).values({
          ...observedColumns(a.obs, now),
          sourceKind: a.obs.sourceKind,
          sourceId: a.obs.sourceId,
          firstFailedAt: now,
          openedAt: now,
          pendingNotice: a.notify ? 'opened' : null,
        });
        counts.opened += 1;
        break;
      case 'promotePending':
        await db.update(chi).set({
          ...observedColumns(a.obs, now),
          openedAt: now,
          healthyStreak: 0,
          pendingNotice: a.notify ? 'opened' : null,
        }).where(and(eq(chi.id, a.incidentId), isNull(chi.openedAt)));
        counts.opened += 1;
        break;
      case 'update':
        await db.update(chi).set({
          ...observedColumns(a.obs, now),
          healthyStreak: 0,
          ...(a.escalated ? { pendingNotice: 'escalated' } : {}),
        }).where(eq(chi.id, a.incidentId));
        break;
      case 'healthyTick':
        await db.update(chi)
          .set({ healthyStreak: a.healthyStreak, lastObservedAt: now })
          .where(eq(chi.id, a.incidentId));
        break;
      case 'resolve':
        await db.update(chi).set({
          resolvedAt: now,
          resolution: a.resolution,
          lastObservedAt: now,
          pendingNotice: sql`CASE WHEN cardinality(${chi.notifiedUserIds}) > 0 THEN 'resolved' ELSE NULL END`,
        }).where(and(eq(chi.id, a.incidentId), isNull(chi.resolvedAt)));
        counts.resolved += 1;
        break;
      case 'reopen':
        // Resolve's mark-read already retired the old notices; the fresh opened_at
        // gives the new 'opened' notice its own dedupe key. Only a resolved row
        // reopens: on a row that is still open this is a no-op.
        await db.update(chi).set({
          ...observedColumns(a.obs, now),
          resolvedAt: null,
          resolution: null,
          openedAt: now,
          healthyStreak: 0,
          flapCount: sql`${chi.flapCount} + 1`,
          pendingNotice: 'opened',
        }).where(and(eq(chi.id, a.incidentId), isNotNull(chi.resolvedAt)));
        counts.opened += 1;
        break;
      case 'deletePending':
        await db.delete(chi).where(and(eq(chi.id, a.incidentId), isNull(chi.openedAt)));
        break;
    }
  }
  return counts;
}

export async function deleteExpiredResolved(now: Date, limit = 1000): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  const victims = await db
    .select({ id: chi.id })
    .from(chi)
    .where(lt(chi.resolvedAt, cutoff))
    .limit(limit);
  if (victims.length === 0) return 0;
  const deleted = await db
    .delete(chi)
    .where(inArray(chi.id, victims.map((v) => v.id)))
    .returning({ id: chi.id });
  return deleted.length;
}
