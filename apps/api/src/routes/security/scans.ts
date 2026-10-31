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
import { startDeviceScan } from '../../services/securityScanStart';

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
    if (!result.ok) return c.json({ error: result.error }, result.status);

    return c.json({ data: { ...result.scan, threatsFound: 0 } }, 202);
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
      // The sweep this scan belongs to, and the rule-set errors it reported
      // (e.g. `rule_set_changed` when a pinned set was republished) (#10049).
      sweepId: scan.sweepId ?? null,
      ruleSetErrors: Array.isArray(scan.ruleSetErrors) ? scan.ruleSetErrors : null
    }));

    return c.json(paginate(mapped, page, limit));
  }
);
