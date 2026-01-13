import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  deviceMetrics,
  deviceCommands,
  enrollmentKeys
} from '../db/schema';
import { createHash, randomBytes } from 'crypto';

export const agentRoutes = new Hono();

// Enrollment request schema
const enrollSchema = z.object({
  enrollmentKey: z.string().min(1),
  hostname: z.string().min(1),
  osType: z.enum(['windows', 'macos', 'linux']),
  osVersion: z.string().min(1),
  architecture: z.string().min(1),
  agentVersion: z.string().min(1),
  hardwareInfo: z.object({
    cpuModel: z.string().optional(),
    cpuCores: z.number().int().optional(),
    cpuThreads: z.number().int().optional(),
    ramTotalMb: z.number().int().optional(),
    diskTotalGb: z.number().int().optional(),
    serialNumber: z.string().optional(),
    manufacturer: z.string().optional(),
    model: z.string().optional(),
    biosVersion: z.string().optional()
  }).optional(),
  networkInfo: z.array(z.object({
    name: z.string(),
    mac: z.string().optional(),
    ip: z.string().optional(),
    isPrimary: z.boolean().optional()
  })).optional()
});

// Heartbeat request schema
const heartbeatSchema = z.object({
  metrics: z.object({
    cpuPercent: z.number(),
    ramPercent: z.number(),
    ramUsedMb: z.number().int(),
    diskPercent: z.number(),
    diskUsedGb: z.number(),
    networkInBytes: z.number().int().optional(),
    networkOutBytes: z.number().int().optional(),
    processCount: z.number().int().optional()
  }),
  status: z.enum(['ok', 'warning', 'error']),
  agentVersion: z.string(),
  pendingReboot: z.boolean().optional(),
  lastUser: z.string().optional(),
  uptime: z.number().int().optional()
});

const commandResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'timeout']),
  exitCode: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  durationMs: z.number().int(),
  error: z.string().optional()
});

// Generate a unique agent ID
function generateAgentId(): string {
  return randomBytes(32).toString('hex');
}

// Generate API key for agent
function generateApiKey(): string {
  return `brz_${randomBytes(32).toString('hex')}`;
}

// Agent enrollment
agentRoutes.post('/enroll', zValidator('json', enrollSchema), async (c) => {
  const data = c.req.valid('json');

  // Validate enrollment key
  const [key] = await db
    .select()
    .from(enrollmentKeys)
    .where(
      and(
        eq(enrollmentKeys.key, data.enrollmentKey),
        sql`(${enrollmentKeys.expiresAt} IS NULL OR ${enrollmentKeys.expiresAt} > NOW())`,
        sql`(${enrollmentKeys.maxUsage} IS NULL OR ${enrollmentKeys.usageCount} < ${enrollmentKeys.maxUsage})`
      )
    )
    .limit(1);

  if (!key) {
    return c.json({ error: 'Invalid or expired enrollment key' }, 401);
  }

  // Generate unique identifiers
  const agentId = generateAgentId();
  const apiKey = generateApiKey();

  // Validate site exists
  const siteId = key.siteId;
  if (!siteId) {
    return c.json({ error: 'Enrollment key must be associated with a site' }, 400);
  }

  // Create device record in transaction
  const result = await db.transaction(async (tx) => {

    // Insert device
    const [device] = await tx
      .insert(devices)
      .values({
        orgId: key.orgId,
        siteId: siteId,
        agentId: agentId,
        hostname: data.hostname,
        osType: data.osType,
        osVersion: data.osVersion,
        architecture: data.architecture,
        agentVersion: data.agentVersion,
        status: 'online',
        lastSeenAt: new Date(),
        tags: []
      })
      .returning();

    if (!device) {
      throw new Error('Failed to create device');
    }

    // Insert hardware info if provided
    if (data.hardwareInfo) {
      await tx
        .insert(deviceHardware)
        .values({
          deviceId: device.id,
          cpuModel: data.hardwareInfo.cpuModel,
          cpuCores: data.hardwareInfo.cpuCores,
          cpuThreads: data.hardwareInfo.cpuThreads,
          ramTotalMb: data.hardwareInfo.ramTotalMb,
          diskTotalGb: data.hardwareInfo.diskTotalGb,
          serialNumber: data.hardwareInfo.serialNumber,
          manufacturer: data.hardwareInfo.manufacturer,
          model: data.hardwareInfo.model,
          biosVersion: data.hardwareInfo.biosVersion
        });
    }

    // Insert network interfaces if provided
    if (data.networkInfo && data.networkInfo.length > 0) {
      for (const nic of data.networkInfo) {
        await tx
          .insert(deviceNetwork)
          .values({
            deviceId: device.id,
            interfaceName: nic.name,
            macAddress: nic.mac,
            ipAddress: nic.ip,
            ipType: nic.ip?.includes(':') ? 'ipv6' : 'ipv4',
            isPrimary: nic.isPrimary ?? false
          });
      }
    }

    // Increment enrollment key usage
    await tx
      .update(enrollmentKeys)
      .set({ usageCount: sql`${enrollmentKeys.usageCount} + 1` })
      .where(eq(enrollmentKeys.id, key.id));

    return device;
  });

  if (!result || 'error' in result) {
    return c.json({ error: 'Failed to enroll device' }, 500);
  }

  // Return enrollment response
  return c.json({
    agentId: agentId,
    deviceId: result.id,
    authToken: apiKey,
    orgId: key.orgId,
    siteId: key.siteId,
    config: {
      heartbeatIntervalSeconds: 60,
      metricsCollectionIntervalSeconds: 30
    }
  }, 201);
});

// Agent heartbeat
agentRoutes.post('/:id/heartbeat', zValidator('json', heartbeatSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  // Find device by agent ID
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  // Update device status and metrics
  await db
    .update(devices)
    .set({
      lastSeenAt: new Date(),
      status: 'online',
      agentVersion: data.agentVersion,
      updatedAt: new Date()
    })
    .where(eq(devices.id, device.id));

  // Store metrics
  await db
    .insert(deviceMetrics)
    .values({
      deviceId: device.id,
      timestamp: new Date(),
      cpuPercent: data.metrics.cpuPercent,
      ramPercent: data.metrics.ramPercent,
      ramUsedMb: data.metrics.ramUsedMb,
      diskPercent: data.metrics.diskPercent,
      diskUsedGb: data.metrics.diskUsedGb,
      networkInBytes: data.metrics.networkInBytes ? BigInt(data.metrics.networkInBytes) : null,
      networkOutBytes: data.metrics.networkOutBytes ? BigInt(data.metrics.networkOutBytes) : null,
      processCount: data.metrics.processCount
    });

  // Get pending commands
  const commands = await db
    .select()
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, device.id),
        eq(deviceCommands.status, 'pending')
      )
    )
    .orderBy(deviceCommands.createdAt)
    .limit(10);

  // Mark commands as sent
  if (commands.length > 0) {
    for (const cmd of commands) {
      await db
        .update(deviceCommands)
        .set({ status: 'sent' })
        .where(eq(deviceCommands.id, cmd.id));
    }
  }

  return c.json({
    commands: commands.map(cmd => ({
      id: cmd.id,
      type: cmd.type,
      payload: cmd.payload
    })),
    configUpdate: null,
    upgradeTo: null
  });
});

// Submit command result
agentRoutes.post(
  '/:id/commands/:commandId/result',
  zValidator('json', commandResultSchema),
  async (c) => {
    const commandId = c.req.param('commandId');
    const data = c.req.valid('json');

    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.id, commandId))
      .limit(1);

    if (!command) {
      return c.json({ error: 'Command not found' }, 404);
    }

    await db
      .update(deviceCommands)
      .set({
        status: data.status === 'completed' ? 'completed' : 'failed',
        completedAt: new Date(),
        result: {
          exitCode: data.exitCode,
          stdout: data.stdout,
          stderr: data.stderr,
          durationMs: data.durationMs,
          error: data.error
        }
      })
      .where(eq(deviceCommands.id, commandId));

    return c.json({ success: true });
  }
);

// Get agent config
agentRoutes.get('/:id/config', async (c) => {
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

agentRoutes.put('/:id/hardware', zValidator('json', updateHardwareSchema), async (c) => {
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
