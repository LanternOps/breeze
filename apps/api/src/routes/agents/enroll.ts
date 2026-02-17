import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  enrollmentKeys
} from '../../db/schema';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { writeAuditEvent } from '../../services/auditEvents';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { issueMtlsCertForDevice } from './helpers';

export const enrollRoutes = new Hono();

const enrollSchema = z.object({
  enrollmentKey: z.string().min(1),
  enrollmentSecret: z.string().min(1).optional(),
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

function generateAgentId(): string {
  return randomBytes(32).toString('hex');
}

function generateApiKey(): string {
  return `brz_${randomBytes(32).toString('hex')}`;
}

enrollRoutes.post('/enroll', zValidator('json', enrollSchema), async (c) => {
  const data = c.req.valid('json');
  const configuredSecret = process.env.AGENT_ENROLLMENT_SECRET;
  const requireSecret = (process.env.NODE_ENV ?? 'development') === 'production'
    && typeof configuredSecret === 'string'
    && configuredSecret.length > 0;

  if (requireSecret) {
    const provided = (data.enrollmentSecret ?? c.req.header('x-agent-enrollment-secret') ?? '').trim();
    if (!provided) {
      return c.json({ error: 'Enrollment secret required' }, 403);
    }

    const providedBuf = Buffer.from(provided);
    const configuredBuf = Buffer.from(configuredSecret);
    if (providedBuf.length !== configuredBuf.length || !timingSafeEqual(providedBuf, configuredBuf)) {
      return c.json({ error: 'Invalid enrollment secret' }, 403);
    }
  }

  const hashedEnrollmentKey = hashEnrollmentKey(data.enrollmentKey);

  return withSystemDbAccessContext(async () => {
    const [key] = await db
      .update(enrollmentKeys)
      .set({ usageCount: sql`${enrollmentKeys.usageCount} + 1` })
      .where(
        and(
          eq(enrollmentKeys.key, hashedEnrollmentKey),
          sql`(${enrollmentKeys.expiresAt} IS NULL OR ${enrollmentKeys.expiresAt} > NOW())`,
          sql`(${enrollmentKeys.maxUsage} IS NULL OR ${enrollmentKeys.usageCount} < ${enrollmentKeys.maxUsage})`
        )
      )
      .returning();

    if (!key) {
      return c.json({ error: 'Invalid or expired enrollment key' }, 401);
    }

    const siteId = key.siteId;
    if (!siteId) {
      await db.update(enrollmentKeys).set({ usageCount: sql`${enrollmentKeys.usageCount} - 1` }).where(eq(enrollmentKeys.id, key.id));
      throw new HTTPException(400, { message: 'Enrollment key must be associated with a site' });
    }

    const agentId = generateAgentId();
    const apiKey = generateApiKey();
    // Agent bearer tokens are high-entropy random values; we store only a SHA-256 hash and never persist
    // the plaintext token.
    // lgtm[js/insufficient-password-hash]
    const tokenHash = createHash('sha256').update(apiKey).digest('hex');

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
      await db.update(enrollmentKeys).set({ usageCount: sql`${enrollmentKeys.usageCount} - 1` }).where(eq(enrollmentKeys.id, key.id));
      throw new HTTPException(403, { message: 'Device has been decommissioned. Contact an administrator.' });
    }

    const device = await db.transaction(async (tx) => {
      let dev;
      if (existingDevice) {
        [dev] = await tx
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
        [dev] = await tx
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

      if (!dev) {
        throw new Error('Failed to create device');
      }

      if (data.hardwareInfo) {
        await tx
          .insert(deviceHardware)
          .values({
            deviceId: dev.id,
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

      if (data.networkInfo && data.networkInfo.length > 0) {
        await tx.delete(deviceNetwork).where(eq(deviceNetwork.deviceId, dev.id));
        for (const nic of data.networkInfo) {
          await tx
            .insert(deviceNetwork)
            .values({
              deviceId: dev.id,
              interfaceName: nic.name,
              macAddress: nic.mac,
              ipAddress: nic.ip,
              ipType: nic.ip?.includes(':') ? 'ipv6' : 'ipv4',
              isPrimary: nic.isPrimary ?? false
            });
        }
      }

      return dev;
    });

    const mtlsCert = await issueMtlsCertForDevice(device.id, key.orgId);

    writeAuditEvent(c, {
      orgId: key.orgId,
      actorType: 'agent',
      actorId: agentId,
      action: 'agent.enroll',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: data.hostname,
      details: {
        siteId: key.siteId,
        reenrollment: Boolean(existingDevice),
        mtlsCertIssued: mtlsCert !== null,
      },
    });

    return c.json({
      agentId: agentId,
      deviceId: device.id,
      authToken: apiKey,
      orgId: key.orgId,
      siteId: key.siteId,
      config: {
        heartbeatIntervalSeconds: 60,
        metricsCollectionIntervalSeconds: 30
      },
      mtls: mtlsCert
    }, 201);
  });
});
