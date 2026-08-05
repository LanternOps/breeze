import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetails from './DeviceDetails';
import DeviceDetailPage from './DeviceDetailPage';
import type { Device } from './DeviceList';

/**
 * Wiring coverage for the collision-enrollment review banner (#2764).
 *
 * The banner's own behaviour lives in PossibleReplacementBanner.test.tsx. What
 * this file guards is the two hops that carry `possibleReplacementOfDeviceId`
 * to it, both of which are explicit whitelists and therefore the classic
 * silent-drop sites (#800 / #1273 / #2138):
 *   1. DeviceDetailPage's API-response → Device transform.
 *   2. DeviceDetails passing the field down to the banner.
 * Drop either and the banner never renders, with nothing else going red.
 */

const OLD_DEVICE_ID = '99999999-9999-9999-9999-999999999999';
const DEVICE_ID = '11111111-1111-1111-1111-111111111111';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => <div data-testid="extension-slot-host-stub" />,
}));

vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: () => () => undefined }),
}));
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setPageContext: () => undefined }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 404): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const baseDevice: Device = {
  id: DEVICE_ID,
  hostname: 'WIN-REBUILD-01',
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

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  // Every incidental panel fetch 404s; only the old-device summary below
  // matters, and the banner is required to render even when that 404s.
  fetchWithAuthMock.mockResolvedValue(jsonResponse({}, false, 404));
});

describe('DeviceDetails — possible-replacement banner wiring (#2764)', () => {
  it('renders the banner when the device carries a replacement link', async () => {
    render(
      <DeviceDetails
        device={{ ...baseDevice, possibleReplacementOfDeviceId: OLD_DEVICE_ID }}
      />,
    );

    expect(await screen.findByTestId('possible-replacement-banner')).toBeInTheDocument();
  });

  it('renders no banner for an ordinary device', async () => {
    render(<DeviceDetails device={{ ...baseDevice, possibleReplacementOfDeviceId: null }} />);

    // Wait for the page to settle so this cannot pass merely by rendering early.
    expect(await screen.findByText('WIN-REBUILD-01')).toBeInTheDocument();
    expect(screen.queryByTestId('possible-replacement-banner')).toBeNull();
  });
});

describe('DeviceDetailPage — carries possibleReplacementOfDeviceId through its transform (#2764)', () => {
  it('renders the banner from the API response field', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url === `/devices/${DEVICE_ID}`) {
        return Promise.resolve(
          jsonResponse({
            id: DEVICE_ID,
            hostname: 'WIN-REBUILD-01',
            osType: 'windows',
            osVersion: '11',
            status: 'online',
            orgId: 'org-1',
            siteId: 'site-1',
            agentVersion: '1.0.0',
            tags: [],
            recentMetrics: [],
            possibleReplacementOfDeviceId: OLD_DEVICE_ID,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, false, 404));
    });

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId('possible-replacement-banner')).toBeInTheDocument(),
    );
  });
});
