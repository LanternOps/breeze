import crypto from 'node:crypto';
import type { MobileAttestation } from '@breeze/shared';
import type { PlatformBoundBasis } from '../db/schema/authenticatorDevices';
import { getRedis } from './redis';
import { captureException } from './sentry';
import { sha256CanonicalSpki, type MobileKeyAlg } from './mobileHwKey';
import { verifyAndroidKeyAttestation } from './attestation/androidKeyAttestation';
import { verifyPlayIntegrityToken } from './attestation/playIntegrity';

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
}

/** The single unattested outcome, built fresh each call so a caller mutating the
 *  returned `evidence` object cannot poison the next registration. */
function unattested(): AttestationResult {
  return { basis: 'unattested', verifiedAt: null, keyId: null, evidence: {}, appIntegrityVerifiedAt: null };
}

/**
 * Android package the approver app ships under (`apps/mobile/app.json:43`).
 * An attestation naming any other package is not our app.
 */
const ANDROID_PACKAGE_NAME = 'com.breeze.rmm';

/**
 * Verify an Android Key Attestation and, when the client supplied one, a Play
 * Integrity verdict.
 *
 * Key Attestation ALONE sets the basis (plan decision 3). Play Integrity is an
 * independent app/device-posture signal that can only ever stamp
 * `appIntegrityVerifiedAt` — never upgrade a basis, and never substitute for a
 * missing chain.
 *
 * A verdict the client DID supply and that comes back disqualifying
 * (unrecognised app, device fails integrity, replayed request hash) revokes the
 * attested basis rather than being ignored: Key Attestation proving the key is
 * in StrongBox does not make a compromised device an acceptable place to hold a
 * critical-tier approver key. A Play Integrity outage on OUR side is different
 * — `verifyPlayIntegrityToken` returns null there, and the Key-Attestation
 * basis stands.
 */
async function verifyAndroid(input: {
  attestation: Extract<MobileAttestation, { platform: 'android' }>;
  transcript: Buffer;
  publicKeySpkiB64: string;
}): Promise<AttestationResult> {
  const key = verifyAndroidKeyAttestation({
    certificateChainDerB64: input.attestation.certificateChain,
    expectedChallenge: input.transcript,
    expectedPackageName: ANDROID_PACKAGE_NAME,
  });

  // The attested leaf key MUST be the key being registered. Without this the
  // chain proves "SOME hardware key exists on this device", and an attacker
  // could pair a genuine attestation with a software key of their own.
  // Compared as canonical-SPKI digests so a re-encoding of the same key still
  // matches — the same normalization `attested_public_key_sha256` stores.
  const attestedDigest = sha256CanonicalSpki(
    key.attestedPublicKeyDer.toString('base64'),
  );
  const registeredDigest = sha256CanonicalSpki(input.publicKeySpkiB64);
  if (!attestedDigest || !registeredDigest || !attestedDigest.equals(registeredDigest)) {
    throw new Error('android attestation does not cover the registered key');
  }

  const integrity = input.attestation.playIntegrityToken
    ? await verifyPlayIntegrityToken(input.attestation.playIntegrityToken, {
        packageName: ANDROID_PACKAGE_NAME,
        // Binds the verdict to THIS registration attempt. W06's Kotlin must
        // pass the same value to `setRequestHash`.
        expectedRequestHash: input.transcript.toString('base64url'),
      })
    : null;

  return {
    basis:
      key.keyMintSecurityLevel === 'StrongBox'
        ? 'android_strongbox_key_attestation'
        : 'android_tee_key_attestation',
    verifiedAt: new Date(),
    keyId: key.leafSerial,
    evidence: {
      verifier: 'android_key_attestation',
      verifierVersion: 1,
      keyMintSecurityLevel: key.keyMintSecurityLevel,
      attestationSecurityLevel: key.attestationSecurityLevel,
      verifiedBootState: key.verifiedBootState,
      deviceLocked: key.deviceLocked,
      packageName: key.packageName,
      playIntegrity: integrity ?? null,
    },
    appIntegrityVerifiedAt: integrity ? new Date() : null,
  };
}

/**
 * Dispatch to the per-platform verifier. W03 wires iOS (Apple App Attest), W04
 * wires Android (Key Attestation + Play Integrity).
 *
 * NEVER THROWS. A platform whose verifier is not wired, or an attestation that
 * fails verification for any reason, resolves `unattested`: the device registers
 * and works at L2/L3, and simply cannot reach L4 — `unattested` is not in
 * `L4_TRUSTED_PLATFORM_BOUND_BASES` (services/authenticatorAssurance.ts), which
 * a test in this module's suite pins. The route relies on this: it does not
 * wrap the call, so a throw here would be a 500 on a registration that should
 * have degraded to an honest unattested row.
 *
 * Fail-closed by construction: an unknown, unimplemented, or forged attestation
 * never yields a trusted basis.
 */
export async function verifyPlatformAttestation(input: {
  attestation: MobileAttestation;
  transcript: Buffer;
  publicKeySpkiB64: string;
}): Promise<AttestationResult> {
  if (input.attestation.platform === 'android') {
    try {
      return await verifyAndroid({ ...input, attestation: input.attestation });
    } catch (err) {
      // A failed attestation is the ROUTINE attacker-shaped case and is not a
      // server defect, so it is not sent to Sentry — a caller could otherwise
      // flood it at will. It is still recorded on the row: `evidence` carries
      // why the downgrade happened, so an operator debugging "why is my phone
      // not L4" has the reason on the device row instead of nothing.
      console.warn('[authenticator-attest] android attestation rejected', {
        reason: (err as Error).message,
      });
      return {
        ...unattested(),
        evidence: {
          verifier: 'android_key_attestation',
          verifierVersion: 1,
          rejected: (err as Error).message,
        },
      };
    }
  }
  return unattested();
}
