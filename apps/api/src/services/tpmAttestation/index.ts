import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { auditLogs, deviceHardware, devices } from '../../db/schema';
import { ownDeviceRowChangedHands, selectOwnDeviceRowForUpdate } from '../agentOwnDeviceRow';
import type { CreateAuditLogParams } from '../auditService';
import { markRequestAuditWritten } from '../auditService';
import { getRedis } from '../redis';
import { makeCredential } from './makeCredential';
import {
  akTemplateRefusal,
  ekPublicKeySha256,
  ekTemplateRefusal,
  parseRsaPublic,
  TpmStructureError,
} from './tpm2Public';

/**
 * TPM endorsement-key collection (#8318 wave T1; spec
 * docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §12.2). The agent proves it holds a TPM's EK, and the server records the
 * EK as the device's baseline, before anyone reformats the machine.
 *
 *   1. challenge: the agent sends the EK's and a fresh AK's TPMT_PUBLIC. The
 *      server checks the EK is the RSA-2048 default template and the AK a
 *      restricted signing key bound to its TPM, then MakeCredential binds a
 *      random secret to both. The challenge is stored in Redis, single use,
 *      for CHALLENGE_TTL_SECONDS, bound to this device and agent.
 *   2. complete: the agent runs TPM2_ActivateCredential, which only the TPM
 *      holding that EK can do for that AK, and returns the secret. The
 *      challenge is consumed (GETDEL) whatever the answer; a right secret
 *      records the baseline.
 *
 * Trust: TOFU on the EK, and the first baseline is kept. T1 checks no EK
 * certificate, so a proof shows possession of a key shaped like the default
 * EK, not that it lives in a TPM. A different proven EK is therefore never
 * written over the baseline: it is held in tpm_ek_mismatch_* and audited for
 * an operator's review (wave T2 adds the accept path, e.g. a replaced
 * motherboard), so a stolen agent token cannot swap the key a later reattach
 * is compared against. This proves the same key, not the same physical TPM
 * (cloned virtual TPMs share EKs); the reattach UI says exactly that (§7).
 * Never logged: challenges, secrets and EKs.
 */

export const CHALLENGE_TTL_SECONDS = 300;
/** Challenges a device may ask for per hour: an agent needs one per process start. */
export const CHALLENGES_PER_HOUR = 6;
const SECRET_BYTES = 32;

const challengeKey = (id: string) => `tpm-attestation:challenge:${id}`;
export const challengeRateKey = (deviceId: string) => `tpm-attestation:rate:${deviceId}`;

type StoredChallenge = {
  deviceId: string;
  agentId: string;
  /** SHA-256 of the secret, hex: compared in constant time, never the secret itself. */
  secretSha256: string;
  ekSha256: string;
};

export class TpmAttestationError extends Error {
  constructor(
    readonly code:
      | 'TPM_PUBLIC_INVALID'
      | 'TPM_EK_REFUSED'
      | 'TPM_AK_REFUSED'
      | 'TPM_CHALLENGE_UNAVAILABLE'
      | 'TPM_CHALLENGE_INVALID',
    readonly status: 400 | 403 | 503,
    message: string,
    /** For TPM_CHALLENGE_INVALID, `wrong_secret` when the challenge was this agent's and the answer was wrong. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'TpmAttestationError';
  }
}

function decodeArea(value: string, which: 'EK' | 'AK') {
  try {
    return parseRsaPublic(Buffer.from(value, 'base64'));
  } catch (error) {
    if (error instanceof TpmStructureError) {
      throw new TpmAttestationError('TPM_PUBLIC_INVALID', 400, `The ${which} public area is not a valid RSA TPMT_PUBLIC`);
    }
    throw error;
  }
}

export type IssuedChallenge = { challengeId: string; credentialBlob: string; encryptedSecret: string; expiresInSeconds: number };

/** Step 1. Throws TpmAttestationError; the caller has already rate-limited the device. */
export async function issueAttestationChallenge(
  agent: { deviceId: string; agentId: string },
  input: { ekPublic: string; akPublic: string },
): Promise<IssuedChallenge> {
  const ek = decodeArea(input.ekPublic, 'EK');
  const ak = decodeArea(input.akPublic, 'AK');
  const ekRefusal = ekTemplateRefusal(ek);
  if (ekRefusal) throw new TpmAttestationError('TPM_EK_REFUSED', 400, 'The EK is not the RSA-2048 default template', ekRefusal);
  const akRefusal = akTemplateRefusal(ak);
  if (akRefusal) throw new TpmAttestationError('TPM_AK_REFUSED', 400, 'The AK is not a restricted signing key bound to its TPM', akRefusal);

  const redis = getRedis();
  if (!redis) throw new TpmAttestationError('TPM_CHALLENGE_UNAVAILABLE', 503, 'Attestation is unavailable right now');

  const secret = randomBytes(SECRET_BYTES);
  const { credentialBlob, encryptedSecret } = makeCredential(ek, ak, secret);
  const challengeId = randomUUID();
  const stored: StoredChallenge = {
    deviceId: agent.deviceId,
    agentId: agent.agentId,
    secretSha256: createHash('sha256').update(secret).digest('hex'),
    ekSha256: ekPublicKeySha256(ek),
  };
  await redis.set(challengeKey(challengeId), JSON.stringify(stored), 'EX', CHALLENGE_TTL_SECONDS);
  return {
    challengeId,
    credentialBlob: credentialBlob.toString('base64'),
    encryptedSecret: encryptedSecret.toString('base64'),
    expiresInSeconds: CHALLENGE_TTL_SECONDS,
  };
}

/**
 * recorded: the first baseline. refreshed: the baseline EK again (its time
 * moves). mismatch: a different EK, held for review; the baseline is untouched.
 */
export type BaselineOutcome = 'recorded' | 'refreshed' | 'mismatch';

/** The audit row of a baseline outcome, built by the route from its request. */
export type BaselineAuditBuilder = (action: 'device.tpm_baseline.recorded' | 'device.tpm_baseline.mismatch', orgId: string) => CreateAuditLogParams;

/**
 * Step 2. Consumes the challenge whatever the answer. Returns how the
 * baseline moved; 'stale' when the device row changed hands since auth (the
 * caller answers the stale-credential 401), 'not_found' when it is gone. Throws TpmAttestationError for a
 * missing, expired, foreign or wrong answer.
 *
 * Runs with no DB context held (the route self-manages its context, agentAuth
 * SELF_MANAGED_DB_CONTEXT_TWO_SEGMENT_ACTIONS): the Redis GETDEL runs first,
 * then ONE org-scoped transaction writes the baseline and, for a first
 * baseline or a mismatch, its audit row, so the record and its audit commit
 * together.
 */
export async function completeAttestation(
  agent: { deviceId: string; agentId: string; orgId: string; partnerId?: string | null },
  input: { challengeId: string; secret: string },
  audit: BaselineAuditBuilder,
  now: Date = new Date(),
): Promise<{ outcome: BaselineOutcome; orgId: string } | 'stale' | 'not_found'> {
  const redis = getRedis();
  if (!redis) throw new TpmAttestationError('TPM_CHALLENGE_UNAVAILABLE', 503, 'Attestation is unavailable right now');
  const raw = await redis.getdel(challengeKey(input.challengeId));
  const invalid = (reason?: string) => new TpmAttestationError('TPM_CHALLENGE_INVALID', 403, 'The attestation challenge is invalid or expired', reason);
  if (!raw) throw invalid();
  let stored: StoredChallenge;
  try {
    stored = JSON.parse(raw) as StoredChallenge;
  } catch {
    throw invalid();
  }
  if (stored.deviceId !== agent.deviceId || stored.agentId !== agent.agentId) throw invalid();
  const expected = Buffer.from(stored.secretSha256, 'hex');
  const given = createHash('sha256').update(Buffer.from(input.secret, 'base64')).digest();
  // This agent's own live challenge answered wrongly: the route audits it as
  // a failed activation (a tampering signal), unlike an unknown challenge.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid('wrong_secret');

  const result = await withDbAccessContext(
    {
      scope: 'organization',
      orgId: agent.orgId,
      accessibleOrgIds: [agent.orgId],
      accessiblePartnerIds: [],
      currentPartnerId: agent.partnerId ?? null,
    },
    () => db.transaction(async (tx) => {
      // The row is still this install's (#8318 §6.4). FOR NO KEY UPDATE, not
      // FOR SHARE: it serializes two completions for the same device, so when
      // there is no device_hardware row yet (nothing for the FOR UPDATE below
      // to lock) the second one still sees the first one's baseline and
      // records a mismatch instead of overwriting it.
      const device = await selectOwnDeviceRowForUpdate(tx, agent, { orgId: devices.orgId });
      if (!device) return (await ownDeviceRowChangedHands(tx, agent)) ? 'stale' as const : 'not_found' as const;
      const [current] = await tx
        .select({ ek: deviceHardware.tpmEkPubSha256 })
        .from(deviceHardware)
        .where(eq(deviceHardware.deviceId, agent.deviceId))
        .limit(1)
        .for('update');
      const outcome: BaselineOutcome = !current?.ek ? 'recorded' : current.ek === stored.ekSha256 ? 'refreshed' : 'mismatch';
      // A proof of possession also says a TPM is there. The baseline itself is
      // written only when there is none: a different EK never replaces it.
      if (outcome === 'mismatch') {
        // The row exists (it holds the baseline), so this is a plain UPDATE: an
        // upsert's proposed INSERT row would carry a mismatch with no baseline
        // and fail device_hardware_tpm_ek_mismatch_shape_chk before ON CONFLICT.
        await tx
          .update(deviceHardware)
          .set({ tpmEkMismatchSha256: stored.ekSha256, tpmEkMismatchAt: now, tpmAvailable: true })
          .where(eq(deviceHardware.deviceId, agent.deviceId));
      } else {
        const set = { tpmEkPubSha256: current?.ek ?? stored.ekSha256, tpmAttestedAt: now, tpmAvailable: true };
        await tx
          .insert(deviceHardware)
          .values({ deviceId: agent.deviceId, orgId: device.orgId, ...set, updatedAt: now })
          .onConflictDoUpdate({ target: deviceHardware.deviceId, set });
      }
      // A first baseline, and a different EK held for review, are audited in
      // this transaction. A refresh of the same key is not.
      if (outcome !== 'refreshed') {
        const { actorType = 'agent', partnerId: _partnerId, trigger: _trigger, ...row } = audit(
          outcome === 'recorded' ? 'device.tpm_baseline.recorded' : 'device.tpm_baseline.mismatch',
          device.orgId,
        );
        await tx.insert(auditLogs).values({ actorType, ...row, orgId: device.orgId, partnerId: null });
      }
      return { outcome, orgId: device.orgId };
    }),
  );
  if (typeof result === 'object' && result.outcome !== 'refreshed') markRequestAuditWritten();
  return result;
}
