/**
 * The Breeze inbound-webhook HMAC scheme (Tool Catalog W05 #5220, plan Task A6
 * / Decision 1), shared by the automations webhook and the flow webhook so a
 * sender signs both the same way:
 *
 *   X-Breeze-Timestamp: <unix seconds or milliseconds>
 *   X-Breeze-Signature: sha256=<hex HMAC-SHA256(secret, `<timestamp>.<raw body>`)>
 *
 * (bare hex without `sha256=` is accepted, as automations always has). The
 * comparison is length-checked and constant time. `signatureDigest` is the
 * sha256 of the NORMALISED signature header — a stable replay key derived
 * from the verified signature, never from a caller-supplied id alone.
 *
 * Pure: no I/O, no clock of its own (`now` is passed), no replay state —
 * each caller keeps its own replay protection.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type BreezeHmacFailure = 'missing_signature' | 'missing_timestamp' | 'invalid_timestamp' | 'stale_timestamp' | 'bad_signature';

export function verifyBreezeHmacSignature(i: {
  secret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  payload: string;
  now: number;
  windowMs: number;
}): { ok: true; signatureDigest: string } | { ok: false; reason: BreezeHmacFailure } {
  const signature = i.signature?.trim();
  if (!signature) return { ok: false, reason: 'missing_signature' };

  const timestamp = i.timestamp?.trim();
  if (!timestamp) return { ok: false, reason: 'missing_timestamp' };
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false, reason: 'invalid_timestamp' };
  const timestampMs = parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
  if (Math.abs(i.now - timestampMs) > i.windowMs) return { ok: false, reason: 'stale_timestamp' };

  const expected = `sha256=${createHmac('sha256', i.secret).update(`${timestamp}.${i.payload}`).digest('hex')}`;
  const normalized = signature.startsWith('sha256=') ? signature : `sha256=${signature}`;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(normalized, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, signatureDigest: createHash('sha256').update(normalized).digest('hex') };
}
