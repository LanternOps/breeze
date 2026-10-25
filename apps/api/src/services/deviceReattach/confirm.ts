/**
 * Phase 2 of the bounded rebind — `POST /agents/:id/rebind-confirm` (#8318
 * spec §6.4, §6.5).
 *
 * Authenticated by the confirm-only token (never an agent credential): the
 * route's `:id` names the SOURCE agent, the token's SHA-256 is compared in
 * constant time with the `confirmation_token_hash` of that agent's intents,
 * or — once the intent is pruned — of its ledger rows.
 *
 * Answers before any lock:
 *  - a confirmed intent, or a ledger row → 200 with the stored identity
 *    `{ deviceId, orgId, siteId, agentId }` (no secrets), with no time limit;
 *  - an expired or cancelled intent → 409 with the state and cancel_reason;
 *    a requested one → 409 `not_staged`.
 *
 * Locks (§6.4, F13): the intent was read unlocked for its ids; then the
 * partner's holding-area advisory lock, both device rows FOR UPDATE in
 * ascending order, the intent FOR UPDATE (re-read; it must name the same
 * devices), and the `partners` row LAST, through admitPartnerDeviceCapacity,
 * only when a decommissioned target is restored.
 *
 * Revalidation (any failure → 409 with its code and the intent CANCELLED with
 * that reason, committed): staged and unexpired; ./revalidation.ts (partner,
 * requester, versions, health); the staged certificate is still pending on
 * the target; then target liveness (./liveness.ts: `target_alive`,
 * `liveness_unknown`, fail closed).
 *
 * Effects, in ONE transaction, in this order:
 *  1. the install-incarnation boundary FIRST (services/deviceInstallBoundary:
 *     incarnation n → n+1, incarnation_started_at, last_reattached_at, the
 *     capability reset and every §5 handler; its counts go to the ledger);
 *  2. the target's identity: agent_id = staged_agent_id, the staged hashes
 *     current (agent, watchdog, helper), every previous/pending hash cleared,
 *     status `pending` (the first heartbeat makes it online), restored when it
 *     was decommissioned;
 *  3. certificates: the target's active one → pending_revocation, the staged
 *     one → active, the legacy `mtls_cert_*` columns follow;
 *  4. the source: decommissioned in place (queueUninstall false — the machine
 *     that would run the uninstall IS the new target), every token hash of it
 *     cleared, its certificate demoted with a 24 h grace, and — if it was
 *     parked — a `reattached` row in device_pool_assignment_events;
 *  5. the device_reattachments ledger row;
 *  6. the intent → confirmed.
 * After commit: revocation broadcast and socket close for EVERY hash of both
 * rows, the source's socket closed (4040, reconnect), the target's demoted
 * certificate revoked at the provider, audit `device.reinstall.reattached` in
 * both orgs with the requester as actor, the `device.reinstalled` event.
 *
 * The source certificate's 24 h path: confirm marks it pending_revocation with
 * `next_revoke_attempt_at = now + 24 h`; the existing five-minute revocation
 * sweep revokes it then. Pulling it forward on the first authentication with
 * the target's certificate is not implemented (it would add a ledger read to
 * every certificate-bound agent authentication).
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  deviceMtlsCertificates,
  devicePoolAssignmentEvents,
  deviceReattachIntents,
  deviceReattachments,
  devices,
  type DeviceReattachIntent,
  type DeviceReattachment,
} from '../../db/schema';
import { disconnectAgent, disconnectAgentCredentialGeneration, publishAgentCredentialRevocation } from '../../routes/agentWs';
import { collectAgentCredentialHashes } from '../agentCredentialHashes';
import {
  enforceRebindConfirmCertificateBinding,
  type AgentCertificateAssertion,
} from '../agentCertificateBinding';
import { invalidateOrgDeviceCount } from '../agentOrgRateLimit';
import { decommissionDeviceInTransaction } from '../deviceDecommission';
import { queueCertificateRevocationCore } from '../deviceMtlsCertificateLifecycle';
import { runInstallIncarnationBoundary, type InstallBoundaryResult } from '../deviceInstallBoundary';
import { publishEvent } from '../eventBus';
import { admitPartnerDeviceCapacity, previewPartnerDeviceCapacity } from '../partnerDeviceCapacity';
import { getRedis } from '../redis';
import { captureException } from '../sentry';
import { lockPartnerHoldingArea } from '../unassignedPool/holdingAreaLock';
import { writeReattachAudit } from './audit';
import { confirmationHashMatches, hashConfirmationToken } from './confirmationToken';
import { intentStateRefusal, reattachRefusal, ReattachRefusedError, type ReattachRefusal } from './errors';
import {
  endIntentInTransaction,
  lockReattachDevices,
  readIntentForUpdate,
  revokeCertificatesAfterCommit,
  type EndedIntent,
  type LockedReattachDevice,
  type ReattachTx,
} from './intentStore';
import { readTargetLiveness } from './liveness';
import { REATTACH_SOURCE_CERT_GRACE_MS, type ReattachCancelReason } from './protocol';
import { revalidateLockedIntent } from './revalidation';

export interface ConfirmedIdentity {
  deviceId: string;
  orgId: string;
  siteId: string;
  agentId: string;
}

export type ConfirmRebindResult =
  | { ok: true; identity: ConfirmedIdentity; replay: boolean; intentId: string }
  | ReattachRefusal;

export interface ConfirmRebindInput {
  /** The route's `:id`: the source agent id. */
  sourceAgentId: string;
  /** The bearer `brz_rbc_…` token, already shape-checked by the route. */
  token: string;
  /** The edge's client-certificate assertion (mTLS binding). */
  assertion: AgentCertificateAssertion;
  /** Test seams. */
  now?: Date;
  hooks?: { afterLocks?: (intentId: string) => Promise<void> };
}

const INVALID_CREDENTIALS = (): ReattachRefusal =>
  reattachRefusal(401, 'invalid_confirmation', 'Invalid confirmation credentials');

function identityFromLedger(row: Pick<DeviceReattachment, 'targetDeviceId' | 'targetOrgId' | 'targetSiteId' | 'stagedAgentId'>): ConfirmedIdentity {
  return { deviceId: row.targetDeviceId, orgId: row.targetOrgId, siteId: row.targetSiteId, agentId: row.stagedAgentId };
}

type Located =
  | { kind: 'intent'; intent: DeviceReattachIntent }
  | { kind: 'ledger'; ledger: DeviceReattachment };

/** Find the caller's intent (or ledger row) whose confirmation hash matches, in constant time per row. */
async function locateByToken(sourceAgentId: string, presentedHash: string): Promise<Located | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const intents = await db
      .select()
      .from(deviceReattachIntents)
      .where(and(
        eq(deviceReattachIntents.sourceAgentId, sourceAgentId),
        isNotNull(deviceReattachIntents.confirmationTokenHash),
      ));
    let match: DeviceReattachIntent | null = null;
    for (const intent of intents) {
      if (confirmationHashMatches(presentedHash, intent.confirmationTokenHash) && !match) match = intent;
    }
    if (match) return { kind: 'intent', intent: match } as const;

    const ledgerRows = await db
      .select()
      .from(deviceReattachments)
      .where(eq(deviceReattachments.sourceAgentId, sourceAgentId));
    let ledger: DeviceReattachment | null = null;
    for (const row of ledgerRows) {
      if (confirmationHashMatches(presentedHash, row.confirmationTokenHash) && !ledger) ledger = row;
    }
    return ledger ? ({ kind: 'ledger', ledger } as const) : null;
  }));
}

async function readLedgerForIntent(intentId: string): Promise<DeviceReattachment | null> {
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select()
    .from(deviceReattachments)
    .where(eq(deviceReattachments.intentId, intentId))
    .limit(1)));
  return row ?? null;
}

interface CommittedConfirm {
  kind: 'confirmed';
  intent: DeviceReattachIntent;
  identity: ConfirmedIdentity;
  ledgerId: string;
  source: LockedReattachDevice;
  target: LockedReattachDevice;
  boundary: InstallBoundaryResult;
  revokeCertificateIds: string[];
}

type ConfirmOutcome =
  | CommittedConfirm
  | { kind: 'replay'; identity: ConfirmedIdentity; intentId: string }
  | { kind: 'refused'; refusal: ReattachRefusal; ended?: EndedIntent; intent?: DeviceReattachIntent };

function cancelledRefusal(reason: ReattachCancelReason): ReattachRefusal {
  return reattachRefusal(409, reason, `The reattach was refused and its intent cancelled (${reason})`, {
    state: 'cancelled',
    cancelReason: reason,
  });
}

/** Clears every credential hash of a row (agent, watchdog, helper × current, previous, pending). */
const CLEARED_CREDENTIALS = {
  agentTokenHash: null,
  previousTokenHash: null,
  previousTokenExpiresAt: null,
  watchdogTokenHash: null,
  previousWatchdogTokenHash: null,
  previousWatchdogTokenExpiresAt: null,
  helperTokenHash: null,
  previousHelperTokenHash: null,
  previousHelperTokenExpiresAt: null,
  pendingTokenHash: null,
  pendingWatchdogTokenHash: null,
  pendingHelperTokenHash: null,
  pendingTokenExpiresAt: null,
} as const satisfies Partial<typeof devices.$inferInsert>;

async function confirmUnderLocks(
  tx: ReattachTx,
  located: DeviceReattachIntent,
  input: ConfirmRebindInput,
  now: Date,
): Promise<ConfirmOutcome> {
  await lockPartnerHoldingArea(tx, located.partnerId);
  const locked = await lockReattachDevices(tx, [located.sourceDeviceId, located.targetDeviceId], 'update');
  const intent = await readIntentForUpdate(tx, located.id);
  if (
    !intent
    || intent.sourceDeviceId !== located.sourceDeviceId
    || intent.targetDeviceId !== located.targetDeviceId
    || intent.sourceAgentId !== input.sourceAgentId
  ) {
    return { kind: 'refused', refusal: INVALID_CREDENTIALS() };
  }
  await input.hooks?.afterLocks?.(intent.id);

  if (intent.state === 'confirmed') {
    // A racing confirm committed first: this one answers its replay.
    const [ledger] = await tx
      .select()
      .from(deviceReattachments)
      .where(eq(deviceReattachments.intentId, intent.id))
      .limit(1);
    if (!ledger) throw new Error(`confirmed reattach intent ${intent.id} has no ledger row`);
    return { kind: 'replay', identity: identityFromLedger(ledger), intentId: intent.id };
  }
  if (intent.state !== 'staged') {
    return { kind: 'refused', refusal: intentStateRefusal(intent.state, intent.cancelReason) };
  }
  if (intent.expiresAt.getTime() <= now.getTime()) {
    const ended = await endIntentInTransaction(tx, intent, { state: 'expired' }, now);
    return { kind: 'refused', refusal: intentStateRefusal('expired', null), ended: ended ?? undefined, intent };
  }

  const cancel = async (reason: ReattachCancelReason): Promise<ConfirmOutcome> => {
    const ended = await endIntentInTransaction(tx, intent, { state: 'cancelled', reason }, now);
    return { kind: 'refused', refusal: cancelledRefusal(reason), ended: ended ?? undefined, intent };
  };

  const source = locked.get(intent.sourceDeviceId);
  const target = locked.get(intent.targetDeviceId);
  if (!source || !target) return { kind: 'refused', refusal: INVALID_CREDENTIALS() };

  const failure = await revalidateLockedIntent(tx, intent, source, target);
  if (failure) return cancel(failure);

  // The staged certificate must still be the target's pending one (a renewal
  // by the old install, or the sweep, would have moved it on).
  let stagedCertificate: typeof deviceMtlsCertificates.$inferSelect | null = null;
  if (intent.stagedMtlsCertificateId) {
    const [row] = await tx
      .select()
      .from(deviceMtlsCertificates)
      .where(eq(deviceMtlsCertificates.id, intent.stagedMtlsCertificateId))
      .limit(1)
      .for('update');
    if (!row || row.state !== 'pending_activation' || row.deviceId !== target.id || row.orgId !== target.orgId) {
      return cancel('target_changed');
    }
    stagedCertificate = row;
  }

  // §6.5: read under the device row lock. Fail closed without Redis.
  const liveness = await readTargetLiveness(target, intent.requestedAt, now);
  if (liveness.state === 'unknown') return cancel('liveness_unknown');
  if (liveness.state === 'alive') return cancel('target_alive');

  const restoring = target.status === 'decommissioned' && intent.restoreDecommissioned;
  if (restoring) {
    // Advisory and unlocked: refuse before the boundary runs. The locked
    // admission comes last, below.
    const preview = await previewPartnerDeviceCapacity(tx, { orgId: target.orgId, expectedPartnerId: intent.partnerId });
    if (!preview.allowed) return cancel('device_limit_reached');
  }

  // ── Effects ───────────────────────────────────────────────────────────
  // (1) The boundary FIRST: it advances the incarnation and invalidates the
  // old install's work, grants and state (§5), on the same transaction.
  const boundary = await runInstallIncarnationBoundary({
    deviceId: target.id,
    expectedIncarnation: intent.targetIncarnation,
    actorUserId: intent.requestedBy,
    at: now,
  });

  // (3, ordered before 2 for the legacy columns) Certificates of the target.
  const revokeCertificateIds: string[] = [];
  const [previousActive] = await tx
    .select({ id: deviceMtlsCertificates.id })
    .from(deviceMtlsCertificates)
    .where(and(eq(deviceMtlsCertificates.deviceId, target.id), eq(deviceMtlsCertificates.state, 'active')))
    .limit(1);
  if (stagedCertificate) {
    // Demote before promote: one active row per device.
    if (previousActive && (await queueCertificateRevocationCore(tx, previousActive.id))) {
      revokeCertificateIds.push(previousActive.id);
    }
    const activated = await tx
      .update(deviceMtlsCertificates)
      .set({ state: 'active', activatedAt: now, updatedAt: now })
      .where(and(eq(deviceMtlsCertificates.id, stagedCertificate.id), eq(deviceMtlsCertificates.state, 'pending_activation')))
      .returning({ id: deviceMtlsCertificates.id });
    if (activated.length !== 1) throw new Error('staged certificate was not activated');
  } else if (previousActive) {
    // No staged certificate (mTLS was not configured at phase 1): the old
    // install's certificate must not outlive its credentials.
    await tx
      .update(deviceMtlsCertificates)
      .set({ state: 'pending_revocation', nextRevokeAttemptAt: now, updatedAt: now })
      .where(and(eq(deviceMtlsCertificates.id, previousActive.id), eq(deviceMtlsCertificates.state, 'active')));
    revokeCertificateIds.push(previousActive.id);
  }

  // (2) The target's identity. The row is locked and version-checked above;
  // the agent_id predicate is belt and braces.
  const [reattached] = await tx
    // own-device-row-allowlisted: reattach-confirm-target-identity
    .update(devices)
    .set({
      ...CLEARED_CREDENTIALS,
      agentId: intent.stagedAgentId!,
      agentTokenHash: intent.stagedTokenHash!,
      watchdogTokenHash: intent.stagedWatchdogTokenHash!,
      helperTokenHash: intent.stagedHelperTokenHash!,
      tokenIssuedAt: now,
      watchdogTokenIssuedAt: now,
      helperTokenIssuedAt: now,
      // The new install's declared capability (it enrolled as the source).
      rebindProtocolVersion: source.rebindProtocolVersion,
      status: 'pending',
      ...(restoring ? { decommissionedAt: null } : {}),
      mtlsCertSerialNumber: stagedCertificate?.serialNumber ?? null,
      mtlsCertExpiresAt: stagedCertificate?.expiresAt ?? null,
      mtlsCertIssuedAt: stagedCertificate?.issuedAt ?? null,
      mtlsCertCfId: stagedCertificate?.providerCertificateId ?? null,
      updatedAt: now,
    })
    .where(and(eq(devices.id, target.id), eq(devices.agentId, intent.targetAgentId)))
    .returning({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId, agentId: devices.agentId });
  if (!reattached) throw new Error(`reattach target ${target.id} identity was not written`);

  // (4) The source: retired in place.
  await decommissionDeviceInTransaction(tx, {
    deviceId: source.id,
    queueUninstall: false,
    actorUserId: intent.requestedBy,
  });
  const sourceCleared = await tx
    // own-device-row-allowlisted: reattach-confirm-source-credentials
    .update(devices)
    .set({ ...CLEARED_CREDENTIALS, updatedAt: now })
    .where(and(eq(devices.id, source.id), eq(devices.agentId, intent.sourceAgentId)))
    .returning({ id: devices.id });
  if (sourceCleared.length !== 1) throw new Error(`reattach source ${source.id} credentials were not cleared`);
  await tx
    .update(deviceMtlsCertificates)
    .set({
      state: 'pending_revocation',
      nextRevokeAttemptAt: new Date(now.getTime() + REATTACH_SOURCE_CERT_GRACE_MS),
      updatedAt: now,
    })
    .where(and(eq(deviceMtlsCertificates.deviceId, source.id), eq(deviceMtlsCertificates.state, 'active')));
  if (intent.sourceParked) {
    await tx.insert(devicePoolAssignmentEvents).values({
      partnerId: intent.partnerId,
      deviceId: source.id,
      deviceAgentId: source.agentId,
      eventType: 'reattached',
      fromOrgId: source.orgId,
      toOrgId: target.orgId,
      assignedByUserId: intent.requestedBy!,
      stepUpGrantRef: intent.stepUpGrantRef,
      parkedAt: source.createdAt,
      parkedDurationSeconds: Math.max(0, Math.floor((now.getTime() - source.createdAt.getTime()) / 1000)),
    });
  }

  // (5) The ledger.
  const [ledger] = await tx
    .insert(deviceReattachments)
    .values({
      partnerId: intent.partnerId,
      intentId: intent.id,
      sourceDeviceId: source.id,
      sourceAgentId: intent.sourceAgentId,
      sourceOrgId: source.orgId,
      sourceParked: intent.sourceParked,
      targetDeviceId: target.id,
      targetOrgId: reattached.orgId,
      targetSiteId: reattached.siteId,
      targetPreviousAgentId: intent.targetAgentId,
      stagedAgentId: reattached.agentId,
      targetPreviousIncarnation: boundary.previousIncarnation,
      targetNewIncarnation: boundary.newIncarnation,
      actorUserId: intent.requestedBy!,
      evidenceLevel: intent.evidenceLevel,
      restoreDecommissioned: intent.restoreDecommissioned,
      stepUpGrantRef: intent.stepUpGrantRef,
      invalidationCounts: boundary.counts,
      confirmationTokenHash: intent.confirmationTokenHash!,
      confirmedAt: now,
    })
    .returning({ id: deviceReattachments.id });
  if (!ledger) throw new Error('reattach ledger row was not written');

  // (6) The intent.
  const [confirmed] = await tx
    .update(deviceReattachIntents)
    .set({
      state: 'confirmed',
      confirmedAt: now,
      stagedTokenHash: null,
      stagedWatchdogTokenHash: null,
      stagedHelperTokenHash: null,
    })
    .where(and(eq(deviceReattachIntents.id, intent.id), eq(deviceReattachIntents.state, 'staged')))
    .returning();
  if (!confirmed) throw new Error('reattach intent was not confirmed');

  // The partners row, last: a restored target re-takes a licensed slot.
  if (restoring) {
    const admission = await admitPartnerDeviceCapacity(tx, {
      orgId: target.orgId,
      expectedPartnerId: intent.partnerId,
      excludeDeviceId: target.id,
    });
    if (!admission.allowed) {
      // Rolled back; the intent stays staged and the agent may retry.
      throw new ReattachRefusedError(reattachRefusal(409, 'device_limit_reached', 'The partner device limit is reached'));
    }
  }

  return {
    kind: 'confirmed',
    intent: confirmed,
    identity: { deviceId: reattached.id, orgId: reattached.orgId, siteId: reattached.siteId, agentId: reattached.agentId },
    ledgerId: ledger.id,
    source,
    target,
    boundary,
    revokeCertificateIds,
  };
}

function report(label: string, err: unknown): void {
  console.error(`[deviceReattach] post-commit ${label} failed:`, err);
  captureException(err);
}

async function afterConfirmCommit(committed: CommittedConfirm): Promise<void> {
  const { intent, source, target, identity } = committed;

  // Every hash of both rows: the target's old install and the source.
  const revocations = [
    { agentId: intent.targetAgentId, hashes: collectAgentCredentialHashes(target) },
    { agentId: intent.sourceAgentId, hashes: collectAgentCredentialHashes(source) },
  ];
  for (const { agentId, hashes } of revocations) {
    if (hashes.length === 0) continue;
    try {
      disconnectAgentCredentialGeneration(agentId, hashes, 'Agent credentials replaced by reattach');
    } catch (err) {
      report('local credential disconnect', err);
    }
    void publishAgentCredentialRevocation({ agentId, revokedTokenHashes: hashes }).catch((err) => report('revocation broadcast', err));
  }
  try {
    // The source install is becoming the target: reconnect, do not back off.
    disconnectAgent(intent.sourceAgentId, 4040, 'Device reattached, reconnect required');
  } catch (err) {
    report('source disconnect', err);
  }

  await revokeCertificatesAfterCommit(committed.revokeCertificateIds);

  await writeReattachAudit({
    action: 'device.reinstall.reattached',
    actorUserId: intent.requestedBy,
    targetOrgId: identity.orgId,
    sourceOrgId: source.orgId,
    targetDeviceId: identity.deviceId,
    targetHostname: target.hostname,
    details: {
      intentId: intent.id,
      ledgerId: committed.ledgerId,
      sourceDeviceId: source.id,
      sourceHostname: source.hostname,
      sourceParked: intent.sourceParked,
      evidenceLevel: intent.evidenceLevel,
      restoreDecommissioned: intent.restoreDecommissioned,
      previousIncarnation: committed.boundary.previousIncarnation,
      newIncarnation: committed.boundary.newIncarnation,
      invalidated: committed.boundary.counts,
    },
  });

  try {
    await publishEvent(
      'device.reinstalled',
      identity.orgId,
      {
        deviceId: identity.deviceId,
        sourceDeviceId: source.id,
        orgId: identity.orgId,
        sourceOrgId: source.orgId,
        siteId: identity.siteId,
        installIncarnation: committed.boundary.newIncarnation,
        previousIncarnation: committed.boundary.previousIncarnation,
        evidenceLevel: intent.evidenceLevel,
        actorUserId: intent.requestedBy,
        reattachmentId: committed.ledgerId,
      },
      'device-reattach',
      { siteId: identity.siteId, eventId: committed.ledgerId, userId: intent.requestedBy ?? undefined },
    );
  } catch (err) {
    report('device.reinstalled event', err);
  }

  const redis = getRedis();
  for (const orgId of new Set([identity.orgId, source.orgId])) {
    invalidateOrgDeviceCount(redis, orgId).catch((err: unknown) => report('device-count cache invalidation', err));
  }
}

export async function confirmRebindIntent(input: ConfirmRebindInput): Promise<ConfirmRebindResult> {
  const now = input.now ?? new Date();
  const presentedHash = hashConfirmationToken(input.token);
  const located = await locateByToken(input.sourceAgentId, presentedHash);
  if (!located) return INVALID_CREDENTIALS();

  const binding = await enforceRebindConfirmCertificateBinding({
    sourceDeviceId: located.kind === 'intent' ? located.intent.sourceDeviceId : located.ledger.sourceDeviceId,
    targetDeviceId: located.kind === 'intent' ? located.intent.targetDeviceId : located.ledger.targetDeviceId,
    stagedCertificateId: located.kind === 'intent' ? located.intent.stagedMtlsCertificateId : null,
    acceptTargetActive: located.kind === 'ledger' || located.intent.state === 'confirmed',
    assertion: input.assertion,
  });
  if (!binding.allowed) {
    console.warn('[deviceReattach] rebind-confirm refused by the certificate binding', { reason: binding.reason });
    return reattachRefusal(403, 'certificate_binding_failed', 'Client certificate does not match this reattach');
  }

  // Answers before any lock.
  if (located.kind === 'ledger') {
    return { ok: true, identity: identityFromLedger(located.ledger), replay: true, intentId: located.ledger.intentId };
  }
  const intent = located.intent;
  if (intent.state === 'confirmed') {
    const ledger = await readLedgerForIntent(intent.id);
    if (!ledger) throw new Error(`confirmed reattach intent ${intent.id} has no ledger row`);
    return { ok: true, identity: identityFromLedger(ledger), replay: true, intentId: intent.id };
  }
  if (intent.state !== 'staged') return intentStateRefusal(intent.state, intent.cancelReason);

  let outcome: ConfirmOutcome;
  try {
    outcome = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.transaction((tx) => confirmUnderLocks(tx, intent, input, now))));
  } catch (err) {
    if (err instanceof ReattachRefusedError) return err.refusal;
    throw err;
  }

  if (outcome.kind === 'replay') {
    return { ok: true, identity: outcome.identity, replay: true, intentId: outcome.intentId };
  }
  if (outcome.kind === 'refused') {
    if (outcome.ended && outcome.intent) {
      await revokeCertificatesAfterCommit(outcome.ended.revokeCertificateIds);
      await writeReattachAudit({
        action: outcome.ended.state === 'expired' ? 'device.reinstall.expired' : 'device.reinstall.cancelled',
        actorUserId: null,
        actorAgentId: input.sourceAgentId,
        targetOrgId: outcome.intent.targetOrgId,
        sourceOrgId: outcome.intent.sourceOrgId,
        targetDeviceId: outcome.intent.targetDeviceId,
        result: 'denied',
        initiatedBy: 'agent',
        details: {
          intentId: outcome.intent.id,
          sourceDeviceId: outcome.intent.sourceDeviceId,
          phase: 'rebind-confirm',
          ...(outcome.ended.cancelReason ? { cancelReason: outcome.ended.cancelReason } : {}),
        },
      });
    }
    return outcome.refusal;
  }

  await afterConfirmCommit(outcome);
  return { ok: true, identity: outcome.identity, replay: false, intentId: outcome.intent.id };
}
