/**
 * GET /pam/elevation-audit/export — server-side export of the PAM
 * `elevation_audit` event ledger (#4910). Query and serialization live in
 * services/pamAuditExport.ts; this route validates, authorizes and audits.
 *
 * Paged, not streamed: a streamed body would outlive the request's RLS
 * transaction (authMiddleware → withDbAccessContext awaits the handler, not
 * the body), and every page here re-runs the caller's authorization. The
 * caller follows `X-Next-Cursor` until it is empty.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { elevationAudit } from '../db/schema';
import { requireMfa, requirePermission } from '../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../services/permissions';
import { normalizeSiteAllowlist } from '../services/siteAllowlist';
import { writeRouteAudit } from '../services/auditEvents';
import {
  PAM_AUDIT_EXPORT_MAX_LIMIT,
  PAM_AUDIT_EXPORT_MAX_WINDOW_DAYS,
  PAM_AUDIT_EXPORT_SCHEMA_VERSION,
  decodeExportCursor,
  fetchElevationAuditExportPage,
  serializeElevationAuditPage,
} from '../services/pamAuditExport';

const isoDateTime = z.string().datetime({ offset: true });

export const exportQuerySchema = z
  .object({
    format: z.enum(['csv', 'jsonl']).optional().default('csv'),
    from: isoDateTime,
    to: isoDateTime,
    orgId: z.string().guid().optional(),
    siteId: z.string().guid().optional(),
    deviceId: z.string().guid().optional(),
    elevationRequestId: z.string().guid().optional(),
    eventType: z.string().max(64).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAM_AUDIT_EXPORT_MAX_LIMIT)
      .optional()
      .default(PAM_AUDIT_EXPORT_MAX_LIMIT),
    cursor: z.string().max(512).optional(),
  })
  .refine((q) => new Date(q.from).getTime() < new Date(q.to).getTime(), {
    message: '`from` must be before `to`',
    path: ['from'],
  })
  .refine(
    (q) =>
      new Date(q.to).getTime() - new Date(q.from).getTime() <=
      PAM_AUDIT_EXPORT_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    { message: `window may not exceed ${PAM_AUDIT_EXPORT_MAX_WINDOW_DAYS} days`, path: ['to'] },
  );

const requireDevicesRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireAuditExport = requirePermission(PERMISSIONS.AUDIT_EXPORT.resource, PERMISSIONS.AUDIT_EXPORT.action);

// Mounted inside pamRoutes (routes/pam.ts), which already applies
// authMiddleware and requireScope('organization', 'partner', 'system').
export const pamAuditExportRoutes = new Hono();

pamAuditExportRoutes.get(
  '/elevation-audit/export',
  requireDevicesRead,
  requireAuditExport,
  requireMfa(),
  zValidator('query', exportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const q = c.req.valid('query');

    if (q.orgId && !auth.canAccessOrg(q.orgId)) {
      return c.json({ error: 'Organization access denied' }, 403);
    }
    if (q.siteId && perms && !canAccessSite(perms, q.siteId)) {
      return c.json({ error: 'Site access denied' }, 403);
    }
    let after: { occurredAt: string; id: string } | null = null;
    if (q.cursor) {
      after = decodeExportCursor(q.cursor);
      if (!after) return c.json({ error: 'Invalid cursor' }, 400);
    }

    const page = await fetchElevationAuditExportPage({
      orgCondition: auth.orgCondition(elevationAudit.orgId),
      allowedSiteIds: normalizeSiteAllowlist(perms?.allowedSiteIds),
      filters: {
        from: new Date(q.from),
        to: new Date(q.to),
        orgId: q.orgId,
        siteId: q.siteId,
        deviceId: q.deviceId,
        elevationRequestId: q.elevationRequestId,
        eventType: q.eventType,
      },
      after,
      limit: q.limit,
    });
    const body = serializeElevationAuditPage(page.records, q.format);

    writeRouteAudit(c, {
      orgId: q.orgId ?? (auth.scope === 'organization' ? auth.orgId : null),
      action: 'pam.elevation_audit.export',
      resourceType: 'elevation_audit',
      details: {
        format: q.format,
        schemaVersion: PAM_AUDIT_EXPORT_SCHEMA_VERSION,
        rowCount: page.records.length,
        byteCount: Buffer.byteLength(body, 'utf8'),
        hasMore: page.hasMore,
        continuation: Boolean(q.cursor),
        scope: auth.scope,
        filters: {
          from: q.from,
          to: q.to,
          orgId: q.orgId ?? null,
          siteId: q.siteId ?? null,
          deviceId: q.deviceId ?? null,
          elevationRequestId: q.elevationRequestId ?? null,
          eventType: q.eventType ?? null,
        },
      },
    });

    c.header('Content-Type', q.format === 'jsonl' ? 'application/x-ndjson; charset=utf-8' : 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="elevation-audit-${q.from.slice(0, 10)}.${q.format}"`);
    c.header('Cache-Control', 'no-store');
    c.header('X-Export-Schema-Version', String(PAM_AUDIT_EXPORT_SCHEMA_VERSION));
    c.header('X-Row-Count', String(page.records.length));
    c.header('X-Next-Cursor', page.nextCursor);
    return c.body(body);
  },
);
