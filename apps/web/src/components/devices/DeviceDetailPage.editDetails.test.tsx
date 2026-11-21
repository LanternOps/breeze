import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../../hooks/useEventStream', () => ({ useEventStream: () => ({ subscribe: vi.fn() }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: () => vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./MoveDeviceOrgDialog', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));

// The stub stands in for the tabs: one button per way in, and the device's
// current name so a refetch is visible.
vi.mock('./DeviceDetails', () => ({
  default: ({ device, onAction, onDeviceUpdated }: {
    device: { displayName?: string; hostname: string };
    onAction: (action: string, device: unknown) => void;
    onDeviceUpdated?: () => void;
  }) => (
    <div>
      <p data-testid="name">{device.displayName || device.hostname}</p>
      <button type="button" data-testid="edit-details" onClick={() => onAction('edit-details', device)}>Edit details</button>
      <button type="button" data-testid="saved" onClick={() => onDeviceUpdated?.()}>Saved</button>
    </div>
  ),
}));

const DEVICE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function deviceResponse(displayName: string | null) {
  return new Response(JSON.stringify({
    id: DEVICE_ID, hostname: 'alpha-01', displayName, osType: 'windows', status: 'online', orgId: 'org-1', siteId: 'site-1',
  }), { status: 200 });
}

describe('DeviceDetailPage — the Details tab is where the record is edited', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('"Edit details" opens the Details tab instead of a settings modal', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () => deviceResponse(null));
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByTestId('edit-details'));
    expect(window.location.hash).toBe('#details');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a save in the Details tab refreshes the header without unmounting the tab', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () => deviceResponse(null));
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    const before = await screen.findByTestId('saved');
    expect(screen.getAllByText('alpha-01').length).toBeGreaterThan(0);

    vi.mocked(fetchWithAuth).mockImplementation(async () => deviceResponse('Front Desk'));
    fireEvent.click(before);

    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Front Desk'));
    // Same element: the page refetched in place, no loading spinner swap.
    expect(screen.getByTestId('saved')).toBe(before);
  });
});
