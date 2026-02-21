import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { reliabilityMetricsSchema } from '@breeze/shared/validators';

import { db } from '../../db';
import { deviceReliabilityHistory, devices } from '../../db/schema';
import { enqueueDeviceReliabilityComputation } from '../../jobs/reliabilityWorker';
import { writeAuditEvent } from '../../services/auditEvents';
import { computeAndPersistDeviceReliability } from '../../services/reliabilityScoring';

export const reliabilityRoutes = new Hono();

reliabilityRoutes.post('/:id/reliability', zValidator('json', reliabilityMetricsSchema), async (c) => {
  const agentId = c.req.param('id');
  const metrics = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await db.insert(deviceReliabilityHistory).values({
    deviceId: device.id,
    orgId: device.orgId,
    collectedAt: new Date(),
    uptimeSeconds: metrics.uptimeSeconds,
    bootTime: new Date(metrics.bootTime),
    crashEvents: metrics.crashEvents,
    appHangs: metrics.appHangs,
    serviceFailures: metrics.serviceFailures,
    hardwareErrors: metrics.hardwareErrors,
    rawMetrics: metrics,
  });

  try {
    await enqueueDeviceReliabilityComputation(device.id);
  } catch (error) {
    console.error('[agents] failed to enqueue reliability computation, using inline fallback:', error);
    await computeAndPersistDeviceReliability(device.id);
  }

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.reliability.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      crashes: metrics.crashEvents.length,
      hangs: metrics.appHangs.length,
      serviceFailures: metrics.serviceFailures.length,
      hardwareErrors: metrics.hardwareErrors.length,
    },
  });

  return c.json({ success: true, status: 'received' });
});
