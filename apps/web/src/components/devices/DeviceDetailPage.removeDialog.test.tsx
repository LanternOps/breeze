import '@/lib/i18n';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { decommissionDevice } from '../../services/deviceActions';

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
  // RemoveDeviceDialog fetches the env-driven drain window when it opens.
  fetchRemovalConfig: vi.fn(async () => ({ uninstallDrainWindowHours: 72 })),
}));

// Two callers, two call SHAPES — that is the whole contract under test:
//   * DeviceSettingsModal's Danger Zone fires `onAction('decommission', device)`
//     with NO third argument. It has no dialog of its own, so the PAGE owes it one.
//   * DeviceActions' kebab already asked the question in its own
//     RemoveDeviceDialog and fires `onAction('decommission', device, choice)`.
//     That path must execute straight through — a second dialog would be a bug.
// DeviceSettingsModal itself is stubbed rather than driven: W03 is editing the
// real component on another branch. The stub reproduces its exact call shape;
// the gate being pinned here keys on the ABSENCE of `opts`, so it holds for any
// caller that omits it, not just this one.
vi.mock('./DeviceDetails', () => ({
  default: ({ device, onAction }: {
    device: { hostname: string };
    onAction: (action: string, device: unknown, opts?: { uninstallAgent?: boolean }) => void;
  }) => (
    <button
      type="button"
      data-testid="kebab-remove-with-choice"
      onClick={() => onAction('decommission', device, { uninstallAgent: false })}
    >
      Kebab Remove
    </button>
  ),
}));
vi.mock('./DeviceSettingsModal', () => ({
  default: ({ device, onAction }: {
    device: { hostname: string };
    onAction?: (action: string, device: unknown) => void;
  }) => (
    <button
      type="button"
      data-testid="settings-decommission"
      onClick={() => onAction?.('decommission', device)}
    >
      Settings Decommission
    </button>
  ),
}));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));

const DEVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function advanceUndoWindow() {
  // Only setTimeout is faked, and it must be installed BEFORE the click that
  // schedules the 5s undo timer (see DeviceDetailPage.permanentDelete.test.tsx).
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
}

// #3987 follow-up: the detail page had a gate-less `case "decommission"`, so the
// Settings → Danger Zone button removed the device with no dialog at all — the
// one Remove surface that still could not choose "leave the agent installed",
// and it defaulted to uninstall silently. DevicesPage has always split gate from
// execute; the detail page now does too.
describe('DeviceDetailPage — Settings → Remove goes through RemoveDeviceDialog (#3987)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({
      id: DEVICE_ID,
      hostname: 'alpha-01',
      osType: 'windows',
      status: 'online',
      orgId: 'org-1',
      siteId: 'site-1',
    }), { status: 200 }));
    vi.mocked(decommissionDevice).mockResolvedValue({ success: true } as never);
  });

  it('opens the agent-choice dialog and removes nothing until it is confirmed', async () => {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    fireEvent.click(await screen.findByTestId('settings-decommission'));

    expect(await screen.findByTestId('remove-choice-uninstall')).toBeChecked();
    expect(screen.getByText('Remove alpha-01?')).toBeInTheDocument();

    // Not even the undo window has opened — nothing is in flight.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await advanceUndoWindow();
    } finally {
      vi.useRealTimers();
    }
    expect(vi.mocked(decommissionDevice)).not.toHaveBeenCalled();
  });

  it('forwards uninstallAgent: false when the operator chooses to leave the agent', async () => {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    fireEvent.click(await screen.findByTestId('settings-decommission'));
    fireEvent.click(await screen.findByTestId('remove-choice-leave'));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(screen.getByTestId('detail-remove-confirm'));
      await advanceUndoWindow();
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() =>
      expect(vi.mocked(decommissionDevice)).toHaveBeenCalledWith(DEVICE_ID, { uninstallAgent: false }),
    );
  });

  it('cancelling the dialog removes nothing', async () => {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    fireEvent.click(await screen.findByTestId('settings-decommission'));
    await screen.findByTestId('detail-remove-confirm');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByTestId('detail-remove-confirm')).toBeNull());
    expect(vi.mocked(decommissionDevice)).not.toHaveBeenCalled();
  });

  // The kebab already asked. Re-gating a call that carries an answer would show
  // the operator two identical dialogs back to back.
  it('does NOT re-ask when the caller already carries a choice (DeviceActions kebab)', async () => {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    const trigger = await screen.findByTestId('kebab-remove-with-choice');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(trigger);
      // No page-level dialog on top of the one DeviceActions already showed.
      expect(screen.queryByTestId('detail-remove-confirm')).toBeNull();
      expect(screen.queryByTestId('remove-choice-uninstall')).toBeNull();
      await advanceUndoWindow();
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() =>
      expect(vi.mocked(decommissionDevice)).toHaveBeenCalledWith(DEVICE_ID, { uninstallAgent: false }),
    );
  });
});
