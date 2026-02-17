import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceRegistryState, deviceConfigState } from '../../db/schema';
import { normalizeStateValue, parseDate } from './helpers';

export const stateReportingRoutes = new Hono();

// Get agent config
stateReportingRoutes.get('/:id/config', async (c) => {
  const agentId = c.req.param('id');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  return c.json({
    heartbeatIntervalSeconds: 60,
    metricsCollectionIntervalSeconds: 30,
    enabledCollectors: ['hardware', 'software', 'metrics', 'network']
  });
});

const updateRegistryStateSchema = z.object({
  entries: z.array(z.object({
    registryPath: z.string().min(1),
    valueName: z.string().min(1),
    valueData: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    valueType: z.string().optional(),
    collectedAt: z.string().optional()
  })),
  replace: z.boolean().optional().default(true)
});

stateReportingRoutes.put('/:id/registry-state', zValidator('json', updateRegistryStateSchema), async (c) => {
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
    if (data.replace) {
      await tx
        .delete(deviceRegistryState)
        .where(eq(deviceRegistryState.deviceId, device.id));
    }

    if (data.entries.length === 0) {
      return;
    }

    const now = new Date();
    await tx
      .insert(deviceRegistryState)
      .values(
        data.entries.map((entry) => ({
          deviceId: device.id,
          registryPath: entry.registryPath,
          valueName: entry.valueName,
          valueData: normalizeStateValue(entry.valueData),
          valueType: entry.valueType || null,
          collectedAt: parseDate(entry.collectedAt) ?? now,
          updatedAt: now
        }))
      )
      .onConflictDoUpdate({
        target: [
          deviceRegistryState.deviceId,
          deviceRegistryState.registryPath,
          deviceRegistryState.valueName
        ],
        set: {
          valueData: sql`excluded.value_data`,
          valueType: sql`excluded.value_type`,
          collectedAt: sql`excluded.collected_at`,
          updatedAt: now
        }
      });
  });

  return c.json({ success: true, count: data.entries.length });
});

const updateConfigStateSchema = z.object({
  entries: z.array(z.object({
    filePath: z.string().min(1),
    configKey: z.string().min(1),
    configValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    collectedAt: z.string().optional()
  })),
  replace: z.boolean().optional().default(true)
});

stateReportingRoutes.put('/:id/config-state', zValidator('json', updateConfigStateSchema), async (c) => {
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
    if (data.replace) {
      await tx
        .delete(deviceConfigState)
        .where(eq(deviceConfigState.deviceId, device.id));
    }

    if (data.entries.length === 0) {
      return;
    }

    const now = new Date();
    await tx
      .insert(deviceConfigState)
      .values(
        data.entries.map((entry) => ({
          deviceId: device.id,
          filePath: entry.filePath,
          configKey: entry.configKey,
          configValue: normalizeStateValue(entry.configValue),
          collectedAt: parseDate(entry.collectedAt) ?? now,
          updatedAt: now
        }))
      )
      .onConflictDoUpdate({
        target: [
          deviceConfigState.deviceId,
          deviceConfigState.filePath,
          deviceConfigState.configKey
        ],
        set: {
          configValue: sql`excluded.config_value`,
          collectedAt: sql`excluded.collected_at`,
          updatedAt: now
        }
      });
  });

  return c.json({ success: true, count: data.entries.length });
});
