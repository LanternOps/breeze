/**
 * Tool Catalog W06 (#5221) Tasks B2 + B6 (Decision 6) — one webhook delivery's
 * occurrence identity, defined ONCE for both engines so a delivery admitted by
 * one collides with the other's claim:
 *
 *  - keys: `webhook:sig:<digest>` (the verified signature digest,
 *    `verifyBreezeHmacSignature`'s, which both verifiers return) and
 *    `webhook:dlv:<id>` (a sender delivery id the flow accepts as
 *    `X-Breeze-Delivery-Id`). Either conflicting is a duplicate;
 *  - the delivery id legacy reads (`x-breeze-event-id`, else
 *    `x-breeze-nonce`), which the forwarder maps to `X-Breeze-Delivery-Id`;
 *  - the instant: the signed `X-Breeze-Timestamp`, parsed as the verifier
 *    parses it.
 *
 * A pure leaf (no DB, no I/O): the legacy route, the forwarder and flow ingest
 * all import it, and the route's unit suites mock `claims.ts` wholesale.
 */
import { FLOW_WEBHOOK_DELIVERY_ID_RE, occurrenceKey } from '@breeze/shared';
import { breezeHmacTimestampMs } from '../../webhookSignature';

/** The raw delivery-id header the legacy route reads: `x-breeze-event-id`, else `x-breeze-nonce`. */
export function legacyWebhookDeliveryIdHeader(get: (name: string) => string | undefined): string | undefined {
  return get('x-breeze-event-id') ?? get('x-breeze-nonce');
}

/** The delivery id as the flow side would carry it, or null when it cannot (absent, or not `FLOW_WEBHOOK_DELIVERY_ID_RE`). */
export function webhookDeliveryIdFor(raw: string | null | undefined): string | null {
  const id = raw?.trim();
  return id && FLOW_WEBHOOK_DELIVERY_ID_RE.test(id) ? id : null;
}

/** The claim aliases of one delivery (possibly none: a token delivery without an id is unkeyable). */
export function webhookOccurrenceKeys(signatureDigest: string | null, deliveryId: string | null | undefined): string[] {
  const keys: string[] = [];
  if (signatureDigest) keys.push(occurrenceKey.webhookSig(signatureDigest));
  const id = webhookDeliveryIdFor(deliveryId);
  if (id) keys.push(occurrenceKey.webhookDelivery(id));
  return keys;
}

/** The signed `X-Breeze-Timestamp` as an instant, or null when there is none. */
export function webhookOccurrenceInstant(timestampHeader: string | null | undefined): Date | null {
  const ms = breezeHmacTimestampMs(timestampHeader);
  return ms === null ? null : new Date(ms);
}
