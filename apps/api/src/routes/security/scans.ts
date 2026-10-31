import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '../../db';
import { devices, securityScans } from '../../db/schema';
import { hasSatisfiedMfa, requirePermission, requireScope } from '../../middleware/auth';
import { canAccessSite, getUserPermissions, type UserPermissions } from '../../services/permissions';
import type { AuthContext } from '../../middleware/auth';
import type { Context } from 'hono';
import { deviceIdParamSchema, scanRequestSchema, listScansQuerySchema } from './schemas';
import { getPagination, paginate, parseDateRange, matchDateRange } from './helpers';
import { z } from 'zod';
import { cancelDeviceScan, startDeviceScan } from '../../services/securityScanStart';
import { writeRouteAudit } from '../../services/auditEvents';

const scanIdParamSchema = z.object({ scanId: z.string().uuid() });

/**
 * Site-scope gate: partner-scope users restricted via `allowedSiteIds` must
 * not see/touch a device in a site they cannot access. RLS does not defend
 * the site axis — mirrors the SP2 launch-readiness sweep (PR #864/#868).
 * Returns true when access is granted, false (and writes a 403 response)
 * otherwise.
 */
async function canAccessDeviceSite(
  c: Context,
  auth: Pick<AuthContext, 'user' | 'partnerId' | 'orgId'>,
  deviceSiteId: string | null,
): Promise<boolean> {
  let userPerms = c.get('permissions') as UserPermissions | undefined;
  if (!userPerms) {
    const fetched = await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId || undefined,
      orgId: auth.orgId || undefined,
    });
    userPerms = fetched || undefined;
  }
  if (!userPerms?.allowedSiteIds) return true;
  if (typeof deviceSiteId !== 'string') return false;
  return canAccessSite(userPerms, deviceSiteId);
}

export const scansRoutes = new Hono();

scansRoutes.post(
  '/scan/:deviceId',
  requireScope('organization', 'partner', 'system'),
  // requireScope only checks tenancy tier, not the caller's role — a read-only
  // Org Viewer would otherwise pass. Dispatching an agent security scan is a
  // device-execute action; matches sensitiveData /scan (DEVICES_EXECUTE).
  requirePermission('devices', 'execute'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', scanRequestSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const payload = c.req.valid('json');

    // #6263 W05-11: shared with the AI `security_scan scan` action.
    const result = await startDeviceScan(auth, {
      deviceId,
      scanType: payload.scanType,
      paths: payload.paths,
      mfaSatisfied: hasSatisfiedMfa(auth),
    });
    if (!result.ok) {
      if (result.status === 409) {
        return c.json({ error: result.error, code: 'SCAN_ALREADY_QUEUED', scanId: result.scanId }, 409);
      }
      return c.json({ error: result.error }, result.status);
    }

    // #10057 gap 2: `queued` means waiting for a free scan slot (the dispatch
    // caps); it goes `running` when the claim dispatches it, or `expired` at
    // `queueExpiresAt`. POST /scans/:scanId/cancel withdraws it.
    return c.json({ data: { ...result.scan, threatsFound: 0 } }, 202);
  }
);

// #10057 gap 2 — cancel a scheduled or manual scan that the agent has not
// started: still waiting for a slot, or dispatched but undelivered. Same
// permission as starting one. The service owns its transaction (a
// self-managed-context route) and applies the site gate itself.
scansRoutes.post(
  '/scans/:scanId/cancel',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'execute'),
  zValidator('param', scanIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { scanId } = c.req.valid('param');
    const result = await cancelDeviceScan(auth, scanId);
    if (!result.ok) {
      if (result.status === 409) return c.json({ error: result.error, code: result.code }, 409);
      return c.json({ error: result.error }, result.status);
    }
    writeRouteAudit(c, {
      orgId: result.orgId,
      action: 'security.scan.cancel',
      resourceType: 'security_scan',
      resourceId: scanId,
      details: { scanId },
    });
    return c.json({ data: result.scan });
  }
);

scansRoutes.get(
  '/scans/:deviceId',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', listScansQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const dateRange = parseDateRange(query.startDate, query.endDate);
    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    const orgCondition = auth.orgCondition(devices.orgId);
    const conditions = [eq(devices.id, deviceId)];
    if (orgCondition) conditions.push(orgCondition);

    const [device] = await db
      .select({ id: devices.id, hostname: devices.hostname, orgId: devices.orgId, siteId: devices.siteId })
      .from(devices)
      .where(and(...conditions))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!(await canAccessDeviceSite(c, auth, device.siteId))) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    let scans = await db
      .select()
      .from(securityScans)
      .where(eq(securityScans.deviceId, device.id))
      .orderBy(desc(securityScans.startedAt));

    if (query.status) {
      scans = scans.filter((scan) => scan.status === query.status);
    }

    if (query.scanType) {
      scans = scans.filter((scan) => scan.scanType === query.scanType);
    }

    if (dateRange.start || dateRange.end) {
      scans = scans.filter((scan) => matchDateRange(scan.startedAt, dateRange.start, dateRange.end));
    }

    const mapped = scans.map((scan) => ({
      id: scan.id,
      deviceId: device.id,
      deviceName: device.hostname,
      orgId: device.orgId,
      scanType: scan.scanType,
      status: scan.status,
      startedAt: scan.startedAt?.toISOString() ?? null,
      finishedAt: scan.completedAt?.toISOString() ?? null,
      threatsFound: scan.threatsFound ?? 0,
      durationSeconds: scan.duration ?? null,
      // #10057 gap 2: set on a Scan now; while `queued` it is waiting for a slot.
      queueExpiresAt: scan.queueExpiresAt?.toISOString() ?? null
    }));

    return c.json(paginate(mapped, page, limit));
  }
);
