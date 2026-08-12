import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';

/**
 * "Network asset" back-link row (#3261 Task 4): DeviceDetails' Overview area
 * fetches `GET /discovery/assets?linkedDeviceId=<deviceId>` and renders a
 * link (single match) or a short list (multiple matches), nothing for zero.
 */

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => <div data-testid="extension-slot-host-stub" />,
}));

const DEVICE_ID = 'device-1';

const baseDevice: Device = {
  id: DEVICE_ID,
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 5,
  ramPercent: 5,
  uptimeSeconds: 3600,
  lastSeen: '2026-08-02T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  tags: [],
} as Device;

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 404): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const ASSETS_URL = `/discovery/assets?linkedDeviceId=${DEVICE_ID}`;

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  // Every incidental panel fetch 404s by default; only the network-asset
  // lookup below is overridden per test.
  fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 404));
});

describe('DeviceDetails — "Network asset" back-link (#3261)', () => {
  it('renders a single link when exactly one asset links to this device', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url === ASSETS_URL) {
        return Promise.resolve(
          makeJsonResponse({
            data: [{ id: 'asset-1', label: 'Core Switch', ipAddress: '10.0.0.2' }],
          }),
        );
      }
      return Promise.resolve(makeJsonResponse({}, false, 404));
    });

    render(<DeviceDetails device={baseDevice} />);

    const link = await screen.findByTestId('device-network-asset-link');
    expect(link.getAttribute('href')).toBe('/devices/network/asset-1');
    expect(link.textContent).toContain('Core Switch');
    expect(screen.queryByTestId('device-network-asset-list')).toBeNull();
  });

  it('renders a short list when more than one asset links to this device', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url === ASSETS_URL) {
        return Promise.resolve(
          makeJsonResponse({
            data: [
              { id: 'asset-1', label: 'Core Switch', ipAddress: '10.0.0.2' },
              { id: 'asset-2', hostname: 'core-switch-02', ipAddress: '10.0.0.3' },
            ],
          }),
        );
      }
      return Promise.resolve(makeJsonResponse({}, false, 404));
    });

    render(<DeviceDetails device={baseDevice} />);

    const list = await screen.findByTestId('device-network-asset-list');
    expect(list.textContent).toContain('Core Switch');
    expect(list.textContent).toContain('core-switch-02');
    const links = screen.getAllByRole('link', { name: /Core Switch|core-switch-02/ });
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/devices/network/asset-1',
      '/devices/network/asset-2',
    ]);
    expect(screen.queryByTestId('device-network-asset-link')).toBeNull();
  });

  it('renders nothing when zero assets link to this device', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url === ASSETS_URL) {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      return Promise.resolve(makeJsonResponse({}, false, 404));
    });

    render(<DeviceDetails device={baseDevice} />);

    // Wait for the page to settle so this cannot pass merely by rendering
    // before the fetch resolves.
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(ASSETS_URL));
    expect(screen.queryByTestId('device-network-asset-link')).toBeNull();
    expect(screen.queryByTestId('device-network-asset-list')).toBeNull();
  });
});
