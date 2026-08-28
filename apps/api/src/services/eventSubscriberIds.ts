// Canonical ids for durable event subscribers (wave 3.5c, #4085). These key
// event_delivery_receipts rows and the EVENT_DISPATCH_QUEUE_SUBSCRIBERS flag —
// renaming one orphans receipts and silently drops it from the queue cohort.
export const EVENT_SUBSCRIBER_IDS = [
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
