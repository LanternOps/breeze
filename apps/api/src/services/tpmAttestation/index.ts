import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { deviceHardware, devices } from '../../db/schema';
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
 * Trust: TOFU on the EK. This proves the same key, not the same physical TPM
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

export type BaselineOutcome = 'recorded' | 'refreshed' | 'changed';

/**
 * Step 2. Consumes the challenge whatever the answer. Returns how the
 * baseline moved, or null when the device row changed hands since auth (the
 * caller answers the stale-credential 401). Throws TpmAttestationError for a
 * missing, expired, foreign or wrong answer.
 */
export async function completeAttestation(
  agent: { deviceId: string; agentId: string },
  input: { challengeId: string; secret: string },
  now: Date = new Date(),
): Promise<{ outcome: BaselineOutcome; orgId: string } | null> {
  const redis = getRedis();
  if (!redis) throw new TpmAttestationError('TPM_CHALLENGE_UNAVAILABLE', 503, 'Attestation is unavailable right now');
  const raw = await redis.getdel(challengeKey(input.challengeId));
  const invalid = () => new TpmAttestationError('TPM_CHALLENGE_INVALID', 403, 'The attestation challenge is invalid or expired');
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
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid();

  return db.transaction(async (tx) => {
    // The row is still this install's (#8318 §6.4), held while the baseline is written.
    const [device] = await tx
      .select({ orgId: devices.orgId })
      .from(devices)
      .where(and(eq(devices.id, agent.deviceId), eq(devices.agentId, agent.agentId)))
      .limit(1)
      .for('share');
    if (!device) return null;
    const [current] = await tx
      .select({ ek: deviceHardware.tpmEkPubSha256 })
      .from(deviceHardware)
      .where(eq(deviceHardware.deviceId, agent.deviceId))
      .limit(1)
      .for('update');
    const outcome: BaselineOutcome = !current?.ek ? 'recorded' : current.ek === stored.ekSha256 ? 'refreshed' : 'changed';
    // A proof of possession also says a TPM is there.
    const baseline = { tpmEkPubSha256: stored.ekSha256, tpmAttestedAt: now, tpmAvailable: true };
    await tx
      .insert(deviceHardware)
      .values({ deviceId: agent.deviceId, orgId: device.orgId, ...baseline, updatedAt: now })
      .onConflictDoUpdate({ target: deviceHardware.deviceId, set: baseline });
    return { outcome, orgId: device.orgId };
  });
}
