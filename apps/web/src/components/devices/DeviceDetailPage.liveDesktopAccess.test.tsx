import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';

/**
 * #5250 — Overview's `device.updated` handler only ever applied the
 * `agentVersion` field; a `desktopAccess` change (the heartbeat now also
 * publishes this event for that field — see heartbeat.ts) previously fell
 * on the floor and Overview only "looked" live because navigating to it
 * remounts and refetches. This proves the handler actually applies a
 * `desktopAccess` event to the rendered device WITHOUT a remount/refetch.
 */

// Captures the page's own onEvent handler so a test can deliver a
// synthetic device.updated event, mirroring the pattern in
// DevicesPage.orgScope.test.tsx.
type DeviceEvent = { type: string; payload: Record<string, unknown> };
const eventStream = vi.hoisted(() => ({
  onEvent: null as null | ((event: DeviceEvent) => void),
}));
vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: (opts: { onEvent: (event: DeviceEvent) => void }) => {
    eventStream.onEvent = opts.onEvent;
    return { subscribe: vi.fn() };
  },
}));

function emitDeviceEvent(event: DeviceEvent): void {
  if (!eventStream.onEvent) throw new Error('useEventStream never received an onEvent handler');
  eventStream.onEvent(event);
}

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: () => vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => <div data-testid="extension-slot-host-stub" />,
}));

// DeviceDetails is the heavy presentational tree; stub it to a thin element
// that surfaces the exact prop under test so the assertion is about the
// page's state, not DeviceDetails' own rendering.
vi.mock('./DeviceDetails', () => ({
  default: ({ device }: { device: { desktopAccess?: { mode?: string } | null } }) => (
    <div data-testid="desktop-access-mode">{device.desktopAccess?.mode ?? 'none'}</div>
  ),
}));

const DEVICE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 404): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

beforeEach(() => {
  eventStream.onEvent = null;
  vi.mocked(fetchWithAuth).mockReset();
  vi.mocked(fetchWithAuth).mockImplementation((url: string) => {
    if (url === `/devices/${DEVICE_ID}`) {
      return Promise.resolve(
        jsonResponse({
          id: DEVICE_ID,
          hostname: 'mac-canary-01',
          osType: 'macos',
          status: 'online',
          orgId: 'org-1',
          siteId: 'site-1',
          agentVersion: '0.109.0',
          tags: [],
          recentMetrics: [],
          desktopAccess: { mode: 'unavailable', loginUiReachable: false, virtualDisplayReady: false, checkedAt: '2026-09-01T00:00:00.000Z' },
        }),
      );
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  });
});

describe('DeviceDetailPage — live desktopAccess via device.updated (#5250)', () => {
  it('applies a desktopAccess event without a remount/refetch', async () => {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId('desktop-access-mode')).toHaveTextContent(/^unavailable$/),
    );

    const fetchCallsBeforeEvent = vi.mocked(fetchWithAuth).mock.calls.length;

    emitDeviceEvent({
      type: 'device.updated',
      payload: {
        deviceId: DEVICE_ID,
        fields: ['desktopAccess'],
        desktopAccess: {
          mode: 'user_session',
          loginUiReachable: true,
          virtualDisplayReady: true,
          checkedAt: '2026-09-08T12:00:00.000Z',
        },
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('desktop-access-mode')).toHaveTextContent(/^user_session$/),
    );

    // No extra fetch was triggered — the event payload was applied directly.
    expect(vi.mocked(fetchWithAuth).mock.calls.length).toBe(fetchCallsBeforeEvent);
  });

  it('ignores a device.updated event for a different device', async () => {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId('desktop-access-mode')).toHaveTextContent(/^unavailable$/),
    );

    emitDeviceEvent({
      type: 'device.updated',
      payload: {
        deviceId: 'some-other-device',
        fields: ['desktopAccess'],
        desktopAccess: { mode: 'user_session', loginUiReachable: true, virtualDisplayReady: true, checkedAt: '2026-09-08T12:00:00.000Z' },
      },
    });

    // Still the original value — the event was for a different device.
    expect(screen.getByTestId('desktop-access-mode')).toHaveTextContent(/^unavailable$/);
  });

  it('ignores a device.updated event whose fields do not include desktopAccess', async () => {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId('desktop-access-mode')).toHaveTextContent(/^unavailable$/),
    );

    emitDeviceEvent({
      type: 'device.updated',
      payload: {
        deviceId: DEVICE_ID,
        fields: ['agentVersion'],
        agentVersion: '0.110.0',
      },
    });

    expect(screen.getByTestId('desktop-access-mode')).toHaveTextContent(/^unavailable$/);
  });
});
