import { randomUUID } from 'crypto';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '../../db';
import { devices, securityScans } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { CommandTypes, queueCommand } from '../../services/commandQueue';
import { deviceIdParamSchema, scanRequestSchema, listScansQuerySchema } from './schemas';
import { getPagination, paginate, parseDateRange, matchDateRange } from './helpers';

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
      .select({ id: devices.id, hostname: devices.hostname, orgId: devices.orgId })
      .from(devices)
      .where(and(...conditions))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const scanId = randomUUID();

    await db.insert(securityScans).values({
      id: scanId,
      deviceId: device.id,
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
      .select({ id: devices.id, hostname: devices.hostname, orgId: devices.orgId })
      .from(devices)
      .where(and(...conditions))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
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
