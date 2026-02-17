import { Hono } from 'hono';
import { eq, asc, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceBootMetrics } from '../../db/schema';

export const bootPerformanceRoutes = new Hono();

const MAX_BOOT_RECORDS_PER_DEVICE = 30;

// POST /:id/boot-performance - Agent submits boot performance metrics after detecting a reboot
bootPerformanceRoutes.post('/:id/boot-performance', async (c) => {
  const agentId = c.req.param('id');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const bootTimestamp = body.bootTimestamp ? new Date(body.bootTimestamp as string) : new Date();
    if (isNaN(bootTimestamp.getTime())) {
      return c.json({ error: 'Invalid bootTimestamp' }, 400);
    }

    const totalBootSeconds = typeof body.totalBootSeconds === 'number' ? body.totalBootSeconds : 0;
    const biosSeconds = typeof body.biosSeconds === 'number' ? body.biosSeconds : null;
    const osLoaderSeconds = typeof body.osLoaderSeconds === 'number' ? body.osLoaderSeconds : null;
    const desktopReadySeconds = typeof body.desktopReadySeconds === 'number' ? body.desktopReadySeconds : null;
    const startupItems = Array.isArray(body.startupItems) ? body.startupItems : [];
    const startupItemCount = typeof body.startupItemCount === 'number' ? body.startupItemCount : startupItems.length;

    await db.insert(deviceBootMetrics).values({
      deviceId: device.id,
      orgId: device.orgId,
      bootTimestamp,
      biosSeconds,
      osLoaderSeconds,
      desktopReadySeconds,
      totalBootSeconds,
      startupItemCount,
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
  } catch (err) {
    console.error(`[BootPerformance] Failed to ingest boot metrics for agent ${agentId}:`, err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});
