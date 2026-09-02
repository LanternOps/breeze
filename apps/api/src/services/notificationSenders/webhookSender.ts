/**
 * Webhook Notification Sender
 *
 * Sends alert notifications via HTTP webhooks.
 * Supports custom headers, authentication, and payload templates.
 */

import { isIP } from 'net';
import {
  isAlwaysBlockedIp,
  isPrivateIp,
  isRfc1918OrUla,
  safeFetch,
  SsrfBlockedError
} from '../urlSafety';
import { selfHostAllowsPrivateNetwork } from '../../config/env';
import { getOutboundHeaderValidationErrors, sanitizeOutboundHeaders, validateOutboundHeader } from '../outboundHeaders';
import { formatHttpFailure, formatHttpFailureDetail } from '../httpFailureMessage';
import { collectChannelSecretStrings } from '../notificationChannelSecrets';

export function redactUrlForLogs(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '[invalid-url]';
  }
}

export interface WebhookNotificationPayload {
  alertId: string;
  alertName: string;
  severity: string;
  summary: string;
  deviceId?: string;
  deviceName?: string;
  orgId: string;
  orgName?: string;
  triggeredAt: string;
  ruleId?: string;
  ruleName?: string;
  context?: Record<string, unknown>;
}

export interface WebhookConfig {
  url: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  authType?: 'none' | 'bearer' | 'basic' | 'api_key';
  authToken?: string;
  authUsername?: string;
  authPassword?: string;
  apiKeyHeader?: string;
  apiKeyValue?: string;
  timeout?: number; // milliseconds
  retryCount?: number;
  payloadTemplate?: string; // Optional JSON template
}

export interface SendResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  responseBody?: string;
}

export function validateWebhookUrlSafety(rawUrl: string): string[] {
  const errors: string[] = [];
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return ['Invalid URL format'];
  }

  // Self-hosted operators own both ends of the connection, so an on-LAN
  // receiver (SIEM, log collector, ticketing) may legitimately be plain http
  // on an RFC1918 address. Hosted SaaS stays HTTPS-only: a private target is
  // unreachable from us anyway and is a genuine SSRF vector.
  const allowPrivate = selfHostAllowsPrivateNetwork();

  if (parsed.protocol !== 'https:' && !(allowPrivate && parsed.protocol === 'http:')) {
    errors.push('Webhook URL must use HTTPS');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    errors.push('Webhook URL hostname is required');
    return errors;
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    errors.push('Webhook URL cannot target localhost or local network hostnames');
  }

  // `isAlwaysBlockedIp` is the shared policy: with private networking opted in
  // it permits RFC1918/ULA only, and still refuses loopback, link-local, cloud
  // metadata and CGNAT (100.64/10) — the ranges that are never a legitimate
  // receiver. Without the opt-in, `isPrivateIp` refuses every private range.
  const blocked = allowPrivate ? isAlwaysBlockedIp : isPrivateIp;
  const ipVersion = isIP(hostname);
  if (ipVersion !== 0 && blocked(hostname)) {
    errors.push(
      allowPrivate
        ? 'Webhook URL cannot target loopback, link-local, metadata, or CGNAT addresses'
        : 'Webhook URL cannot target private, loopback, or link-local addresses'
    );
  }

  // The cleartext concession exists for the on-LAN hop a self-host operator
  // owns end to end, not for the public internet. For a literal address we can
  // say so now; a hostname needs DNS, handled in the WithDns variant below.
  if (
    allowPrivate &&
    parsed.protocol === 'http:' &&
    ipVersion !== 0 &&
    !isRfc1918OrUla(hostname)
  ) {
    errors.push('Webhook URL may only use plain http for private (RFC1918/ULA) addresses');
  }

  return errors;
}

export async function validateWebhookUrlSafetyWithDns(rawUrl: string): Promise<string[]> {
  const errors = validateWebhookUrlSafety(rawUrl);
  if (errors.length > 0) {
    return errors;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return ['Invalid URL format'];
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) {
    return errors;
  }

  // Delegate to the shared resolver so both this config-time validator and
  // the runtime `safeFetch` apply identical rules. Using `dns/promises` via
  // `safeFetch`'s module-level hook keeps one code path for both checks.
  const { lookup } = await import('dns/promises');
  try {
    const resolved = await lookup(hostname, { all: true, verbatim: true });
    if (resolved.length === 0) {
      return ['Webhook URL hostname could not be resolved'];
    }

    const addresses = resolved.map((entry) => entry.address);
    const blockedTargets = addresses.filter(
      selfHostAllowsPrivateNetwork() ? isAlwaysBlockedIp : isPrivateIp
    );

    if (blockedTargets.length > 0) {
      errors.push(`Webhook URL resolves to blocked address space: ${blockedTargets.join(', ')}`);
    }

    // Cleartext to a hostname is only safe if EVERY answer is private: safeFetch
    // pins one record, and a mixed private/public rotation would otherwise let a
    // later delivery take the public one in the clear.
    if (
      parsed.protocol === 'http:' &&
      selfHostAllowsPrivateNetwork() &&
      !addresses.every(isRfc1918OrUla)
    ) {
      errors.push(
        `Webhook URL may only use plain http for private (RFC1918/ULA) addresses; ${hostname} resolves to ${addresses.join(', ')}`
      );
    }
  } catch {
    errors.push('Webhook URL hostname could not be resolved');
  }

  return errors;
}

/**
 * Send a webhook notification for an alert
 */
export async function sendWebhookNotification(
  config: WebhookConfig,
  payload: WebhookNotificationPayload
): Promise<SendResult> {
  // Fast-fail on obviously-bad URLs so we get a crisp error message before
  // involving the network stack. `safeFetch` below re-validates DNS-resolved
  // addresses at connection time, closing the TOCTOU window that a
  // separate `check-then-fetch` pattern would leave open.
  const staticErrors = validateWebhookUrlSafety(config.url);
  if (staticErrors.length > 0) {
    return {
      success: false,
      error: `Unsafe webhook URL: ${staticErrors.join('; ')}`
    };
  }

  const method = config.method || 'POST';
  const timeout = config.timeout || 30000; // 30 second default
  const maxRetries = config.retryCount || 0;

  // Build headers
  const headers: Record<string, string> = {
    ...sanitizeOutboundHeaders(config.headers),
    'Content-Type': 'application/json',
    'User-Agent': 'Breeze-RMM/1.0'
  };

  // Add authentication
  if (config.authType === 'bearer' && config.authToken) {
    headers['Authorization'] = `Bearer ${config.authToken}`;
  } else if (config.authType === 'basic' && config.authUsername && config.authPassword) {
    const credentials = Buffer.from(`${config.authUsername}:${config.authPassword}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  } else if (config.authType === 'api_key' && config.apiKeyHeader && config.apiKeyValue) {
    if (validateOutboundHeader(config.apiKeyHeader, config.apiKeyValue)) {
      return {
        success: false,
        error: 'Invalid API key header'
      };
    }
    headers[config.apiKeyHeader.trim()] = config.apiKeyValue;
  }

  // Build request body
  let body: string;
  if (config.payloadTemplate) {
    // Use custom template with variable substitution
    body = interpolatePayloadTemplate(config.payloadTemplate, payload);
  } else {
    // Use default payload structure
    body = JSON.stringify({
      event: 'alert.triggered',
      timestamp: new Date().toISOString(),
      alert: {
        id: payload.alertId,
        name: payload.alertName,
        severity: payload.severity,
        summary: payload.summary,
        triggeredAt: payload.triggeredAt,
        ruleId: payload.ruleId,
        ruleName: payload.ruleName
      },
      device: payload.deviceId ? {
        id: payload.deviceId,
        name: payload.deviceName
      } : null,
      organization: {
        id: payload.orgId,
        name: payload.orgName
      },
      context: payload.context
    });
  }

  // Send request with retries
  let lastError: string | undefined;
  // The operator-facing `lastError` is deliberately short and markup-free
  // (#3992); the unshortened form is kept for the log line below so debugging
  // a strange destination loses nothing.
  let lastErrorDetail: string | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await safeFetch(config.url, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'error',
        // Must mirror the save-time decision, or a URL we accepted would be
        // refused at delivery — the TOCTOU re-check is meant to catch DNS
        // rebinding, not to second-guess the deployment's own policy.
        allowPrivateNetwork: selfHostAllowsPrivateNetwork(),
        // The cleartext allowance is for the operator's own LAN hop; safeFetch
        // enforces it against the record it pins, so this cannot drift from the
        // address actually dialed.
        requirePrivateForCleartext: true
      });

      clearTimeout(timeoutId);

      const responseBody = await response.text();

      if (response.ok) {
        return {
          success: true,
          statusCode: response.status,
          responseBody
        };
      }

      // Non-2xx response
      // Redact the channel's own credentials from the RAW body first: the
      // route's scrub runs on the already-transformed string and matches by
      // literal substring, so it cannot catch what normalisation rewrote (#3992).
      const secrets = collectChannelSecretStrings('webhook', config);
      lastError = formatHttpFailure(response.status, responseBody, { secrets });
      lastErrorDetail = formatHttpFailureDetail(response.status, responseBody, secrets);

      // Don't retry on 4xx errors (client errors)
      if (response.status >= 400 && response.status < 500) {
        break;
      }
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        // DNS resolved to a private IP — do not retry, the answer won't change
        // on this timescale and we don't want to spam DNS either.
        return {
          success: false,
          error: `Unsafe webhook URL: ${error.message}`
        };
      }
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          lastError = 'Request timed out';
          lastErrorDetail = lastError;
        } else {
          lastError = error.message;
          lastErrorDetail = lastError;
        }
      } else {
        lastError = 'Unknown error';
        lastErrorDetail = lastError;
      }
    }

    // Wait before retry (exponential backoff)
    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }

  console.error(`[WebhookSender] Failed to send to ${redactUrlForLogs(config.url)}: ${lastErrorDetail ?? lastError}`);

  return {
    success: false,
    error: lastError
  };
}

/**
 * Interpolate variables in a payload template
 * Supports {{variable}} and {{nested.path}} syntax
 */
function interpolatePayloadTemplate(
  template: string,
  payload: WebhookNotificationPayload
): string {
  // Flatten payload for easier access
  const flatPayload: Record<string, unknown> = {
    alertId: payload.alertId,
    alertName: payload.alertName,
    severity: payload.severity,
    summary: payload.summary,
    deviceId: payload.deviceId,
    deviceName: payload.deviceName,
    orgId: payload.orgId,
    orgName: payload.orgName,
    triggeredAt: payload.triggeredAt,
    ruleId: payload.ruleId,
    ruleName: payload.ruleName,
    timestamp: new Date().toISOString(),
    ...payload.context
  };

  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
    const value = getNestedValue(flatPayload, path);
    if (value === undefined || value === null) {
      return match; // Keep original if no value
    }
    // Escape for JSON if it's a string
    if (typeof value === 'string') {
      return JSON.stringify(value).slice(1, -1); // Remove quotes
    }
    return String(value);
  });
}

/**
 * Get a nested value from an object using dot notation
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Validate webhook channel configuration
 */
export function validateWebhookConfig(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be an object'] };
  }

  const c = config as Record<string, unknown>;

  // URL is required
  if (!c.url || typeof c.url !== 'string') {
    errors.push('Missing or invalid URL');
  } else {
    errors.push(...validateWebhookUrlSafety(c.url));
  }

  // Validate method if provided
  if (c.method && !['POST', 'PUT', 'PATCH'].includes(c.method as string)) {
    errors.push('Method must be POST, PUT, or PATCH');
  }

  // Validate auth type if provided
  const validAuthTypes = ['none', 'bearer', 'basic', 'api_key'];
  if (c.authType && !validAuthTypes.includes(c.authType as string)) {
    errors.push(`Invalid auth type. Must be one of: ${validAuthTypes.join(', ')}`);
  }

  // Check auth fields based on type
  if (c.authType === 'bearer' && !c.authToken) {
    errors.push('Bearer auth requires authToken');
  }
  if (c.authType === 'basic' && (!c.authUsername || !c.authPassword)) {
    errors.push('Basic auth requires authUsername and authPassword');
  }
  if (c.authType === 'api_key' && (!c.apiKeyHeader || !c.apiKeyValue)) {
    errors.push('API key auth requires apiKeyHeader and apiKeyValue');
  }
  if (c.authType === 'api_key' && typeof c.apiKeyHeader === 'string' && typeof c.apiKeyValue === 'string') {
    const apiKeyHeaderError = validateOutboundHeader(c.apiKeyHeader, c.apiKeyValue);
    if (apiKeyHeaderError) errors.push(apiKeyHeaderError);
  }

  if (c.headers !== undefined) {
    if (!c.headers || typeof c.headers !== 'object' || Array.isArray(c.headers)) {
      errors.push('Headers must be an object');
    } else {
      errors.push(...getOutboundHeaderValidationErrors(c.headers as Record<string, string>));
    }
  }

  // Validate timeout if provided
  if (c.timeout !== undefined) {
    if (typeof c.timeout !== 'number' || c.timeout < 1000 || c.timeout > 60000) {
      errors.push('Timeout must be between 1000 and 60000 milliseconds');
    }
  }

  // Validate payload template if provided
  if (c.payloadTemplate !== undefined) {
    if (typeof c.payloadTemplate !== 'string') {
      errors.push('Payload template must be a string');
    } else {
      try {
        // Check if it's valid JSON (after simple placeholder replacement)
        const testTemplate = c.payloadTemplate.replace(/\{\{[\w.]+\}\}/g, '"test"');
        JSON.parse(testTemplate);
      } catch {
        errors.push('Payload template is not valid JSON');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Test a webhook endpoint with a test payload
 */
export async function testWebhook(config: WebhookConfig): Promise<SendResult> {
  const testPayload: WebhookNotificationPayload = {
    alertId: 'test-alert-id',
    alertName: 'Test Alert',
    severity: 'info',
    summary: 'This is a test notification from Breeze RMM',
    deviceId: 'test-device-id',
    deviceName: 'Test Device',
    orgId: 'test-org-id',
    orgName: 'Test Organization',
    triggeredAt: new Date().toISOString(),
    ruleId: 'test-rule-id',
    ruleName: 'Test Rule',
    context: {
      test: true,
      message: 'This is a test notification'
    }
  };

  return sendWebhookNotification(config, testPayload);
}
