import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Svix webhook signature verification (spec §9.3: "signature-verified (svix
 * scheme)"). Resend delivers through Svix and uses the scheme unmodified.
 *
 * Implemented by hand on purpose: `svix` is not a dependency of this repo, and
 * `resend@6.18.0`'s client exposes webhook CRUD only — there is no
 * `webhooks.verify` to call (node_modules/resend/dist/index.d.mts). The scheme
 * is small and fully specified, so a hand-rolled verifier is cheaper than a new
 * transitive dependency on an unauthenticated public surface.
 *
 * The scheme:
 *   signed content = `${svix-id}.${svix-timestamp}.${rawBody}`
 *   key            = base64-decoded body of the `whsec_`-prefixed secret
 *   signature      = base64( HMAC-SHA256( key, signed content ) )
 *   header         = space-separated `v<version>,<signature>` entries
 *
 * Three properties this function guarantees, each with a test:
 *  - it NEVER throws. A thrown error inside a public webhook handler becomes a
 *    500, which tells the provider to retry a payload that can never verify.
 *  - every candidate signature is compared in constant time, and a length
 *    mismatch short-circuits BEFORE timingSafeEqual (which throws on unequal
 *    lengths).
 *  - EVERY `v1` entry is checked, not just the first: Svix sends one signature
 *    per currently-valid secret during a rotation.
 */

export type WebhookVerifyFailure =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'bad_secret'
  | 'bad_signature';

export type WebhookVerifyResult = { ok: true } | { ok: false; reason: WebhookVerifyFailure };

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * Svix's own recommendation. Wide enough that a retry after a brief provider
 * queue delay still verifies, narrow enough that a captured payload cannot be
 * replayed hours later — and the `svix-id` reservation in the route is the
 * second, stronger replay defence.
 */
export const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 300;

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual THROWS on differing lengths, so the length check has to
  // come first. Length is not a secret here: it is fixed by the algorithm.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifySvixSignature(
  headers: SvixHeaders,
  rawBody: string,
  secret: string,
  now: Date = new Date(),
): WebhookVerifyResult {
  const id = headers.id?.trim() ?? '';
  const timestamp = headers.timestamp?.trim() ?? '';
  const signatureHeader = headers.signature?.trim() ?? '';
  if (id.length === 0 || timestamp.length === 0 || signatureHeader.length === 0) {
    return { ok: false, reason: 'missing_headers' };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || !Number.isInteger(sentAt)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  // Symmetric: a timestamp far in the future is as suspicious as a stale one
  // and is what a replay with a doctored clock looks like.
  if (Math.abs(nowSeconds - sentAt) > SVIX_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const trimmedSecret = secret.trim();
  if (trimmedSecret.length === 0) return { ok: false, reason: 'bad_secret' };
  // The `whsec_` prefix is a label, not part of the key. Tolerate a secret
  // pasted without it: that is the single most likely operator mistake, and
  // silently failing every delivery over a missing prefix is a bad trade.
  const key = Buffer.from(trimmedSecret.replace(/^whsec_/, ''), 'base64');
  if (key.length === 0) return { ok: false, reason: 'bad_secret' };

  let expected: string;
  try {
    expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64');
  } catch {
    return { ok: false, reason: 'bad_secret' };
  }

  for (const entry of signatureHeader.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma <= 0) continue;
    if (entry.slice(0, comma) !== 'v1') continue;
    const candidate = entry.slice(comma + 1);
    if (candidate.length === 0) continue;
    if (constantTimeEquals(expected, candidate)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}
