import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../hooks/useEventStream', () => ({ useEventStream: () => ({ subscribe: vi.fn() }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: () => vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../services/deviceActions', () => ({
  sendDeviceCommand: vi.fn(),
  executeScript: vi.fn(),
  toggleMaintenanceMode: vi.fn(),
  decommissionDevice: vi.fn(),
  clearDeviceSessions: vi.fn(),
  restoreDevice: vi.fn(),
  permanentDeleteDevice: vi.fn(),
  sendWakeCommand: vi.fn(),
  watchWakeOutcome: vi.fn(),
  WakeCommandError: class WakeCommandError extends Error {},
  wakeFriendlyErrorMessage: vi.fn(),
}));
vi.mock('./DeviceDetails', () => ({ default: () => <div data-testid="device-details" /> }));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./MoveDeviceOrgDialog', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));

// #6501: `/devices/network` (no further id segment) is served by
// `pages/devices/[id].astro` with id="network", which — before this fix —
// hit `GET /devices/network`. That path is ALSO matched by the network
// asset LIST endpoint (mounted ahead of the `/:id` device-detail route), so
// the fetch resolves 200 with a `{ data: [...], pagination: {...} }` list
// envelope instead of a device row. DeviceDetailPage's transform then reads
// every field off that envelope as `undefined` and falls back to its
// placeholder defaults ("Unknown" / "offline" / ""), rendering a phantom
// device page with live Wake / Run Script / Connect buttons for a device
// that was never fetched. The fix must treat a payload with no `id` field
// as "not found," not as a device.
describe('DeviceDetailPage payload-shape guard (#6501)', () => {
  const DEVICE_ID = 'network';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "not found" instead of a phantom device when the response has no device id', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'asset-1', hostname: 'switch-1' }],
          pagination: { page: 1, limit: 500, total: 1 },
        }),
        { status: 200 },
      ),
    );

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    expect(await screen.findByText(/device not found/i)).toBeInTheDocument();
    expect(screen.queryByTestId('device-details')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /wake/i })).not.toBeInTheDocument();
  });

  it('treats an empty-string device id the same as a missing one', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      new Response(JSON.stringify({ id: '', hostname: 'switch-1' }), { status: 200 }),
    );

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    expect(await screen.findByText(/device not found/i)).toBeInTheDocument();
    expect(screen.queryByTestId('device-details')).not.toBeInTheDocument();
  });
});
