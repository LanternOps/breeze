import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceBootMetrics } from '../../db/schema';
import { normalizeStartupItems } from '../../services/startupItems';

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
    const startupItems = normalizeStartupItems(Array.isArray(body.startupItems) ? body.startupItems : []);
    const startupItemCount = startupItems.length;

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
    }).onConflictDoUpdate({
      target: [deviceBootMetrics.deviceId, deviceBootMetrics.bootTimestamp],
      set: {
        orgId: device.orgId,
        biosSeconds,
        osLoaderSeconds,
        desktopReadySeconds,
        totalBootSeconds,
        startupItemCount,
        startupItems,
      },
    });

    // Retention: keep only the most recent N boot records per device.
    // Single SQL pass with row_number avoids count+scan races.
    await db.execute(sql`
      DELETE FROM device_boot_metrics
      WHERE id IN (
        SELECT id
        FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY device_id
              ORDER BY boot_timestamp DESC, created_at DESC
            ) AS rn
          FROM device_boot_metrics
          WHERE device_id = ${device.id}
        ) ranked
        WHERE ranked.rn > ${MAX_BOOT_RECORDS_PER_DEVICE}
      )
    `);

    return c.json({ success: true }, 201);
  } catch (err) {
    console.error(`[BootPerformance] Failed to ingest boot metrics for agent ${agentId}:`, err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});
