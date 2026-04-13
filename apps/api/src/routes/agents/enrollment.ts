import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { and, eq, ne, sql } from 'drizzle-orm';
import { createHash, timingSafeEqual } from 'crypto';
import { db, withSystemDbAccessContext } from '../../db';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  enrollmentKeys,
  organizations,
  partners,
} from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { getTrustedClientIp } from '../../services/clientIp';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { enrollSchema } from './schemas';
import { generateAgentId, generateApiKey, issueMtlsCertForDevice } from './helpers';
import { queueWarrantySyncForDevice } from '../../services/warrantyWorker';
import { dispatchHook } from '../../services/partnerHooks';

export const enrollmentRoutes = new Hono();
const ENROLLMENT_RATE_LIMIT = 10;
const ENROLLMENT_RATE_WINDOW_SECONDS = 60;

function getProvidedEnrollmentSecret(c: any, data: { enrollmentSecret?: string }): string {
  return (data.enrollmentSecret ?? c.req.header('x-agent-enrollment-secret') ?? '').trim();
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  return leftBuf.length === rightBuf.length && timingSafeEqual(leftBuf, rightBuf);
}

function hashEnrollmentSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function getGlobalEnrollmentSecret(): string | null {
  const configuredSecret = process.env.AGENT_ENROLLMENT_SECRET?.trim() ?? '';
  return configuredSecret.length > 0 ? configuredSecret : null;
}

enrollmentRoutes.post('/enroll', zValidator('json', enrollSchema), async (c) => {
  const data = c.req.valid('json');
  const clientIp = getTrustedClientIp(c, 'unknown');
  const rateCheck = await rateLimiter(
    getRedis(),
    `agent-enroll:${clientIp}`,
    ENROLLMENT_RATE_LIMIT,
    ENROLLMENT_RATE_WINDOW_SECONDS
  );
  if (!rateCheck.allowed) {
    c.header('Retry-After', String(Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)));
    writeAuditEvent(c, {
      orgId: null,
      actorType: 'system',
      action: 'agent.enroll',
      resourceType: 'device',
      resourceName: data.hostname,
      details: { reason: 'rate_limit' },
      result: 'denied',
      errorMessage: 'Agent enrollment rate limit exceeded',
    });
    return c.json({ error: 'Enrollment rate limit exceeded' }, 429);
  }

  const hashedEnrollmentKey = hashEnrollmentKey(data.enrollmentKey);

  return withSystemDbAccessContext(async () => {
    // Re-validated in the UPDATE WHERE below to close the TOCTOU window between
    // this initial lookup and the usage_count bump.
    const validEnrollmentKeyConditions = [
      eq(enrollmentKeys.key, hashedEnrollmentKey),
      sql`(${enrollmentKeys.expiresAt} IS NULL OR ${enrollmentKeys.expiresAt} > NOW())`,
      sql`(${enrollmentKeys.maxUsage} IS NULL OR ${enrollmentKeys.usageCount} < ${enrollmentKeys.maxUsage})`,
    ] as const;

    // Step 1: look up by hash ONLY, so we can tell the admin *why* the key
    // was rejected instead of conflating three distinct failure modes into
    // one opaque "Invalid or expired enrollment key" string.
    const [matchingKey] = await db
      .select({
        id: enrollmentKeys.id,
        orgId: enrollmentKeys.orgId,
        siteId: enrollmentKeys.siteId,
        keySecretHash: enrollmentKeys.keySecretHash,
        expiresAt: enrollmentKeys.expiresAt,
        maxUsage: enrollmentKeys.maxUsage,
        usageCount: enrollmentKeys.usageCount,
      })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.key, hashedEnrollmentKey))
      .limit(1);

    if (!matchingKey) {
      writeAuditEvent(c, {
        orgId: null,
        actorType: 'system',
        action: 'agent.enroll',
        resourceType: 'device',
        resourceName: data.hostname,
        details: { reason: 'enrollment_key_not_found' },
        result: 'denied',
        errorMessage: 'Enrollment key not recognized',
      });
      return c.json({
        error: 'Enrollment key not recognized',
        reason: 'enrollment_key_not_found',
      }, 401);
    }

    // Step 2: the row exists — now tell the admin precisely which invariant
    // it's violating. Both branches stay on 401 for backwards compatibility
    // with older agents that don't parse `reason`.
    if (matchingKey.expiresAt && new Date(matchingKey.expiresAt) <= new Date()) {
      writeAuditEvent(c, {
        orgId: matchingKey.orgId,
        actorType: 'system',
        action: 'agent.enroll',
        resourceType: 'device',
        resourceName: data.hostname,
        details: { reason: 'enrollment_key_expired', keyId: matchingKey.id },
        result: 'denied',
        errorMessage: 'Enrollment key has expired',
      });
      return c.json({
        error: 'Enrollment key has expired — regenerate the key or installer link and retry',
        reason: 'enrollment_key_expired',
      }, 401);
    }

    if (matchingKey.maxUsage !== null && matchingKey.usageCount >= matchingKey.maxUsage) {
      writeAuditEvent(c, {
        orgId: matchingKey.orgId,
        actorType: 'system',
        action: 'agent.enroll',
        resourceType: 'device',
        resourceName: data.hostname,
        details: { reason: 'enrollment_key_exhausted', keyId: matchingKey.id },
        result: 'denied',
        errorMessage: 'Enrollment key usage exhausted',
      });
      return c.json({
        error: 'Enrollment key has reached its maximum usage count — regenerate a fresh key or installer link',
        reason: 'enrollment_key_exhausted',
      }, 401);
    }

    const providedSecret = getProvidedEnrollmentSecret(c, data);
    const configuredSecret = getGlobalEnrollmentSecret();

    if (matchingKey.keySecretHash) {
      if (!providedSecret) {
        writeAuditEvent(c, {
          orgId: null,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceName: data.hostname,
          details: { reason: 'missing_enrollment_secret' },
          result: 'denied',
          errorMessage: 'Enrollment secret required',
        });
        return c.json({ error: 'Enrollment secret required' }, 403);
      }

      const providedSecretHash = hashEnrollmentSecret(providedSecret);
      if (!timingSafeStringEqual(providedSecretHash, matchingKey.keySecretHash)) {
        writeAuditEvent(c, {
          orgId: null,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceName: data.hostname,
          details: { reason: 'invalid_enrollment_secret' },
          result: 'denied',
          errorMessage: 'Invalid enrollment secret',
        });
        return c.json({ error: 'Invalid enrollment secret' }, 403);
      }
    } else if (configuredSecret) {
      if (!providedSecret) {
        writeAuditEvent(c, {
          orgId: null,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceName: data.hostname,
          details: { reason: 'missing_enrollment_secret' },
          result: 'denied',
          errorMessage: 'Enrollment secret required',
        });
        return c.json({ error: 'Enrollment secret required' }, 403);
      }

      if (!timingSafeStringEqual(hashEnrollmentSecret(providedSecret), hashEnrollmentSecret(configuredSecret))) {
        writeAuditEvent(c, {
          orgId: null,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceName: data.hostname,
          details: { reason: 'invalid_enrollment_secret' },
          result: 'denied',
          errorMessage: 'Invalid enrollment secret',
        });
        return c.json({ error: 'Invalid enrollment secret' }, 403);
      }
    } else if (process.env.NODE_ENV === 'production') {
      // In production, require at least one form of enrollment secret (global
      // or per-key) to prevent open enrollment if AGENT_ENROLLMENT_SECRET is
      // accidentally omitted from the deployment.
      console.error(
        '[enrollment] Production enrollment blocked: neither AGENT_ENROLLMENT_SECRET nor per-key secret is configured'
      );
      writeAuditEvent(c, {
        orgId: null,
        actorType: 'system',
        action: 'agent.enroll',
        resourceType: 'device',
        resourceName: data.hostname,
        details: { reason: 'no_enrollment_secret_configured' },
        result: 'denied',
        errorMessage: 'Enrollment secret required in production',
      });
      return c.json({ error: 'Enrollment secret required' }, 403);
    }

    if (!matchingKey.siteId) {
      throw new HTTPException(400, { message: 'Enrollment key must be associated with a site' });
    }

    const [key] = await db
      .update(enrollmentKeys)
      .set({ usageCount: sql`${enrollmentKeys.usageCount} + 1` })
      .where(
        and(
          eq(enrollmentKeys.id, matchingKey.id),
          ...validEnrollmentKeyConditions
        )
      )
      .returning();

    if (!key) {
      // The row existed at step 1 but the re-validated UPDATE affected 0
      // rows — the key expired or was exhausted between the initial lookup
      // and the claim. Distinct reason so this specific race is visible in
      // the audit log and the client can retry with a fresh installer.
      writeAuditEvent(c, {
        orgId: matchingKey.orgId,
        actorType: 'system',
        action: 'agent.enroll',
        resourceType: 'device',
        resourceName: data.hostname,
        details: { reason: 'enrollment_key_race_lost', keyId: matchingKey.id },
        result: 'denied',
        errorMessage: 'Enrollment key was claimed by another enrollment in the same moment',
      });
      return c.json({
        error: 'Enrollment key was just exhausted or expired — regenerate a fresh key or installer link',
        reason: 'enrollment_key_race_lost',
      }, 401);
    }

    const siteId = key.siteId!; // non-null asserted: matchingKey.siteId guard at line 180

    // Fetch partner device limit (used inside transaction below)
    let deviceLimitPartnerId: string | null = null;
    let maxDevices: number | null = null;
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, key.orgId))
      .limit(1);

    if (org) {
      const [partner] = await db
        .select({ maxDevices: partners.maxDevices })
        .from(partners)
        .where(eq(partners.id, org.partnerId))
        .limit(1);

      if (partner?.maxDevices != null) {
deviceLimitPartnerId = org.partnerId;
        maxDevices = partner.maxDevices;
      }
    }

    const agentId = generateAgentId();
    const apiKey = generateApiKey();
    const tokenIssuedAt = new Date();
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

    // Auto-restore decommissioned devices on re-enrollment
    if (existingDevice && existingDevice.status === 'decommissioned') {
      await db.update(devices)
        .set({ status: 'offline', updatedAt: new Date() })
        .where(eq(devices.id, existingDevice.id));
    }

    const device = await db.transaction(async (tx) => {
      // Device limit check inside transaction to prevent TOCTOU race
      if (maxDevices != null && deviceLimitPartnerId && !existingDevice) {
        const partnerOrgIds = tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, deviceLimitPartnerId));

        const [countResult] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(devices)
          .where(
            and(
              sql`${devices.orgId} IN (${partnerOrgIds})`,
              ne(devices.status, 'decommissioned')
            )
          );

        const activeCount = Number(countResult?.count ?? 0);
        if (activeCount >= maxDevices) {
          // Fire-and-forget hook outside transaction (non-blocking)
          dispatchHook('device-limit', deviceLimitPartnerId, {
            currentDevices: activeCount,
            maxDevices,
          }).catch((err) => {
            console.error('[Enrollment] Failed to dispatch device-limit hook:', err instanceof Error ? err.message : err);
          });
          throw new HTTPException(403, {
            message: JSON.stringify({
              error: 'Device limit reached',
              code: 'DEVICE_LIMIT_REACHED',
              currentDevices: activeCount,
              maxDevices,
            }),
          });
        }
      }

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
            tokenIssuedAt,
            previousTokenHash: null,
            previousTokenExpiresAt: null,
            deviceRole: data.deviceRole || 'unknown',
            deviceRoleSource: 'auto',
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
            tokenIssuedAt,
            deviceRole: data.deviceRole || 'unknown',
            deviceRoleSource: 'auto',
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
            orgId: dev.orgId,
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
              orgId: dev.orgId,
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

    // Queue warranty lookup for the newly enrolled device (fire-and-forget)
    queueWarrantySyncForDevice(device.id).catch((err) => {
      console.error('[Enrollment] Failed to queue warranty sync:', err instanceof Error ? err.message : err);
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
