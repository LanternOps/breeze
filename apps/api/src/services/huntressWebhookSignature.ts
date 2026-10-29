/**
 * Signature verification for the public Huntress webhook receiver
 * (`POST /api/v1/huntress/webhook`).
 *
 * Huntress delivers through Svix, i.e. Standard Webhooks (#10335, confirmed
 * from a captured Send Test delivery):
 *   webhook-id:        msg_<id>
 *   webhook-timestamp: <unix seconds>
 *   webhook-signature: v1,<base64 HMAC-SHA256(key, "{id}.{timestamp}.{rawBody}")>
 *                      (space-separated when several secrets are live)
 *   secret:            whsec_<base64 key>, as shown by Huntress's "View Signing Secret"
 * The `svix-id` / `svix-timestamp` / `svix-signature` spellings are accepted
 * as aliases. The HMAC, the per-entry constant-time comparison and the
 * never-throw guarantee come from the shared Svix verifier.
 *
 * The older `x-huntress-signature: sha256=<hex HMAC("{timestamp}.{body}")>`
 * scheme (with `x-huntress-timestamp`, or `x-signature` / `x-timestamp`) is
 * kept unchanged for any sender already configured that way.
 *
 * Scheme selection: if ANY Standard Webhooks header is present, that scheme
 * is authoritative and the legacy headers are not consulted, so a partly
 * stripped delivery reports the header that is actually missing. Otherwise
 * the legacy verifier runs.
 */
import { verifyHuntressWebhookSignature } from './huntressClient';
import { verifySvixSignature, type WebhookVerifyFailure } from './emailDomains/webhookSignature';

/** Same replay window as the legacy scheme. */
export const HUNTRESS_WEBHOOK_REPLAY_WINDOW_SECONDS = 10 * 60;

export type HuntressWebhookScheme = 'standard-webhooks' | 'legacy';

export type HuntressWebhookVerifyResult =
  | { ok: true; scheme: HuntressWebhookScheme }
  | { ok: false; scheme: HuntressWebhookScheme; error: string };

type HeaderReader = (name: string) => string | undefined;

const STANDARD_WEBHOOK_HEADERS = {
  id: ['webhook-id', 'svix-id'],
  timestamp: ['webhook-timestamp', 'svix-timestamp'],
  signature: ['webhook-signature', 'svix-signature'],
} as const;

function firstHeader(header: HeaderReader, names: readonly string[]): string | null {
  for (const name of names) {
    const value = header(name)?.trim();
    if (value) return value;
  }
  return null;
}

const STANDARD_WEBHOOK_ERRORS: Record<Exclude<WebhookVerifyFailure, 'missing_headers'>, string> = {
  bad_timestamp: 'Invalid webhook-timestamp header',
  stale_timestamp: 'Webhook signature timestamp is outside the replay window',
  bad_secret: 'Webhook secret is not configured correctly',
  bad_signature: 'Invalid Huntress webhook signature',
};

export function verifyHuntressWebhookRequest(input: {
  secret: string;
  /** The raw request body, byte-for-byte as received. */
  payload: string;
  header: HeaderReader;
  now?: Date;
}): HuntressWebhookVerifyResult {
  const { secret, payload, header } = input;

  const id = firstHeader(header, STANDARD_WEBHOOK_HEADERS.id);
  const timestamp = firstHeader(header, STANDARD_WEBHOOK_HEADERS.timestamp);
  const signature = firstHeader(header, STANDARD_WEBHOOK_HEADERS.signature);

  if (id !== null || timestamp !== null || signature !== null) {
    const missing = [
      id === null ? 'webhook-id' : null,
      timestamp === null ? 'webhook-timestamp' : null,
      signature === null ? 'webhook-signature' : null,
    ].filter((name): name is string => name !== null);
    if (missing.length > 0) {
      return {
        ok: false,
        scheme: 'standard-webhooks',
        error: `Missing Standard Webhooks header(s): ${missing.join(', ')}`,
      };
    }

    const result = verifySvixSignature(
      { id, timestamp, signature },
      payload,
      secret,
      input.now ?? new Date(),
      { toleranceSeconds: HUNTRESS_WEBHOOK_REPLAY_WINDOW_SECONDS, unprefixedSecret: 'raw' },
    );
    if (result.ok) return { ok: true, scheme: 'standard-webhooks' };
    // All three headers were non-empty, so the shared verifier cannot report
    // missing_headers here; map it defensively rather than assert.
    const error = result.reason === 'missing_headers'
      ? 'Missing Standard Webhooks header(s)'
      : STANDARD_WEBHOOK_ERRORS[result.reason];
    return { ok: false, scheme: 'standard-webhooks', error };
  }

  const legacySignature = header('x-huntress-signature') ?? header('x-signature');
  if (!legacySignature?.trim()) {
    return {
      ok: false,
      scheme: 'legacy',
      error: 'Missing webhook signature header (expected webhook-signature or x-huntress-signature)',
    };
  }

  const legacy = verifyHuntressWebhookSignature({
    secret,
    payload,
    signatureHeader: legacySignature,
    timestampHeader: header('x-huntress-timestamp') ?? header('x-timestamp'),
    maxAgeSeconds: HUNTRESS_WEBHOOK_REPLAY_WINDOW_SECONDS,
  });
  return legacy.ok
    ? { ok: true, scheme: 'legacy' }
    : { ok: false, scheme: 'legacy', error: legacy.error };
}
