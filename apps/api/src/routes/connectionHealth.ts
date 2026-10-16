import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, gt, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db';
import { connectionHealthIncidents as chi } from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { zValidator } from '../lib/validation';
import { PERMISSIONS, hasPermission } from '../services/permissions';
import { permissionFromText } from '../services/connectionHealth/store';

// Read-only view of connection health incidents (spec 2026-10-15). Only the
// reconciler writes this table. Rows are first narrowed by RLS (request DB
// context), then per-row by the incident's view_permission. Pending rows
// (opened_at IS NULL) are never returned.
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 500;
const querySchema = z.object({ status: z.enum(['open', 'recent']).default('open') });

export const connectionHealthRoutes = new Hono();
connectionHealthRoutes.use('*', authMiddleware);

connectionHealthRoutes.get(
  '/incidents',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', querySchema),
  async (c) => {
    const { status } = c.req.valid('query');
    const auth = c.get('auth');
    const perms = c.get('permissions');

    const where = status === 'open'
      ? and(isNull(chi.resolvedAt), isNotNull(chi.openedAt))
      : and(
          isNotNull(chi.openedAt),
          isNotNull(chi.resolvedAt),
          gt(chi.resolvedAt, new Date(Date.now() - RECENT_MS)),
        );

    const rows = await db.select().from(chi).where(where).orderBy(desc(chi.openedAt)).limit(MAX_ROWS);

    const data = rows
      .filter((r) => {
        if (auth.scope === 'system') return true;
        const p = permissionFromText(r.viewPermission);
        return !!perms && hasPermission(perms, p.resource, p.action);
      })
      .map((r) => ({
        id: r.id,
        sourceKind: r.sourceKind,
        orgId: r.orgId,
        condition: r.condition,
        severity: r.severity,
        detail: r.detail,
        displayName: r.displayName,
        fixHref: r.fixHref,
        firstFailedAt: r.firstFailedAt,
        openedAt: r.openedAt,
        lastObservedAt: r.lastObservedAt,
        resolvedAt: r.resolvedAt,
        resolution: r.resolution,
      }));

    return c.json({ data });
  },
);
