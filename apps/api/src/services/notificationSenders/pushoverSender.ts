/**
 * Pushover Notification Sender
 *
 * Sends alert notifications via the Pushover Messages API
 * (https://pushover.net/api). One HTTP POST per alert; form-encoded body.
 */

import type { AlertSeverity } from '../email';

const PUSHOVER_MESSAGES_URL = 'https://api.pushover.net/1/messages.json';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_EMERGENCY_RETRY_SECONDS = 60;
const DEFAULT_EMERGENCY_EXPIRE_SECONDS = 3600;

export type PushoverPriority = -2 | -1 | 0 | 1 | 2;

export interface PushoverConfig {
  token?: string;
  user?: string;
  device?: string;
  priority?: PushoverPriority;
  sound?: string;
  retry?: number;
  expire?: number;
  ttl?: number;
  timeout?: number;
}

export interface PushoverNotificationPayload {
  alertId: string;
  alertName: string;
  severity: AlertSeverity;
  summary: string;
  deviceId?: string;
  deviceName?: string;
  orgId: string;
  orgName?: string;
  triggeredAt: string;
  ruleId?: string;
  ruleName?: string;
  dashboardUrl?: string;
}

export interface SendResult {
  success: boolean;
  statusCode?: number;
  receipt?: string;
  request?: string;
  error?: string;
}

function isValidPriority(value: unknown): value is PushoverPriority {
  return value === -2 || value === -1 || value === 0 || value === 1 || value === 2;
}

function severityToPriority(severity: AlertSeverity): PushoverPriority {
  switch (severity) {
    case 'critical':
      return 2;
    case 'high':
      return 1;
    case 'medium':
      return 0;
    case 'low':
    case 'info':
    default:
      return -1;
  }
}

export function validatePushoverConfig(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be an object'] };
  }

  const parsed = config as PushoverConfig;

  const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
  const user = typeof parsed.user === 'string' ? parsed.user.trim() : '';
  if (token.length === 0) {
    errors.push('Pushover channel requires token (application API token)');
  } else if (token.length > 30) {
    errors.push('Pushover token must be 30 characters or fewer');
  }
  if (user.length === 0) {
    errors.push('Pushover channel requires user (user or group key)');
  } else if (user.length > 30) {
    errors.push('Pushover user/group key must be 30 characters or fewer');
  }

  if (parsed.device !== undefined && parsed.device !== '') {
    if (typeof parsed.device !== 'string' || parsed.device.length > 25) {
      errors.push('Pushover device name must be 25 characters or fewer');
    }
  }

  if (parsed.priority !== undefined && !isValidPriority(parsed.priority)) {
    errors.push('Pushover priority must be one of: -2, -1, 0, 1, 2');
  }

  if (parsed.priority === 2) {
    if (parsed.retry !== undefined && (typeof parsed.retry !== 'number' || parsed.retry < 30)) {
      errors.push('Pushover emergency retry must be at least 30 seconds');
    }
    if (parsed.expire !== undefined && (typeof parsed.expire !== 'number' || parsed.expire < 1 || parsed.expire > 10800)) {
      errors.push('Pushover emergency expire must be between 1 and 10800 seconds');
    }
  }

  if (parsed.timeout !== undefined) {
    if (typeof parsed.timeout !== 'number' || parsed.timeout < 1000 || parsed.timeout > 60000) {
      errors.push('Pushover timeout must be between 1000 and 60000 milliseconds');
    }
  }

  return { valid: errors.length === 0, errors };
}

export async function sendPushoverNotification(
  config: PushoverConfig,
  payload: PushoverNotificationPayload
): Promise<SendResult> {
  const validation = validatePushoverConfig(config);
  if (!validation.valid) {
    return { success: false, error: validation.errors.join('; ') };
  }

  const priority = isValidPriority(config.priority)
    ? config.priority
    : severityToPriority(payload.severity);

  const title = `${payload.alertName}`.slice(0, 250);
  const messageLines = [
    payload.summary,
    payload.deviceName ? `Device: ${payload.deviceName}` : null,
    payload.orgName ? `Org: ${payload.orgName}` : null,
    payload.dashboardUrl ? payload.dashboardUrl : null,
  ].filter((line): line is string => Boolean(line));
  const message = messageLines.join('\n').slice(0, 1024);

  const form = new URLSearchParams();
  form.set('token', config.token!.trim());
  form.set('user', config.user!.trim());
  form.set('title', title);
  form.set('message', message);
  form.set('priority', String(priority));
  if (config.sound) form.set('sound', config.sound);
  if (config.device) form.set('device', config.device);
  if (typeof config.ttl === 'number' && config.ttl > 0) form.set('ttl', String(config.ttl));

  if (priority === 2) {
    form.set('retry', String(config.retry ?? DEFAULT_EMERGENCY_RETRY_SECONDS));
    form.set('expire', String(config.expire ?? DEFAULT_EMERGENCY_EXPIRE_SECONDS));
  }

  const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(PUSHOVER_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Breeze-RMM/1.0',
      },
      body: form.toString(),
      signal: controller.signal,
    });

    const responseBody = await response.text();
    let parsed: { status?: number; request?: string; receipt?: string; errors?: string[] } = {};
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      // fall through; we'll report HTTP status only
    }

    if (!response.ok || parsed.status !== 1) {
      const errMsg = parsed.errors?.length
        ? parsed.errors.join('; ')
        : `HTTP ${response.status}: ${responseBody.slice(0, 500)}`;
      return {
        success: false,
        statusCode: response.status,
        request: parsed.request,
        error: errMsg,
      };
    }

    return {
      success: true,
      statusCode: response.status,
      request: parsed.request,
      receipt: parsed.receipt,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { success: false, error: 'Pushover request timed out' };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown Pushover error',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
