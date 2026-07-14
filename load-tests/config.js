// Shared configuration for all k6 load test scenarios.
// Override via environment variables when running k6:
//   k6 run -e BASE_URL=https://breeze.example.com scenarios/auth.js

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
export const API_URL = `${BASE_URL}/api/v1`;
export const WS_BASE_URL = __ENV.WS_BASE_URL || BASE_URL.replace(/^http/, 'ws');
export const WS_API_URL = `${WS_BASE_URL}/api/v1`;

// Auth token for authenticated endpoints. Generate one via the API or use a
// long-lived API key created in the Breeze admin panel.
export const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

// Agent bearer token for agent-specific endpoints (heartbeat, etc.).
export const AGENT_TOKEN = __ENV.AGENT_TOKEN || '';

// A known device ID used in tests that target a specific device.
export const DEVICE_ID = __ENV.DEVICE_ID || '';

// Partner reconstruction export. The scenario intentionally uses the
// dedicated X-API-Key machine credential rather than AUTH_TOKEN.
export const PARTNER_API_KEY = __ENV.PARTNER_API_KEY || '';
export const PARTNER_API_MODE = (__ENV.PARTNER_API_MODE || 'both').toLowerCase();
export const PARTNER_API_PAGE_LIMIT = Number.parseInt(__ENV.PARTNER_API_PAGE_LIMIT || '500', 10);
export const INCREMENTAL_PAGE_LIMIT = Number.parseInt(__ENV.INCREMENTAL_PAGE_LIMIT || '500', 10);
export const INCREMENTAL_UPDATED_SINCE = __ENV.INCREMENTAL_UPDATED_SINCE || '';
export const PARTNER_API_CHECKPOINTS_JSON = __ENV.PARTNER_API_CHECKPOINTS_JSON || '';
export const PARTNER_API_SUMMARY_FILE = __ENV.PARTNER_API_SUMMARY_FILE || 'partner-api-export-summary.json';
export const PARTNER_API_INCREMENTAL_EXPECTED_RECORDS = Number.parseInt(
  __ENV.PARTNER_API_INCREMENTAL_EXPECTED_RECORDS || '0',
  10,
);
export const PARTNER_API_EXPECTED_DEVICES = Number.parseInt(__ENV.PARTNER_API_EXPECTED_DEVICES || '10000', 10);
export const PARTNER_API_MAX_RETRIES = Number.parseInt(__ENV.PARTNER_API_MAX_RETRIES || '5', 10);
export const PARTNER_API_MAX_PAGES = Number.parseInt(__ENV.PARTNER_API_MAX_PAGES || '100000', 10);

// Common HTTP headers
export function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${AUTH_TOKEN}`,
  };
}

export function agentHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${AGENT_TOKEN}`,
  };
}

export function partnerApiHeaders() {
  return {
    Accept: 'application/json',
    'X-API-Key': PARTNER_API_KEY,
  };
}

// Default thresholds shared across scenarios. Individual scripts may override.
export const defaultThresholds = {
  http_req_failed: ['rate<0.01'],       // < 1% error rate
  http_req_duration: ['p(95)<500'],     // p95 < 500ms
};

// Strict thresholds for high-volume agent endpoints.
export const agentThresholds = {
  http_req_failed: ['rate<0.001'],      // < 0.1% error rate
  http_req_duration: ['p(99)<2000'],    // p99 < 2s
};
