/**
 * API helpers for test setup and teardown.
 *
 * These make direct HTTP calls to the Breeze API to create / clean up test
 * fixtures without going through the UI, keeping tests fast and independent.
 */

const API_BASE = process.env.E2E_API_URL || 'http://localhost:3001';

interface ApiClientOptions {
  baseUrl?: string;
  accessToken?: string;
}

export function apiClient(opts: ApiClientOptions = {}) {
  const baseUrl = (opts.baseUrl || API_BASE).replace(/\/$/, '');
  let token = opts.accessToken || '';

  async function request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      console.warn(`[apiClient] Non-JSON response from ${method} ${path} (status ${res.status}): ${text.substring(0, 200)}`);
      data = text as unknown as T;
    }

    return { status: res.status, data };
  }

  return {
    /** Update the bearer token used for subsequent requests. */
    setToken(newToken: string) {
      token = newToken;
    },

    /**
     * Authenticate and store the access token for later calls.
     * Returns the login response payload.
     */
    async login(email?: string, password?: string) {
      const e = email || process.env.E2E_ADMIN_EMAIL || 'admin@breeze.local';
      const p = password || process.env.E2E_ADMIN_PASSWORD || 'BreezeAdmin123!';

      const { status, data } = await request<{
        tokens?: { accessToken: string };
        error?: string;
      }>('POST', '/api/v1/auth/login', { email: e, password: p });

      if (status === 200 && data?.tokens?.accessToken) {
        token = data.tokens.accessToken;
      } else {
        console.error(`[apiClient] Login failed: status=${status}, error=${data?.error || 'unknown'}`);
      }

      return { status, data };
    },

    /**
     * Create a test device via the API (for tests that need fixture data).
     * Returns the created device record.
     */
    async createTestDevice(overrides: Record<string, unknown> = {}) {
      const payload = {
        hostname: `e2e-test-device-${Date.now()}`,
        platform: 'linux',
        ...overrides,
      };
      return request('POST', '/api/v1/devices', payload);
    },

    /**
     * Create a test script via the API.
     */
    async createTestScript(overrides: Record<string, unknown> = {}) {
      const payload = {
        name: `E2E Test Script ${Date.now()}`,
        language: 'bash',
        content: '#!/bin/bash\necho "hello from e2e"',
        ...overrides,
      };
      return request('POST', '/api/v1/scripts', payload);
    },

    /**
     * Create a test alert rule via the API.
     */
    async createTestAlert(overrides: Record<string, unknown> = {}) {
      const payload = {
        name: `E2E Alert Rule ${Date.now()}`,
        metric: 'cpu_usage',
        condition: 'gt',
        threshold: 90,
        severity: 'warning',
        ...overrides,
      };
      return request('POST', '/api/v1/alerts/rules', payload);
    },

    /**
     * Clean up test data created during test runs.
     * Deletes devices, scripts, and alert rules whose names start with "E2E".
     */
    async cleanupTestData() {
      // Best-effort cleanup -- individual failures are logged but do not throw.
      const endpoints = [
        '/api/v1/devices',
        '/api/v1/scripts',
        '/api/v1/alerts/rules',
      ];

      for (const endpoint of endpoints) {
        try {
          const { data } = await request<{ data?: { id: string; name?: string; hostname?: string }[] }>(
            'GET',
            endpoint,
          );

          const items = Array.isArray(data) ? data : (data as any)?.data ?? [];
          for (const item of items) {
            const label = item.name || item.hostname || '';
            if (label.startsWith('E2E') || label.startsWith('e2e-test-')) {
              try {
                await request('DELETE', `${endpoint}/${item.id}`);
              } catch (err) {
                console.warn(`[cleanup] Failed to delete ${endpoint}/${item.id}:`, err);
              }
            }
          }
        } catch (err) {
          console.warn(`[cleanup] Failed to list ${endpoint}:`, err);
        }
      }
    },

    /** Generic GET */
    get: <T = unknown>(path: string) => request<T>('GET', path),

    /** Generic POST */
    post: <T = unknown>(path: string, body?: unknown) => request<T>('POST', path, body),

    /** Generic PATCH */
    patch: <T = unknown>(path: string, body?: unknown) => request<T>('PATCH', path, body),

    /** Generic DELETE */
    del: <T = unknown>(path: string) => request<T>('DELETE', path),
  };
}
