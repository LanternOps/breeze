import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';

/**
 * Wiring coverage for the agent-uninstall badge (#3987 item 7).
 *
 * `GET /devices/:id` returns `uninstall: { state, ... }`, but
 * DeviceDetailPage's API-response → Device transform is an explicit whitelist
 * (see the comments in DeviceDetailPage.tsx about exactly this failure mode
 * for `possibleReplacementOfDeviceId` / `linkGroupId` / `rebootScheduledAt`),
 * so a dropped field here silently kills UninstallStateBadge — its `undefined`
 * guard returns null — with nothing else going red.
 *
 * The null-vs-undefined distinction is load-bearing and is the reason for the
 * second test: on the DETAIL payload an absent field means "this Remove queued
 * no uninstall", which the badge is required to report as "left installed".
 * Only `null` says that; `undefined` means "this payload does not carry the
 * field" and renders nothing. A transform that forwarded `data.uninstall`
 * unchanged would pass the first test and fail the second.
 */

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';

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

/** The badge only renders on a removed device — every fixture is one. */
const removedDevice = (extra: Record<string, unknown>) => ({
  id: DEVICE_ID,
  hostname: 'WIN-RETIRED-01',
  osType: 'windows',
  osVersion: '11',
  status: 'decommissioned',
  orgId: 'org-1',
  siteId: 'site-1',
  agentVersion: '1.0.0',
  tags: [],
  recentMetrics: [],
  ...extra,
});

function mockDetail(payload: Record<string, unknown>) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === `/devices/${DEVICE_ID}`) return Promise.resolve(jsonResponse(payload));
    return Promise.resolve(jsonResponse({}, false, 404));
  });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  // Every incidental panel fetch 404s; only the device-detail fetch matters,
  // and the badge is required to render even when those 404.
  fetchWithAuthMock.mockResolvedValue(jsonResponse({}, false, 404));
});

describe('DeviceDetailPage — carries `uninstall` through its transform (#3987)', () => {
  it('renders the uninstall-state badge from the API response field', async () => {
    mockDetail(
      removedDevice({
        uninstall: {
          state: 'pending',
          queuedAt: '2026-09-05T10:00:00.000Z',
          sentAt: null,
          completedAt: null,
          // Far enough out that the relative deadline never goes negative as
          // the suite ages; the badge only needs A deadline, not a specific one.
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      }),
    );

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    const badge = await waitFor(() => screen.getByTestId('uninstall-state'));
    expect(badge).toHaveAttribute('data-state', 'pending');
    // Presence + state alone would still pass if the deadline were dropped, and
    // the deadline is what tells a tech whether to wait or go touch the machine.
    expect(badge).toHaveTextContent(/expires/i);
  });

  it('reports "left installed" when the detail payload carries no uninstall', async () => {
    mockDetail(removedDevice({}));

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    // `undefined` would render nothing at all here — the transform owes the
    // badge an explicit `null` so a removed device with no queued uninstall
    // says so instead of staying silent.
    const badge = await waitFor(() => screen.getByTestId('uninstall-state'));
    expect(badge).toHaveAttribute('data-state', 'none');
    expect(badge).toHaveTextContent(/left installed/i);
  });
});
