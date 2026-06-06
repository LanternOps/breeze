import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
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
import { getActiveOrgTenant } from '../../services/tenantStatus';
import { writeAuditEvent } from '../../services/auditEvents';
import { hashEnrollmentKeyCandidates } from '../../services/enrollmentKeySecurity';
import { getTrustedClientIp } from '../../services/clientIp';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { enrollSchema } from './schemas';
import { generateAgentId, generateApiKey, issueMtlsCertForDevice } from './helpers';
import { recordAgentEnrollment } from '../../services/anomalyMetrics';
import { queueWarrantySyncForDevice } from '../../services/warrantyWorker';
import { dispatchHook } from '../../services/partnerHooks';
import { matchDeploymentInviteOnEnrollment } from '../../modules/mcpInvites/matchInviteOnEnrollment';
import { getActiveTrustKeyset, type ManifestTrustKey } from '../../services/manifestSigning';
import { captureException } from '../../services/sentry';

export const enrollmentRoutes = new Hono();
const ENROLLMENT_RATE_LIMIT = 10;
const ENROLLMENT_RATE_WINDOW_SECONDS = 60;

function getProvidedEnrollmentSecret(c: any, data: { enrollmentSecret?: string }): string {
  return (data.enrollmentSecret ?? c.req.header('x-agent-enrollment-secret') ?? '').trim();
}

function getProvidedExistingDeviceToken(c: any): string {
  const explicit = c.req.header('x-agent-reenrollment-token')?.trim();
  if (explicit) {
    return explicit;
  }

  const authorization = c.req.header('authorization')?.trim() ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
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

function tokenHashMatches(storedHash: string | null | undefined, presentedToken: string, now: Date, expiresAt?: Date | null): boolean {
  if (!storedHash || !presentedToken) {
    return false;
  }
  if (expiresAt && expiresAt <= now) {
    return false;
  }
  const presentedHash = createHash('sha256').update(presentedToken).digest('hex');
  return timingSafeStringEqual(storedHash, presentedHash);
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
    recordAgentEnrollment('denied');
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

  // Try the primary pepper first, then any legacy fallback peppers (APP_ENCRYPTION_KEY,
  // JWT_SECRET, etc.) so keys hashed before ENROLLMENT_KEY_PEPPER was mandatory still match.
  const enrollmentKeyCandidates = hashEnrollmentKeyCandidates(data.enrollmentKey);

  return withSystemDbAccessContext(async () => {
    // Re-validated in the UPDATE WHERE below to close the TOCTOU window between
    // this initial lookup and the usage_count bump.
    const validEnrollmentKeyConditions = [
      inArray(enrollmentKeys.key, enrollmentKeyCandidates),
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
      .where(inArray(enrollmentKeys.key, enrollmentKeyCandidates))
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
        recordAgentEnrollment('error');
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
        recordAgentEnrollment('error');
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
        recordAgentEnrollment('error');
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
        recordAgentEnrollment('error');
        return c.json({ error: 'Invalid enrollment secret' }, 403);
      }
    } else if (process.env.NODE_ENV === 'production') {
      // In production, require at least one form of enrollment secret (global
      // or per-key) to prevent open enrollment if AGENT_ENROLLMENT_SECRET is
      // accidentally omitted from the deployment.
      //
      // ENROLLMENT_SECRET_ENFORCEMENT_MODE controls behavior when no secret is
      // configured: 'enforce' (default) blocks the request; 'warn' lets it
      // through but emits a loud warning. The 'warn' mode exists for the first
      // release after this gate was introduced — operators who upgraded without
      // setting AGENT_ENROLLMENT_SECRET would otherwise be unable to enroll any
      // new devices until they redeploy with the env var set.
      const mode = (process.env.ENROLLMENT_SECRET_ENFORCEMENT_MODE ?? 'enforce').trim().toLowerCase();
      if (mode === 'warn') {
        console.error(
          '[enrollment] WARNING: Production enrollment proceeding WITHOUT enrollment secret. ' +
          'Set AGENT_ENROLLMENT_SECRET (or per-key secrets) and remove ENROLLMENT_SECRET_ENFORCEMENT_MODE=warn.'
        );
        writeAuditEvent(c, {
          orgId: null,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceName: data.hostname,
          details: { reason: 'no_enrollment_secret_configured', enforcementMode: 'warn' },
          result: 'success',
        });
      } else {
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
        recordAgentEnrollment('error');
        return c.json({ error: 'Enrollment secret required' }, 403);
      }
    }

    if (!matchingKey.siteId) {
      throw new HTTPException(400, { message: 'Enrollment key must be associated with a site' });
    }

    // The enrollment key is NOT consumed here — only validated. The actual
    // usage_count bump happens inside the transaction below, *after* the
    // device INSERT/UPDATE succeeds. Issue #946: previously, the increment
    // ran before the device write, so any post-validation failure
    // (hostname collision, device limit, etc.) silently burned a single-
    // use key without ever creating a device.
    const key = {
      id: matchingKey.id,
      orgId: matchingKey.orgId,
      siteId: matchingKey.siteId,
    };

    const siteId = key.siteId!; // non-null asserted: matchingKey.siteId guard above

    // Tenant-status gate (finding: enrollment ignored tenant lifecycle). A
    // still-valid enrollment key for a suspended/churned/soft-deleted org or
    // partner must NOT mint fresh full-capability agent tokens — that path let
    // a suspended-for-abuse tenant re-establish a fleet the uninstall sweep
    // tore down. getActiveOrgTenant cascades org -> partner status. We call it
    // directly (uncached) rather than isAgentTenantActive: enrollment is rare,
    // so the authoritative check is worth it and avoids any stale-positive
    // window from the agent hot-path cache.
    if (!(await getActiveOrgTenant(key.orgId))) {
      writeAuditEvent(c, {
        orgId: key.orgId,
        actorType: 'system',
        action: 'agent.enroll',
        resourceType: 'device',
        resourceName: data.hostname,
        details: { reason: 'tenant_inactive', enrollmentKeyId: key.id },
        result: 'denied',
        errorMessage: 'Enrollment tenant is not active',
      });
      return c.json({ error: 'Enrollment tenant is not active', reason: 'tenant_inactive' }, 403);
    }

    // Fetch partner device limit (used inside transaction below)
    let deviceLimitPartnerId: string | null = null;
    let maxDevices: number | null = null;
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, key.orgId))
      .limit(1);

    // Captured for the success-path anomaly counter (enrollment rate by partner).
    const enrollmentPartnerId = org?.partnerId ?? null;

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
    const watchdogApiKey = generateApiKey();
    const helperApiKey = generateApiKey();
    const tokenIssuedAt = new Date();
    // Agent bearer tokens are high-entropy random values; we store only a SHA-256 hash and never persist
    // the plaintext token.
    // lgtm[js/insufficient-password-hash]
    const tokenHash = createHash('sha256').update(apiKey).digest('hex');
    // lgtm[js/insufficient-password-hash]
    const watchdogTokenHash = createHash('sha256').update(watchdogApiKey).digest('hex');
    // lgtm[js/insufficient-password-hash]
    const helperTokenHash = createHash('sha256').update(helperApiKey).digest('hex');

    const [existingDevice] = await db
      .select({
        id: devices.id,
        status: devices.status,
        agentTokenHash: devices.agentTokenHash,
        previousTokenHash: devices.previousTokenHash,
        previousTokenExpiresAt: devices.previousTokenExpiresAt,
        agentTokenSuspendedAt: devices.agentTokenSuspendedAt,
      })
      .from(devices)
      .where(
        and(
          eq(devices.hostname, data.hostname),
          eq(devices.orgId, key.orgId),
          eq(devices.siteId, siteId)
        )
      )
      .limit(1);

    let existingDeviceAuthenticated = false;
    // Set true on the decom-bypass path so the transaction below renames
    // the old row's hostname (freeing the slot) and INSERTs a fresh device
    // row with a new id, instead of UPDATE-in-place on the prior id. See
    // issue #914 — without a fresh id, any holder of the org enrollment
    // key + secret + a known-decommissioned hostname could silently adopt
    // the prior device's audit history (agent_logs, alerts, etc.).
    let decomBypassFreshRow = false;
    if (existingDevice) {
      // Containment guard: a quarantined device must NOT be able to clear its
      // own containment by re-enrolling. Even with a valid existing-device
      // token, re-enrollment must be refused — only the admin /approve endpoint
      // (mtls.ts POST /:id/approve) may clear quarantinedAt/quarantinedReason
      // and return the device to 'online'. Without this gate, the quarantined
      // row (or anyone holding its brz_ token — exactly what quarantine is
      // meant to contain) re-POSTs /enroll and the in-place UPDATE below flips
      // status back to 'online', resuming heartbeat/commands/remote-desktop
      // with no operator approval and leaving stale quarantinedAt/Reason
      // columns that mask the bypass in the UI.
      if (existingDevice.status === 'quarantined') {
        writeAuditEvent(c, {
          orgId: key.orgId,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceId: existingDevice.id,
          resourceName: data.hostname,
          details: {
            reason: 'quarantined_device_reenroll_refused',
            siteId,
          },
          result: 'denied',
          errorMessage:
            'Re-enrollment refused: device is quarantined and awaiting administrator approval',
        });
        return c.json(
          {
            error:
              'Device is quarantined and awaiting administrator approval. Re-enrollment cannot clear quarantine; an administrator must approve the device.',
            reason: 'device_quarantined',
          },
          403,
        );
      }

      const tokenSuspended = !!existingDevice.agentTokenSuspendedAt;

      if (tokenSuspended) {
        // Suspension trumps decommission. Task 18 added a suspend-on-probe
        // mechanism; the maintainer's explicit intent (commit 2669ea43) is
        // that unsuspending is manual — "the reconnect-loop on a single
        // device is the desired ops alarm signal." An admin DELETE of a
        // probe-suspended device must NOT silently auto-restore the slot:
        // the operator has to clear `agent_token_suspended_at` deliberately
        // (SQL or future admin endpoint), which leaves an audit trail of
        // the "yes, I cleared a security suspension" decision. Without
        // this, the decom-bypass below would let the same hostname re-
        // enroll with fresh tokens after the suspend alarm fired.
        existingDeviceAuthenticated = false;
      } else if (existingDevice.status === 'decommissioned') {
        // Decommission-bypass: admin explicitly DELETE'd the device. The
        // prior agent's tokens are irrelevant; the slot is freed for fresh
        // enrollment. Per issue #914 we mint a NEW device.id rather than
        // re-using existingDevice.id — the old row keeps its FK-attached
        // audit history (agent_logs, alerts, deviceHardware/Network) and
        // is renamed below in-transaction to free the hostname for the
        // fresh INSERT. Re-enrollment still works (the case that #896
        // originally fixed), but the new agent does not silently inherit
        // the prior row's historical attribution.
        existingDeviceAuthenticated = true;
        decomBypassFreshRow = true;
        // Audit the admin-approved-replacement bypass for forensic
        // traceability. Re-enrollment onto a decommissioned slot is a
        // sensitive transition (new tokens issued) and must be traceable
        // independent of the success-path audit below. resourceId here is
        // the PRIOR device id; the success audit below will record the new
        // fresh id.
        writeAuditEvent(c, {
          orgId: key.orgId,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceId: existingDevice.id,
          resourceName: data.hostname,
          details: {
            reason: 'decommissioned_row_reenrolled_fresh_id',
            siteId,
            priorDeviceId: existingDevice.id,
          },
          result: 'success',
        });
      } else {
        const now = new Date();
        const existingDeviceToken = getProvidedExistingDeviceToken(c);
        existingDeviceAuthenticated =
          tokenHashMatches(existingDevice.agentTokenHash, existingDeviceToken, now) ||
          tokenHashMatches(existingDevice.previousTokenHash, existingDeviceToken, now, existingDevice.previousTokenExpiresAt);
      }

      if (!existingDeviceAuthenticated) {
        const isSuspendedDecom = tokenSuspended && existingDevice.status === 'decommissioned';
        const reason = isSuspendedDecom
          ? 'existing_decommissioned_row_has_suspended_token'
          : 'hostname_collision_requires_existing_device_token';
        const errorMessage = isSuspendedDecom
          ? 'Re-enrollment refused: existing device is decommissioned but its agent token was suspended (cross-tenant probe alarm). Clear agent_token_suspended_at on the device row before re-enrolling.'
          : 'Enrollment attempted to replace an existing hostname without the existing device token';

        writeAuditEvent(c, {
          orgId: key.orgId,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceId: existingDevice.id,
          resourceName: data.hostname,
          details: {
            reason,
            siteId,
          },
          result: 'denied',
          errorMessage,
        });
        return c.json({
          error: isSuspendedDecom
            ? 'Re-enrollment refused: existing device row is decommissioned and has a suspended agent token. An operator must clear the suspension flag before re-enrollment.'
            : 'A device with this hostname already exists and re-enrollment requires the existing device token or an admin-approved replacement workflow',
          reason,
        }, 409);
      }
    }

    // Pre-#914 a top-level auto-restore UPDATE flipped a decommissioned
    // existingDevice back to status='offline' before the in-transaction
    // re-enroll UPDATE. With #914 the decom path INSERTs a fresh row
    // (the old row stays decommissioned), and the non-decom branches
    // never reach this point with status='decommissioned' — so that
    // top-level UPDATE is now unreachable and has been removed.
    //
    // #946: in-transaction sentinel used to translate "enrollment-key
    // claim lost the TOCTOU race" into the 401 enrollment_key_race_lost
    // response after rolling back the device INSERT. Any other throw in
    // the transaction propagates normally (HTTPException for device-limit,
    // generic 500 for unexpected failures).
    const ENROLLMENT_KEY_RACE_LOST = Symbol('enrollment_key_race_lost');
    let device;
    try {
      device = await db.transaction(async (tx) => {
      // Device limit check inside transaction to prevent TOCTOU race.
      // Runs when no existing row OR when the decom-bypass-fresh-id path
      // (#914) is going to INSERT a new active row — both grow net active
      // count by 1. Skipped on the normal UPDATE-in-place re-enroll path,
      // which is count-neutral.
      if (maxDevices != null && deviceLimitPartnerId && (!existingDevice || decomBypassFreshRow)) {
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
          recordAgentEnrollment('error', deviceLimitPartnerId);
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

      // #914 decom-bypass: rename the prior decommissioned row's hostname
      // so the new INSERT can claim the original. There is no DB-level
      // unique constraint on hostname today (only the cursor-keyset index
      // devices_hostname_id_idx), but the application's existingDevice
      // lookup at the top of this handler filters by exact hostname — if
      // both rows kept the same hostname, the next re-enroll would race
      // on which row .limit(1) returns. The `.decom-<id8>` suffix is
      // collision-free in practice (8 hex chars = ~4B namespace) and
      // mirrors the SQL workaround documented in the #896 incident notes.
      if (decomBypassFreshRow && existingDevice) {
        await tx
          .update(devices)
          .set({
            hostname: `${data.hostname}.decom-${existingDevice.id.slice(0, 8)}`,
            updatedAt: new Date(),
          })
          .where(eq(devices.id, existingDevice.id));
      }

      let dev;
      if (existingDevice && !decomBypassFreshRow) {
        [dev] = await tx
          .update(devices)
          .set({
            agentId: agentId,
            agentTokenHash: tokenHash,
            watchdogTokenHash,
            helperTokenHash,
            osType: data.osType,
            osVersion: data.osVersion,
            architecture: data.architecture,
            agentVersion: data.agentVersion,
            tokenIssuedAt,
            watchdogTokenIssuedAt: tokenIssuedAt,
            helperTokenIssuedAt: tokenIssuedAt,
            previousTokenHash: null,
            previousTokenExpiresAt: null,
            previousWatchdogTokenHash: null,
            previousWatchdogTokenExpiresAt: null,
            previousHelperTokenHash: null,
            previousHelperTokenExpiresAt: null,
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
            watchdogTokenHash,
            helperTokenHash,
            hostname: data.hostname,
            osType: data.osType,
            osVersion: data.osVersion,
            architecture: data.architecture,
            agentVersion: data.agentVersion,
            tokenIssuedAt,
            watchdogTokenIssuedAt: tokenIssuedAt,
            helperTokenIssuedAt: tokenIssuedAt,
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

      // #946: consume the enrollment key ONLY after the device row has
      // been successfully written. We re-apply the validity conditions
      // (`expiresAt`/`maxUsage`) to preserve the TOCTOU protection that
      // the standalone pre-insert UPDATE used to provide. If a concurrent
      // claim drained the last slot between our initial lookup and this
      // point, the UPDATE affects 0 rows; we throw the sentinel and the
      // transaction rolls back — the device INSERT is undone and the
      // caller receives 401 enrollment_key_race_lost.
      const claimed = await tx
        .update(enrollmentKeys)
        .set({ usageCount: sql`${enrollmentKeys.usageCount} + 1` })
        .where(
          and(
            eq(enrollmentKeys.id, matchingKey.id),
            ...validEnrollmentKeyConditions
          )
        )
        .returning({ id: enrollmentKeys.id });

      if (claimed.length === 0) {
        throw ENROLLMENT_KEY_RACE_LOST;
      }

      return dev;
    });
    } catch (err) {
      if (err === ENROLLMENT_KEY_RACE_LOST) {
        // The device INSERT was rolled back along with the failed key
        // claim. Surface the same `enrollment_key_race_lost` reason the
        // standalone pre-insert UPDATE used to emit, so clients and audit
        // logs stay backwards-compatible.
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
      throw err;
    }

    const mtlsCert = await issueMtlsCertForDevice(device.id, key.orgId);

    recordAgentEnrollment('success', enrollmentPartnerId);

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
        // #914: when decom-bypass minted a fresh id, link the new row's
        // audit trail back to the decommissioned row it replaced so the
        // forensic chain is queryable in one step.
        ...(decomBypassFreshRow && existingDevice
          ? { decomBypassPriorDeviceId: existingDevice.id }
          : {}),
      },
    });

    // Queue warranty lookup for the newly enrolled device (fire-and-forget)
    queueWarrantySyncForDevice(device.id).catch((err) => {
      console.error('[Enrollment] Failed to queue warranty sync:', err instanceof Error ? err.message : err);
    });

    // Close the MCP deployment-invite funnel if this enrollment key was
    // issued by `send_deployment_invites` (best-effort; no-op for manual
    // enrollments or re-enrollments).
    await matchDeploymentInviteOnEnrollment({
      enrollmentKeyId: key.id,
      deviceId: device.id,
    });

    // Per-deployment manifest trust keys for self-host agent updates.
    // Empty for hosted SaaS where the LanternOps build-time trust root in
    // the agent binary is the only required key. See #625 / docs/deploy/
    // agent-update-trust-bootstrap.md.
    let manifestTrustKeys: ManifestTrustKey[] = [];
    try {
      manifestTrustKeys = await getActiveTrustKeyset();
    } catch (err) {
      console.error(`[enrollment] Failed to load manifest trust keyset for enrollmentKeyId=${key.id}, deviceId=${device.id}:`, err);
      captureException(err);
    }

    return c.json({
      agentId: agentId,
      deviceId: device.id,
      authToken: apiKey,
      watchdogAuthToken: watchdogApiKey,
      helperAuthToken: helperApiKey,
      orgId: key.orgId,
      siteId: key.siteId,
      config: {
        heartbeatIntervalSeconds: 60,
        metricsCollectionIntervalSeconds: 30
      },
      mtls: mtlsCert,
      manifestTrustKeys,
    }, 201);
  });
});

