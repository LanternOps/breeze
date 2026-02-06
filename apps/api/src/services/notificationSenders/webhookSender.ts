/**
 * Webhook Notification Sender
 *
 * Sends alert notifications via HTTP webhooks.
 * Supports custom headers, authentication, and payload templates.
 */

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
  method?: 'POST' | 'PUT';
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

/**
 * Send a webhook notification for an alert
 */
export async function sendWebhookNotification(
  config: WebhookConfig,
  payload: WebhookNotificationPayload
): Promise<SendResult> {
  const method = config.method || 'POST';
  const timeout = config.timeout || 30000; // 30 second default
  const maxRetries = config.retryCount || 0;

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Breeze-RMM/1.0',
    ...(config.headers || {})
  };

  // Add authentication
  if (config.authType === 'bearer' && config.authToken) {
    headers['Authorization'] = `Bearer ${config.authToken}`;
  } else if (config.authType === 'basic' && config.authUsername && config.authPassword) {
    const credentials = Buffer.from(`${config.authUsername}:${config.authPassword}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  } else if (config.authType === 'api_key' && config.apiKeyHeader && config.apiKeyValue) {
    headers[config.apiKeyHeader] = config.apiKeyValue;
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
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(config.url, {
        method,
        headers,
        body,
        signal: controller.signal
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
      lastError = `HTTP ${response.status}: ${responseBody.substring(0, 500)}`;

      // Don't retry on 4xx errors (client errors)
      if (response.status >= 400 && response.status < 500) {
        break;
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          lastError = 'Request timed out';
        } else {
          lastError = error.message;
        }
      } else {
        lastError = 'Unknown error';
      }
    }

    // Wait before retry (exponential backoff)
    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }

  console.error(`[WebhookSender] Failed to send to ${config.url}: ${lastError}`);

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
    try {
      new URL(c.url);
    } catch {
      errors.push('Invalid URL format');
    }
  }

  // Validate method if provided
  if (c.method && !['POST', 'PUT'].includes(c.method as string)) {
    errors.push('Method must be POST or PUT');
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
