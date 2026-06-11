import { randomUUID } from 'crypto';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '../../db';
import { devices, securityScans } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { CommandTypes, queueCommand } from '../../services/commandQueue';
import { canAccessSite, getUserPermissions, type UserPermissions } from '../../services/permissions';
import type { AuthContext } from '../../middleware/auth';
import type { Context } from 'hono';
import { deviceIdParamSchema, scanRequestSchema, listScansQuerySchema } from './schemas';
import { getPagination, paginate, parseDateRange, matchDateRange } from './helpers';

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
  zValidator('param', deviceIdParamSchema),
  zValidator('json', scanRequestSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const payload = c.req.valid('json');

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

    const scanId = randomUUID();

    await db.insert(securityScans).values({
      id: scanId,
      deviceId: device.id,
      orgId: device.orgId,
      scanType: payload.scanType,
      status: 'queued',
      startedAt: new Date(),
      initiatedBy: auth.user.id
    });

    await queueCommand(
      device.id,
      CommandTypes.SECURITY_SCAN,
      {
        scanRecordId: scanId,
        scanType: payload.scanType,
        paths: payload.paths,
        triggerDefender: true
      },
      auth.user.id
    );

    return c.json({
      data: {
        id: scanId,
        deviceId: device.id,
        deviceName: device.hostname,
        orgId: device.orgId,
        scanType: payload.scanType,
        status: 'queued',
        startedAt: new Date().toISOString(),
        threatsFound: 0
      }
    }, 202);
  }
);

scansRoutes.get(
  '/scans/:deviceId',
  requireScope('organization', 'partner', 'system'),
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
      durationSeconds: scan.duration ?? null
    }));

    return c.json(paginate(mapped, page, limit));
  }
);
