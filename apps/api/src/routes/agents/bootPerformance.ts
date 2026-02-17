import { Hono } from 'hono';
import { eq, asc, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceBootMetrics } from '../../db/schema';

export const bootPerformanceRoutes = new Hono();

const MAX_BOOT_RECORDS_PER_DEVICE = 30;

// POST /:id/boot-performance - Agent submits boot performance metrics after detecting a reboot
bootPerformanceRoutes.post('/:id/boot-performance', async (c) => {
  const agentId = c.req.param('id');
  const body = await c.req.json();

  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const bootTimestamp = body.bootTimestamp ? new Date(body.bootTimestamp) : new Date();
  const startupItems = Array.isArray(body.startupItems) ? body.startupItems : [];

  await db.insert(deviceBootMetrics).values({
    deviceId: device.id,
    orgId: device.orgId,
    bootTimestamp,
    biosSeconds: body.biosSeconds ?? null,
    osLoaderSeconds: body.osLoaderSeconds ?? null,
    desktopReadySeconds: body.desktopReadySeconds ?? null,
    totalBootSeconds: body.totalBootSeconds ?? 0,
    startupItemCount: body.startupItemCount ?? startupItems.length,
    startupItems,
  });

  // Retention: keep only the most recent N boot records per device.
  // Delete the oldest records if we exceed the limit.
  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deviceBootMetrics)
    .where(eq(deviceBootMetrics.deviceId, device.id));

  const totalRecords = countResult[0]?.count ?? 0;
  if (totalRecords > MAX_BOOT_RECORDS_PER_DEVICE) {
    const excess = totalRecords - MAX_BOOT_RECORDS_PER_DEVICE;
    // Find the IDs of the oldest records to delete
    const oldestRecords = await db
      .select({ id: deviceBootMetrics.id })
      .from(deviceBootMetrics)
      .where(eq(deviceBootMetrics.deviceId, device.id))
      .orderBy(asc(deviceBootMetrics.bootTimestamp))
      .limit(excess);

    if (oldestRecords.length > 0) {
      const idsToDelete = oldestRecords.map(r => r.id);
      await db
        .delete(deviceBootMetrics)
        .where(inArray(deviceBootMetrics.id, idsToDelete));
    }
  }

  return c.json({ success: true }, 201);
});
