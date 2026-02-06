/**
 * Email Notification Sender
 *
 * Sends alert notifications via email using the EmailService.
 */

import { getEmailService, AlertSeverity } from '../email';

export interface EmailNotificationPayload {
  to: string | string[];
  alertName: string;
  severity: AlertSeverity;
  summary: string;
  deviceName?: string;
  occurredAt?: Date | string;
  dashboardUrl?: string;
  orgName?: string;
}

export interface SendResult {
  success: boolean;
  error?: string;
}

/**
 * Send an email notification for an alert
 */
export async function sendEmailNotification(payload: EmailNotificationPayload): Promise<SendResult> {
  const emailService = getEmailService();

  if (!emailService) {
    return {
      success: false,
      error: 'Email service not configured'
    };
  }

  try {
    await emailService.sendAlertNotification({
      to: payload.to,
      alertName: payload.alertName,
      severity: payload.severity,
      summary: payload.summary,
      deviceName: payload.deviceName,
      occurredAt: payload.occurredAt,
      dashboardUrl: payload.dashboardUrl,
      orgName: payload.orgName
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[EmailSender] Failed to send notification:', errorMessage);

    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Validate email channel configuration
 */
export function validateEmailConfig(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be an object'] };
  }

  const c = config as Record<string, unknown>;

  // Email channels require at least one recipient
  if (!c.recipients && !c.to) {
    errors.push('Missing recipients field');
  } else {
    const recipients = (c.recipients || c.to) as unknown;
    if (typeof recipients === 'string') {
      if (!isValidEmail(recipients)) {
        errors.push('Invalid email address');
      }
    } else if (Array.isArray(recipients)) {
      for (const email of recipients) {
        if (!isValidEmail(email as string)) {
          errors.push(`Invalid email address: ${email}`);
        }
      }
    } else {
      errors.push('Recipients must be a string or array of strings');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Basic email validation
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return typeof email === 'string' && emailRegex.test(email);
}

/**
 * Extract recipients from channel config
 */
export function getEmailRecipients(config: Record<string, unknown>): string[] {
  const recipients = (config.recipients || config.to) as unknown;

  if (typeof recipients === 'string') {
    return [recipients];
  }

  if (Array.isArray(recipients)) {
    return recipients.filter((r): r is string => typeof r === 'string');
  }

  return [];
}
