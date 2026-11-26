/**
 * POST /agents/enroll with a holding-area deploy key (#8318 wave D-1, spec
 * 2026-10-12 §10.6, plan §4). Reached from routes/agents/enrollment.ts after
 * the per-IP rate limit, for any key carrying the `bdk_` prefix, before the
 * org-key lookup — so the org-key path never sees a deploy key and a deploy
 * key never reaches the enrollment-secret gate (user decision 2026-11-25:
 * the key is the only credential; see the comment at the branch).
 *
 * The device is PARKED: created in the partner's hidden holding org and its
 * one site, with no customer org, no assignment and no candidate reveal.
 *
 * Order, each step outside the next one's context:
 *   1. resolve the key by hash in its own short system context; 401
 *      `deploy_key_not_found | deploy_key_revoked | deploy_key_expired |
 *      deploy_key_exhausted`, as the org-key reasons;
 *   2. the key's optional source CIDRs against the client IP the per-IP limit
 *      used (403 `deploy_key_source_not_allowed`);
 *   3. the per-key and per-partner rate buckets, outside any DB context, fail
 *      closed (429 `deploy_key_rate_limited`);
 *   4. the platform flag + partner switch and the eligibility rule
 *      (services/deployKeys/eligibility.ts): 403
 *      `deploy_key_enrollment_unavailable`, the detail in the audit row only;
 *   5. the holding org + site (getOrCreateUnassignedPoolOrg, own context);
 *   6. the tenant gate on the holding org, which cascades to the partner
 *      (getActiveOrgTenant, as the org path): 403 `tenant_inactive`;
 *   7. one system context: the hostname-collision lookup scoped to the holding
 *      org + site, then the device transaction (retried on a lost lock race):
 *        holding-area lock — admitParkedEnrollment for a fresh row (partner
 *        cap, admission declaration), lockPartnerHoldingArea for an in-place
 *        re-enrollment — then the key row FOR UPDATE, re-checked (active,
 *        unexpired, under max_usage), eligibility again, the per-key parked
 *        cap, the partner-export org lock, the device write, the inventory,
 *        the usage claim with last_used_at / last_used_ip, and the `enrolled`
 *        ledger row naming the key;
 *      then the mTLS certificate.
 * LOCK ORDER (services/unassignedPool/holdingAreaLock.ts): holding-area lock,
 * then the key row. Revoke takes only the key row, so the two cannot deadlock.
 *
 * Partner trust: eligibility requires `trust_state = 'trusted'` (re-read
 * inside the device transaction), so the org path's probation gate
 * (evaluateCapability + probation_enrollments) can never apply here and is not
 * run. Licensed capacity (admitPartnerDeviceCapacity) is not consulted:
 * parked devices are not licensed (partnerDeviceCapacity.ts).
 *
 * In-place re-enrollment: an agent that proves possession of a live parked
 * row's token (same hostname, same holding site) re-enrolls onto that row, as
 * the org path does; no partner-cap admission runs for it (no new row), and a
 * further `enrolled` ledger row names the new key, so revoking either key
 * expires the device (expireDevicesParkedByDeployKey reads every `enrolled`
 * row). A collider in a customer org is never seen: the lookup is scoped to
 * the holding org.
 *
 * Not done for a deploy key (each is org-path behaviour a parked device must
 * not get): Quick Support, the deployment-invite match, the manifest trust keys
 * and delegations and the backup URL in the response, the reinstall-candidate
 * search at enrollment (parked sources are found later, §9.3), the warranty
 * sync, the org default device group, the dynamic-group re-evaluation, the
 * identity-collision alert, and the `device.enrolled` event — partner-wide
 * webhook and automation subscribers fan out by partner and would see the
 * parked device.
 */
import type { Context } from 'hono';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devicePoolAssignmentEvents, devices, partnerDeployKeys } from '../../db/schema';
import { collectAgentCredentialHashes } from '../../services/agentCredentialHashes';
import { writeAuditEvent } from '../../services/auditEvents';
import { recordAgentEnrollment } from '../../services/anomalyMetrics';
import { captureException } from '../../services/sentry';
import { getRedis } from '../../services/redis';
import { invalidateOrgDeviceCount } from '../../services/agentOrgRateLimit';
import { getActiveOrgTenant } from '../../services/tenantStatus';
import { enqueueIpClassify } from '../../services/ipClassify';
import { partnerTrustMode } from '../../config/partnerTrustMode';
import { lockPartnerExportOrg } from '../../db/partnerExportLock';
import { isTransientLockError, pgErrorCode, retryOnTransientLockError } from '../../utils/pgErrors';
import { deployKeyHashCandidates, isWellFormedDeployKey } from '../../services/deployKeys/keyFormat';
import { readDeployKeyEligibility } from '../../services/deployKeys/eligibility';
import {
  deployKeyStateRefusal,
  sourceAllowed,
  type DeployKeyKeyRefusalReason,
} from '../../services/deployKeys/enrollmentGate';
import { checkDeployKeyRateBuckets } from '../../services/unassignedPool/enrollmentRateBuckets';
import { isDeployKeyEnrollmentEnabled } from '../../services/unassignedPool/switches';
import { getOrCreateUnassignedPoolOrg } from '../../services/unassignedPool/poolOrg';
import { lockPartnerHoldingArea } from '../../services/unassignedPool/holdingAreaLock';
import { parkedCertificateLifetimeDays } from '../../services/unassignedPool/limits';
import {
  admitDeployKeyParkedCapacity,
  admitParkedEnrollment,
  DeployKeyParkedCapReachedError,
  ParkedCapReachedError,
} from '../../services/unassignedPool/admission';
import { disconnectAgentCredentialGeneration, publishAgentCredentialRevocation } from '../agentWs';
import { buildEnrollmentResponseBody } from './enrollmentResponse';
import { issueMtlsCertForDevice } from './helpers';
import {
  collidingDeviceColumns,
  findAuthenticatedCollider,
  freshDeviceValues,
  getProvidedExistingDeviceToken,
  mintEnrollmentCredentials,
  reenrollDeviceSet,
  writeEnrollmentInventory,
  type EnrollBody,
} from './enrollmentDeviceWrite';

/** Seconds an agent is told to wait after the device write lost every lock race. */
const ENROLLMENT_CONTENDED_RETRY_AFTER_SECONDS = 2;

const KEY_REFUSAL_MESSAGE: Record<DeployKeyKeyRefusalReason, string> = {
  deploy_key_not_found: 'Enrollment key not recognized',
  deploy_key_revoked: 'Deploy key has been revoked — use the image\'s current key',
  deploy_key_expired: 'Deploy key has expired — rebuild the image with a fresh key',
  deploy_key_exhausted: 'Deploy key has reached its maximum usage count — rotate the key',
};

interface ResolvedKey {
  id: string;
  partnerId: string;
  name: string;
  status: string;
  expired: boolean;
  maxUsage: number;
  usageCount: number;
  maxParked: number;
  sourceCidrs: string[] | null;
}

/** A refusal decided inside the device transaction; it rolls the transaction back. */
class DeployKeyEnrollRefusal extends Error {
  constructor(
    readonly status: 401 | 403 | 409,
    readonly body: Record<string, unknown>,
    readonly auditReason: string,
    readonly auditDetails: Record<string, unknown> = {},
    readonly metric: 'error' | null = 'error',
  ) {
    super(auditReason);
    this.name = 'DeployKeyEnrollRefusal';
  }
}

const keySelection = {
  id: partnerDeployKeys.id,
  partnerId: partnerDeployKeys.partnerId,
  name: partnerDeployKeys.name,
  status: partnerDeployKeys.status,
  expired: sql<boolean>`(${partnerDeployKeys.expiresAt} <= now())`,
  maxUsage: partnerDeployKeys.maxUsage,
  usageCount: partnerDeployKeys.usageCount,
  maxParked: partnerDeployKeys.maxParked,
  sourceCidrs: partnerDeployKeys.sourceCidrs,
};

export async function enrollWithDeployKey(
  c: Context,
  data: EnrollBody,
  options: { enrollmentIp: string | null },
): Promise<Response> {
  const { enrollmentIp } = options;

  const deny = (input: {
    orgId: string | null;
    reason: string;
    message: string;
    details?: Record<string, unknown>;
    result?: 'denied' | 'failure';
  }) => {
    writeAuditEvent(c, {
      orgId: input.orgId,
      actorType: 'system',
      action: 'agent.enroll',
      resourceType: 'device',
      resourceName: data.hostname,
      details: { reason: input.reason, ...(input.details ?? {}) },
      result: input.result ?? 'denied',
      errorMessage: input.message,
    });
  };

  const refuseKey = (reason: DeployKeyKeyRefusalReason, key: ResolvedKey | null) => {
    deny({
      orgId: null,
      reason,
      message: KEY_REFUSAL_MESSAGE[reason],
      details: key ? { deployKeyId: key.id, partnerId: key.partnerId } : {},
    });
    return c.json({ error: KEY_REFUSAL_MESSAGE[reason], reason }, 401);
  };

  // 1. Resolve the key (own short system context). A malformed bdk_ value is
  //    not looked up at all.
  let key: ResolvedKey | null = null;
  if (isWellFormedDeployKey(data.enrollmentKey)) {
    const candidates = deployKeyHashCandidates(data.enrollmentKey);
    const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
      .select(keySelection)
      .from(partnerDeployKeys)
      .where(inArray(partnerDeployKeys.keyHash, candidates))
      .limit(1)));
    key = row ? { ...row, sourceCidrs: row.sourceCidrs ?? null } : null;
  }
  if (!key) return refuseKey('deploy_key_not_found', null);
  const stateRefusal = deployKeyStateRefusal(key);
  if (stateRefusal) return refuseKey(stateRefusal, key);
  const partnerId = key.partnerId;
  const keyRef = { deployKeyId: key.id, partnerId };

  // 2. Optional source allow-list, against the address the per-IP limit used.
  if (!sourceAllowed(key.sourceCidrs, enrollmentIp)) {
    deny({ orgId: null, reason: 'deploy_key_source_not_allowed', message: 'Enrollment source is not allowed for this deploy key', details: keyRef });
    recordAgentEnrollment('denied', partnerId);
    return c.json({ error: 'Enrollment is not allowed from this network for this deploy key', reason: 'deploy_key_source_not_allowed' }, 403);
  }

  // 3. Rate buckets: a Redis round-trip, outside any DB context. Fail closed.
  const rate = await checkDeployKeyRateBuckets({ deployKeyId: key.id, partnerId });
  if (!rate.allowed) {
    deny({ orgId: null, reason: 'deploy_key_rate_limited', message: 'Deploy-key enrollment rate limit exceeded', details: { ...keyRef, bucket: rate.bucket } });
    recordAgentEnrollment('denied', partnerId);
    c.header('Retry-After', String(rate.retryAfterSeconds));
    return c.json({ error: 'Enrollment rate limit exceeded', reason: 'deploy_key_rate_limited' }, 429);
  }

  // 4. Switches and eligibility. One public reason; the detail is audited.
  const unavailable = (detail: string) => {
    deny({ orgId: null, reason: 'deploy_key_enrollment_unavailable', message: 'Deploy-key enrollment is not available for this partner', details: { ...keyRef, detail } });
    recordAgentEnrollment('error', partnerId);
    return c.json({ error: 'Deploy-key enrollment is not available', reason: 'deploy_key_enrollment_unavailable' }, 403);
  };
  if (!(await isDeployKeyEnrollmentEnabled(partnerId))) return unavailable('enrollment_disabled');
  const eligibility = await runOutsideDbContext(() => withSystemDbAccessContext(() => readDeployKeyEligibility(db, partnerId)));
  if (!eligibility.eligible) return unavailable(eligibility.reason);

  // 5. The holding org and its site (own system context).
  const pool = await getOrCreateUnassignedPoolOrg(partnerId);

  // 6. Tenant gate: the holding org, cascading to the partner.
  if (!(await getActiveOrgTenant(pool.orgId))) {
    deny({ orgId: pool.orgId, reason: 'tenant_inactive', message: 'Enrollment tenant is not active', details: keyRef });
    return c.json({ error: 'Enrollment tenant is not active', reason: 'tenant_inactive' }, 403);
  }

  const credentials = mintEnrollmentCredentials();
  const presentedToken = getProvidedExistingDeviceToken(c);

  type Outcome =
    | Response
    | {
        device: { id: string; siteId: string };
        inPlace: boolean;
        replacedAgentId?: string;
        replacedCredentialHashes?: string[];
        mtls: Awaited<ReturnType<typeof issueMtlsCertForDevice>>;
        collidingDeviceIds: string[];
        ledgerEventId: string;
      };

  // 7. Collision lookup + device transaction + certificate, one system context.
  const outcome = await runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<Outcome> => {
    // #2764, scoped to the holding org + site: a customer-org row is never a
    // candidate. Decommissioned (expired) parked rows are not either: an
    // expired device must not come back through its old token.
    const colliders = await db
      .select({ ...collidingDeviceColumns(), createdAt: devices.createdAt })
      .from(devices)
      .where(and(
        eq(devices.hostname, data.hostname),
        eq(devices.orgId, pool.orgId),
        eq(devices.siteId, pool.siteId),
        eq(devices.isEphemeral, false),
        ne(devices.status, 'decommissioned'),
      ))
      .orderBy(devices.createdAt);

    const authenticated = findAuthenticatedCollider(colliders, presentedToken, new Date());
    // Containment can never be escaped by re-enrolling (as the org path).
    const quarantineBlocker = authenticated
      ? (authenticated.status === 'quarantined' ? authenticated : undefined)
      : colliders.find((candidate) => candidate.status === 'quarantined');
    if (quarantineBlocker) {
      writeAuditEvent(c, {
        orgId: pool.orgId,
        actorType: 'system',
        action: 'agent.enroll',
        resourceType: 'device',
        resourceId: quarantineBlocker.id,
        resourceName: data.hostname,
        details: { reason: 'quarantined_device_reenroll_refused', ...keyRef },
        result: 'denied',
        errorMessage: 'Re-enrollment refused: device is quarantined and awaiting administrator approval',
      });
      return c.json({
        error: 'Device is quarantined and awaiting administrator approval. Re-enrollment cannot clear quarantine; an administrator must approve the device.',
        reason: 'device_quarantined',
      }, 403);
    }
    const inPlace = authenticated;

    let written: { device: { id: string; siteId: string; createdAt: Date }; ledgerEventId: string };
    try {
      written = await retryOnTransientLockError('deploy_key_enrollment', () => db.transaction(async (tx) => {
        if (inPlace) {
          await lockPartnerHoldingArea(tx, partnerId);
        } else {
          await admitParkedEnrollment(tx, { partnerId, holdingOrgId: pool.orgId });
        }

        const [locked] = await tx
          .select(keySelection)
          .from(partnerDeployKeys)
          .where(eq(partnerDeployKeys.id, keyRef.deployKeyId))
          .limit(1)
          .for('update');
        const lockedRefusal = locked ? deployKeyStateRefusal(locked) : 'deploy_key_revoked';
        if (!locked || lockedRefusal) {
          const reason = lockedRefusal ?? 'deploy_key_revoked';
          throw new DeployKeyEnrollRefusal(401, { error: KEY_REFUSAL_MESSAGE[reason], reason }, reason, keyRef, null);
        }

        const inTx = await readDeployKeyEligibility(tx, partnerId);
        if (!inTx.eligible) {
          throw new DeployKeyEnrollRefusal(
            403,
            { error: 'Deploy-key enrollment is not available', reason: 'deploy_key_enrollment_unavailable' },
            'deploy_key_enrollment_unavailable',
            { ...keyRef, detail: inTx.reason },
          );
        }

        // Per-key parked cap. An in-place re-enrollment adds no parked device,
        // but moves the device's attribution to this key, so it counts unless
        // the device is already this key's.
        await admitDeployKeyParkedCapacity(tx, {
          holdingOrgId: pool.orgId,
          deployKeyId: locked.id,
          maxParked: locked.maxParked,
          ...(inPlace ? { excludeDeviceId: inPlace.id } : {}),
        });

        await lockPartnerExportOrg(tx, pool.orgId);

        let dev;
        if (inPlace) {
          // Still parked in this holding org (an assignment or expiry would
          // have needed the holding-area lock we now hold) and still the
          // install whose token matched.
          // own-device-row-allowlisted: deploy-key-reenroll-matched-parked-row
          [dev] = await tx
            .update(devices)
            .set(reenrollDeviceSet({ data, credentials, enrollmentIp }))
            .where(and(
              eq(devices.id, inPlace.id),
              eq(devices.agentId, inPlace.agentId),
              eq(devices.orgId, pool.orgId),
              ne(devices.status, 'decommissioned'),
            ))
            .returning();
          if (!dev) {
            throw new DeployKeyEnrollRefusal(
              409,
              { error: 'The device row changed during re-enrollment; retry the enrollment', code: 'reenrollment_conflict' },
              'reenrollment_conflict',
              { ...keyRef, priorDeviceId: inPlace.id },
            );
          }
        } else {
          [dev] = await tx
            .insert(devices)
            .values({
              ...freshDeviceValues({ data, credentials, enrollmentIp, orgId: pool.orgId, siteId: pool.siteId }),
              isEphemeral: false,
              tags: [],
            })
            .returning();
        }
        if (!dev) throw new Error('Failed to create device');

        await writeEnrollmentInventory(tx, dev, data, { freshRow: !inPlace });

        const claimed = await tx
          .update(partnerDeployKeys)
          .set({
            usageCount: sql`${partnerDeployKeys.usageCount} + 1`,
            lastUsedAt: sql`now()`,
            lastUsedIp: enrollmentIp,
          })
          .where(and(
            eq(partnerDeployKeys.id, locked.id),
            eq(partnerDeployKeys.status, 'active'),
            sql`${partnerDeployKeys.expiresAt} > now()`,
            sql`${partnerDeployKeys.usageCount} < ${partnerDeployKeys.maxUsage}`,
          ))
          .returning({ id: partnerDeployKeys.id });
        if (claimed.length === 0) {
          throw new DeployKeyEnrollRefusal(401, { error: KEY_REFUSAL_MESSAGE.deploy_key_exhausted, reason: 'deploy_key_exhausted' }, 'deploy_key_exhausted', keyRef, null);
        }

        const [ledger] = await tx
          .insert(devicePoolAssignmentEvents)
          .values({
            partnerId,
            deviceId: dev.id,
            deviceAgentId: credentials.agentId,
            eventType: 'enrolled',
            toOrgId: pool.orgId,
            deployKeyId: locked.id,
            deployKeyName: locked.name,
            parkedAt: dev.createdAt,
          })
          .returning({ id: devicePoolAssignmentEvents.id });
        if (!ledger) throw new Error('enrolled ledger row was not written');

        return { device: dev, ledgerEventId: ledger.id };
      }));
    } catch (err) {
      if (err instanceof DeployKeyEnrollRefusal) {
        deny({ orgId: pool.orgId, reason: err.auditReason, message: String(err.body.error), details: err.auditDetails });
        if (err.metric) recordAgentEnrollment(err.metric, partnerId);
        return c.json(err.body, err.status);
      }
      if (err instanceof ParkedCapReachedError) {
        deny({ orgId: pool.orgId, reason: 'parked_cap_reached', message: err.message, details: { ...keyRef, parkedCount: err.parkedCount } });
        recordAgentEnrollment('error', partnerId);
        return c.json({ error: 'The holding area is full; assign or remove waiting devices first', reason: 'parked_cap_reached' }, 409);
      }
      if (err instanceof DeployKeyParkedCapReachedError) {
        deny({ orgId: pool.orgId, reason: 'deploy_key_parked_cap_reached', message: err.message, details: { ...keyRef, parkedCount: err.parkedCount, maxParked: err.maxParked } });
        recordAgentEnrollment('error', partnerId);
        return c.json({ error: 'This deploy key already has its maximum of devices waiting for assignment', reason: 'deploy_key_parked_cap_reached' }, 409);
      }
      if (isTransientLockError(err)) {
        const sqlState = pgErrorCode(err) ?? 'unknown';
        captureException(
          err,
          c,
          { route: 'agent_enroll', reason: 'enrollment_contended', org_id: pool.orgId },
          { fingerprint: ['agent-enroll', 'enrollment_contended', sqlState] },
        );
        deny({ orgId: pool.orgId, reason: 'enrollment_contended', message: 'Enrollment lost every lock race; the agent was told to retry', details: { ...keyRef, sqlState }, result: 'failure' });
        recordAgentEnrollment('error', partnerId);
        c.header('Retry-After', String(ENROLLMENT_CONTENDED_RETRY_AFTER_SECONDS));
        return c.json({ error: 'Enrollment is busy on the server; retry shortly', reason: 'enrollment_contended' }, 503);
      }
      throw err;
    }

    // Spec §10.4 / §13 decision 9: a pool-enrolled certificate lives no
    // longer than the device's parking window (measured from created_at,
    // which an in-place re-enrollment keeps). Parked renewal is refused
    // (routes/agents/mtls.ts), and assignment asks for the real one.
    const parkedAt = written.device.createdAt;
    const mtls = await issueMtlsCertForDevice(written.device.id, pool.orgId, {
      lifetimeDays: (policyDays) => parkedCertificateLifetimeDays({ policyDays, parkedAt }),
    });

    return {
      device: written.device,
      inPlace: Boolean(inPlace),
      replacedAgentId: inPlace?.agentId,
      replacedCredentialHashes: inPlace ? collectAgentCredentialHashes(inPlace) : undefined,
      mtls,
      collidingDeviceIds: colliders.map((candidate) => candidate.id),
      ledgerEventId: written.ledgerEventId,
    };
  }));

  if (outcome instanceof Response) return outcome;

  // After commit: sever the replaced install's sockets (in-place only).
  if (outcome.replacedAgentId) {
    disconnectAgentCredentialGeneration(
      outcome.replacedAgentId,
      outcome.replacedCredentialHashes ?? [],
      'Agent credentials replaced by re-enrollment',
    );
    if (outcome.replacedCredentialHashes?.length) {
      void publishAgentCredentialRevocation({
        agentId: outcome.replacedAgentId,
        revokedTokenHashes: outcome.replacedCredentialHashes,
      });
    }
  }

  try {
    void invalidateOrgDeviceCount(getRedis(), pool.orgId);
  } catch (err) {
    console.error('[enrollment] device-count cache invalidation failed', err);
  }

  recordAgentEnrollment('success', partnerId);
  writeAuditEvent(c, {
    orgId: pool.orgId,
    actorType: 'agent',
    actorId: credentials.agentId,
    action: 'agent.enroll',
    resourceType: 'device',
    resourceId: outcome.device.id,
    resourceName: data.hostname,
    details: {
      siteId: pool.siteId,
      parked: true,
      partnerId,
      deployKeyId: key.id,
      deployKeyName: key.name,
      ledgerEventId: outcome.ledgerEventId,
      reenrollment: outcome.inPlace,
      mtlsCertIssued: outcome.mtls !== null,
      ...(outcome.collidingDeviceIds.length > 0 && !outcome.inPlace
        ? { reason: 'hostname_collision_enrolled_fresh_row', collidingDeviceIds: outcome.collidingDeviceIds }
        : {}),
    },
  });

  if (enrollmentIp && partnerTrustMode() !== 'off') {
    void enqueueIpClassify({ kind: 'device', deviceId: outcome.device.id, ip: enrollmentIp }).catch((err) => {
      console.warn('[Enrollment] Failed to queue IP classification:', err instanceof Error ? err.message : err);
    });
  }

  return c.json(buildEnrollmentResponseBody(
    {
      agentId: credentials.agentId,
      deviceId: outcome.device.id,
      authToken: credentials.apiKey,
      watchdogAuthToken: credentials.watchdogApiKey,
      helperAuthToken: credentials.helperApiKey,
      orgId: pool.orgId,
      siteId: outcome.device.siteId,
      backupServerUrl: undefined,
      config: { heartbeatIntervalSeconds: 60, metricsCollectionIntervalSeconds: 30 },
      mtls: outcome.mtls,
      manifestTrustKeys: [],
      manifestKeyDelegations: [],
    },
    { preAssignment: true },
  ), 201);
}
