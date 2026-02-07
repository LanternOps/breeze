import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  deviceDisks,
  deviceMetrics,
  deviceCommands,
  deviceConnections,
  enrollmentKeys,
  softwareInventory,
  patches,
  devicePatches,
  deviceEventLogs,
  securityStatus,
  securityThreats,
  securityScans
} from '../db/schema';
import { createHash, randomBytes } from 'crypto';
import { agentAuthMiddleware } from '../middleware/agentAuth';
import { writeAuditEvent } from '../services/auditEvents';

export const agentRoutes = new Hono();

// Apply agent auth to all parameterized routes (skips /enroll)
agentRoutes.use('/:id/*', async (c, next) => {
  // Hono matches "enroll" as :id — skip auth for the enrollment endpoint
  if (c.req.param('id') === 'enroll') {
    return next();
  }
  return agentAuthMiddleware(c, next);
});

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
    biosVersion: z.string().optional(),
    gpuModel: z.string().optional()
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

const securityProviderValues = [
  'windows_defender',
  'bitdefender',
  'sophos',
  'sentinelone',
  'crowdstrike',
  'malwarebytes',
  'eset',
  'kaspersky',
  'other'
] as const;

type SecurityProviderValue = (typeof securityProviderValues)[number];

const securityStatusIngestSchema = z.object({
  provider: z.string().optional(),
  providerVersion: z.string().optional(),
  definitionsVersion: z.string().optional(),
  definitionsDate: z.string().optional(),
  lastScan: z.string().optional(),
  lastScanType: z.string().optional(),
  realTimeProtection: z.boolean().optional(),
  threatCount: z.number().int().min(0).optional(),
  firewallEnabled: z.boolean().optional(),
  encryptionStatus: z.string().optional(),
  gatekeeperEnabled: z.boolean().optional(),
  guardianEnabled: z.boolean().optional(),
  windowsSecurityCenterAvailable: z.boolean().optional(),
  avProducts: z.array(
    z.object({
      displayName: z.string().optional(),
      provider: z.string().optional(),
      realTimeProtection: z.boolean().optional(),
      definitionsUpToDate: z.boolean().optional(),
      productState: z.number().int().optional()
    }).passthrough()
  ).optional()
}).passthrough();

type SecurityStatusPayload = z.infer<typeof securityStatusIngestSchema>;

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const securityCommandTypes = {
  collectStatus: 'security_collect_status',
  scan: 'security_scan',
  quarantine: 'security_threat_quarantine',
  remove: 'security_threat_remove',
  restore: 'security_threat_restore'
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeProvider(raw: unknown): SecurityProviderValue {
  if (typeof raw !== 'string') return 'other';
  const value = raw.trim().toLowerCase();
  switch (value) {
    case 'windows_defender':
    case 'microsoft_defender':
    case 'defender':
    case 'prov-defender':
      return 'windows_defender';
    case 'bitdefender':
    case 'prov-bitdefender':
      return 'bitdefender';
    case 'sophos':
      return 'sophos';
    case 'sentinelone':
    case 'sentinel_one':
    case 'sentinel':
    case 'prov-sentinelone':
      return 'sentinelone';
    case 'crowdstrike':
    case 'prov-crowdstrike':
      return 'crowdstrike';
    case 'malwarebytes':
      return 'malwarebytes';
    case 'eset':
      return 'eset';
    case 'kaspersky':
      return 'kaspersky';
    default:
      return 'other';
  }
}

function normalizeEncryptionStatus(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === '') return null;
  if (value === 'encrypted' || value === 'partial' || value === 'unencrypted' || value === 'unknown') {
    return value;
  }
  if (value.includes('encrypt')) return 'encrypted';
  if (value.includes('unencrypt')) return 'unencrypted';
  return value.slice(0, 50);
}

function normalizeSeverity(raw: unknown): 'low' | 'medium' | 'high' | 'critical' {
  if (typeof raw !== 'string') return 'medium';
  const value = raw.trim().toLowerCase();
  if (value === 'critical') return 'critical';
  if (value === 'high') return 'high';
  if (value === 'low') return 'low';
  return 'medium';
}

function normalizeKnownOsType(raw: unknown): 'windows' | 'macos' | 'linux' | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'windows' || value === 'macos' || value === 'linux') {
    return value;
  }
  return null;
}

function inferPatchOsType(source: string, deviceOs: unknown): 'windows' | 'macos' | 'linux' | null {
  const normalizedDeviceOs = normalizeKnownOsType(deviceOs);
  if (normalizedDeviceOs) {
    return normalizedDeviceOs;
  }

  switch (source) {
    case 'microsoft':
      return 'windows';
    case 'apple':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return null;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidRegex.test(value);
}

function parseResultJson(stdout: string | undefined): Record<string, unknown> | undefined {
  if (!stdout) return undefined;
  try {
    const parsed = JSON.parse(stdout);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function getSecurityStatusFromResult(resultData: Record<string, unknown> | undefined): SecurityStatusPayload | undefined {
  if (!resultData) return undefined;

  const nested = isObject(resultData.status) ? resultData.status : undefined;
  const candidate = nested ?? resultData;
  const parsed = securityStatusIngestSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  return parsed.data;
}

async function upsertSecurityStatusForDevice(deviceId: string, payload: SecurityStatusPayload): Promise<void> {
  const avProducts = Array.isArray(payload.avProducts) ? payload.avProducts : [];
  const preferredProduct = avProducts.find((p) => p.realTimeProtection) ?? avProducts[0];
  const provider = normalizeProvider(payload.provider ?? preferredProduct?.provider);

  await db
    .insert(securityStatus)
    .values({
      deviceId,
      provider,
      providerVersion: asString(payload.providerVersion) ?? null,
      definitionsVersion: asString(payload.definitionsVersion) ?? null,
      definitionsDate: parseDate(payload.definitionsDate),
      realTimeProtection: payload.realTimeProtection ?? preferredProduct?.realTimeProtection ?? false,
      lastScan: parseDate(payload.lastScan),
      lastScanType: asString(payload.lastScanType) ?? null,
      threatCount: payload.threatCount ?? 0,
      firewallEnabled: payload.firewallEnabled ?? null,
      encryptionStatus: normalizeEncryptionStatus(payload.encryptionStatus),
      gatekeeperEnabled: payload.gatekeeperEnabled ?? payload.guardianEnabled ?? null,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: securityStatus.deviceId,
      set: {
        provider,
        providerVersion: asString(payload.providerVersion) ?? null,
        definitionsVersion: asString(payload.definitionsVersion) ?? null,
        definitionsDate: parseDate(payload.definitionsDate),
        realTimeProtection: payload.realTimeProtection ?? preferredProduct?.realTimeProtection ?? false,
        lastScan: parseDate(payload.lastScan),
        lastScanType: asString(payload.lastScanType) ?? null,
        threatCount: payload.threatCount ?? 0,
        firewallEnabled: payload.firewallEnabled ?? null,
        encryptionStatus: normalizeEncryptionStatus(payload.encryptionStatus),
        gatekeeperEnabled: payload.gatekeeperEnabled ?? payload.guardianEnabled ?? null,
        updatedAt: new Date()
      }
    });
}

async function updateThreatStatusForAction(command: typeof deviceCommands.$inferSelect): Promise<void> {
  const payload = isObject(command.payload) ? command.payload : {};
  const threatId = payload.threatId;
  const threatPath = asString(payload.path);

  let targetId: string | undefined;
  if (isUuid(threatId)) {
    targetId = threatId;
  } else if (threatPath) {
    const [threat] = await db
      .select({ id: securityThreats.id })
      .from(securityThreats)
      .where(and(eq(securityThreats.deviceId, command.deviceId), eq(securityThreats.filePath, threatPath)))
      .orderBy(desc(securityThreats.detectedAt))
      .limit(1);
    targetId = threat?.id;
  }

  if (!targetId) return;

  const now = new Date();
  if (command.type === securityCommandTypes.quarantine) {
    await db
      .update(securityThreats)
      .set({ status: 'quarantined', resolvedAt: null, resolvedBy: null })
      .where(eq(securityThreats.id, targetId));
    return;
  }

  if (command.type === securityCommandTypes.remove) {
    await db
      .update(securityThreats)
      .set({ status: 'removed', resolvedAt: now, resolvedBy: 'agent' })
      .where(eq(securityThreats.id, targetId));
    return;
  }

  if (command.type === securityCommandTypes.restore) {
    await db
      .update(securityThreats)
      .set({ status: 'allowed', resolvedAt: now, resolvedBy: 'agent' })
      .where(eq(securityThreats.id, targetId));
  }
}

async function handleSecurityCommandResult(
  command: typeof deviceCommands.$inferSelect,
  resultData: z.infer<typeof commandResultSchema>
): Promise<void> {
  const resultJson = parseResultJson(resultData.stdout);
  const parsedStatus = getSecurityStatusFromResult(resultJson);
  if (parsedStatus) {
    await upsertSecurityStatusForDevice(command.deviceId, parsedStatus);
  }

  if (command.type === securityCommandTypes.collectStatus) {
    return;
  }

  if (command.type === securityCommandTypes.scan) {
    const payload = isObject(command.payload) ? command.payload : {};
    const scanType = asString(resultJson?.scanType) ?? asString(payload.scanType) ?? 'quick';
    const scanRecordId = asString(resultJson?.scanRecordId) ?? asString(payload.scanRecordId);
    const threatsValue = Array.isArray(resultJson?.threats) ? resultJson.threats : [];
    const threatsFoundRaw = resultJson?.threatsFound;
    const threatsFound = typeof threatsFoundRaw === 'number'
      ? Math.max(0, Math.floor(threatsFoundRaw))
      : threatsValue.length;
    const completedAt = new Date();
    const durationSeconds = Math.max(0, Math.round(resultData.durationMs / 1000));

    let existingScan: { id: string } | undefined;
    if (isUuid(scanRecordId)) {
      [existingScan] = await db
        .select({ id: securityScans.id })
        .from(securityScans)
        .where(and(eq(securityScans.id, scanRecordId), eq(securityScans.deviceId, command.deviceId)))
        .limit(1);
    }

    if (existingScan) {
      await db
        .update(securityScans)
        .set({
          status: resultData.status === 'completed' ? 'completed' : 'failed',
          completedAt,
          duration: durationSeconds,
          threatsFound
        })
        .where(eq(securityScans.id, existingScan.id));
    } else {
      await db.insert(securityScans).values({
        ...(isUuid(scanRecordId) ? { id: scanRecordId } : {}),
        deviceId: command.deviceId,
        scanType,
        status: resultData.status === 'completed' ? 'completed' : 'failed',
        startedAt: command.createdAt ?? new Date(),
        completedAt,
        threatsFound,
        duration: durationSeconds
      });
    }

    if (resultData.status === 'completed' && threatsValue.length > 0) {
      const provider = normalizeProvider(parsedStatus?.provider);
      const inserts: Array<typeof securityThreats.$inferInsert> = [];

      for (const threat of threatsValue) {
        if (!isObject(threat)) continue;
        inserts.push({
          deviceId: command.deviceId,
          provider,
          threatName: asString(threat.name) ?? asString(threat.threatName) ?? 'Unknown Threat',
          threatType: asString(threat.type) ?? asString(threat.threatType) ?? asString(threat.category) ?? null,
          severity: normalizeSeverity(threat.severity),
          status: 'detected',
          filePath: asString(threat.path) ?? asString(threat.filePath) ?? null,
          processName: asString(threat.processName) ?? null,
          detectedAt: completedAt,
          details: threat
        });
      }

      if (inserts.length > 0) {
        await db.insert(securityThreats).values(inserts);
      }
    }

    return;
  }

  if (
    command.type === securityCommandTypes.quarantine ||
    command.type === securityCommandTypes.remove ||
    command.type === securityCommandTypes.restore
  ) {
    if (resultData.status === 'completed') {
      await updateThreatStatusForAction(command);
    }
  }
}

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
  const tokenHash = createHash('sha256').update(apiKey).digest('hex');

  // Validate site exists
  const siteId = key.siteId;
  if (!siteId) {
    return c.json({ error: 'Enrollment key must be associated with a site' }, 400);
  }

  // Check for existing device with same hostname + org + site (re-enrollment)
  const [existingDevice] = await db
    .select({ id: devices.id, status: devices.status })
    .from(devices)
    .where(
      and(
        eq(devices.hostname, data.hostname),
        eq(devices.orgId, key.orgId),
        eq(devices.siteId, siteId)
      )
    )
    .limit(1);

  if (existingDevice && existingDevice.status === 'decommissioned') {
    return c.json({ error: 'Device has been decommissioned. Contact an administrator.' }, 403);
  }

  // Create or re-enroll device in transaction
  const result = await db.transaction(async (tx) => {
    let device;

    if (existingDevice) {
      // Re-enrollment: update existing device with new credentials
      [device] = await tx
        .update(devices)
        .set({
          agentId: agentId,
          agentTokenHash: tokenHash,
          osType: data.osType,
          osVersion: data.osVersion,
          architecture: data.architecture,
          agentVersion: data.agentVersion,
          status: 'online',
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(devices.id, existingDevice.id))
        .returning();
    } else {
      // New enrollment: create device record
      [device] = await tx
        .insert(devices)
        .values({
          orgId: key.orgId,
          siteId: siteId,
          agentId: agentId,
          agentTokenHash: tokenHash,
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
    }

    if (!device) {
      throw new Error('Failed to create device');
    }

    // Upsert hardware info if provided
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
          gpuModel: data.hardwareInfo.gpuModel,
          serialNumber: data.hardwareInfo.serialNumber,
          manufacturer: data.hardwareInfo.manufacturer,
          model: data.hardwareInfo.model,
          biosVersion: data.hardwareInfo.biosVersion
        })
        .onConflictDoUpdate({
          target: deviceHardware.deviceId,
          set: {
            cpuModel: data.hardwareInfo.cpuModel,
            cpuCores: data.hardwareInfo.cpuCores,
            cpuThreads: data.hardwareInfo.cpuThreads,
            ramTotalMb: data.hardwareInfo.ramTotalMb,
            diskTotalGb: data.hardwareInfo.diskTotalGb,
            gpuModel: data.hardwareInfo.gpuModel,
            serialNumber: data.hardwareInfo.serialNumber,
            manufacturer: data.hardwareInfo.manufacturer,
            model: data.hardwareInfo.model,
            biosVersion: data.hardwareInfo.biosVersion,
            updatedAt: new Date()
          }
        });
    }

    // Replace network interfaces if provided
    if (data.networkInfo && data.networkInfo.length > 0) {
      await tx.delete(deviceNetwork).where(eq(deviceNetwork.deviceId, device.id));
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
  writeAuditEvent(c, {
    orgId: key.orgId,
    actorType: 'agent',
    actorId: agentId,
    action: 'agent.enroll',
    resourceType: 'device',
    resourceId: result.id,
    resourceName: data.hostname,
    details: {
      siteId: key.siteId,
      reenrollment: Boolean(existingDevice),
    },
  });

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

// Submit device security status
agentRoutes.put('/:id/security/status', zValidator('json', securityStatusIngestSchema), async (c) => {
  const agentId = c.req.param('id');
  const payload = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await upsertSecurityStatusForDevice(device.id, payload);
  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.security_status.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      provider: payload.provider ?? null,
      threatCount: payload.threatCount ?? null,
    },
  });
  return c.json({ success: true });
});

// Submit command result
agentRoutes.post(
  '/:id/commands/:commandId/result',
  zValidator('json', commandResultSchema),
  async (c) => {
    const commandId = c.req.param('commandId');
    const data = c.req.valid('json');
    const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;
    const agentId = c.req.param('id');

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

    if (
      command.type === securityCommandTypes.collectStatus ||
      command.type === securityCommandTypes.scan ||
      command.type === securityCommandTypes.quarantine ||
      command.type === securityCommandTypes.remove ||
      command.type === securityCommandTypes.restore
    ) {
      try {
        await handleSecurityCommandResult(command, data);
      } catch (err) {
        console.error(`[agents] security command post-processing failed for ${commandId}:`, err);
      }
    }

    writeAuditEvent(c, {
      orgId: agent?.orgId,
      actorType: 'agent',
      actorId: agent?.agentId ?? agentId,
      action: 'agent.command.result.submit',
      resourceType: 'device_command',
      resourceId: commandId,
      details: {
        commandType: command.type,
        status: data.status,
        exitCode: data.exitCode ?? null,
      },
      result: data.status === 'completed' ? 'success' : 'failure',
    });

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

agentRoutes.put('/:id/software', zValidator('json', updateSoftwareSchema), async (c) => {
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

  // Use a transaction to replace all software entries atomically
  await db.transaction(async (tx) => {
    // Delete existing software entries for this device
    await tx
      .delete(softwareInventory)
      .where(eq(softwareInventory.deviceId, device.id));

    // Insert new software entries
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

agentRoutes.put('/:id/disks', zValidator('json', updateDisksSchema), async (c) => {
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

  // Use a transaction to replace all disk entries atomically
  await db.transaction(async (tx) => {
    // Delete existing disk entries for this device
    await tx
      .delete(deviceDisks)
      .where(eq(deviceDisks.deviceId, device.id));

    // Insert new disk entries
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

agentRoutes.put('/:id/network', zValidator('json', updateNetworkSchema), async (c) => {
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

  // Use a transaction to replace all network entries atomically
  await db.transaction(async (tx) => {
    // Delete existing network entries for this device
    await tx
      .delete(deviceNetwork)
      .where(eq(deviceNetwork.deviceId, device.id));

    // Insert new network entries
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

// Submit available and installed patches
const submitPatchesSchema = z.object({
  patches: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    currentVersion: z.string().optional(),
    kbNumber: z.string().optional(),
    category: z.string().optional(),
    severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
    size: z.number().int().optional(),
    requiresRestart: z.boolean().optional(),
    releaseDate: z.string().optional(),
    description: z.string().optional(),
    source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).default('custom')
  })),
  installed: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    category: z.string().optional(),
    source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).default('custom'),
    installedAt: z.string()
  })).optional()
});

agentRoutes.put('/:id/patches', zValidator('json', submitPatchesSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;
  const installedCount = data.installed?.length || 0;
  console.log(`[PATCHES] Agent ${agentId} submitting ${data.patches.length} pending, ${installedCount} installed`);

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await db.transaction(async (tx) => {
    // First, mark all existing patches for this device as "missing" (will update found ones)
    await tx
      .update(devicePatches)
      .set({ status: 'missing', lastCheckedAt: new Date() })
      .where(eq(devicePatches.deviceId, device.id));

    // Process pending patches
    for (const patchData of data.patches) {
      // Generate an external ID based on source + name + version
      const externalId = patchData.kbNumber ||
        `${patchData.source}:${patchData.name}:${patchData.version || 'latest'}`;
      const inferredOsType = inferPatchOsType(patchData.source, device.osType);

      // Upsert the patch record
      const [patch] = await tx
        .insert(patches)
        .values({
          source: patchData.source,
          externalId: externalId,
          title: patchData.name,
          description: patchData.description || null,
          severity: patchData.severity || 'unknown',
          category: patchData.category || null,
          releaseDate: patchData.releaseDate || null,
          requiresReboot: patchData.requiresRestart || false,
          downloadSizeMb: patchData.size ? Math.ceil(patchData.size / (1024 * 1024)) : null,
          ...(inferredOsType ? { osTypes: [inferredOsType] } : {})
        })
        .onConflictDoUpdate({
          target: [patches.source, patches.externalId],
          set: {
            title: patchData.name,
            description: patchData.description || null,
            severity: patchData.severity || 'unknown',
            category: patchData.category || null,
            requiresReboot: patchData.requiresRestart || false,
            ...(inferredOsType
              ? {
                  osTypes: sql`CASE
                    WHEN ${inferredOsType} = ANY(COALESCE(${patches.osTypes}, ARRAY[]::text[]))
                    THEN COALESCE(${patches.osTypes}, ARRAY[]::text[])
                    ELSE COALESCE(${patches.osTypes}, ARRAY[]::text[]) || ARRAY[${inferredOsType}]::text[]
                  END`
                }
              : {}),
            updatedAt: new Date()
          }
        })
        .returning();

      if (patch) {
        // Upsert the device-patch relationship as "pending" (available but not installed)
        await tx
          .insert(devicePatches)
          .values({
            deviceId: device.id,
            patchId: patch.id,
            status: 'pending',
            lastCheckedAt: new Date()
          })
          .onConflictDoUpdate({
            target: [devicePatches.deviceId, devicePatches.patchId],
            set: {
              status: 'pending',
              lastCheckedAt: new Date(),
              updatedAt: new Date()
            }
          });
      }
    }

    // Process installed patches
    if (data.installed && data.installed.length > 0) {
      for (const patchData of data.installed) {
        const externalId = `${patchData.source}:${patchData.name}:${patchData.version || 'installed'}`;
        const inferredOsType = inferPatchOsType(patchData.source, device.osType);

        // Upsert the patch record
        const [patch] = await tx
          .insert(patches)
          .values({
            source: patchData.source,
            externalId: externalId,
            title: patchData.name,
            severity: 'unknown',
            category: patchData.category || null,
            ...(inferredOsType ? { osTypes: [inferredOsType] } : {})
          })
          .onConflictDoUpdate({
            target: [patches.source, patches.externalId],
            set: {
              title: patchData.name,
              category: patchData.category || null,
              ...(inferredOsType
                ? {
                    osTypes: sql`CASE
                      WHEN ${inferredOsType} = ANY(COALESCE(${patches.osTypes}, ARRAY[]::text[]))
                      THEN COALESCE(${patches.osTypes}, ARRAY[]::text[])
                      ELSE COALESCE(${patches.osTypes}, ARRAY[]::text[]) || ARRAY[${inferredOsType}]::text[]
                    END`
                  }
                : {}),
              updatedAt: new Date()
            }
          })
          .returning();

        if (patch) {
          // Upsert the device-patch relationship as "installed"
          const installedAt = patchData.installedAt ? new Date(patchData.installedAt) : new Date();
          await tx
            .insert(devicePatches)
            .values({
              deviceId: device.id,
              patchId: patch.id,
              status: 'installed',
              installedAt: installedAt,
              installedVersion: patchData.version || null,
              lastCheckedAt: new Date()
            })
            .onConflictDoUpdate({
              target: [devicePatches.deviceId, devicePatches.patchId],
              set: {
                status: 'installed',
                installedAt: installedAt,
                installedVersion: patchData.version || null,
                lastCheckedAt: new Date(),
                updatedAt: new Date()
              }
            });
        }
      }
    }
  });

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.patches.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      pendingCount: data.patches.length,
      installedCount,
    },
  });

  return c.json({ success: true, pending: data.patches.length, installed: installedCount });
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

agentRoutes.put('/:id/connections', zValidator('json', submitConnectionsSchema), async (c) => {
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

  // Use a transaction to replace all connection entries atomically
  await db.transaction(async (tx) => {
    // Delete existing connection entries for this device
    await tx
      .delete(deviceConnections)
      .where(eq(deviceConnections.deviceId, device.id));

    // Insert new connection entries
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

// Submit event logs
const submitEventLogsSchema = z.object({
  events: z.array(z.object({
    timestamp: z.string().min(1),
    level: z.enum(['info', 'warning', 'error', 'critical']),
    category: z.enum(['security', 'hardware', 'application', 'system']),
    source: z.string().min(1),
    eventId: z.string().optional(),
    message: z.string().min(1),
    details: z.record(z.any()).optional()
  }))
});

agentRoutes.put('/:id/eventlogs', zValidator('json', submitEventLogsSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (data.events.length === 0) {
    return c.json({ success: true, count: 0 });
  }

  // Batch insert event logs with ON CONFLICT dedup
  const rows = data.events.map((event: any) => ({
    deviceId: device.id,
    orgId: device.orgId,
    timestamp: new Date(event.timestamp),
    level: event.level,
    category: event.category,
    source: event.source,
    eventId: event.eventId || null,
    message: event.message,
    details: event.details || null
  }));

  let inserted = 0;
  try {
    // Insert in batches of 100 to avoid oversized queries
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      await db.insert(deviceEventLogs).values(batch).onConflictDoNothing();
      inserted += batch.length;
    }
  } catch (err) {
    console.error(`[EventLogs] Error batch inserting events for device ${device.id}:`, err);
  }

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.eventlogs.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      submittedCount: data.events.length,
      insertedCount: inserted,
    },
  });

  return c.json({ success: true, count: inserted });
});
