import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  deviceDisks,
  softwareInventory,
  deviceConnections
} from '../../db/schema';

export const inventoryRoutes = new Hono();

// Update hardware info
const updateHardwareSchema = z.object({
  cpuModel: z.string().optional(),
  cpuCores: z.number().int().optional(),
  cpuThreads: z.number().int().optional(),
  ramTotalMb: z.number().int().optional(),
  diskTotalGb: z.number().int().optional(),
  serialNumber: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  biosVersion: z.string().optional(),
  gpuModel: z.string().optional()
});

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

// Update software inventory
const updateSoftwareSchema = z.object({
  software: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    vendor: z.string().optional(),
    installDate: z.string().optional(),
    installLocation: z.string().optional(),
    uninstallString: z.string().optional()
  }))
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

// Update disk drives inventory
const updateDisksSchema = z.object({
  disks: z.array(z.object({
    mountPoint: z.string().min(1),
    device: z.string().optional(),
    fsType: z.string().optional(),
    totalGb: z.number(),
    usedGb: z.number(),
    freeGb: z.number(),
    usedPercent: z.number(),
    health: z.string().optional()
  }))
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

// Update network adapters
const updateNetworkSchema = z.object({
  adapters: z.array(z.object({
    interfaceName: z.string().min(1),
    macAddress: z.string().optional(),
    ipAddress: z.string().optional(),
    ipType: z.enum(['ipv4', 'ipv6']).optional(),
    isPrimary: z.boolean().optional()
  }))
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

// Submit network connections
const submitConnectionsSchema = z.object({
  connections: z.array(z.object({
    protocol: z.enum(['tcp', 'tcp6', 'udp', 'udp6']),
    localAddr: z.string().min(1),
    localPort: z.number().int().min(0).max(65535),
    remoteAddr: z.string().optional(),
    remotePort: z.number().int().min(0).max(65535).optional(),
    state: z.string().optional(),
    pid: z.number().int().optional(),
    processName: z.string().optional()
  }))
});

inventoryRoutes.put('/:id/connections', zValidator('json', submitConnectionsSchema), async (c) => {
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
      .delete(deviceConnections)
      .where(eq(deviceConnections.deviceId, device.id));

    if (data.connections.length > 0) {
      const now = new Date();
      await tx.insert(deviceConnections).values(
        data.connections.map((conn) => ({
          deviceId: device.id,
          protocol: conn.protocol,
          localAddr: conn.localAddr,
          localPort: conn.localPort,
          remoteAddr: conn.remoteAddr || null,
          remotePort: conn.remotePort || null,
          state: conn.state || null,
          pid: conn.pid || null,
          processName: conn.processName || null,
          updatedAt: now
        }))
      );
    }
  });

  return c.json({ success: true, count: data.connections.length });
});
