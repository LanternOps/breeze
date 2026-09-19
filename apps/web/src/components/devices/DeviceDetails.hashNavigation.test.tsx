/**
 * #4229 — hash links inside the device detail page must switch tabs on click,
 * not only after a page refresh.
 *
 * These tests run with `installAstroClientRouterStandIn()`, without which a
 * plain jsdom click follows the browser default and passes even against the
 * broken code. See `components/shared/HashLink.tsx` for the mechanism.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';
import {
  installAstroClientRouterStandIn,
  type ClientRouterStandIn,
} from '../../__tests__/astroClientRouterStandIn';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

const useExtensionSlotDescriptorsMock = vi.hoisted(() => vi.fn());
vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: (...a: unknown[]) => useExtensionSlotDescriptorsMock(...a),
  default: () => <div data-testid="extension-slot-host-stub" />,
}));

// The two tab panels these links target are stubbed: the assertion is that the
// tab *switched*, not what each panel renders (covered by their own suites).
vi.mock('./DeviceEventLogViewer', () => ({
  default: ({ deviceId }: { deviceId: string }) => (
    <div data-testid="event-log-viewer-stub" data-device-id={deviceId} />
  ),
}));
vi.mock('./DeviceAlertHistory', () => ({
  default: ({ deviceId }: { deviceId: string }) => (
    <div data-testid="alert-history-stub" data-device-id={deviceId} />
  ),
}));

const device: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 12,
  ramPercent: 34,
  uptimeSeconds: 3600,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  pendingReboot: false,
  displayName: 'Edge 01',
} as Device;

const jsonResponse = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const notFound = (): Response =>
  ({
    ok: false,
    status: 404,
    statusText: 'NOT FOUND',
    json: vi.fn().mockResolvedValue({}),
  }) as unknown as Response;

let router: ClientRouterStandIn;

beforeEach(() => {
  window.location.hash = '';
  useExtensionSlotDescriptorsMock.mockReturnValue([]);
  // Every panel on the Overview tab loads independently; only the activity
  // feed's two calls need real payloads for the links under test to render.
  fetchWithAuthMock.mockImplementation((url: string) => {
    const href = String(url);
    if (href.includes('/events')) {
      return Promise.resolve(
        jsonResponse({
          data: [
            {
              id: 'e1',
              action: 'device.reboot',
              message: 'Reboot requested',
              result: 'success',
              timestamp: '2026-02-09T09:00:00.000Z',
              actor: { type: 'user', name: 'Jane Doe' },
            },
          ],
          pagination: { page: 1, limit: 10, total: null },
        }),
      );
    }
    if (href.includes('/alerts')) {
      return Promise.resolve(jsonResponse({ data: [{ id: 'a1' }, { id: 'a2' }] }));
    }
    return Promise.resolve(notFound());
  });
  router = installAstroClientRouterStandIn();
});

afterEach(() => {
  router.uninstall();
  window.location.hash = '';
});

describe('DeviceDetails hash-link navigation (#4229)', () => {
  it('opens the Activity view when "View all activity" is clicked, without a refresh', async () => {
    const user = userEvent.setup();
    render(<DeviceDetails device={device} />);

    const link = await screen.findByRole('link', { name: /View all activity/i });
    await user.click(link);

    const panel = await screen.findByTestId('event-log-viewer-stub');
    expect(panel.dataset.deviceId).toBe('device-1');
    expect(window.location.hash).toBe('#activities');
    // Astro's router must never have seen the click: if it had, it would have
    // pushState'd the fragment and no hashchange would ever fire.
    expect(router.intercepted).toHaveLength(0);
  });

  it('opens the Alerts view when the pinned active-alert link is clicked', async () => {
    const user = userEvent.setup();
    render(<DeviceDetails device={device} />);

    const link = await screen.findByRole('link', { name: /active alerts/i });
    await user.click(link);

    expect(await screen.findByTestId('alert-history-stub')).toBeInTheDocument();
    expect(window.location.hash).toBe('#alerts');
    expect(router.intercepted).toHaveLength(0);
  });

  it('keeps both links as real anchors carrying their fragment href', async () => {
    render(<DeviceDetails device={device} />);

    expect(await screen.findByRole('link', { name: /View all activity/i })).toHaveAttribute(
      'href',
      '#activities'
    );
    expect(screen.getByRole('link', { name: /active alerts/i })).toHaveAttribute(
      'href',
      '#alerts'
    );
  });
});
