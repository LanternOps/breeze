/**
 * Phase 1 of the bounded rebind — `POST /agents/:id/rebind` (#8318 spec §6.3).
 *
 * The SOURCE agent (its own credentials, main role) sends the hashes of the
 * staged set it generated and persisted: agent, watchdog and helper tokens and
 * the confirm-only token (`brz_rbc_…`). Only hashes travel; nothing is
 * written to the target's credential columns, so agent auth can never match
 * the staged set (it is not in `devices.pending_*`, F2).
 *
 * The provider call for the target's next certificate is made before the
 * transaction (never inside one, #1105), after a cheap unlocked read decided
 * that one is needed. Then ONE system transaction: both device rows
 * FOR KEY SHARE (ascending), the intent FOR UPDATE, re-decided under the
 * locks:
 *  - `requested` → revalidate (§6.4 minus liveness), assign `staged_agent_id`
 *    (32 random bytes, hex, like enrollment), store the hashes, insert the
 *    target's pending certificate with `activation_expires_at` = the new
 *    expiry, `staged_at = now`, `expires_at = now + 15 min`, state `staged`;
 *  - `staged` with the SAME four hashes → a lost-response retry: the same
 *    `staged_agent_id`, a fresh pending certificate (the previous one is
 *    demoted and revoked after commit, since the provider's private key is
 *    never stored), nothing else changes;
 *  - `staged` with DIFFERENT hashes → `409 restage_refused`: the intent is
 *    cancelled, its staged hashes discarded (the confirmation hash stays) and
 *    its pending certificate revoked. Audited: the source's credentials may
 *    have been copied (§3);
 *  - `confirmed` / `expired` / `cancelled` → 409 with the state. Nothing
 *    reopens staging.
 * A revalidation failure cancels the intent with its reason (409).
 */
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceReattachIntents, type DeviceReattachIntent } from '../../db/schema';
import { collectAgentCredentialHashes } from '../agentCredentialHashes';
import { writeReattachAudit } from './audit';
import { intentStateRefusal, reattachRefusal, ReattachRefusedError, type ReattachRefusal } from './errors';
import {
  demoteStagedCertificate,
  endIntentInTransaction,
  lockReattachDevices,
  readIntentForUpdate,
  revokeCertificatesAfterCommit,
  type EndedIntent,
} from './intentStore';
import { REATTACH_STAGED_TTL_MS, SHA256_HEX } from './protocol';
import { revalidateLockedIntent } from './revalidation';
import {
  insertStagedCertificateRow,
  issueStagedCertificate,
  revokeOrphanStagedCertificate,
  type IssuedStagedCertificate,
} from './stagedCertificate';

export interface StagedSetHashes {
  stagedTokenHash: string;
  stagedWatchdogTokenHash: string;
  stagedHelperTokenHash: string;
  confirmationTokenHash: string;
}

export interface StageRebindInput extends StagedSetHashes {
  /** The authenticated source: the device and install the request authenticated as. */
  caller: { deviceId: string; agentId: string };
  intentId: string;
  /** Test seam. */
  now?: Date;
}

export interface StagedCertificateMaterial {
  certificate: string;
  privateKey: string;
  expiresAt: string;
  serialNumber: string;
}

export type StageRebindResult =
  | {
      ok: true;
      outcome: 'staged' | 'retry';
      intentId: string;
      stagedAgentId: string;
      target: { deviceId: string; orgId: string; siteId: string };
      /** Null when mTLS is not configured. */
      certificate: StagedCertificateMaterial | null;
      expiresAt: Date;
    }
  | ReattachRefusal;

function sameStagedSet(intent: DeviceReattachIntent, hashes: StagedSetHashes): boolean {
  return intent.stagedTokenHash === hashes.stagedTokenHash
    && intent.stagedWatchdogTokenHash === hashes.stagedWatchdogTokenHash
    && intent.stagedHelperTokenHash === hashes.stagedHelperTokenHash
    && intent.confirmationTokenHash === hashes.confirmationTokenHash;
}

function belongsToCaller(intent: DeviceReattachIntent | null, caller: StageRebindInput['caller']): intent is DeviceReattachIntent {
  return Boolean(intent && intent.sourceDeviceId === caller.deviceId && intent.sourceAgentId === caller.agentId);
}

const INTENT_NOT_FOUND = (): ReattachRefusal => reattachRefusal(404, 'intent_not_found', 'No such reattach intent for this device');

type Committed =
  | { kind: 'refused'; refusal: ReattachRefusal; ended?: EndedIntent; intent?: DeviceReattachIntent }
  | {
      kind: 'staged' | 'retry';
      intent: DeviceReattachIntent;
      stagedAgentId: string;
      target: { deviceId: string; orgId: string; siteId: string; hostname: string };
      certificateUsed: boolean;
      revokeCertificateIds: string[];
      expiresAt: Date;
    };

export async function stageRebindIntent(input: StageRebindInput): Promise<StageRebindResult> {
  const now = input.now ?? new Date();
  const hashes: StagedSetHashes = {
    stagedTokenHash: input.stagedTokenHash,
    stagedWatchdogTokenHash: input.stagedWatchdogTokenHash,
    stagedHelperTokenHash: input.stagedHelperTokenHash,
    confirmationTokenHash: input.confirmationTokenHash,
  };
  const values = Object.values(hashes);
  if (!values.every((value) => SHA256_HEX.test(value)) || new Set(values).size !== values.length) {
    return reattachRefusal(400, 'invalid_staged_set', 'The staged set must be four distinct SHA-256 hex digests');
  }

  // Unlocked pre-read: decides whether a certificate is needed before any lock.
  const preview = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(deviceReattachIntents)
      .where(eq(deviceReattachIntents.id, input.intentId))
      .limit(1);
    return row ?? null;
  }));
  if (!belongsToCaller(preview, input.caller)) return INTENT_NOT_FOUND();
  if (preview.state !== 'requested' && preview.state !== 'staged') {
    return intentStateRefusal(preview.state, preview.cancelReason);
  }

  const needsCertificate = preview.expiresAt.getTime() > now.getTime()
    && (preview.state === 'requested' || sameStagedSet(preview, hashes));
  let issued: IssuedStagedCertificate | null = null;
  if (needsCertificate) {
    const issue = await issueStagedCertificate(preview.targetOrgId);
    if (issue.kind === 'failed') {
      return reattachRefusal(503, 'certificate_unavailable', 'The target certificate could not be issued; retry');
    }
    if (issue.kind === 'issued') issued = issue.issued;
  }

  let committed: Committed;
  try {
    committed = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx): Promise<Committed> => {
      const locked = await lockReattachDevices(tx, [preview.sourceDeviceId, preview.targetDeviceId], 'key share');
      const intent = await readIntentForUpdate(tx, input.intentId);
      if (!belongsToCaller(intent, input.caller) || intent.targetDeviceId !== preview.targetDeviceId) {
        return { kind: 'refused', refusal: INTENT_NOT_FOUND() };
      }
      if (intent.state !== 'requested' && intent.state !== 'staged') {
        return { kind: 'refused', refusal: intentStateRefusal(intent.state, intent.cancelReason) };
      }
      if (intent.expiresAt.getTime() <= now.getTime()) {
        const ended = await endIntentInTransaction(tx, intent, { state: 'expired' }, now);
        return { kind: 'refused', refusal: intentStateRefusal('expired', null), ended: ended ?? undefined, intent };
      }
      if (intent.state === 'staged' && !sameStagedSet(intent, hashes)) {
        const ended = await endIntentInTransaction(tx, intent, { state: 'cancelled', reason: 'restage_refused' }, now);
        return {
          kind: 'refused',
          refusal: reattachRefusal(409, 'restage_refused', 'A different staged set was sent for this reattach; it is cancelled and must be requested again', {
            state: 'cancelled',
            cancelReason: 'restage_refused',
          }),
          ended: ended ?? undefined,
          intent,
        };
      }

      const source = locked.get(intent.sourceDeviceId);
      const target = locked.get(intent.targetDeviceId);
      if (!source || !target) return { kind: 'refused', refusal: INTENT_NOT_FOUND() };

      const failure = await revalidateLockedIntent(tx, intent, source, target);
      if (failure) {
        const ended = await endIntentInTransaction(tx, intent, { state: 'cancelled', reason: failure }, now);
        return {
          kind: 'refused',
          refusal: reattachRefusal(409, failure, `The reattach intent was cancelled (${failure})`, { state: 'cancelled', cancelReason: failure }),
          ended: ended ?? undefined,
          intent,
        };
      }

      // A staged set that reuses one of the source's own credentials is an
      // agent defect: refused, and nothing changes.
      const sourceHashes = new Set(collectAgentCredentialHashes(source));
      if (values.some((value) => sourceHashes.has(value))) {
        throw new ReattachRefusedError(
          reattachRefusal(400, 'invalid_staged_set', 'The staged set must be new credentials, not the source\'s own'),
        );
      }

      const targetIdentity = { deviceId: target.id, orgId: target.orgId, siteId: target.siteId, hostname: target.hostname };

      if (intent.state === 'requested') {
        const stagedAgentId = randomBytes(32).toString('hex');
        const expiresAt = new Date(now.getTime() + REATTACH_STAGED_TTL_MS);
        const certificateId = issued
          ? await insertStagedCertificateRow(tx, { orgId: target.orgId, deviceId: target.id, issued, activationExpiresAt: expiresAt })
          : null;
        const [staged] = await tx
          .update(deviceReattachIntents)
          .set({
            state: 'staged',
            stagedAgentId,
            stagedTokenHash: hashes.stagedTokenHash,
            stagedWatchdogTokenHash: hashes.stagedWatchdogTokenHash,
            stagedHelperTokenHash: hashes.stagedHelperTokenHash,
            confirmationTokenHash: hashes.confirmationTokenHash,
            stagedMtlsCertificateId: certificateId,
            stagedAt: now,
            expiresAt,
          })
          .where(and(eq(deviceReattachIntents.id, intent.id), eq(deviceReattachIntents.state, 'requested')))
          .returning();
        if (!staged) throw new Error('reattach intent was not staged');
        return {
          kind: 'staged',
          intent: staged,
          stagedAgentId,
          target: targetIdentity,
          certificateUsed: certificateId !== null,
          revokeCertificateIds: [],
          expiresAt,
        };
      }

      // A lost-response retry with the same set: a fresh pending certificate.
      if (!issued) {
        return {
          kind: 'retry',
          intent,
          stagedAgentId: intent.stagedAgentId!,
          target: targetIdentity,
          certificateUsed: false,
          revokeCertificateIds: [],
          expiresAt: intent.expiresAt,
        };
      }
      const superseded = await demoteStagedCertificate(tx, intent.stagedMtlsCertificateId, now);
      const certificateId = await insertStagedCertificateRow(tx, {
        orgId: target.orgId,
        deviceId: target.id,
        issued,
        activationExpiresAt: intent.expiresAt,
      });
      const [retried] = await tx
        .update(deviceReattachIntents)
        .set({ stagedMtlsCertificateId: certificateId })
        .where(and(eq(deviceReattachIntents.id, intent.id), eq(deviceReattachIntents.state, 'staged')))
        .returning();
      if (!retried) throw new Error('reattach intent retry was not recorded');
      return {
        kind: 'retry',
        intent: retried,
        stagedAgentId: intent.stagedAgentId!,
        target: targetIdentity,
        certificateUsed: true,
        revokeCertificateIds: superseded ? [superseded] : [],
        expiresAt: intent.expiresAt,
      };
    })));
  } catch (err) {
    if (issued) await revokeOrphanStagedCertificate({ orgId: preview.targetOrgId, deviceId: preview.targetDeviceId }, issued);
    if (err instanceof ReattachRefusedError) return err.refusal;
    throw err;
  }

  if (committed.kind === 'refused') {
    if (issued) await revokeOrphanStagedCertificate({ orgId: preview.targetOrgId, deviceId: preview.targetDeviceId }, issued);
    if (committed.ended && committed.intent) {
      await revokeCertificatesAfterCommit(committed.ended.revokeCertificateIds);
      const restage = committed.ended.cancelReason === 'restage_refused';
      await writeReattachAudit({
        action: committed.ended.state === 'expired' ? 'device.reinstall.expired' : 'device.reinstall.cancelled',
        actorUserId: null,
        actorAgentId: input.caller.agentId,
        targetOrgId: committed.intent.targetOrgId,
        sourceOrgId: committed.intent.sourceOrgId,
        targetDeviceId: committed.intent.targetDeviceId,
        result: 'denied',
        initiatedBy: 'agent',
        details: {
          intentId: committed.intent.id,
          sourceDeviceId: committed.intent.sourceDeviceId,
          phase: 'rebind',
          ...(committed.ended.cancelReason ? { cancelReason: committed.ended.cancelReason } : {}),
          ...(restage
            ? {
                warning: 'A second, different staged set was sent for this reattach. The source device\'s credentials may have been copied; request the reattach again only after checking the source.',
              }
            : {}),
        },
      });
    }
    return committed.refusal;
  }

  if (issued && !committed.certificateUsed) {
    await revokeOrphanStagedCertificate({ orgId: preview.targetOrgId, deviceId: preview.targetDeviceId }, issued);
  }
  await revokeCertificatesAfterCommit(committed.revokeCertificateIds);
  if (committed.kind === 'staged') {
    await writeReattachAudit({
      action: 'device.reinstall.staged',
      actorUserId: null,
      actorAgentId: input.caller.agentId,
      targetOrgId: committed.intent.targetOrgId,
      sourceOrgId: committed.intent.sourceOrgId,
      targetDeviceId: committed.intent.targetDeviceId,
      targetHostname: committed.target.hostname,
      initiatedBy: 'agent',
      details: {
        intentId: committed.intent.id,
        sourceDeviceId: committed.intent.sourceDeviceId,
        expiresAt: committed.expiresAt.toISOString(),
        certificateIssued: committed.certificateUsed,
      },
    });
  }

  const { hostname: _hostname, ...target } = committed.target;
  return {
    ok: true,
    outcome: committed.kind,
    intentId: committed.intent.id,
    stagedAgentId: committed.stagedAgentId,
    target,
    certificate: issued && committed.certificateUsed
      ? {
          certificate: issued.cert.certificate,
          privateKey: issued.cert.privateKey,
          expiresAt: issued.cert.expiresOn,
          serialNumber: issued.cert.serialNumber,
        }
      : null,
    expiresAt: committed.expiresAt,
  };
}
