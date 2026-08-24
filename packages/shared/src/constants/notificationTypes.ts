/** Canonical notification types shared by API validation and web rendering. */
export const NOTIFICATION_TYPES = [
  'alert',
  'device',
  'script',
  'automation',
  'system',
  'user',
  'security',
  'ticket',
  'approval',
  'ai',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
