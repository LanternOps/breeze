import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../hooks/useEventStream', () => ({ useEventStream: () => ({ subscribe: vi.fn() }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: () => vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./DeviceDetails', () => ({
  default: ({ device, onAction }: { device: { hostname: string }; onAction: (action: string, device: unknown) => void }) => (
    <button type="button" onClick={() => onAction('restore', device)}>Restore</button>
  ),
}));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
// The real dialog pulls in the org store, which needs more of stores/auth than this suite mocks.
vi.mock('./MoveDeviceOrgDialog', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));

const DEVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RESTORE_URL = `/devices/${DEVICE_ID}/restore`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function rigRestoreResponse(restore: () => Response) {
  vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
    if (url === RESTORE_URL) return restore();
    return jsonResponse({
      id: DEVICE_ID,
      hostname: 'alpha-01',
      osType: 'windows',
      status: 'decommissioned',
      orgId: 'org-1',
      siteId: 'site-1',
    });
  });
}

function restoreCalls(): number {
  return vi.mocked(fetchWithAuth).mock.calls
    .filter(([url, init]) => url === RESTORE_URL && init?.method === 'POST').length;
}

describe('DeviceDetailPage restore surfaces the API outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the device-limit refusal and never reports the device restored', async () => {
    rigRestoreResponse(() => jsonResponse({
      error: 'Device limit reached',
      code: 'DEVICE_LIMIT_REACHED',
      currentDevices: 25,
      maxDevices: 25,
    }, 403));

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByText('Restore'));

    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Device limit reached' }),
      ),
    );
    expect(restoreCalls()).toBe(1);
    expect(vi.mocked(showToast)).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    );
  });

  it('toasts success when the restore goes through', async () => {
    rigRestoreResponse(() => jsonResponse({ success: true, uninstallAlreadyDispatched: false }));

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByText('Restore'));

    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: 'alpha-01 has been restored' }),
      ),
    );
    expect(restoreCalls()).toBe(1);
  });
});
