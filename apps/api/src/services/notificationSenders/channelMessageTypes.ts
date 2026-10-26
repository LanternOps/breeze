/**
 * Tool Catalog W05 (#5220), plan Decision 14 — notification channel types a
 * flow notice (`notify` step, the document's `notices.channelId`) can be sent
 * to. A leaf so the flow validator can check a channel's type without loading
 * the senders. `webhook` (use `http_request`) and `pagerduty` (an incident, not
 * a notice) are refused at save with `channel_type_not_supported`.
 */
export const CHANNEL_MESSAGE_TYPES = ['email', 'slack', 'teams', 'sms', 'pushover'] as const;
export type ChannelMessageType = (typeof CHANNEL_MESSAGE_TYPES)[number];

export function isChannelMessageType(type: string): type is ChannelMessageType {
  return (CHANNEL_MESSAGE_TYPES as readonly string[]).includes(type);
}
