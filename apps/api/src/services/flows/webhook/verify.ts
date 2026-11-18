/**
 * Tool Catalog W05 (#5220), plan Task A6 / Decision 1 — authenticate one flow
 * webhook delivery.
 *
 *  - `hmac` (default): the shared Breeze scheme (services/webhookSignature.ts),
 *    ±`FLOW_RUN_LIMITS.webhookTimestampWindowMs`. The signature digest is the
 *    durable replay key (Decision 2).
 *  - `token`: the secret itself in `X-Breeze-Webhook-Token` (never
 *    `Authorization`, which auth and partnerGuard parse; never a query string,
 *    which lands in proxy logs). Compared as sha256 digests with
 *    `timingSafeEqual`, so the comparison is constant time and length-blind.
 *    Weaker: without `X-Breeze-Delivery-Id` every POST is a new run.
 *
 * The optional `X-Breeze-Delivery-Id` is checked only after authentication,
 * so an unauthenticated caller learns nothing from it.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  FLOW_RUN_LIMITS,
  FLOW_WEBHOOK_DELIVERY_ID_RE,
  FLOW_WEBHOOK_HEADERS,
  type FlowWebhookAuthFailure,
  type FlowWebhookAuthMode,
} from '@breeze/shared';
import { verifyBreezeHmacSignature, type BreezeHmacFailure } from '../../webhookSignature';

const HMAC_FAILURE: Record<BreezeHmacFailure, FlowWebhookAuthFailure> = {
  missing_signature: 'missing_signature',
  missing_timestamp: 'stale_timestamp',
  invalid_timestamp: 'stale_timestamp',
  stale_timestamp: 'stale_timestamp',
  bad_signature: 'bad_signature',
};

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export function verifyFlowWebhook(i: {
  rawBody: string;
  headers: Headers;
  secret: string;
  mode: FlowWebhookAuthMode;
  now: number;
}): { ok: true; signatureDigest: string | null; deliveryId: string | null } | { ok: false; reason: FlowWebhookAuthFailure } {
  let signatureDigest: string | null = null;
  if (i.mode === 'hmac') {
    const verified = verifyBreezeHmacSignature({
      secret: i.secret,
      timestamp: i.headers.get(FLOW_WEBHOOK_HEADERS.timestamp),
      signature: i.headers.get(FLOW_WEBHOOK_HEADERS.signature),
      payload: i.rawBody,
      now: i.now,
      windowMs: FLOW_RUN_LIMITS.webhookTimestampWindowMs,
    });
    if (!verified.ok) return { ok: false, reason: HMAC_FAILURE[verified.reason] };
    signatureDigest = verified.signatureDigest;
  } else {
    const token = i.headers.get(FLOW_WEBHOOK_HEADERS.token)?.trim();
    if (!token) return { ok: false, reason: 'missing_token' };
    if (!timingSafeEqual(sha256(token), sha256(i.secret))) return { ok: false, reason: 'bad_token' };
  }

  const rawDeliveryId = i.headers.get(FLOW_WEBHOOK_HEADERS.deliveryId)?.trim();
  if (!rawDeliveryId) return { ok: true, signatureDigest, deliveryId: null };
  if (!FLOW_WEBHOOK_DELIVERY_ID_RE.test(rawDeliveryId)) return { ok: false, reason: 'bad_delivery_id' };
  return { ok: true, signatureDigest, deliveryId: rawDeliveryId };
}
