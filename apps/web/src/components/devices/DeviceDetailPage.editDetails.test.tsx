import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

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
      {/* OverflowTabs gives the Details tab this id (overflowTabId). */}
      <button type="button" role="tab" id="device-tab-details">Details</button>
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

  it('"Edit details" opens the Details tab and no dialog', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () => deviceResponse(null));
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByTestId('edit-details'));
    expect(window.location.hash).toBe('#details');
    expect(screen.queryByRole('dialog')).toBeNull();
    // The reveal runs a frame later; let it land here, not in the next test.
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('device-tab-details')));
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

  it('a refresh that fails after a save keeps the device on screen and says the page may be out of date', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetchWithAuth).mockImplementation(async () => deviceResponse(null));
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    const before = await screen.findByTestId('saved');

    vi.mocked(fetchWithAuth).mockImplementation(async () => new Response('{}', { status: 500 }));
    fireEvent.click(before);

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
    // Not the full-page error, not the spinner: the saved edit is still there to work with.
    expect(screen.getByTestId('saved')).toBe(before);
    expect(screen.getByTestId('name')).toHaveTextContent('alpha-01');
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('two saves in a row: an older refresh that lands last does not put old data back', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () => deviceResponse(null));
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    const saved = await screen.findByTestId('saved');

    const pending: Array<(response: Response) => void> = [];
    vi.mocked(fetchWithAuth).mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));
    fireEvent.click(saved);
    fireEvent.click(saved);
    await waitFor(() => expect(pending).toHaveLength(2));

    pending[1]!(deviceResponse('After second save'));
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('After second save'));
    pending[0]!(deviceResponse('After first save'));
    // Give the stale response every chance to be applied.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId('name')).toHaveTextContent('After second save');
  });

  describe('choosing it while already on the Details tab', () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const originalMatchMedia = window.matchMedia;

    function mockReducedMotion(reduce: boolean) {
      window.matchMedia = vi.fn((query: string) => ({
        matches: reduce && query.includes('prefers-reduced-motion: reduce'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as unknown as typeof window.matchMedia;
    }

    beforeEach(() => {
      // jsdom has no layout: scrollIntoView is missing, so stub it to observe.
      Element.prototype.scrollIntoView = scrollIntoView;
      scrollIntoView.mockClear();
      window.location.hash = 'details';
    });

    afterEach(() => {
      Element.prototype.scrollIntoView = originalScrollIntoView;
      window.matchMedia = originalMatchMedia;
    });

    it('brings the Details tab into view and focuses it (no hashchange fires)', async () => {
      mockReducedMotion(false);
      vi.mocked(fetchWithAuth).mockImplementation(async () => deviceResponse(null));
      render(<DeviceDetailPage deviceId={DEVICE_ID} />);
      const editButton = await screen.findByTestId('edit-details');
      editButton.focus();

      fireEvent.click(editButton);

      const tab = document.getElementById('device-tab-details');
      await waitFor(() => expect(document.activeElement).toBe(tab));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(tab);
      expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'start', behavior: 'smooth' }));
      expect(window.location.hash).toBe('#details');
    });

    it('scrolls instantly when the user prefers reduced motion', async () => {
      mockReducedMotion(true);
      vi.mocked(fetchWithAuth).mockImplementation(async () => deviceResponse(null));
      render(<DeviceDetailPage deviceId={DEVICE_ID} />);
      fireEvent.click(await screen.findByTestId('edit-details'));

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'start', behavior: 'auto' }));
    });
  });
});
