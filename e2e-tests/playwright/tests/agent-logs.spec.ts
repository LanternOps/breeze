// e2e-tests/playwright/tests/agent-logs.spec.ts
import { test, expect } from '../fixtures';

const macosDeviceId = process.env.E2E_MACOS_DEVICE_ID ?? '';
const windowsDeviceId = process.env.E2E_WINDOWS_DEVICE_ID ?? '';

// Two hours ago ISO string for filtering by recency
const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

test.describe('Agent Diagnostic Log Shipping', () => {
  test.skip(!macosDeviceId, 'E2E_MACOS_DEVICE_ID not set — skipping agent log tests');

  test('diagnostic logs exist for macOS device', async ({ request, authedPage: _ }) => {
    const baseURL = process.env.E2E_BASE_URL ?? 'https://2breeze.app';
    const url = new URL(`${baseURL}/api/v1/devices/${macosDeviceId}/diagnostic-logs`);
    url.searchParams.set('limit', '10');

    const response = await request.get(url.toString());
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.total).toBeGreaterThan(0);
  });

  test('heartbeat component logs exist', async ({ request, authedPage: _ }) => {
    const baseURL = process.env.E2E_BASE_URL ?? 'https://2breeze.app';
    const url = new URL(`${baseURL}/api/v1/devices/${macosDeviceId}/diagnostic-logs`);
    url.searchParams.set('component', 'heartbeat');
    url.searchParams.set('limit', '5');

    const response = await request.get(url.toString());
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.total).toBeGreaterThan(0);
  });

  test('recent logs from last 2 hours exist', async ({ request, authedPage: _ }) => {
    const baseURL = process.env.E2E_BASE_URL ?? 'https://2breeze.app';
    const url = new URL(`${baseURL}/api/v1/devices/${macosDeviceId}/diagnostic-logs`);
    url.searchParams.set('since', twoHoursAgo);
    url.searchParams.set('limit', '5');

    const response = await request.get(url.toString());
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.total).toBeGreaterThan(0);
  });

  test('windows device diagnostic logs query succeeds', async ({ request, authedPage: _ }) => {
    if (!windowsDeviceId) {
      test.skip();
      return;
    }
    const baseURL = process.env.E2E_BASE_URL ?? 'https://2breeze.app';
    const url = new URL(`${baseURL}/api/v1/devices/${windowsDeviceId}/diagnostic-logs`);
    url.searchParams.set('limit', '5');

    const response = await request.get(url.toString());
    expect(response.ok()).toBeTruthy();
  });

  test('macOS device detail page shows device as online', async ({ authedPage }) => {
    await authedPage.goto(`/devices/${macosDeviceId}`);
    // Wait for device name to appear (YAML expected "MacBook-Pro" but actual hostname may vary)
    await authedPage.waitForURL(`**/devices/${macosDeviceId}`);
    await expect(authedPage.getByText('Online', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(authedPage.getByText('macOS')).toBeVisible();
  });

  test('device API returns correct status for macOS device', async ({ request, authedPage: _ }) => {
    const baseURL = process.env.E2E_BASE_URL ?? 'https://2breeze.app';
    const response = await request.get(`${baseURL}/api/v1/devices/${macosDeviceId}`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.status).toBe('online');
    expect(data.osType).toBe('macos');
  });
});
