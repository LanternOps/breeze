import { Hono } from 'hono';
import { db } from '../../db';
import { devices, deviceHardware, deviceMetrics, alerts } from '../../db/schema';
import { eq, and, desc, SQL } from 'drizzle-orm';
import { authMiddleware } from '../../middleware/auth';
import { executeCommand } from '../../services/commandQueue';

const diagnoseRoutes = new Hono();

diagnoseRoutes.use('*', authMiddleware);

diagnoseRoutes.post('/:id/diagnose', async (c) => {
  const auth = c.get('auth');
  const deviceId = c.req.param('id');

  try {
    // Verify device access
    const conditions: SQL[] = [eq(devices.id, deviceId)];
    const orgCond = auth.orgCondition(devices.orgId);
    if (orgCond) conditions.push(orgCond);
    const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);

    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    if (device.status !== 'online') {
      return c.json({ error: `Device is ${device.status}, cannot capture screenshot` }, 400);
    }

    // Capture screenshot
    const screenshotResult = await executeCommand(deviceId, 'take_screenshot', {
      monitor: 0
    }, { userId: auth.user.id, timeoutMs: 30000 });

    if (screenshotResult.status !== 'completed') {
      return c.json({ error: screenshotResult.error || 'Screenshot capture failed' }, 502);
    }

    let screenshotData: { imageBase64?: string; width?: number; height?: number; capturedAt?: string };
    try {
      screenshotData = JSON.parse(screenshotResult.stdout ?? '{}');
    } catch (parseErr) {
      const rawPreview = (screenshotResult.stdout ?? '').slice(0, 200);
      console.error(`[Diagnose] Failed to parse screenshot JSON for device ${deviceId}:`, parseErr, 'Raw stdout preview:', rawPreview);
      return c.json({ error: 'Failed to parse screenshot data' }, 500);
    }

    // Gather device context in parallel
    const [hardware, recentMetrics, activeAlerts] = await Promise.all([
      db.select({
        cpuModel: deviceHardware.cpuModel,
        cpuCores: deviceHardware.cpuCores,
        ramTotalMb: deviceHardware.ramTotalMb,
        diskTotalGb: deviceHardware.diskTotalGb,
        gpuModel: deviceHardware.gpuModel,
      }).from(deviceHardware).where(eq(deviceHardware.deviceId, deviceId)).limit(1),
      db.select().from(deviceMetrics)
        .where(eq(deviceMetrics.deviceId, deviceId))
        .orderBy(desc(deviceMetrics.timestamp))
        .limit(3),
      db.select({
        id: alerts.id,
        severity: alerts.severity,
        title: alerts.title,
        message: alerts.message,
        triggeredAt: alerts.triggeredAt,
        status: alerts.status,
      }).from(alerts)
        .where(and(
          eq(alerts.deviceId, deviceId),
          eq(alerts.status, 'active')
        ))
        .orderBy(desc(alerts.triggeredAt))
        .limit(5),
    ]);

    return c.json({
      screenshot: {
        imageBase64: screenshotData.imageBase64,
        width: screenshotData.width,
        height: screenshotData.height,
        capturedAt: screenshotData.capturedAt,
      },
      device: {
        id: device.id,
        hostname: device.hostname,
        osType: device.osType,
        osVersion: device.osVersion,
        status: device.status,
      },
      hardware: hardware[0] ?? null,
      recentMetrics,
      activeAlerts,
    });
  } catch (err) {
    console.error(`[Diagnose] Failed to diagnose device ${deviceId}:`, err);
    return c.json({ error: 'Diagnosis failed. Please try again.' }, 500);
  }
});

export { diagnoseRoutes };
