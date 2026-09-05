import crypto from 'node:crypto';
import type { MobileAttestation } from '@breeze/shared';
import type { PlatformBoundBasis } from '../db/schema/authenticatorDevices';
import { APPLE_APP_ATTEST_APP_ID, appleAppAttestEnvironment } from '../config/env';
import { getRedis } from './redis';
import { captureException } from './sentry';
import type { MobileKeyAlg } from './mobileHwKey';
import {
  AppAttestVerificationError,
  verifyAppAttestAttestation,
} from './attestation/appleAppAttest';

/**
 * Attested mobile approver-key registration (#1374, feature #4707 wave W02).
 *
 * The two-step protocol this backs:
 *   1. POST /authenticator/devices/mobile/challenge -> a single-use attempt
 *      (attemptId + 32 random bytes of challenge), held in Redis for 5 minutes.
 *   2. POST /authenticator/devices/mobile/verify    -> the phone returns its new
 *      public key, a platform attestation bound to the challenge, and a
 *      proof-of-possession signature by that key.
 *
 * A server challenge is not optional garnish here: both Apple App Attest
 * (`clientDataHash`) and Android Key Attestation (`setAttestationChallenge`)
 * only mean anything if the value they commit to was chosen by the server for
 * this one registration. Without it, an attestation captured once could be
 * replayed forever.
 */

/** Attempts are short-lived on purpose: long enough for a biometric prompt and
 *  an attestation round-trip, short enough that a captured challenge is stale
 *  before it is useful. */
export const ATTEMPT_TTL_SECONDS = 300;

/**
 * Domain tag hashed INTO the transcript. Versioned (`.v1`) so a future change to
 * the transcript layout is a new tag rather than a silent reinterpretation of
 * the same bytes by clients on two different app versions.
 */
const TRANSCRIPT_DOMAIN = 'breeze.authenticator.mobile-register.v1';

const attemptKey = (attemptId: string) => `authenticator-attest:${attemptId}`;

export interface RegistrationAttempt {
  attemptId: string;
  userId: string;
  /** base64url, 32 random bytes. */
  challenge: string;
  /** epoch ms */
  issuedAt: number;
  platform: 'ios' | 'android';
}

/**
 * The bytes both the platform attestation and the registration
 * proof-of-possession are computed over.
 *
 * iOS passes this as App Attest's `clientDataHash`; Android passes it as the
 * KeyStore `setAttestationChallenge`; and the client also signs it with the new
 * approval key under a biometric prompt. One digest, three bindings — which is
 * what makes "this attestation vouches for THIS key in THIS attempt" checkable
 * rather than merely asserted.
 *
 * Domain-separated and newline-delimited so a signature minted for any other
 * Breeze flow, or a different split of the same concatenated bytes, cannot be
 * replayed in here. Every field is base64/base64url/uuid/enum, i.e. newline-free,
 * so the separator is unambiguous.
 *
 * The exact pre-image is pinned by a test: W05/W06 mint this digest on-device,
 * so a silent reordering here would break every phone in the field.
 */
export function registrationTranscript(input: {
  attemptId: string;
  challenge: string;
  publicKeyAlg: MobileKeyAlg;
  publicKeySpkiB64: string;
}): Buffer {
  return crypto
    .createHash('sha256')
    .update(
      [
        TRANSCRIPT_DOMAIN,
        input.attemptId,
        input.challenge,
        input.publicKeyAlg,
        input.publicKeySpkiB64,
      ].join('\n'),
      'utf8',
    )
    .digest();
}

/**
 * Mint a single-use registration attempt. The attempt records the USER it was
 * issued to so /verify can refuse an attempt minted for somebody else, and the
 * PLATFORM so a client cannot request an iOS challenge and return an Android
 * attestation against it.
 */
export async function issueRegistrationAttempt(
  userId: string,
  platform: 'ios' | 'android',
): Promise<RegistrationAttempt> {
  const redis = getRedis();
  // Fail loudly rather than issuing a challenge that can never be consumed —
  // a "successful" challenge with no server-side state would let /verify be
  // reached with a value the server never chose.
  if (!redis) throw new Error('redis unavailable');
  const attempt: RegistrationAttempt = {
    attemptId: crypto.randomUUID(),
    userId,
    challenge: crypto.randomBytes(32).toString('base64url'),
    issuedAt: Date.now(),
    platform,
  };
  await redis.setex(attemptKey(attempt.attemptId), ATTEMPT_TTL_SECONDS, JSON.stringify(attempt));
  return attempt;
}

/**
 * Atomic read-and-delete (`GETDEL`): a replayed attemptId finds nothing. A
 * read-then-delete pair would leave a window in which two concurrent /verify
 * calls both see the attempt as live.
 */
export async function consumeRegistrationAttempt(attemptId: string): Promise<RegistrationAttempt | null> {
  const redis = getRedis();
  if (!redis) throw new Error('redis unavailable');
  const stored = await redis.getdel(attemptKey(attemptId));
  if (stored == null) return null;
  try {
    return JSON.parse(stored) as RegistrationAttempt;
  } catch (err) {
    // Corrupt value: the attempt is already gone (getdel), so this is terminal.
    // Returning null makes /verify 400 rather than throw a 500.
    //
    // But this is NOT an attacker-shaped failure and must not be swallowed
    // silently. `attemptId` is a randomUUID keyspace we wrote ourselves with
    // JSON.stringify moments earlier, so a parse failure means Redis-level
    // corruption, a key-namespace collision on `authenticator-attest:*`, or a
    // serialization bug — a server defect an operator needs to see. The caller
    // is told "expired"; the operator is told the truth.
    captureException(err, undefined, { area: 'authenticator_attestation', reason: 'attempt_corrupt' });
    console.error('[authenticator-attest] corrupt registration attempt payload', { attemptId });
    return null;
  }
}

/**
 * What a verified (or unverified) platform attestation contributes to the new
 * device row. `basis` is the authority: `attestationVerifiedAt`/`keyId`/
 * `evidence` describe it, they do not decide it.
 */
export interface AttestationResult {
  basis: PlatformBoundBasis;
  verifiedAt: Date | null;
  keyId: string | null;
  /** NORMALIZED, SERVER-VERIFIED claims only — never a raw client blob. */
  evidence: Record<string, unknown>;
  appIntegrityVerifiedAt: Date | null;
  /**
   * Why a presented attestation did NOT verify. Set only alongside
   * `basis: 'unattested'`, and only when a verifier actually ran and rejected —
   * never for a platform with no verifier wired.
   *
   * This exists because the failure that matters most is not the forged blob,
   * it is the MISCONFIGURATION: a stale APPLE_APP_ATTEST_APP_ID or a wrong
   * APPLE_APP_ATTEST_ENVIRONMENT rejects 100% of genuine enrolments, fleet-wide
   * and indefinitely, and every one of those rejections looks — request by
   * request — exactly like a single attacker being turned away. A console line
   * cannot be aggregated after the fact; an audit-log field can, which turns
   * "why did nobody reach L4 last month" into one query instead of a stdout
   * grep against whatever retention happens to survive.
   *
   * The verifier's own reason strings are safe to persist: they describe the
   * SERVER's checks ("rpIdHash does not match the configured appId"), never
   * client-supplied bytes.
   */
  failureReason?: string;
}

/** The single unattested outcome, built fresh each call so a caller mutating the
 *  returned `evidence` object cannot poison the next registration. */
function unattested(): AttestationResult {
  return { basis: 'unattested', verifiedAt: null, keyId: null, evidence: {}, appIntegrityVerifiedAt: null };
}

/**
 * Dispatch to the per-platform verifier. W03 wires iOS (Apple App Attest), W04
 * wires Android (Key Attestation + Play Integrity).
 *
 * Anything not yet wired — and anything that fails verification — resolves
 * `unattested`: the device registers and works at L2/L3, and simply cannot
 * reach L4, because `unattested` is not in `L4_TRUSTED_PLATFORM_BOUND_BASES`
 * (services/authenticatorAssurance.ts), which a test in this module's suite
 * pins. Fail-closed by construction: an unknown, unimplemented, or forged
 * attestation never yields a trusted basis.
 */
export async function verifyPlatformAttestation(input: {
  attestation: MobileAttestation;
  transcript: Buffer;
  publicKeySpkiB64: string;
  publicKeyAlg: MobileKeyAlg;
}): Promise<AttestationResult> {
  if (input.attestation.platform === 'ios') {
    return verifyIosAttestation(input.attestation, input.transcript, input.publicKeyAlg);
  }
  return unattested();
}

/**
 * iOS — Apple App Attest (#1374 W03).
 *
 * A verification FAILURE is a downgrade, not a 5xx: the phone still gets a
 * working L2/L3 approver key, it just never reaches L4. That is deliberate —
 * the shapes that land here are client-provokable (a development build against
 * a production-configured server, a stale attempt, a genuinely forged blob) and
 * none of them should block a technician from enrolling a device that is still
 * useful at lower tiers. `evidence` stays empty on that path so no unverified
 * claim is ever persisted; the reason travels back on `failureReason` for the
 * route to record in the audit row.
 *
 * But "the verifier refused" and "the verifier BROKE" are different events and
 * must not share a log line. An `AppAttestVerificationError` is a decision the
 * verifier reached on purpose; anything else — a TypeError from a tiny-cbor or
 * @peculiar/x509 upgrade, a RangeError from a parser regression — means every
 * legitimate Apple blob in the fleet is now being downgraded and NOBODY would
 * know, because it reads exactly like ordinary attacker noise. That one gets
 * captureException, the same call `consumeRegistrationAttempt` above makes for
 * the same reason.
 */
function verifyIosAttestation(
  attestation: Extract<MobileAttestation, { platform: 'ios' }>,
  transcript: Buffer,
  publicKeyAlg: MobileKeyAlg,
): AttestationResult {
  const appId = APPLE_APP_ATTEST_APP_ID;
  const environment = appleAppAttestEnvironment();

  let attested: { attestedPublicKeyDer: Buffer; receiptB64: string };
  try {
    attested = verifyAppAttestAttestation({
      attestationObjectB64: attestation.attestationObject,
      keyIdB64: attestation.keyId,
      clientDataHash: transcript,
      appId,
      environment,
    });
  } catch (err) {
    const expected = err instanceof AppAttestVerificationError;
    const reason = expected
      ? err.reason
      : `verifier error: ${err instanceof Error ? err.name : 'unknown'}`;
    if (!expected) {
      // Not a rejection — a defect. No client can provoke a non-
      // AppAttestVerificationError out of a pure function whose every failure
      // path goes through reject(), so this is our bug or a dependency's, and
      // it is silently costing every iOS device its L4 eligibility.
      captureException(err, undefined, {
        area: 'authenticator_attestation',
        reason: 'app_attest_verifier_error',
      });
    }
    // appId is logged too: a stale team/bundle id is the single likeliest cause
    // of a fleet-wide rejection, and it is the one value an operator cannot see
    // from the outside.
    console.warn('[authenticator-attest] App Attest verification failed', {
      appId,
      environment,
      reason,
      expected,
    });
    return { ...unattested(), failureReason: reason };
  }

  // The App Attest key and the APPROVAL key are two different keys. App Attest
  // proves a genuine app instance on genuine hardware; the transcript binding
  // proves that instance vouched for THIS approval SPKI. What decides the basis
  // is whether the approval key is itself Secure-Enclave resident, which the
  // client asserts by minting a P-256 key with kSecAttrTokenIDSecureEnclave —
  // and which iOS gives us NO API to verify server-side. So: ES256 gets
  // ios_se_p256_app_attest; RS256 (which CANNOT be Secure Enclave — the SE
  // holds only P-256) gets the weaker ios_keychain_rsa_app_attest, which is
  // deliberately NOT in L4_TRUSTED_PLATFORM_BOUND_BASES.
  const basis: PlatformBoundBasis =
    publicKeyAlg === 'ES256' ? 'ios_se_p256_app_attest' : 'ios_keychain_rsa_app_attest';

  return {
    basis,
    verifiedAt: new Date(),
    keyId: attestation.keyId,
    // DIGESTS ONLY, never the raw receipt. The receipt is a bearer artifact for
    // Apple's fraud-metric endpoint; hashing it keeps the forensic link without
    // persisting a credential in a jsonb column.
    evidence: {
      verifier: 'apple_app_attest',
      verifierVersion: 1,
      appId,
      environment,
      attestedAppAttestKeySha256: crypto
        .createHash('sha256')
        .update(attested.attestedPublicKeyDer)
        .digest('hex'),
      receiptSha256: crypto
        .createHash('sha256')
        .update(Buffer.from(attested.receiptB64, 'base64'))
        .digest('hex'),
    },
    // App Attest attests the app instance itself, so a pass IS an app-integrity
    // signal — unlike Android, where key attestation and Play Integrity are two
    // separate checks (W04).
    appIntegrityVerifiedAt: new Date(),
  };
}
