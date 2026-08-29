// Canonical ids for durable event subscribers (wave 3.5c, #4085). These key
// event_delivery_receipts rows and the EVENT_DISPATCH_QUEUE_SUBSCRIBERS flag —
// renaming one orphans receipts and silently drops it from the queue cohort.
export const EVENT_SUBSCRIBER_IDS = [
  // Phase 2 wave P2-1 (alert verdicts), task 12 — durable alert-verdict
  // admission subscriber. Alphabetically first
  // ('ai-agent-alert-verdict' < 'ai-agent-anomaly'); otherwise an ordinary
  // entry, subject to every rule the header comment above describes.
  'ai-agent-alert-verdict',
  // Wave 6 PR 4 (#3828) — durable anomaly-triggered admission subscriber.
  'ai-agent-anomaly',
  // Wave 6 PR 3 (#3828) — durable ticket-helpdesk admission subscriber.
  'ai-agent-ticket-helpdesk',
  'automation-worker',
  'dns-threat-alerts',
  'notification-dispatcher',
  'policy-alert-bridge',
  'webhook-delivery',
] as const;

export type SubscriberId = (typeof EVENT_SUBSCRIBER_IDS)[number];

export function isSubscriberId(value: string): value is SubscriberId {
  return (EVENT_SUBSCRIBER_IDS as readonly string[]).includes(value);
}
