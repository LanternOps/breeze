import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RemoteToolsPage from './RemoteToolsPage';
import { fetchWithAuth } from '@/stores/auth';

/**
 * #5250 — Remote Tools fetched device desktop-access state once on mount and
 * never again: no interval, no visibility refetch, no event-stream
 * subscription. A helper recovering (or dropping) while this page stayed
 * open left Connect Desktop stuck gray/lit until the operator navigated
 * away and back. This proves the fix's two live-update paths:
 *   1. a `device.updated` event carrying `fields: ['desktopAccess']` flips
 *      the button WITHOUT remounting the page or issuing another fetch.
 *   2. the tab regaining visibility triggers a refetch.
 */

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// Captures the page's own onEvent handler so a test can deliver a synthetic
// device.updated event, mirroring the pattern in DevicesPage.orgScope.test.tsx.
type StreamEvent = { type: string; payload: Record<string, unknown> };
const eventStream = vi.hoisted(() => ({
  onEvent: null as null | ((event: StreamEvent) => void),
  subscribed: [] as string[][],
}));
vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: (opts: { onEvent: (event: StreamEvent) => void }) => {
    eventStream.onEvent = opts.onEvent;
    return {
      subscribe: (types: string[]) => {
        eventStream.subscribed.push(types);
      },
    };
  },
}));

function emitDeviceEvent(event: StreamEvent): void {
  if (!eventStream.onEvent) throw new Error('useEventStream never received an onEvent handler');
  act(() => {
    eventStream.onEvent!(event);
  });
}

// The real button drives desktop-session launch/deep-link flows unrelated to
// this suite; stub it to surface the exact prop under test.
vi.mock('./ConnectDesktopButton', () => ({
  default: ({ desktopAccess }: { desktopAccess: { mode?: string } | null }) => (
    <div data-testid="connect-desktop-mode">{desktopAccess?.mode ?? 'none'}</div>
  ),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown = {}, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 404,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response);

const DEVICE_ID = 'device-1';

beforeEach(() => {
  eventStream.onEvent = null;
  eventStream.subscribed = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url === `/devices/${DEVICE_ID}`) {
      return makeResponse({
        hostname: 'mac-canary-01',
        osType: 'macos',
        isHeadless: false,
        desktopAccess: { mode: 'unavailable', loginUiReachable: false, virtualDisplayReady: false, checkedAt: '2026-09-01T00:00:00.000Z' },
      });
    }
    // Every other incidental panel fetch (processes, etc.) 404s quietly.
    return makeResponse({}, false);
  });
});

const originalVisibilityState = document.visibilityState;

afterEach(() => {
  cleanup();
  Object.defineProperty(document, 'visibilityState', { value: originalVisibilityState, configurable: true });
});

const renderPage = () =>
  render(<RemoteToolsPage deviceId={DEVICE_ID} deviceName="host-1" deviceOs="macos" />);

describe('RemoteToolsPage live desktopAccess updates (#5250)', () => {
  it('subscribes to device.updated on mount', async () => {
    renderPage();

    await waitFor(() => {
      expect(eventStream.subscribed.flat()).toContain('device.updated');
    });
  });

  it('flips Connect Desktop from unavailable to available on a device.updated desktopAccess event, without a remount/refetch', async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('connect-desktop-mode')).toHaveTextContent(/^unavailable$/),
    );

    const fetchCallsBeforeEvent = fetchMock.mock.calls.length;

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
      expect(screen.getByTestId('connect-desktop-mode')).toHaveTextContent(/^user_session$/),
    );

    // Applied directly from the event payload — no extra fetch round-trip.
    expect(fetchMock.mock.calls.length).toBe(fetchCallsBeforeEvent);
  });

  it('ignores a device.updated event for a different device', async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('connect-desktop-mode')).toHaveTextContent(/^unavailable$/),
    );

    emitDeviceEvent({
      type: 'device.updated',
      payload: {
        deviceId: 'some-other-device',
        fields: ['desktopAccess'],
        desktopAccess: { mode: 'user_session', loginUiReachable: true, virtualDisplayReady: true, checkedAt: '2026-09-08T12:00:00.000Z' },
      },
    });

    expect(screen.getByTestId('connect-desktop-mode')).toHaveTextContent(/^unavailable$/);
  });

  it('refetches device info when the tab regains visibility', async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('connect-desktop-mode')).toHaveTextContent(/^unavailable$/),
    );

    // Helper recovers server-side; next refetch should pick it up.
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `/devices/${DEVICE_ID}`) {
        return makeResponse({
          hostname: 'mac-canary-01',
          osType: 'macos',
          isHeadless: false,
          desktopAccess: { mode: 'user_session', loginUiReachable: true, virtualDisplayReady: true, checkedAt: '2026-09-08T12:00:00.000Z' },
        });
      }
      return makeResponse({}, false);
    });

    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('connect-desktop-mode')).toHaveTextContent(/^user_session$/),
    );
  });

  // #5250 review — the happy-path test above only proved recovery
  // (unavailable → available); the helper DROPPING mid-session while the
  // page stays open is at least as important (it is a security-relevant
  // "is remote access still live" signal) and the handler code is
  // symmetric today, but nothing pinned that until this test.
  it('flips Connect Desktop from available to unavailable on a device.updated desktopAccess event (degrading transition)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `/devices/${DEVICE_ID}`) {
        return makeResponse({
          hostname: 'mac-canary-01',
          osType: 'macos',
          isHeadless: false,
          desktopAccess: { mode: 'user_session', loginUiReachable: true, virtualDisplayReady: true, checkedAt: '2026-09-01T00:00:00.000Z' },
        });
      }
      return makeResponse({}, false);
    });

    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('connect-desktop-mode')).toHaveTextContent(/^user_session$/),
    );

    emitDeviceEvent({
      type: 'device.updated',
      payload: {
        deviceId: DEVICE_ID,
        fields: ['desktopAccess'],
        desktopAccess: {
          mode: 'unavailable',
          loginUiReachable: false,
          virtualDisplayReady: false,
          reason: 'helper_not_connected',
          checkedAt: '2026-09-08T12:00:00.000Z',
        },
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('connect-desktop-mode')).toHaveTextContent(/^unavailable$/),
    );
  });

  // #5250 review — nothing previously exercised the `fields` guard itself on
  // this page (the "different device" test exercises a different
  // early-return); a device.updated event whose fields name something else
  // entirely (e.g. agentVersion) must not touch desktopAccess.
  it('ignores a device.updated event whose fields do not include desktopAccess', async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('connect-desktop-mode')).toHaveTextContent(/^unavailable$/),
    );

    emitDeviceEvent({
      type: 'device.updated',
      payload: {
        deviceId: DEVICE_ID,
        fields: ['agentVersion'],
        agentVersion: '0.110.0',
      },
    });

    expect(screen.getByTestId('connect-desktop-mode')).toHaveTextContent(/^unavailable$/);
  });

  // #5250 review — the handler's fallback branch (fields names desktopAccess
  // but the payload doesn't carry a value, e.g. an older API build) was
  // entirely untested: it must refetch rather than silently do nothing.
  it('refetches when a device.updated event names desktopAccess but the payload omits the value', async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('connect-desktop-mode')).toHaveTextContent(/^unavailable$/),
    );

    const fetchCallsBeforeEvent = fetchMock.mock.calls.filter(([url]) => url === `/devices/${DEVICE_ID}`).length;

    // Helper recovers server-side; the event names the field but (as an
    // older API build would) carries no value, so the page must fall back
    // to a fetch rather than silently doing nothing.
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `/devices/${DEVICE_ID}`) {
        return makeResponse({
          hostname: 'mac-canary-01',
          osType: 'macos',
          isHeadless: false,
          desktopAccess: { mode: 'user_session', loginUiReachable: true, virtualDisplayReady: true, checkedAt: '2026-09-08T12:00:00.000Z' },
        });
      }
      return makeResponse({}, false);
    });

    emitDeviceEvent({
      type: 'device.updated',
      payload: {
        deviceId: DEVICE_ID,
        fields: ['desktopAccess'],
        // No `desktopAccess` key at all.
      },
    });

    await waitFor(() => {
      const callsAfter = fetchMock.mock.calls.filter(([url]) => url === `/devices/${DEVICE_ID}`).length;
      expect(callsAfter).toBeGreaterThan(fetchCallsBeforeEvent);
    });
    await waitFor(() =>
      expect(screen.getByTestId('connect-desktop-mode')).toHaveTextContent(/^user_session$/),
    );
  });
});
