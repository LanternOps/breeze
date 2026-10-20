import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../../hooks/useEventStream', () => ({ useEventStream: () => ({ subscribe: vi.fn() }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: () => vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./DeviceDetails', () => ({
  default: ({
    device,
    onAction,
  }: {
    device: { watchdogLastSeen?: string | null; watchdogStatus?: string | null };
    onAction: (action: string, device: unknown) => void;
  }) => (
    <>
      <span data-testid="watchdog-state">{`${device.watchdogStatus ?? 'none'}@${device.watchdogLastSeen ?? 'never'}`}</span>
      <button type="button" onClick={() => onAction('restart-agent', device)}>Restart agent</button>
    </>
  ),
}));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./MoveDeviceOrgDialog', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));

const DEVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RECOVERY_URL = `/devices/${DEVICE_ID}/agent-recovery`;
const WATCHDOG_SEEN = '2026-10-20T12:00:00.000Z';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function rig(recovery: () => Response) {
  vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
    if (url === RECOVERY_URL) return recovery();
    return jsonResponse({
      id: DEVICE_ID,
      hostname: 'alpha-01',
      osType: 'windows',
      status: 'offline',
      orgId: 'org-1',
      siteId: 'site-1',
      watchdogStatus: 'failover',
      watchdogLastSeen: WATCHDOG_SEEN,
    });
  });
}

function recoveryCalls() {
  return vi.mocked(fetchWithAuth).mock.calls.filter(([url, init]) => url === RECOVERY_URL && init?.method === 'POST');
}

describe('DeviceDetailPage "Restart agent" (#9234)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the watchdog state from the API through to the device header', async () => {
    rig(() => jsonResponse({}, 500));

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    expect(await screen.findByTestId('watchdog-state')).toHaveTextContent(`failover@${WATCHDOG_SEEN}`);
  });

  it('POSTs restart_agent to the watchdog recovery route and toasts that it is queued', async () => {
    rig(() => jsonResponse({ commandId: 'cmd-1', action: 'restart_agent', status: 'queued' }, 202));

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByText('Restart agent'));

    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringContaining('alpha-01') }),
      ),
    );
    const calls = recoveryCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({ action: 'restart_agent' });
  });

  it('shows the refusal and never reports success when one is already waiting', async () => {
    rig(() => jsonResponse({ error: 'already waiting', code: 'ALREADY_PENDING', commandId: 'cmd-0' }, 409));

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByText('Restart agent'));

    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: expect.stringMatching(/already waiting for the watchdog/i) }),
      ),
    );
    expect(vi.mocked(showToast)).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('shows the server refusal when the watchdog is not reporting', async () => {
    rig(() => jsonResponse({
      error: 'Watchdog is not reporting; cannot dispatch watchdog command',
      code: 'WATCHDOG_REFUSED',
    }, 409));

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByText('Restart agent'));

    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: expect.stringMatching(/watchdog is not reporting/i) }),
      ),
    );
  });
});
