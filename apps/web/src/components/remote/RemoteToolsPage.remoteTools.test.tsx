import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RemoteToolsPage from './RemoteToolsPage';
import { fetchWithAuth } from '@/stores/auth';

/**
 * #10922 — Remote Tools keeps the Connect button's tool menu in hand-written
 * state filled from GET /devices/:id. A dropped field there silently removes
 * the menu on this page while every other suite stays green.
 */

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: vi.fn() }),
}));

// Surface exactly the props under test.
vi.mock('./ConnectDesktopButton', () => ({
  default: (props: { remoteAccessProviders?: unknown; remoteAccessDefaultProviderId?: unknown }) => (
    <div data-testid="connect-desktop-tools">
      {JSON.stringify({ providers: props.remoteAccessProviders, defaultId: props.remoteAccessDefaultProviderId })}
    </div>
  ),
}));

const DEVICE_ID = 'device-1';
const fetchMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown = {}, ok = true): Response =>
  ({ ok, status: ok ? 200 : 404, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function serveDevice(extra: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) =>
    url === `/devices/${DEVICE_ID}`
      ? makeResponse({ hostname: 'ws-01', osType: 'windows', isHeadless: false, desktopAccess: null, ...extra })
      : makeResponse({}, false),
  );
}

async function renderedTools() {
  render(<RemoteToolsPage deviceId={DEVICE_ID} deviceName="ws-01" deviceOs="windows" />);
  const el = await screen.findByTestId('connect-desktop-tools');
  return el;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('RemoteToolsPage — remote tool menu fields (#10922)', () => {
  it('passes the device\'s tools and default through to Connect Desktop', async () => {
    const providers = [
      { id: 'rustdesk', label: 'RustDesk', kind: 'protocol' },
      { id: 'sc', label: 'ScreenConnect', kind: 'web' },
    ];
    serveDevice({ remoteAccessProviders: providers, remoteAccessDefaultProviderId: 'rustdesk' });

    const el = await renderedTools();

    await waitFor(() =>
      expect(JSON.parse(el.textContent ?? '{}')).toEqual({ providers, defaultId: 'rustdesk' }),
    );
  });

  it('passes no tools when an older API omits the fields', async () => {
    serveDevice({});

    const el = await renderedTools();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/devices/${DEVICE_ID}`));
    expect(JSON.parse(el.textContent ?? '{}')).toEqual({ providers: [], defaultId: null });
  });
});
