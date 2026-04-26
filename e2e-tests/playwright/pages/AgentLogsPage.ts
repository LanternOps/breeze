// e2e-tests/playwright/pages/AgentLogsPage.ts
// Covers the device detail page and diagnostic logs API interactions
import { type APIRequestContext } from '@playwright/test';
import { BasePage } from './BasePage';

export class AgentLogsPage extends BasePage {
  readonly baseUrl = '/devices';

  deviceDetailHeading(name: string) {
    return this.page.getByText(name);
  }

  onlineStatus() {
    return this.page.getByText('Online', { exact: true });
  }

  macosText() {
    return this.page.getByText('macOS');
  }

  async gotoDeviceDetail(deviceId: string) {
    await this.page.goto(`${this.baseUrl}/${deviceId}`);
  }

  // API helper: query diagnostic logs for a device
  static async queryDiagnosticLogs(
    request: APIRequestContext,
    baseURL: string,
    deviceId: string,
    params: Record<string, string> = {}
  ) {
    const url = new URL(`${baseURL}/api/v1/devices/${deviceId}/diagnostic-logs`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    const response = await request.get(url.toString());
    return response.json();
  }

  // API helper: query device info
  static async queryDevice(
    request: APIRequestContext,
    baseURL: string,
    deviceId: string
  ) {
    const response = await request.get(`${baseURL}/api/v1/devices/${deviceId}`);
    return response.json();
  }
}
