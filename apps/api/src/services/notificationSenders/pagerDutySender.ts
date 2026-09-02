/**
 * PagerDuty Notification Sender
 *
 * Sends alert notifications via PagerDuty Events API v2.
 */

import type { AlertSeverity } from '../email';
import { formatHttpFailure, formatHttpFailureDetail } from '../httpFailureMessage';
import { collectChannelSecretStrings } from '../notificationChannelSecrets';

const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';
const DEFAULT_TIMEOUT_MS = 15000;

export interface PagerDutyConfig {
  routingKey?: string;
  integrationKey?: string;
  severity?: 'critical' | 'error' | 'warning' | 'info';
  source?: string;
  component?: string;
  class?: string;
  group?: string;
  dedupKey?: string;
  customDetails?: Record<string, unknown>;
  timeout?: number;
}

export interface PagerDutyNotificationPayload {
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
  dedupKey?: string;
  error?: string;
}

function getRoutingKey(config: PagerDutyConfig): string | null {
  const routingKey = typeof config.routingKey === 'string' ? config.routingKey.trim() : '';
  if (routingKey.length > 0) {
    return routingKey;
  }

  const integrationKey = typeof config.integrationKey === 'string' ? config.integrationKey.trim() : '';
  if (integrationKey.length > 0) {
    return integrationKey;
  }

  return null;
}

function normalizePagerDutySeverity(
  configured: PagerDutyConfig['severity'] | undefined,
  fallback: AlertSeverity
): 'critical' | 'error' | 'warning' | 'info' {
  if (configured && ['critical', 'error', 'warning', 'info'].includes(configured)) {
    return configured;
  }

  switch (fallback) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
    case 'info':
    default:
      return 'info';
  }
}

export function validatePagerDutyConfig(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be an object'] };
  }

  const parsed = config as PagerDutyConfig;
  if (!getRoutingKey(parsed)) {
    errors.push('PagerDuty channel requires routingKey or integrationKey');
  }

  if (parsed.severity && !['critical', 'error', 'warning', 'info'].includes(parsed.severity)) {
    errors.push('PagerDuty severity must be one of: critical, error, warning, info');
  }

  if (parsed.timeout !== undefined) {
    if (typeof parsed.timeout !== 'number' || parsed.timeout < 1000 || parsed.timeout > 60000) {
      errors.push('PagerDuty timeout must be between 1000 and 60000 milliseconds');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export async function sendPagerDutyNotification(
  config: PagerDutyConfig,
  payload: PagerDutyNotificationPayload
): Promise<SendResult> {
  const validation = validatePagerDutyConfig(config);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.errors.join('; ')
    };
  }

  const routingKey = getRoutingKey(config);
  if (!routingKey) {
    return {
      success: false,
      error: 'PagerDuty channel requires routingKey or integrationKey'
    };
  }

  const dedupKey = config.dedupKey || payload.alertId;
  const eventPayload = {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: dedupKey,
    payload: {
      summary: `${payload.alertName}: ${payload.summary}`.slice(0, 1024),
      source: config.source || payload.deviceName || 'breeze-rmm',
      severity: normalizePagerDutySeverity(config.severity, payload.severity),
      component: config.component || payload.deviceName,
      group: config.group || payload.orgName,
      class: config.class || payload.ruleName,
      timestamp: payload.triggeredAt,
      custom_details: {
        alertId: payload.alertId,
        alertName: payload.alertName,
        severity: payload.severity,
        summary: payload.summary,
        orgId: payload.orgId,
        orgName: payload.orgName,
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
        ruleId: payload.ruleId,
        ruleName: payload.ruleName,
        dashboardUrl: payload.dashboardUrl,
        ...(config.customDetails || {})
      }
    }
  };

  const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(PAGERDUTY_EVENTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Breeze-RMM/1.0'
      },
      body: JSON.stringify(eventPayload),
      signal: controller.signal
    });

    const responseBody = await response.text();
    if (!response.ok) {
      // Redact the channel's own credentials from the RAW body before it is
      // transformed. Nothing scrubs this string on the live alert path — it
      // goes straight into alert_notifications.error_message (#3992).
      const secrets = collectChannelSecretStrings('pagerduty', config);
      // The returned `error` is operator-facing: the dispatcher persists it
      // into alert_notifications.error_message and it is rendered in the UI, so
      // it is short and markup-free (#3992). This sender keeps no other copy of
      // the body, so without this line the shortening would be the end of it on
      // the live alert path. Not a new secrets surface — the dispatcher's own
      // console.error already carried the unshortened form before #3992.
      console.error(
        `[PagerDutySender] Failed to send: ${formatHttpFailureDetail(response.status, responseBody, secrets)}`
      );
      return {
        success: false,
        statusCode: response.status,
        dedupKey,
        error: formatHttpFailure(response.status, responseBody, { secrets })
      };
    }

    return {
      success: true,
      statusCode: response.status,
      dedupKey
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        dedupKey,
        error: 'PagerDuty request timed out'
      };
    }

    return {
      success: false,
      dedupKey,
      error: error instanceof Error ? error.message : 'Unknown PagerDuty error'
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
