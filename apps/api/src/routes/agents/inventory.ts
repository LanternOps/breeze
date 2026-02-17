import { Hono } from 'hono';
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
  updateHardwareSchema,
  updateSoftwareSchema,
  updateDisksSchema,
  updateNetworkSchema,
} from './schemas';

export const inventoryRoutes = new Hono();

inventoryRoutes.put('/:id/hardware', zValidator('json', updateHardwareSchema), async (c) => {
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

  await db
    .insert(deviceHardware)
    .values({
      deviceId: device.id,
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

  return c.json({ success: true });
});

inventoryRoutes.put('/:id/software', zValidator('json', updateSoftwareSchema), async (c) => {
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
          name: item.name,
          version: item.version || null,
          vendor: item.vendor || null,
          installDate: item.installDate || null,
          installLocation: item.installLocation || null,
          uninstallString: item.uninstallString || null,
          lastSeen: now
        }))
      );
    }
  });

  return c.json({ success: true, count: data.software.length });
});

inventoryRoutes.put('/:id/disks', zValidator('json', updateDisksSchema), async (c) => {
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

inventoryRoutes.put('/:id/network', zValidator('json', updateNetworkSchema), async (c) => {
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
