/**
 * Notification Senders
 *
 * Exports all notification sender implementations.
 */

export {
  sendEmailNotification,
  validateEmailConfig,
  getEmailRecipients,
  type EmailNotificationPayload,
  type SendResult as EmailSendResult
} from './emailSender';

export {
  sendWebhookNotification,
  validateWebhookConfig,
  testWebhook,
  type WebhookNotificationPayload,
  type WebhookConfig,
  type SendResult as WebhookSendResult
} from './webhookSender';

export {
  sendInAppNotification,
  sendInAppNotificationToUsers,
  validateInAppConfig,
  type InAppNotificationPayload,
  type SendResult as InAppSendResult
} from './inAppSender';

// Re-export AlertSeverity for convenience
export type { AlertSeverity } from '../email';

/**
 * Channel type to sender mapping
 */
export type NotificationChannelType = 'email' | 'slack' | 'teams' | 'webhook' | 'pagerduty' | 'sms' | 'in_app';

/**
 * Unified send result type
 */
export interface NotificationSendResult {
  success: boolean;
  channelType: NotificationChannelType;
  error?: string;
  metadata?: Record<string, unknown>;
}
