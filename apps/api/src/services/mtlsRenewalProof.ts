/**
 * Recovery proof-of-possession for expired-certificate mTLS renewal —
 * security remediation Wave 5 Task 4.
 *
 * An agent whose active certificate has already expired cannot complete a
 * fresh mTLS handshake to prove it still holds the old private key, so the
 * bearer token alone would otherwise be sufficient to mint a brand-new
 * certificate (P1-MTLS-002). This module implements a short-lived,
 * server-issued challenge that the agent signs with the OLD certificate's
 * private key; the API verifies the signature against the SPKI captured at
 * issuance time (`device_mtls_certificates.public_key_spki`) and consumes
 * the challenge exactly once.
 *
 * Redis key: `mtls:renew-proof:<deviceId>:<challengeId>`, five-minute TTL,
 * value is `JSON.stringify({ spkiBase64, expiresUnix })`.
 *
 * Canonical signed bytes (UTF-8):
 *   ['breeze-mtls-renew-v1', deviceId, challengeId, String(expiresUnix)].join('\n')
 *
 * SECURITY (fail-closed, never log secrets): every failure path here is
 * reported ONLY as a bounded `RenewalProofFailureReason` enum value — never a
 * raw error message, the SPKI, the signature, the challenge id, or any other
 * proof material. Callers must not log the `proof` argument or the resolved
 * public key.
 */

import { createPublicKey, randomBytes, verify } from 'crypto';
import { getRedis } from './redis';

export const RENEWAL_CHALLENGE_TTL_SECONDS = 5 * 60;
export const RENEWAL_PROOF_CANONICAL_PREFIX = 'breeze-mtls-renew-v1';

export interface RenewalChallenge {
  challengeId: string;
  expiresUnix: number;
}

export interface RenewalProof {
  challengeId: string;
  expiresUnix: number;
  signatureBase64: string;
}

interface StoredRenewalChallenge {
  spkiBase64: string;
  expiresUnix: number;
}

function challengeRedisKey(deviceId: string, challengeId: string): string {
  return `mtls:renew-proof:${deviceId}:${challengeId}`;
}

/**
 * Builds the exact canonical byte sequence the agent must sign, per the
 * Wave 5 Task 4 brief. Exported so route tests / the agent's own
 * (future, Task 5) canonicalization can be proven byte-for-byte identical.
 */
export function buildRenewalProofCanonicalBytes(
  deviceId: string,
  challengeId: string,
  expiresUnix: number,
): Buffer {
  return Buffer.from(
    [RENEWAL_PROOF_CANONICAL_PREFIX, deviceId, challengeId, String(expiresUnix)].join('\n'),
    'utf8',
  );
}

/**
 * Issues a one-use, five-minute recovery challenge for `deviceId`, binding it
 * to the SPKI of the certificate the agent must prove possession of. Returns
 * `null` when Redis is unavailable (the caller — the /renew-cert/challenge
 * route — treats that as "recovery challenge unavailable", never as a
 * license to skip the proof requirement).
 */
export async function issueRenewalChallenge(
  deviceId: string,
  spkiBase64: string,
): Promise<RenewalChallenge | null> {
  const redis = getRedis();
  if (!redis) return null;

  const challengeId = randomBytes(16).toString('hex');
  const expiresUnix = Math.floor(Date.now() / 1000) + RENEWAL_CHALLENGE_TTL_SECONDS;
  const stored: StoredRenewalChallenge = { spkiBase64, expiresUnix };

  try {
    await redis.set(
      challengeRedisKey(deviceId, challengeId),
      JSON.stringify(stored),
      'EX',
      RENEWAL_CHALLENGE_TTL_SECONDS,
    );
  } catch (err) {
    console.error('[mtlsRenewalProof] failed to issue renewal challenge:', err instanceof Error ? err.name : 'unknown');
    return null;
  }

  return { challengeId, expiresUnix };
}

export type RenewalProofFailureReason =
  | 'redis_unavailable'
  | 'not_found'
  | 'expiry_mismatch'
  | 'malformed_key'
  | 'signature_invalid'
  | 'race_lost';

export type RenewalProofResult =
  | { ok: true }
  | { ok: false; reason: RenewalProofFailureReason };

// Redis-server-side Lua (NOT JavaScript eval) — atomically consumes the
// challenge only if its value is unchanged since our earlier GET, so a
// concurrent replay of the same (now-verified-valid) proof can only win once.
const CONSUME_IF_UNCHANGED_LUA = `
local v = redis.call('GET', KEYS[1])
if v == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

/**
 * Verifies a recovery proof against the challenge issued by
 * {@link issueRenewalChallenge} and, only on success, atomically consumes it
 * so it can never be replayed. Every failure — expired/replayed/unknown
 * challenge, an expiry that doesn't match what was issued, a malformed
 * stored/derived key, or a signature that doesn't verify — returns a bounded
 * `reason` and fails closed (`ok: false`). Never throws.
 */
export async function verifyAndConsumeRenewalProof(
  deviceId: string,
  proof: RenewalProof,
): Promise<RenewalProofResult> {
  const redis = getRedis();
  if (!redis) {
    return { ok: false, reason: 'redis_unavailable' };
  }

  const key = challengeRedisKey(deviceId, proof.challengeId);
  let raw: string | null;
  try {
    raw = await redis.get(key);
  } catch (err) {
    console.error('[mtlsRenewalProof] redis GET failed during proof verification:', err instanceof Error ? err.name : 'unknown');
    return { ok: false, reason: 'redis_unavailable' };
  }

  if (!raw) {
    // Absent key covers: never issued, already consumed (replay), or
    // TTL-expired — all indistinguishable from Redis's point of view, and
    // all correctly denied the same way.
    return { ok: false, reason: 'not_found' };
  }

  let stored: StoredRenewalChallenge;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRenewalChallenge>;
    if (typeof parsed.spkiBase64 !== 'string' || typeof parsed.expiresUnix !== 'number') {
      return { ok: false, reason: 'malformed_key' };
    }
    stored = { spkiBase64: parsed.spkiBase64, expiresUnix: parsed.expiresUnix };
  } catch {
    return { ok: false, reason: 'malformed_key' };
  }

  // The body-supplied expiry must equal exactly what was issued — this is
  // also what's fed into the canonical signed bytes, so a tampered expiry is
  // caught either here (mismatch) or below (signature no longer verifies).
  if (stored.expiresUnix !== proof.expiresUnix) {
    return { ok: false, reason: 'expiry_mismatch' };
  }

  if (Math.floor(Date.now() / 1000) > stored.expiresUnix) {
    // Belt-and-suspenders: the Redis TTL should already have removed this key
    // by the time it's expired, but a clock/timing edge shouldn't be trusted
    // to be the ONLY enforcement of expiry.
    return { ok: false, reason: 'not_found' };
  }

  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(stored.spkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return { ok: false, reason: 'malformed_key' };
  }

  const canonicalBytes = buildRenewalProofCanonicalBytes(deviceId, proof.challengeId, proof.expiresUnix);

  let signatureValid: boolean;
  try {
    signatureValid = verify(
      'sha256',
      canonicalBytes,
      publicKey,
      Buffer.from(proof.signatureBase64, 'base64'),
    );
  } catch {
    // Malformed base64, wrong signature length/encoding for the key type,
    // etc. all land here — never distinguish further, never log the bytes.
    signatureValid = false;
  }

  if (!signatureValid) {
    return { ok: false, reason: 'signature_invalid' };
  }

  try {
    // redis.eval() runs the literal Lua script above SERVER-SIDE inside Redis
    // — this is ioredis's Lua-script API, not JavaScript `eval`; no
    // client-controlled code is ever passed here.
    const consumed = await redis.eval(CONSUME_IF_UNCHANGED_LUA, 1, key, raw);
    if (consumed !== 1) {
      // Someone else consumed this exact valid proof between our GET and
      // this compare-and-delete (concurrent replay) — only the first caller
      // may win.
      return { ok: false, reason: 'race_lost' };
    }
  } catch (err) {
    console.error('[mtlsRenewalProof] redis consume failed:', err instanceof Error ? err.name : 'unknown');
    return { ok: false, reason: 'redis_unavailable' };
  }

  return { ok: true };
}
