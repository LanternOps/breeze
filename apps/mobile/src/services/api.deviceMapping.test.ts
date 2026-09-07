import { beforeEach, describe, expect, it, vi } from 'vitest';

// #5104: two independent mobile device-mapping bugs.
//   1. getDeviceMetrics() read `avgCpuPercent`/`avgRamPercent`/`avgDiskPercent`
//      off the metrics response, but GET /devices/:id/metrics
//      (apps/api/src/routes/devices/metrics.ts, aggregateMetricsByInterval)
//      sends buckets keyed `cpu`/`ram`/`disk` — so Device Details always
//      showed "-%" for an online device with real samples.
//   2. mapDevice() never read an org name off the device record at all, so
//      the org/site rows on Device Details and the org·site row meta on the
//      device list never rendered, even though the backend sends one under
//      `orgName` (single-device fetch) or `organizationName` (list fetch).

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue('tok'),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('@sentry/react-native', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn().mockResolvedValue('https://example.test') }));
vi.mock('./installationId', () => ({ getOrCreateInstallationId: vi.fn().mockResolvedValue('i') }));

const fetchWithTimeout = vi.fn();
vi.mock('./fetchWithTimeout', () => ({
  fetchWithTimeout: (...a: unknown[]) => fetchWithTimeout(...a),
}));

import { getDevice, getDevices, getDeviceMetrics } from './api';

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

beforeEach(() => {
  fetchWithTimeout.mockReset();
});

describe('getDeviceMetrics', () => {
  it('reads cpu/ram/disk off the real bucket shape, not avg*Percent', async () => {
    // Shaped exactly like aggregateMetricsByInterval's actual output:
    // ascending timestamp order, keyed cpu/ram/disk.
    fetchWithTimeout.mockImplementationOnce(() =>
      jsonResponse({
        data: [
          { timestamp: '2026-09-06T10:00:00.000Z', cpu: 10, ram: 20, disk: 30 },
          { timestamp: '2026-09-06T11:00:00.000Z', cpu: 42, ram: 55, disk: 61 },
        ],
      })
    );

    const metrics = await getDeviceMetrics('device-1');

    expect(metrics).toEqual({ cpuUsage: 42, memoryUsage: 55, diskUsage: 61 });
  });

  it('returns undefined when there are no buckets yet', async () => {
    fetchWithTimeout.mockImplementationOnce(() => jsonResponse({ data: [] }));

    expect(await getDeviceMetrics('device-1')).toBeUndefined();
  });
});

describe('organization mapping', () => {
  it('maps the single-device endpoint\'s `orgName` field onto organizationName', async () => {
    fetchWithTimeout.mockImplementationOnce(() =>
      jsonResponse({
        id: 'device-1',
        hostname: 'host-1',
        status: 'online',
        orgId: 'org-1',
        orgName: 'Acme Corp',
        siteId: 'site-1',
        siteName: 'HQ',
      })
    );

    const device = await getDevice('device-1');

    expect(device.organizationName).toBe('Acme Corp');
    expect(device.siteName).toBe('HQ');
  });

  it('maps the list endpoint\'s `organizationName` field', async () => {
    fetchWithTimeout.mockImplementationOnce(() =>
      jsonResponse({
        data: [
          {
            id: 'device-1',
            hostname: 'host-1',
            status: 'online',
            orgId: 'org-1',
            organizationName: 'Acme Corp',
          },
        ],
        pagination: { page: 1, limit: 100, total: 1, nextCursor: null },
      })
    );

    const [device] = await getDevices();

    expect(device!.organizationName).toBe('Acme Corp');
  });
});

// #5140: Device Details v1 fields (decision #5117-2) — osVersion, lastUser,
// lanIp, publicIp, openAlertCount, openTicketCount.
describe('Device Details v1 fields (#5140)', () => {
  it('maps all six fields when present', async () => {
    fetchWithTimeout.mockImplementationOnce(() =>
      jsonResponse({
        data: [
          {
            id: 'device-1',
            hostname: 'host-1',
            status: 'online',
            orgId: 'org-1',
            osVersion: '22.04',
            lastUser: 'jdoe',
            lanIp: '10.0.0.5',
            publicIp: '203.0.113.9',
            openAlertCount: 3,
            openTicketCount: 2,
          },
        ],
        pagination: { page: 1, limit: 100, total: 1, nextCursor: null },
      })
    );

    const [device] = await getDevices();

    expect(device!.osVersion).toBe('22.04');
    expect(device!.lastUser).toBe('jdoe');
    expect(device!.lanIp).toBe('10.0.0.5');
    expect(device!.publicIp).toBe('203.0.113.9');
    expect(device!.openAlertCount).toBe(3);
    expect(device!.openTicketCount).toBe(2);
  });

  it('maps an explicit null count (server-side count query failed) to undefined, not 0', async () => {
    fetchWithTimeout.mockImplementationOnce(() =>
      jsonResponse({
        data: [
          {
            id: 'device-1',
            hostname: 'host-1',
            status: 'online',
            orgId: 'org-1',
            openAlertCount: null,
            openTicketCount: 4,
          },
        ],
        pagination: { page: 1, limit: 100, total: 1, nextCursor: null },
      })
    );

    const [device] = await getDevices();

    // formatCountLabel (deviceDetailFields.ts) treats undefined the same as
    // null — an em dash, not a false "0" — so mapDevice normalizing an
    // explicit API-side null to undefined here is the correct behavior, not
    // a lossy simplification.
    expect(device!.openAlertCount).toBeUndefined();
    expect(device!.openTicketCount).toBe(4);
  });

  it('a device with none of the new fields still maps without throwing', async () => {
    fetchWithTimeout.mockImplementationOnce(() =>
      jsonResponse({
        data: [
          {
            id: 'device-1',
            hostname: 'host-1',
            status: 'online',
            orgId: 'org-1',
          },
        ],
        pagination: { page: 1, limit: 100, total: 1, nextCursor: null },
      })
    );

    const [device] = await getDevices();

    expect(device!.osVersion).toBeUndefined();
    expect(device!.lastUser).toBeUndefined();
    expect(device!.lanIp).toBeUndefined();
    expect(device!.publicIp).toBeUndefined();
    expect(device!.openAlertCount).toBeUndefined();
    expect(device!.openTicketCount).toBeUndefined();
  });
});
