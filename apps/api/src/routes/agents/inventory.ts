import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  deviceHardware,
  deviceDisks,
  deviceNetwork,
  softwareInventory,
} from '../../db/schema';
import {
  agentWarrantyInfoSchema,
  updateHardwareSchema,
  updateSoftwareSchema,
  updateDisksSchema,
  updateNetworkSchema,
} from './schemas';
import { sanitizeDate } from './helpers';
import { upsertAgentWarranty } from '../../services/warrantySync';
import { queueWarrantySyncForDevice } from '../../services/warrantyWorker';
import { requireAgentRole } from '../../middleware/requireAgentRole';

export const inventoryRoutes = new Hono();
// Inventory ingest is the main agent's job; reject watchdog-role tokens.
inventoryRoutes.use('*', requireAgentRole);

inventoryRoutes.put('/:id/hardware', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), zValidator('json', updateHardwareSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  // Capture the prior warranty-relevant identity so we can detect the
  // empty -> populated transition after the upsert. Warranty sync at
  // enrollment time runs before the first inventory report, so it hits the
  // "no serial/manufacturer" early-return and skips; nothing re-fires it once
  // hardware arrives, leaving the device with no warranty row until the next
  // 6-hour batch sweep or a manual refresh (issue #1732).
  const [priorHw] = await db
    .select({
      serialNumber: deviceHardware.serialNumber,
      manufacturer: deviceHardware.manufacturer,
    })
    .from(deviceHardware)
    .where(eq(deviceHardware.deviceId, device.id))
    .limit(1);

  await db
    .insert(deviceHardware)
    .values({
      deviceId: device.id,
      orgId: device.orgId,
      ...data,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: deviceHardware.deviceId,
      set: {
        ...data,
        updatedAt: new Date()
      }
    });

  // Enqueue a warranty sync only when this report makes both the manufacturer
  // and serial number known for the first time (empty/absent -> populated).
  // queueWarrantySyncForDevice uses a stable jobId so duplicate enqueues are
  // deduplicated by BullMQ, but gating on the transition avoids redundant Dell
  // API calls on every routine hardware re-report. Fire-and-forget.
  const wasIdentified = Boolean(priorHw?.manufacturer && priorHw?.serialNumber);
  const nowIdentified = Boolean(data.manufacturer && data.serialNumber);
  if (!wasIdentified && nowIdentified) {
    queueWarrantySyncForDevice(device.id).catch((err) => {
      console.error(
        `[Inventory] Failed to queue warranty sync on hardware report for device ${device.id}:`,
        err instanceof Error ? err.message : err
      );
    });
  }

  return c.json({ success: true });
});

inventoryRoutes.put('/:id/software', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), zValidator('json', updateSoftwareSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(softwareInventory)
      .where(eq(softwareInventory.deviceId, device.id));

    if (data.software.length > 0) {
      const now = new Date();
      await tx.insert(softwareInventory).values(
        data.software.map((item) => ({
          deviceId: device.id,
          orgId: device.orgId,
          name: item.name,
          version: item.version || null,
          vendor: item.vendor || null,
          installDate: sanitizeDate(item.installDate),
          installLocation: item.installLocation || null,
          uninstallString: item.uninstallString || null,
          fileHash: item.fileHash || null,
          hashAlgorithm: item.hashAlgorithm || null,
          lastSeen: now
        }))
      );
    }
  });

  return c.json({ success: true, count: data.software.length });
});

inventoryRoutes.put('/:id/disks', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), zValidator('json', updateDisksSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(deviceDisks)
      .where(eq(deviceDisks.deviceId, device.id));

    if (data.disks.length > 0) {
      const now = new Date();
      await tx.insert(deviceDisks).values(
        data.disks.map((disk) => ({
          deviceId: device.id,
          orgId: device.orgId,
          mountPoint: disk.mountPoint,
          device: disk.device || null,
          fsType: disk.fsType || null,
          totalGb: disk.totalGb,
          usedGb: disk.usedGb,
          freeGb: disk.freeGb,
          usedPercent: disk.usedPercent,
          health: disk.health || 'healthy',
          updatedAt: now
        }))
      );
    }
  });

  return c.json({ success: true, count: data.disks.length });
});

inventoryRoutes.put('/:id/network', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }), zValidator('json', updateNetworkSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(deviceNetwork)
      .where(eq(deviceNetwork.deviceId, device.id));

    if (data.adapters.length > 0) {
      const now = new Date();
      await tx.insert(deviceNetwork).values(
        data.adapters.map((adapter) => ({
          deviceId: device.id,
          orgId: device.orgId,
          interfaceName: adapter.interfaceName,
          macAddress: adapter.macAddress || null,
          ipAddress: adapter.ipAddress || null,
          ipType: adapter.ipType || 'ipv4',
          isPrimary: adapter.isPrimary || false,
          updatedAt: now
        }))
      );
    }
  });

  return c.json({ success: true, count: data.adapters.length });
});

// PUT /:id/warranty-info — agent reports locally-collected warranty data (e.g. Apple plist)
inventoryRoutes.put(
  '/:id/warranty-info',
  bodyLimit({ maxSize: 1 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
  zValidator('json', agentWarrantyInfoSchema),
  async (c) => {
    const agentId = c.req.param('id');
    const data = c.req.valid('json');

    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Get serial number from hardware table for the warranty record
    const [hw] = await db
      .select({ serialNumber: deviceHardware.serialNumber })
      .from(deviceHardware)
      .where(eq(deviceHardware.deviceId, device.id))
      .limit(1);

    await upsertAgentWarranty(device.id, device.orgId, {
      source: data.source,
      manufacturer: data.manufacturer,
      serialNumber: hw?.serialNumber ?? null,
      coverageEndDate: data.coverageEndDate ?? null,
      coverageStartDate: data.coverageStartDate ?? null,
      coverageType: data.coverageType ?? null,
      coverageKind: data.coverageKind ?? null,
    });

    return c.json({ success: true });
  }
);
