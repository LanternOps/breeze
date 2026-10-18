import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, gt, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { connectionHealthIncidents as chi } from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { zValidator } from '../lib/validation';
import { PERMISSIONS, hasPermission } from '../services/permissions';
import { permissionFromText } from '../services/connectionHealth/store';
import { registerConnectionHealthSettingsRoutes } from './connectionHealthSettings';

// Read-only view of connection health incidents (spec 2026-10-15). Only the
// reconciler writes this table. Rows are narrowed by RLS (request DB context)
// and by the incident's view_permission, both BEFORE the row limit: the caller's
// permitted view permissions go into the WHERE, so rows they cannot see never
// use up the page. Pending rows (opened_at IS NULL) are never returned.
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

    const statusWhere = (status === 'open'
      ? and(isNull(chi.resolvedAt), isNotNull(chi.openedAt))
      : and(
          isNotNull(chi.openedAt),
          isNotNull(chi.resolvedAt),
          gt(chi.resolvedAt, new Date(Date.now() - RECENT_MS)),
        )) as SQL;

    let where: SQL = statusWhere;
    if (auth.scope !== 'system') {
      // The distinct view permissions present under the same filter (RLS-narrowed,
      // a handful of values), kept to those the caller holds.
      const present = await db
        .selectDistinct({ viewPermission: chi.viewPermission })
        .from(chi)
        .where(statusWhere);
      const allowed = present.map((p) => p.viewPermission).filter((text) => {
        const p = permissionFromText(text);
        return !!perms && hasPermission(perms, p.resource, p.action);
      });
      if (allowed.length === 0) return c.json({ data: [], truncated: false });
      where = and(statusWhere, inArray(chi.viewPermission, allowed)) as SQL;
    }

    // id breaks ties, so rows written in the same reconcile keep a stable order.
    const order = status === 'open'
      ? [desc(chi.openedAt), desc(chi.id)]
      : [desc(chi.resolvedAt), desc(chi.id)];
    const rows = await db.select().from(chi).where(where).orderBy(...order).limit(MAX_ROWS + 1);

    const truncated = rows.length > MAX_ROWS;
    const data = rows
      .slice(0, MAX_ROWS)
      // Defense in depth: the WHERE already holds only permitted values.
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

    return c.json({ data, truncated });
  },
);

// W5: the customer-delivery setting (GET /settings, PUT /settings/partner,
// PUT /settings/orgs/:orgId). The incidents API itself stays GET-only.
registerConnectionHealthSettingsRoutes(connectionHealthRoutes);
