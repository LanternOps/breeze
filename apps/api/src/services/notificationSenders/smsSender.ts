/**
 * SMS Notification Sender
 *
 * Sends alert notifications via Twilio Programmable Messaging.
 */

import { getTwilioService } from '../twilio';
import type { AlertSeverity } from '../email';

const E164_PHONE_REGEX = /^\+[1-9]\d{1,14}$/;
const MAX_SMS_BODY_LENGTH = 1400;

export interface SmsChannelConfig {
  phoneNumbers: string[];
  from?: string;
  messagingServiceSid?: string;
}

export interface SmsNotificationPayload {
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
  sentCount: number;
  failedCount: number;
  error?: string;
  errors?: string[];
}

export function isValidE164PhoneNumber(phoneNumber: string): boolean {
  return E164_PHONE_REGEX.test(phoneNumber.trim());
}

export function getSmsRecipients(config: Record<string, unknown>): string[] {
  const phoneNumbers = config.phoneNumbers;
  if (!Array.isArray(phoneNumbers)) {
    return [];
  }

  return phoneNumbers
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function validateSmsConfig(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be an object'] };
  }

  const parsed = config as Record<string, unknown>;
  const recipients = getSmsRecipients(parsed);
  if (recipients.length === 0) {
    errors.push('SMS channel phoneNumbers must be a non-empty array');
  }

  for (const recipient of recipients) {
    if (!isValidE164PhoneNumber(recipient)) {
      errors.push(`Invalid E.164 phone number: ${recipient}`);
    }
  }

  if (parsed.from !== undefined) {
    if (typeof parsed.from !== 'string' || parsed.from.trim().length === 0) {
      errors.push('SMS channel from must be a non-empty string when provided');
    } else if (!isValidE164PhoneNumber(parsed.from)) {
      errors.push(`Invalid E.164 from phone number: ${parsed.from}`);
    }
  }

  if (parsed.messagingServiceSid !== undefined && (typeof parsed.messagingServiceSid !== 'string' || parsed.messagingServiceSid.trim().length === 0)) {
    errors.push('SMS channel messagingServiceSid must be a non-empty string when provided');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function buildSmsBody(payload: SmsNotificationPayload): string {
  const severity = payload.severity.toUpperCase();
  const devicePart = payload.deviceName ? ` on ${payload.deviceName}` : '';
  const orgPart = payload.orgName ? ` (${payload.orgName})` : '';
  const base = `[${severity}] ${payload.alertName}${devicePart}${orgPart}: ${payload.summary}`;
  const withLink = payload.dashboardUrl ? `${base} ${payload.dashboardUrl}` : base;
  const normalized = withLink.replace(/\s+/g, ' ').trim();

  if (normalized.length <= MAX_SMS_BODY_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_SMS_BODY_LENGTH - 3)}...`;
}

/**
 * Send an SMS notification for an alert.
 */
export async function sendSmsNotification(
  config: SmsChannelConfig | Record<string, unknown>,
  payload: SmsNotificationPayload
): Promise<SendResult> {
  const validation = validateSmsConfig(config);
  if (!validation.valid) {
    return {
      success: false,
      sentCount: 0,
      failedCount: 0,
      error: validation.errors.join('; '),
      errors: validation.errors
    };
  }

  const parsedConfig = config as Record<string, unknown>;
  const recipients = getSmsRecipients(parsedConfig);
  const twilio = getTwilioService('messaging');
  if (!twilio) {
    return {
      success: false,
      sentCount: 0,
      failedCount: recipients.length,
      error: 'SMS service not configured'
    };
  }

  const smsBody = buildSmsBody(payload);
  const sendErrors: string[] = [];
  let sentCount = 0;

  for (const recipient of recipients) {
    const result = await twilio.sendSmsMessage(recipient, smsBody, {
      from: typeof parsedConfig.from === 'string' ? parsedConfig.from : undefined,
      messagingServiceSid: typeof parsedConfig.messagingServiceSid === 'string' ? parsedConfig.messagingServiceSid : undefined
    });

    if (result.success) {
      sentCount += 1;
      continue;
    }

    const errorMessage = result.error || 'Unknown SMS send error';
    sendErrors.push(`${recipient}: ${errorMessage}`);
  }

  const failedCount = sendErrors.length;
  const success = failedCount === 0 && sentCount > 0;

  return {
    success,
    sentCount,
    failedCount,
    error: failedCount > 0 ? sendErrors.join('; ') : undefined,
    errors: failedCount > 0 ? sendErrors : undefined
  };
}
