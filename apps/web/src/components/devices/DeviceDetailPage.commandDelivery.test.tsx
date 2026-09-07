import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';

/**
 * #5128 W2 — the single-command toast on the device detail page now reads
 * the dispatch core's own `delivery`/`deliverBy` fields off the POST
 * response, rather than the pre-request `device.status` snapshot. This is a
 * real behavior change: a device that reads 'online' in the UI (so the
 * Reboot button is enabled) can still come back `queued_offline` from the
 * server — a race the old status-based heuristic could not represent.
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

const showToastMock = vi.hoisted(() => vi.fn());
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 404): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function deviceResponse() {
  return jsonResponse({
    id: DEVICE_ID,
    hostname: 'ws-detail-01',
    osType: 'windows',
    osVersion: '11',
    status: 'online',
    orgId: 'org-1',
    siteId: 'site-1',
    agentVersion: '1.0.0',
    tags: [],
    recentMetrics: [],
  });
}

async function rebootFromDetailPage(commandResponse: unknown) {
  fetchWithAuthMock.mockReset();
  showToastMock.mockReset();
  fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === `/devices/${DEVICE_ID}` && (!init || (init.method ?? 'GET') === 'GET')) {
      return Promise.resolve(deviceResponse());
    }
    if (url === `/devices/${DEVICE_ID}/commands` && init?.method === 'POST') {
      return Promise.resolve(jsonResponse(commandResponse));
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  });

  render(<DeviceDetailPage deviceId={DEVICE_ID} />);

  // The full (non-compact) action bar puts Reboot behind the "Power"
  // dropdown, not the "…" overflow menu.
  fireEvent.click(await screen.findByRole('button', { name: 'Power' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Reboot' }));
  // The dropdown item closes on click; the ConfirmDialog's "Reboot" button
  // is the only one left once it does.
  fireEvent.click(await screen.findByRole('button', { name: 'Reboot' }));

  await waitFor(() => expect(showToastMock).toHaveBeenCalled());
  return showToastMock.mock.calls.map((c) => c[0]);
}

describe('DeviceDetailPage single-command toast reads delivery, not device.status (#5128 W2)', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    showToastMock.mockReset();
  });

  it('reports "sent" when the server delivered the command', async () => {
    const toasts = await rebootFromDetailPage({
      id: 'cmd-1',
      deviceId: DEVICE_ID,
      type: 'reboot',
      status: 'sent',
      createdAt: '2026-09-01T00:00:00.000Z',
      delivery: 'delivered',
      deliverBy: null,
    });

    const success = toasts.find((t) => t.type === 'success');
    expect(success?.message).toMatch(/reboot command sent to ws-detail-01/i);
  });

  it('reports the runs-when-online copy — even though the UI showed the device online — when the server queued it offline', async () => {
    const toasts = await rebootFromDetailPage({
      id: 'cmd-1',
      deviceId: DEVICE_ID,
      type: 'reboot',
      status: 'pending',
      createdAt: '2026-09-01T00:00:00.000Z',
      delivery: 'queued_offline',
      deliverBy: '2026-09-08T00:00:00.000Z',
    });

    const success = toasts.find((t) => t.type === 'success');
    expect(success?.message).toMatch(/runs when the device is online/i);
    expect(success?.message).not.toMatch(/command sent/i);
  });
});
