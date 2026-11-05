/**
 * Flow webhook contracts (tool catalog W5, #5220, Decisions 1, 2, 5, 6). Browser safe.
 *
 * Senders sign `<timestamp>.<raw body>` with HMAC-SHA256 (the Breeze scheme used by
 * automation and outbound webhooks) or send the secret in a header (`token` mode).
 */

export const FLOW_WEBHOOK_AUTH_MODES = ['hmac', 'token'] as const;
export type FlowWebhookAuthMode = (typeof FLOW_WEBHOOK_AUTH_MODES)[number];

export const FLOW_WEBHOOK_DELIVERY_STATUSES = ['accepted', 'org_unresolved', 'refused', 'invalid_body'] as const;
export type FlowWebhookDeliveryStatus = (typeof FLOW_WEBHOOK_DELIVERY_STATUSES)[number];

/** Recorded on the flow (never as delivery rows) at most once a minute. */
export const FLOW_WEBHOOK_AUTH_FAILURES = [
  'missing_signature', 'bad_signature', 'stale_timestamp', 'missing_token', 'bad_token', 'bad_delivery_id',
] as const;
export type FlowWebhookAuthFailure = (typeof FLOW_WEBHOOK_AUTH_FAILURES)[number];

export const FLOW_WEBHOOK_HEADERS = {
  timestamp: 'x-breeze-timestamp',
  signature: 'x-breeze-signature',
  deliveryId: 'x-breeze-delivery-id',
  token: 'x-breeze-webhook-token',
} as const;

export const FLOW_WEBHOOK_DELIVERY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Max characters of an org-resolver value stored on a delivery row. */
export const FLOW_WEBHOOK_RESOLVER_VALUE_MAX = 256;

export interface FlowWebhookInfoDto {
  url: string;
  authMode: FlowWebhookAuthMode;
  secretFingerprint: string | null;
  secretRotatedAt: string | null;
  lastAuthFailureAt: string | null;
  lastAuthFailureReason: FlowWebhookAuthFailure | null;
}

export interface FlowWebhookDeliveryDto {
  id: string;
  receivedAt: string;
  status: FlowWebhookDeliveryStatus;
  refusalCode: string | null;
  orgId: string | null;
  runId: string | null;
  deliveryId: string | null;
  authMode: FlowWebhookAuthMode;
  bodyBytes: number;
  attempts: number;
  resolverValue: string | null;
}

export interface FlowWebhookSecretRevealDto {
  secret: string;
  fingerprint: string;
  rotatedAt: string;
  warning: string;
}
