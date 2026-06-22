import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, lte, gte, asc, desc } from 'drizzle-orm';
import { db } from '../../db';
import { deviceProcessSamples } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { processSamplesQuerySchema } from './schemas';

export const processSamplesRoutes = new Hono();

processSamplesRoutes.use('*', authMiddleware);

processSamplesRoutes.get(
  '/:id/process-samples',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', processSamplesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);

    // Range markers: lightweight timestamp-only list so the scrubber knows
    // which samples exist in the visible chart range.
    if (query.from && query.to) {
      const markers = await db
        .select({ timestamp: deviceProcessSamples.timestamp })
        .from(deviceProcessSamples)
        .where(and(
          eq(deviceProcessSamples.deviceId, deviceId),
          gte(deviceProcessSamples.timestamp, new Date(query.from)),
          lte(deviceProcessSamples.timestamp, new Date(query.to))
        ))
        .orderBy(asc(deviceProcessSamples.timestamp));
      return c.json({ markers: markers.map((m) => m.timestamp.toISOString()) });
    }

    // Nearest snapshot at-or-before the clicked time (index-backed reverse scan
    // on PK (device_id, timestamp DESC)).
    const [sample] = await db
      .select()
      .from(deviceProcessSamples)
      .where(and(
        eq(deviceProcessSamples.deviceId, deviceId),
        lte(deviceProcessSamples.timestamp, new Date(query.at!))
      ))
      .orderBy(desc(deviceProcessSamples.timestamp))
      .limit(1);

    if (!sample) {
      // Distinguish "this device has never recorded a process sample" from
      // "samples exist, but none at-or-before the clicked time" so the UI can
      // show a meaningful empty state instead of a single ambiguous blank
      // message (issue #1722). A hit here is cheap: the same
      // (device_id, timestamp DESC) index backs this existence probe.
      const [anySample] = await db
        .select({ timestamp: deviceProcessSamples.timestamp })
        .from(deviceProcessSamples)
        .where(eq(deviceProcessSamples.deviceId, deviceId))
        .limit(1);
      return c.json({ sample: null, hasAnySample: Boolean(anySample) });
    }
    return c.json({
      sample: {
        timestamp: sample.timestamp.toISOString(),
        agentTimestamp: sample.agentTimestamp ? sample.agentTimestamp.toISOString() : null,
        topProcesses: sample.topProcesses
      },
      hasAnySample: true
    });
  }
);
