/**
 * Tool Catalog W05 (#5220), plan Decision 14 — notification channel types a
 * flow notice (`notify` step, the document's `notices.channelId`) can be sent
 * to. A leaf so the flow validator can check a channel's type without loading
 * the senders.
 *
 * W06 (#5221, Decision 15) narrowly reopens W05 Decision 14: `webhook` (the
 * channel's own URL, auth and signing) and `pagerduty` (one incident per run,
 * step and for-each item through the notice's dedup key) are supported, so a
 * converted Job that pages someone can move to a flow. Any other type is
 * refused at save with `channel_type_not_supported`.
 */
export const CHANNEL_MESSAGE_TYPES = ['email', 'slack', 'teams', 'sms', 'pushover', 'webhook', 'pagerduty'] as const;
export type ChannelMessageType = (typeof CHANNEL_MESSAGE_TYPES)[number];

export function isChannelMessageType(type: string): type is ChannelMessageType {
  return (CHANNEL_MESSAGE_TYPES as readonly string[]).includes(type);
}
