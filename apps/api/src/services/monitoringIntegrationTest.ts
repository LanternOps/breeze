export type MonitoringTestProvider = 'prometheus' | 'grafana' | 'pagerDuty' | 'opsGenie' | 'webhooks';

export interface MonitoringTestInput {
  provider: MonitoringTestProvider;
  /** The provider's settings object as the UI holds it (secrets already resolved to plaintext). */
  config: Record<string, unknown>;
  /** webhooks only: which endpoint to test. */
  endpointId?: string;
  allowPrivateNetwork: boolean;
}

export interface MonitoringTestFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
}

export interface MonitoringTestDeps {
  fetch: (url: string, init: MonitoringTestFetchInit) => Promise<Response>;
}

export type MonitoringTestResult =
  | { ok: true; message: string }
  | { ok: false; kind: 'invalid' | 'unreachable' | 'rejected'; message: string };

interface WebhookEndpointLike {
  id?: unknown;
  name?: unknown;
  url?: unknown;
  enabled?: unknown;
}

export const MONITORING_TEST_PROVIDERS: readonly MonitoringTestProvider[] = ['prometheus', 'grafana', 'pagerDuty', 'opsGenie', 'webhooks'] as const;

function requireHttpUrl(value: unknown, label: string): { ok: true; url: string } | { ok: false; message: string } {
  if (typeof value !== 'string' || !value) return { ok: false, message: `${label} must be an http(s) URL` };
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, message: `${label} must be an http(s) URL` };
    return { ok: true, url: value.replace(/\/+$/, '') };
  } catch {
    return { ok: false, message: `${label} must be an http(s) URL` };
  }
}

export async function testMonitoringProvider(input: MonitoringTestInput, deps: MonitoringTestDeps): Promise<MonitoringTestResult> {
  const { provider, config, endpointId, allowPrivateNetwork } = input;

  if (provider === 'prometheus') {
    const baseResult = requireHttpUrl(config.endpointUrl, 'Prometheus endpoint URL');
    if (!baseResult.ok) return { ok: false, kind: 'invalid', message: baseResult.message };
    const base = baseResult.url;

    try {
      let res = await deps.fetch(`${base}/-/healthy`, { method: 'GET', timeoutMs: 10_000, allowPrivateNetwork });
      if (res.ok) return { ok: true, message: 'Prometheus is reachable.' };
      const metricsPath = (config.metricsPath as string | undefined) || '/metrics';
      res = await deps.fetch(`${base}${metricsPath}`, { method: 'GET', timeoutMs: 10_000, allowPrivateNetwork });
      if (res.ok) return { ok: true, message: 'Metrics endpoint is reachable.' };
      return { ok: false, kind: 'unreachable', message: `Prometheus returned HTTP ${res.status}` };
    } catch (e) {
      const err = e as Error;
      return { ok: false, kind: 'unreachable', message: `Could not reach ${new URL(base).host}: ${err.message}` };
    }
  }

  if (provider === 'grafana') {
    const urlResult = requireHttpUrl(config.url, 'Grafana URL');
    if (!urlResult.ok) return { ok: false, kind: 'invalid', message: urlResult.message };
    const apiKey = config.apiKey;
    if (typeof apiKey !== 'string' || !apiKey) return { ok: false, kind: 'invalid', message: 'Enter the Grafana API key before testing' };

    try {
      const res = await deps.fetch(`${urlResult.url}/api/org`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: 10_000,
        allowPrivateNetwork
      });
      if (res.ok) return { ok: true, message: 'Grafana accepted the API key.' };
      if (res.status === 401 || res.status === 403) return { ok: false, kind: 'rejected', message: 'Grafana rejected the API key.' };
      return { ok: false, kind: 'unreachable', message: `Grafana returned HTTP ${res.status}` };
    } catch (e) {
      const err = e as Error;
      return { ok: false, kind: 'unreachable', message: `Could not reach ${new URL(urlResult.url).host}: ${err.message}` };
    }
  }

  if (provider === 'pagerDuty') {
    const key = config.integrationKey;
    if (typeof key !== 'string' || !/^[0-9a-f]{32}$/i.test(key)) {
      return { ok: false, kind: 'invalid', message: 'PagerDuty integration key must be the 32-character Events API v2 key' };
    }
    return { ok: true, message: 'Integration key format is valid. PagerDuty offers no dry-run; the first real alert confirms delivery.' };
  }

  if (provider === 'opsGenie') {
    const apiKey = config.apiKey;
    if (typeof apiKey !== 'string' || !apiKey) return { ok: false, kind: 'invalid', message: 'Enter the Opsgenie API key before testing' };

    try {
      const res = await deps.fetch('https://api.opsgenie.com/v2/account', {
        method: 'GET',
        headers: { Authorization: `GenieKey ${apiKey}` },
        timeoutMs: 10_000,
        allowPrivateNetwork
      });
      if (res.ok) return { ok: true, message: 'Opsgenie accepted the API key.' };
      if (res.status === 401 || res.status === 403) return { ok: false, kind: 'rejected', message: 'Opsgenie rejected the API key.' };
      return { ok: false, kind: 'unreachable', message: `Opsgenie returned HTTP ${res.status}` };
    } catch (e) {
      const err = e as Error;
      return { ok: false, kind: 'unreachable', message: `Could not reach api.opsgenie.com: ${err.message}` };
    }
  }

  if (provider === 'webhooks') {
    const endpoints = config.endpoints;
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      return { ok: false, kind: 'invalid', message: 'No webhook endpoint to test' };
    }

    const candidates = endpoints as WebhookEndpointLike[];
    const selected = (endpointId ? candidates.find((e) => e.id === endpointId) : undefined)
      ?? candidates.find((e) => e.enabled === true)
      ?? candidates[0];
    if (!selected) return { ok: false, kind: 'invalid', message: 'No webhook endpoint to test' };

    const urlResult = requireHttpUrl(selected.url, 'Webhook URL');
    if (!urlResult.ok) return { ok: false, kind: 'invalid', message: urlResult.message };

    const name = typeof selected.name === 'string' && selected.name ? selected.name : new URL(urlResult.url).host;

    try {
      const res = await deps.fetch(urlResult.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'breeze.monitoring.test', sentAt: new Date().toISOString() }),
        timeoutMs: 10_000,
        allowPrivateNetwork
      });
      if (res.ok) return { ok: true, message: `Webhook ${name} accepted the test event (HTTP ${res.status}).` };
      if (res.status === 401 || res.status === 403) return { ok: false, kind: 'rejected', message: `Webhook ${name} rejected the test event (HTTP ${res.status})` };
      return { ok: false, kind: 'unreachable', message: `Webhook ${name} returned HTTP ${res.status}` };
    } catch (e) {
      const err = e as Error;
      return { ok: false, kind: 'unreachable', message: `Could not reach ${new URL(urlResult.url).host}: ${err.message}` };
    }
  }

  return { ok: false, kind: 'invalid', message: 'Unsupported monitoring provider' };
}