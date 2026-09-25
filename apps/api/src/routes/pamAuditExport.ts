/**
 * GET /pam/elevation-audit/export — server-side export of the PAM
 * `elevation_audit` event ledger (#4910). Query and serialization live in
 * services/pamAuditExport.ts; this route validates, authorizes and audits.
 *
 * Paged, not streamed: a streamed body would outlive the request's RLS
 * transaction (authMiddleware → withDbAccessContext awaits the handler, not
 * the body), and every page here re-runs the caller's authorization. The
 * caller pages with `X-Next-Cursor` while `X-Has-More` is true, and the window
 * is fully exported only once `X-Window-Complete` is true; until then it
 * resumes from `X-Next-Cursor` later (see services/pamAuditExport.ts).
 *
 * Gates are the audit-log export's (routes/auditLogs.ts): a permission plus
 * requireMfa(), whose contract is the caller's EFFECTIVE MFA policy, not an
 * unconditional factor check. Machine principals that hold both permissions
 * are admitted on purpose, so a SIEM can pull the ledger. The per-page audit
 * record is best-effort, like every writeRouteAudit call.
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
    // Required for partner and system callers; an organization caller's own org by default.
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

    // One organization per export: the keyset walk is served by the
    // (org_id, created_at, id) index only when org_id is fixed.
    const orgId = q.orgId ?? (auth.scope === 'organization' ? auth.orgId : null);
    if (!orgId) {
      return c.json({ error: 'orgId is required for partner and system callers' }, 400);
    }
    if (!auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Organization access denied' }, 403);
    }
    if (q.siteId && perms && !canAccessSite(perms, q.siteId)) {
      return c.json({ error: 'Site access denied' }, 403);
    }
    let after: { recordedAt: string; id: string } | null = null;
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
        orgId,
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
      orgId,
      action: 'pam.elevation_audit.export',
      resourceType: 'elevation_audit',
      details: {
        format: q.format,
        schemaVersion: PAM_AUDIT_EXPORT_SCHEMA_VERSION,
        rowCount: page.records.length,
        byteCount: Buffer.byteLength(body, 'utf8'),
        hasMore: page.hasMore,
        windowComplete: page.windowComplete,
        continuation: Boolean(q.cursor),
        scope: auth.scope,
        filters: {
          from: q.from,
          to: q.to,
          orgId,
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
    c.header('X-Has-More', String(page.hasMore));
    c.header('X-Window-Complete', String(page.windowComplete));
    c.header('X-Settled-Through', page.settledThrough);
    c.header('X-Next-Cursor', page.nextCursor);
    return c.body(body);
  },
);
