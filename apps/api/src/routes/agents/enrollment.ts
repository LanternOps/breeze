import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '../../lib/validation';
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
  supportSessions,
} from '../../db/schema';
import { getActiveOrgTenant } from '../../services/tenantStatus';
import { writeAuditEvent } from '../../services/auditEvents';
import { hashEnrollmentKeyCandidates, hashEnrollmentSecret } from '../../services/enrollmentKeySecurity';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { invalidateOrgDeviceCount } from '../../services/agentOrgRateLimit';
import { enrollSchema } from './schemas';
import { generateAgentId, generateApiKey, issueMtlsCertForDevice } from './helpers';
import { recordAgentEnrollment } from '../../services/anomalyMetrics';
import { queueWarrantySyncForDevice } from '../../services/warrantyWorker';
import { dispatchHook } from '../../services/partnerHooks';
import { matchDeploymentInviteOnEnrollment } from '../../modules/mcpInvites/matchInviteOnEnrollment';
import {
  getActiveTrustKeyset,
  getActiveManifestKeyDelegations,
  type ManifestTrustKey,
  type ManifestKeyDelegation,
} from '../../services/manifestSigning';
import { captureException } from '../../services/sentry';
import {
  raiseDeviceIdentityCollisionAlert,
  type DeviceIdentityCollisionAlertInput,
} from '../../services/deviceIdentityCollisionAlert';
import { partnerTrustMode } from '../../config/partnerTrustMode';
import { evaluateCapability, trustDenyBody } from '../../services/partnerTrust';
import { enqueueIpClassify } from '../../services/ipClassify';

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
  // 'unknown' is the rate-limiter fallback, not a real address — store NULL.
  const enrollmentIp = clientIp === 'unknown' ? null : clientIp;
  const rateCheck = await rateLimiter(
    getRedis(),
    `agent-enroll:${rateLimitIpKey(clientIp)}`,
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

  // #1105: the callback below returns either an early-exit Response (error
  // paths) or the success-path data needed to build the response. The
  // warranty-sync enqueue (Redis round-trip) must NOT fire while the
  // withSystemDbAccessContext transaction is still open — it now runs after
  // this block resolves and the pooled connection is released, mirroring
  // reliabilityWorker.ts's processScanOrgs (#2640).
  const enrollmentOutcome = await withSystemDbAccessContext(async (): Promise<
    | Response
    | {
        deviceId: string;
        collision?: DeviceIdentityCollisionAlertInput;
        responseBody: Record<string, unknown>;
      }
  > => {
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
        // Set only on the single-use child keys minted by POST /support/redeem;
        // NULL on every ordinary key. Drives the whole Quick Support branch below.
        supportSessionId: enrollmentKeys.supportSessionId,
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

    // Quick Support enrollments ride the same key path as everything else, but
    // mint an EPHEMERAL device: excluded from the partner licence count, never
    // adopted by a hostname collision, and linked back to its session below.
    const isSupportEnrollment = !!matchingKey.supportSessionId;

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
          orgId: matchingKey.orgId,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceName: data.hostname,
          details: { reason: 'missing_enrollment_secret', keyId: matchingKey.id },
          result: 'denied',
          errorMessage: 'Enrollment secret required',
        });
        recordAgentEnrollment('error');
        return c.json({ error: 'Enrollment secret required' }, 403);
      }

      const providedSecretHash = hashEnrollmentSecret(providedSecret);
      if (!timingSafeStringEqual(providedSecretHash, matchingKey.keySecretHash)) {
        writeAuditEvent(c, {
          orgId: matchingKey.orgId,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceName: data.hostname,
          details: { reason: 'invalid_enrollment_secret', keyId: matchingKey.id },
          result: 'denied',
          errorMessage: 'Invalid enrollment secret',
        });
        recordAgentEnrollment('error');
        return c.json({ error: 'Invalid enrollment secret' }, 403);
      }
    } else if (configuredSecret) {
      if (!providedSecret) {
        writeAuditEvent(c, {
          orgId: matchingKey.orgId,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceName: data.hostname,
          details: { reason: 'missing_enrollment_secret', keyId: matchingKey.id },
          result: 'denied',
          errorMessage: 'Enrollment secret required',
        });
        recordAgentEnrollment('error');
        return c.json({ error: 'Enrollment secret required' }, 403);
      }

      if (!timingSafeStringEqual(hashEnrollmentSecret(providedSecret), hashEnrollmentSecret(configuredSecret))) {
        writeAuditEvent(c, {
          orgId: matchingKey.orgId,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceName: data.hostname,
          details: { reason: 'invalid_enrollment_secret', keyId: matchingKey.id },
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

    // Step 3 (Quick Support only): the child key is single-use and short-lived,
    // but the SESSION is the real authority — a technician who ends a session,
    // or a hard-expiry reaper run, must invalidate a key that was redeemed
    // moments earlier and never used. Checked AFTER the secret verification so
    // a caller holding only the key cannot probe session state.
    //
    // The response is byte-for-byte the ordinary expired-key rejection: the end
    // user is an anonymous stranger and nothing here should confirm that a
    // support session ever existed. The audit row carries the real reason.
    if (isSupportEnrollment) {
      const [session] = await db
        .select({
          status: supportSessions.status,
          hardExpiresAt: supportSessions.hardExpiresAt,
        })
        .from(supportSessions)
        .where(eq(supportSessions.id, matchingKey.supportSessionId!))
        .limit(1);

      const supportNow = new Date();
      if (!session || session.status !== 'claimed' || new Date(session.hardExpiresAt) < supportNow) {
        writeAuditEvent(c, {
          orgId: matchingKey.orgId,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceName: data.hostname,
          details: {
            reason: 'support_session_not_claimable',
            keyId: matchingKey.id,
            supportSessionId: matchingKey.supportSessionId,
            sessionStatus: session?.status ?? null,
          },
          result: 'denied',
          errorMessage: 'Quick Support session is not claimable',
        });
        recordAgentEnrollment('error');
        return c.json({
          error: 'Enrollment key has expired — regenerate the key or installer link and retry',
          reason: 'enrollment_key_expired',
        }, 401);
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
      deviceLimitPartnerId = org.partnerId;
      const [partner] = await db
        .select({ maxDevices: partners.maxDevices })
        .from(partners)
        .where(eq(partners.id, org.partnerId))
        .limit(1);

      if (partner?.maxDevices != null) {
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

    // #2764: every colliding row, oldest first — not `.limit(1)`. Collisions
    // are no longer refused, so more than one row can legitimately share a
    // hostname and the audit trail must name all of them. Ordering makes the
    // selection deterministic (the old `.limit(1)` was not).
    const collidingDevices = await db
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
          eq(devices.siteId, siteId),
          // Ephemeral Quick Support rows are never collision candidates. Every
          // session for the same machine lands in the same hidden per-partner
          // org under the same hostname, so without this filter the second
          // support run would take the re-enrollment-token branch, fail to
          // prove possession of the (already reaped) prior row's token, and
          // drag a dead session's device into the new one. Each session gets
          // its own fresh row instead.
          eq(devices.isEphemeral, false)
        )
      )
      .orderBy(devices.createdAt);

    const enrollNow = new Date();
    const presentedExistingDeviceToken = getProvidedExistingDeviceToken(c);
    // Match the presented credential against EVERY colliding row, not just the
    // first. With multiple rows sharing a hostname (only possible post-#2764),
    // checking one arbitrary row would fail to recognize the agent's own row
    // and mint yet another fresh row on every reinstall — an unbounded device-
    // row leak on the exact path this feature exists to make idempotent.
    // A suspended row can never authenticate (suspension binds its credential).
    const authenticatedDevice = presentedExistingDeviceToken
      ? collidingDevices.find(
          (candidate) =>
            !candidate.agentTokenSuspendedAt &&
            (tokenHashMatches(candidate.agentTokenHash, presentedExistingDeviceToken, enrollNow) ||
              tokenHashMatches(
                candidate.previousTokenHash,
                presentedExistingDeviceToken,
                enrollNow,
                candidate.previousTokenExpiresAt,
              ))
        )
      : undefined;

    // The row this enrollment is measured against: the one the agent proved
    // possession of, else the ONLINE collider (the live lookalike an operator
    // needs pointed at), else any LIVE collider, else the oldest.
    //
    // The "any live collider" rung is load-bearing. A decommissioned row is a
    // dead record an admin already retired; letting it win over a live sibling
    // would (a) route a plain collision into the #914 decom bypass — losing
    // the replacement linkage, the collision audit and the alert — and (b) if
    // that dead row also carried a probe suspension, resurrect the
    // `existing_decommissioned_row_has_suspended_token` 409 against a
    // perfectly healthy host, i.e. exactly the permanently-un-enrollable
    // failure this change exists to remove. Reachable in the field: a
    // collision mints row2, an operator then decommissions row1, and row2's
    // machine reinstalls. Decom-bypass therefore fires only when EVERY
    // collider is decommissioned.
    const existingDevice =
      authenticatedDevice ??
      collidingDevices.find((candidate) => candidate.status === 'online') ??
      collidingDevices.find((candidate) => candidate.status !== 'decommissioned') ??
      collidingDevices[0];

    // Containment can never be escaped by re-enrolling. When the agent proved
    // possession of a colliding row's credential, only THAT row's quarantine
    // status can block it; otherwise any quarantined collider blocks (strictly
    // at least as strict as the pre-#2764 single-row check).
    const quarantineBlocker = authenticatedDevice
      ? (authenticatedDevice.status === 'quarantined' ? authenticatedDevice : undefined)
      : collidingDevices.find((candidate) => candidate.status === 'quarantined');

    let existingDeviceAuthenticated = false;
    // Set true on the decom-bypass path so the transaction below renames
    // the old row's hostname (freeing the slot) and INSERTs a fresh device
    // row with a new id, instead of UPDATE-in-place on the prior id. See
    // issue #914 — without a fresh id, any holder of the org enrollment
    // key + secret + a known-decommissioned hostname could silently adopt
    // the prior device's audit history (agent_logs, alerts, etc.).
    let decomBypassFreshRow = false;
    // #2764 hostname-collision path: INSERT a fresh row exactly like the
    // decom bypass, but WITHOUT its hostname rename — the colliding rows now
    // coexist and no existing row is written at enrollment time.
    let collisionFreshRow = false;
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
      if (quarantineBlocker) {
        writeAuditEvent(c, {
          orgId: key.orgId,
          actorType: 'system',
          action: 'agent.enroll',
          resourceType: 'device',
          resourceId: quarantineBlocker.id,
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
        // The presented credential was already matched against every
        // colliding row above; this row is authenticated iff it is the one
        // that matched.
        existingDeviceAuthenticated = authenticatedDevice?.id === existingDevice.id;
      }

      if (!existingDeviceAuthenticated) {
        if (tokenSuspended && existingDevice.status === 'decommissioned') {
          // UNCHANGED refusal — deliberate ops alarm. A probe-suspended token
          // on a decommissioned row means an operator must consciously clear
          // agent_token_suspended_at before that hostname re-enrolls.
          const reason = 'existing_decommissioned_row_has_suspended_token';
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
            errorMessage:
              'Re-enrollment refused: existing device is decommissioned but its agent token was suspended (cross-tenant probe alarm). Clear agent_token_suspended_at on the device row before re-enrolling.',
          });
          return c.json({
            error: 'Re-enrollment refused: existing device row is decommissioned and has a suspended agent token. An operator must clear the suspension flag before re-enrollment.',
            reason,
          }, 409);
        }

        // #2764: the former `hostname_collision_requires_existing_device_token`
        // 409 is GONE. A reimaged or reinstalled machine structurally cannot
        // hold the prior row's token, so the refusal made the host permanently
        // un-enrollable and rolled back the whole MSI install — while
        // preventing nothing, since the hostname is self-attested and an
        // attacker with a valid key can already enroll under any other name.
        //
        // Prevention is replaced by DETECTION: a fresh row linked back to the
        // row it may be replacing, an audit trail naming every collider, and
        // (when the collider is live) an operator alert. Deliberately NOT
        // done here: renaming, decommissioning, adopting or otherwise writing
        // the existing row. Staleness is not authorization, and hardware
        // identifiers are self-attested so they gate nothing.
        collisionFreshRow = true;
      }
    }

    // Both fresh-row paths take the INSERT branch below; only the decom
    // bypass additionally renames the row it replaces.
    const insertFreshRow = !existingDevice || decomBypassFreshRow || collisionFreshRow;
    const collisionReplacedDeviceId = collisionFreshRow && existingDevice ? existingDevice.id : null;

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
      if (partnerTrustMode() !== 'off' && deviceLimitPartnerId) {
        const [trustRow] = await tx
          .select({
            trustState: partners.trustState,
            probationEnrollments: partners.probationEnrollments,
          })
          .from(partners)
          .where(eq(partners.id, deviceLimitPartnerId))
          .for('update');

        if (trustRow && trustRow.trustState !== 'trusted') {
          const decision = await evaluateCapability('agent_enroll', {
            partnerId: deviceLimitPartnerId,
            orgId: key.orgId,
            detail: { probationEnrollments: trustRow.probationEnrollments },
          });
          if (!decision.allow) {
            writeAuditEvent(c, {
              orgId: key.orgId,
              action: 'agent.enroll',
              resourceType: 'device',
              result: 'denied',
              details: { reason: decision.reason },
            });
            throw new HTTPException(403, {
              message: JSON.stringify(trustDenyBody(decision, false)),
            });
          }
          await tx
            .update(partners)
            .set({ probationEnrollments: sql`${partners.probationEnrollments} + 1` })
            .where(eq(partners.id, deviceLimitPartnerId));
        }
      }

      // Device limit check inside transaction to prevent TOCTOU race.
      // Runs when no existing row OR when the decom-bypass-fresh-id path
      // (#914) is going to INSERT a new active row — both grow net active
      // count by 1. Skipped on the normal UPDATE-in-place re-enroll path,
      // which is count-neutral.
      //
      // Also skipped entirely for Quick Support: an ephemeral device is a
      // minutes-long remote-assist session on a machine the MSP does not
      // manage, not a licensed endpoint. A partner sitting at their cap must
      // still be able to help a caller — and since the row is excluded from
      // the count below, admitting it cannot push the fleet past the cap.
      if (maxDevices != null && deviceLimitPartnerId && insertFreshRow && !isSupportEnrollment) {
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
              ne(devices.status, 'decommissioned'),
              // Quick Support devices are not licensed endpoints — they live in
              // the hidden per-partner support org for the length of one
              // session and are purged by the reaper. Counting them would let a
              // busy support day silently consume a partner's device
              // entitlement and block real enrollments.
              eq(devices.isEphemeral, false)
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
          // Device-cap denials are org-attributable (the key was already
          // resolved) and must land in audit_logs like every other denial
          // path — otherwise this signal is invisible to the abuse-signals
          // sweep's `denied` CTE (heuristics.ts).
          writeAuditEvent(c, {
            orgId: key.orgId,
            actorType: 'system',
            action: 'agent.enroll',
            resourceType: 'device',
            resourceName: data.hostname,
            details: {
              reason: 'device_limit_reached',
              enrollmentKeyId: key.id,
              partnerId: deviceLimitPartnerId,
              currentDevices: activeCount,
              maxDevices,
            },
            result: 'denied',
            errorMessage: 'Partner device limit reached',
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
      if (!insertFreshRow && existingDevice) {
        [dev] = await tx
          .update(devices)
          .set({
            agentId: agentId,
            enrollmentIp,
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
            // Issue #2621 — re-enrollment is a full credential reset, so it must
            // also drop any staged rotation. Leaving it would let a staged set
            // minted before the re-enrollment keep authenticating, and be
            // promoted over the freshly issued credentials.
            pendingTokenHash: null,
            pendingWatchdogTokenHash: null,
            pendingHelperTokenHash: null,
            pendingTokenExpiresAt: null,
            deviceRole: data.deviceRole || 'unknown',
            deviceRoleSource: 'auto',
            isVirtual: data.isVirtual ?? false,
            virtualizationPlatform: data.virtualizationPlatform ?? null,
            status: 'pending',
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
            enrollmentIp,
            osType: data.osType,
            osVersion: data.osVersion,
            architecture: data.architecture,
            agentVersion: data.agentVersion,
            tokenIssuedAt,
            watchdogTokenIssuedAt: tokenIssuedAt,
            helperTokenIssuedAt: tokenIssuedAt,
            deviceRole: data.deviceRole || 'unknown',
            deviceRoleSource: 'auto',
            isVirtual: data.isVirtual ?? false,
            virtualizationPlatform: data.virtualizationPlatform ?? null,
            status: 'pending',
            isEphemeral: isSupportEnrollment,
            // #2764: forensic + UI linkage back to the row this enrollment may
            // be replacing. Set on the collision path only — the decom bypass
            // records its own linkage in the audit trail (#914).
            possibleReplacementOfDeviceId: collisionReplacedDeviceId,
            tags: []
          })
          .returning();
      }

      if (!dev) {
        throw new Error('Failed to create device');
      }

      // Quick Support: bind the session to the device it just enrolled. Inside
      // the SAME transaction as the device write so a rolled-back enrollment
      // can never leave a session pointing at a device row that does not exist.
      // The status='claimed' guard makes this a no-op if the technician ended
      // (or the reaper expired) the session while the insert was in flight —
      // that session must stay terminal rather than be revived by a late agent.
      if (isSupportEnrollment) {
        await tx
          .update(supportSessions)
          .set({ deviceId: dev.id })
          .where(
            and(
              eq(supportSessions.id, matchingKey.supportSessionId!),
              eq(supportSessions.status, 'claimed')
            )
          );
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
            motherboardManufacturer: data.hardwareInfo.motherboardManufacturer,
            motherboardProduct: data.hardwareInfo.motherboardProduct,
            motherboardVersion: data.hardwareInfo.motherboardVersion,
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
              motherboardManufacturer: data.hardwareInfo.motherboardManufacturer,
              motherboardProduct: data.hardwareInfo.motherboardProduct,
              motherboardVersion: data.hardwareInfo.motherboardVersion,
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
      if (err instanceof HTTPException) {
        try {
          return c.json(JSON.parse(err.message), err.status);
        } catch {
          // Preserve non-JSON HTTPExceptions for the application's normal handler.
        }
      }
      throw err;
    }

    const mtlsCert = await issueMtlsCertForDevice(device.id, key.orgId);

    // #2728 — the per-org agent rate limit is sized from the enrolled device
    // count, which is cached. Drop the cache on enrollment so a fleet being
    // rolled out isn't throttled against a stale (smaller) count for up to the
    // cache TTL. Best-effort; the TTL is the backstop. Guarded because the
    // device row is already committed — a cache problem must not fail an
    // otherwise successful enrollment.
    try {
      void invalidateOrgDeviceCount(getRedis(), key.orgId);
    } catch (err) {
      console.error('[enrollment] device-count cache invalidation failed', err);
    }

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
        // #2764: the hostname collision that used to be a 409. Names the row
        // the fresh one may be replacing plus every colliding id, so the
        // forensic chain is queryable in one step.
        ...(collisionReplacedDeviceId
          ? {
              reason: 'hostname_collision_enrolled_fresh_row',
              possibleReplacementOfDeviceId: collisionReplacedDeviceId,
              collidingDeviceIds: collidingDevices.map((candidate) => candidate.id),
            }
          : {}),
      },
    });

    // Warranty sync is queued AFTER withSystemDbAccessContext resolves below
    // (#1105) — it must not fire while this transaction is still open.

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

    // Signed manifest key delegations (Wave 6 Task 7). Delivered here so a
    // device enrolling mid-rotation learns about the pending key change on
    // its very first contact rather than waiting for a heartbeat.
    //
    // #1105: this is DATABASE work only — getActiveManifestKeyDelegations
    // issues one SELECT and makes no network or queue call — so it is safe
    // inside this system DB context, exactly like getActiveTrustKeyset
    // above. The boundary that must not be crossed is external handoff:
    // queueWarrantySyncForDevice still fires only AFTER this context
    // resolves (see the end of the handler), and nothing here may be moved
    // to join it.
    //
    // A failure is non-fatal: the device enrolls, and adopts on a later
    // heartbeat. Blocking enrollment on a rotation record would turn a
    // rotation-time hiccup into an onboarding outage.
    let manifestKeyDelegations: ManifestKeyDelegation[] = [];
    try {
      manifestKeyDelegations = await getActiveManifestKeyDelegations();
    } catch (err) {
      console.error(`[enrollment] Failed to load manifest key delegations for enrollmentKeyId=${key.id}, deviceId=${device.id}:`, err);
      captureException(err);
    }

    return {
      deviceId: device.id,
      // #2764: raised AFTER this context closes (see below). Only when the
      // colliding row is currently ONLINE — that is the lookalike signal;
      // a stale offline row is the ordinary reimage case and would be pure
      // noise. Status column, not the in-process websocket map, which is not
      // cluster-authoritative.
      collision:
        collisionReplacedDeviceId && existingDevice?.status === 'online'
          ? {
              orgId: key.orgId,
              siteId,
              hostname: data.hostname,
              newDeviceId: device.id,
              existingDeviceId: collisionReplacedDeviceId,
              collidingDeviceIds: collidingDevices.map((candidate) => candidate.id),
            }
          : undefined,
      responseBody: {
        agentId: agentId,
        deviceId: device.id,
        authToken: apiKey,
        watchdogAuthToken: watchdogApiKey,
        helperAuthToken: helperApiKey,
        orgId: key.orgId,
        siteId: key.siteId,
        backupServerUrl: (process.env.AGENT_BACKUP_SERVER_URL ?? '').trim() || undefined,
        config: {
          heartbeatIntervalSeconds: 60,
          metricsCollectionIntervalSeconds: 30
        },
        mtls: mtlsCert,
        manifestTrustKeys,
        manifestKeyDelegations,
      },
    };
  });

  if (enrollmentOutcome instanceof Response) {
    // Error path — no device was enrolled, so no warranty sync to queue.
    return enrollmentOutcome;
  }

  // #1105: fire-and-forget BullMQ enqueue now runs after the transaction has
  // committed and the pooled connection has been released. Same fire-and-
  // forget error handling as before — an enqueue failure must never fail
  // enrollment.
  queueWarrantySyncForDevice(enrollmentOutcome.deviceId).catch((err) => {
    console.error('[Enrollment] Failed to queue warranty sync:', err instanceof Error ? err.message : err);
  });

  if (enrollmentIp && partnerTrustMode() !== 'off') {
    void enqueueIpClassify({
      kind: 'device',
      deviceId: enrollmentOutcome.deviceId,
      ip: enrollmentIp,
    }).catch((err) => {
      console.warn('[Enrollment] Failed to queue IP classification:', err instanceof Error ? err.message : err);
    });
  }

  // #2764 identity-collision alert. Best-effort and strictly fire-and-forget:
  // an alerting failure must never fail an enrollment that already committed.
  // Runs in its OWN system DB context, after the enrollment context released
  // its pooled connection — createAlert does Redis/BullMQ/event-bus work that
  // must not be held inside the enrollment transaction (#1105).
  const collision = enrollmentOutcome.collision;
  if (collision) {
    withSystemDbAccessContext(() => raiseDeviceIdentityCollisionAlert(collision)).catch((err) => {
      console.error(
        `[Enrollment] Failed to raise identity-collision alert for device ${collision.newDeviceId}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  return c.json(enrollmentOutcome.responseBody, 201);
});
