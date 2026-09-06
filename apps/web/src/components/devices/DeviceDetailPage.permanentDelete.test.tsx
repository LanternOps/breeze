import '@/lib/i18n';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { permanentDeleteDevice } from '../../services/deviceActions';
import { showToast } from '../shared/Toast';

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
vi.mock('./DeviceDetails', () => ({
  default: ({ device, onAction }: { device: { hostname: string }; onAction: (action: string, device: unknown) => void }) => (
    <button type="button" onClick={() => onAction('permanent-delete', device)}>Permanent Delete</button>
  ),
}));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));

const DEVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// #4368 was "surface the API's `warning` when the agent could not be reached".
// #2787 deleted that warning along with the best-effort WS uninstall it
// described — permanent delete now REFUSES while a durable agent uninstall is
// still collectable instead of deleting and hoping. The detail-page toast is
// therefore unconditionally the success one, and what is pinned here is that
// the branch is genuinely gone.
describe('DeviceDetailPage permanent delete toasts success, with no warning branch (#2787, was #4368)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({
      id: DEVICE_ID,
      hostname: 'alpha-01',
      osType: 'windows',
      status: 'decommissioned',
      orgId: 'org-1',
      siteId: 'site-1',
    }), { status: 200 }));
  });

  async function runPermanentDelete() {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    const trigger = await screen.findByText('Permanent Delete');

    // Only setTimeout is faked, and fake timers must be installed BEFORE the
    // click — the 5s undo-window timer is scheduled synchronously inside the
    // click handler, so installing fake timers after the click would leave it
    // running on the real clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(trigger);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it('shows a success toast for the plain { success: true } body the API now returns', async () => {
    vi.mocked(permanentDeleteDevice).mockResolvedValue({ success: true });

    await runPermanentDelete();

    const calls = vi.mocked(showToast).mock.calls.map(c => c[0]);
    expect(calls).toContainEqual(expect.objectContaining({ type: 'success' }));
    expect(calls.some(c => c.type === 'warning')).toBe(false);
  });

  /**
   * The DISCRIMINATING half — a body still carrying the retired `warning`
   * field must NOT produce the old toast. Without this, a dead `if` left
   * behind would keep claiming an uninstall attempt that no longer happens.
   */
  it('ignores a stray legacy `warning` field instead of resurrecting the old toast', async () => {
    vi.mocked(permanentDeleteDevice).mockResolvedValue({
      success: true,
      warning: 'The agent could not be reached for remote uninstall.',
    } as never);

    await runPermanentDelete();

    const calls = vi.mocked(showToast).mock.calls.map(c => c[0]);
    expect(calls.some(c => c.type === 'warning')).toBe(false);
    expect(calls).toContainEqual(expect.objectContaining({ type: 'success' }));
  });
});
