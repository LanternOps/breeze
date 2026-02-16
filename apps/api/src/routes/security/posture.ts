import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';

import { db } from '../../db';
import { devices } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import {
  getLatestSecurityPostureForDevice,
  listLatestSecurityPosture
} from '../../services/securityPosture';
import { postureQuerySchema, deviceIdParamSchema } from './schemas';
import { getPagination, paginate } from './helpers';

export const postureRoutes = new Hono();

postureRoutes.get(
  '/posture',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', postureQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const parsedMinScore = query.minScore !== undefined ? Number.parseInt(query.minScore, 10) : undefined;
    const parsedMaxScore = query.maxScore !== undefined ? Number.parseInt(query.maxScore, 10) : undefined;
    if (parsedMinScore !== undefined && Number.isNaN(parsedMinScore)) {
      return c.json({ error: 'Invalid minScore' }, 400);
    }
    if (parsedMaxScore !== undefined && Number.isNaN(parsedMaxScore)) {
      return c.json({ error: 'Invalid maxScore' }, 400);
    }

    const orgIds = query.orgId
      ? [query.orgId]
      : auth.orgId
        ? [auth.orgId]
        : auth.accessibleOrgIds && auth.accessibleOrgIds.length > 0
          ? auth.accessibleOrgIds
          : undefined;

    if (!orgIds && auth.scope !== 'system') {
      return c.json({ error: 'Organization context required' }, 400);
    }

    const data = await listLatestSecurityPosture({
      orgIds,
      minScore: parsedMinScore,
      maxScore: parsedMaxScore,
      riskLevel: query.riskLevel,
      search: query.search,
      limit: Math.max(500, limit * page)
    });

    const summary = {
      totalDevices: data.length,
      averageScore: data.length
        ? Math.round(data.reduce((sum, item) => sum + item.overallScore, 0) / data.length)
        : 0,
      lowRiskDevices: data.filter((item) => item.riskLevel === 'low').length,
      mediumRiskDevices: data.filter((item) => item.riskLevel === 'medium').length,
      highRiskDevices: data.filter((item) => item.riskLevel === 'high').length,
      criticalRiskDevices: data.filter((item) => item.riskLevel === 'critical').length
    };

    return c.json({
      ...paginate(data, page, limit),
      summary
    });
  }
);

postureRoutes.get(
  '/posture/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');

    const [device] = await db
      .select({
        id: devices.id,
        orgId: devices.orgId
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!auth.canAccessOrg(device.orgId)) {
      return c.json({ error: 'Access denied to this device' }, 403);
    }

    const posture = await getLatestSecurityPostureForDevice(deviceId);
    if (!posture) {
      return c.json({ error: 'No security posture available for this device yet' }, 404);
    }
    return c.json({ data: posture });
  }
);
