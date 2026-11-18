import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';

/**
 * #10922 — the Connect button's tool menu is fed by two fields of GET
 * /devices/:id. The page's device transform is an explicit whitelist, so a
 * field it forgets is silently dropped and the menu never appears while every
 * other test stays green (the #800/#1273/#2138 dropped-field mode).
 */

vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: vi.fn() }),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
}));
vi.mock('../remote/ActiveSessionsBanner', () => ({ default: () => null }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: () => vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => null,
}));
vi.mock('./MoveDeviceOrgDialog', () => ({ default: () => null }));

// Surface exactly the props under test.
vi.mock('./DeviceDetails', () => ({
  default: ({ device }: { device: { remoteAccessProviders?: unknown; remoteAccessDefaultProviderId?: unknown } }) => (
    <div data-testid="remote-tools">
      {JSON.stringify({
        providers: device.remoteAccessProviders,
        defaultId: device.remoteAccessDefaultProviderId,
      })}
    </div>
  ),
}));

const DEVICE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const jsonResponse = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 404, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function serveDevice(extra: Record<string, unknown>) {
  vi.mocked(fetchWithAuth).mockImplementation((url: string) =>
    Promise.resolve(
      url === `/devices/${DEVICE_ID}`
        ? jsonResponse({
            id: DEVICE_ID,
            hostname: 'ws-01',
            osType: 'windows',
            status: 'online',
            orgId: 'org-1',
            siteId: 'site-1',
            tags: [],
            recentMetrics: [],
            ...extra,
          })
        : jsonResponse({}, false),
    ),
  );
}

async function renderedTools() {
  render(<DeviceDetailPage deviceId={DEVICE_ID} />);
  await waitFor(() => expect(screen.getByTestId('remote-tools')).toBeInTheDocument());
  return JSON.parse(screen.getByTestId('remote-tools').textContent ?? '{}');
}

beforeEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
});

describe('DeviceDetailPage — remote tool menu fields (#10922)', () => {
  it('carries remoteAccessProviders and remoteAccessDefaultProviderId through to the device', async () => {
    const providers = [
      { id: 'rustdesk', label: 'RustDesk', kind: 'protocol' },
      { id: 'sc', label: 'ScreenConnect', kind: 'web' },
    ];
    serveDevice({ remoteAccessProviders: providers, remoteAccessDefaultProviderId: 'rustdesk' });

    expect(await renderedTools()).toEqual({ providers, defaultId: 'rustdesk' });
  });

  it('defaults to no tools when an older API omits the fields', async () => {
    serveDevice({});

    expect(await renderedTools()).toEqual({ providers: [], defaultId: null });
  });
});
