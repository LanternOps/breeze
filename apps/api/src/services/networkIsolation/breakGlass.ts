import { createHmac, randomBytes } from 'node:crypto';

/**
 * Offline break-glass code for a network-isolation episode (spec §3.6 item 3, plan "Break-glass code").
 *
 *   code = base32(HMAC-SHA256(secret, "<isolationId lowercase>|<generation>|<hourBucket>")[0:5])
 *
 * hourBucket = floor(unixSeconds / 3600) in decimal; base32 is RFC 4648 without padding, so 5 bytes are
 * exactly 8 characters. The agent (W1d) computes the same code with zero connectivity, accepts buckets
 * -1, 0 and +1, and rate-limits attempts; agent/internal/isolation/testdata/breakglass_vectors.json pins
 * both implementations to one reference. The secret is per episode, 32 random bytes, stored encrypted
 * (device_network_isolations.break_glass_secret_enc) and never logged.
 */

const SECRET_BYTES = 32;
const CODE_BYTES = 5;
const HOUR_MS = 3_600_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface BreakGlassCodes {
  /** Code for the current hour bucket. */
  current: string;
  /** Code for the next hour bucket (the console shows both; the agent also accepts the previous one). */
  next: string;
  /** End of the current hour bucket, when `next` becomes `current`. */
  currentValidUntil: Date;
}

/** A fresh per-episode secret: 32 bytes from the OS CSPRNG. */
export function generateEpisodeSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** RFC 4648 base32, no padding. */
function base32NoPad(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export function breakGlassCode(secret: Buffer, isolationId: string, generation: number, hourBucket: number): string {
  if (!Buffer.isBuffer(secret) || secret.length !== SECRET_BYTES) {
    throw new Error(`break-glass secret must be exactly ${SECRET_BYTES} bytes`);
  }
  const id = typeof isolationId === 'string' ? isolationId.toLowerCase() : '';
  if (!UUID_RE.test(id)) throw new Error('isolationId must be a UUID');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('generation must be a positive integer');
  if (!Number.isSafeInteger(hourBucket) || hourBucket < 0) throw new Error('hourBucket must be a non-negative integer');

  const mac = createHmac('sha256', secret).update(`${id}|${generation}|${hourBucket}`, 'utf8').digest();
  return base32NoPad(mac.subarray(0, CODE_BYTES));
}

/** The codes the console shows for `now`: this hour's and the next hour's. */
export function currentBreakGlassCodes(secret: Buffer, isolationId: string, generation: number, now: Date): BreakGlassCodes {
  const ms = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0) throw new Error('now must be a valid date');
  const bucket = Math.floor(ms / HOUR_MS);
  return {
    current: breakGlassCode(secret, isolationId, generation, bucket),
    next: breakGlassCode(secret, isolationId, generation, bucket + 1),
    currentValidUntil: new Date((bucket + 1) * HOUR_MS),
  };
}
