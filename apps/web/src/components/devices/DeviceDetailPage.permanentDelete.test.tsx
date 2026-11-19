import '@/lib/i18n';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
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
// The real dialog pulls in the org store, which needs more of stores/auth than this suite mocks.
vi.mock('./MoveDeviceOrgDialog', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));

const DEVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const DEVICE_BODY = {
  id: DEVICE_ID,
  hostname: 'alpha-01',
  osType: 'windows',
  status: 'decommissioned',
  orgId: 'org-1',
  siteId: 'site-1',
};

// #11153: permanent delete goes through runAction -> fetchWithAuth now.
const deleteCalls = () =>
  vi.mocked(fetchWithAuth).mock.calls.filter(
    ([url, init]) => String(url).endsWith('/permanent') && (init as RequestInit | undefined)?.method === 'DELETE',
  );
function mockPermanentDelete(...responses: Response[]) {
  const queue = [...responses];
  vi.mocked(fetchWithAuth).mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/permanent') && init?.method === 'DELETE') {
      return queue.shift() ?? new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify(DEVICE_BODY), { status: 200 });
  });
}
const notConfirmed = (uninstallState: string) =>
  new Response(
    JSON.stringify({ error: 'Agent uninstall was not confirmed', code: 'UNINSTALL_NOT_CONFIRMED', uninstallState }),
    { status: 409 },
  );

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

    // #5023: the kebab only OPENS the confirm now — the delete (and its undo
    // window) starts from the dialog's confirm button.
    fireEvent.click(trigger);
    const confirmBtn = await screen.findByTestId('detail-permanent-delete-confirm');

    // Only setTimeout is faked, and fake timers must be installed BEFORE the
    // confirm — the 5s undo-window timer is scheduled synchronously inside the
    // handler, so installing fake timers after it would leave it running on
    // the real clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(confirmBtn);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it('shows a success toast for the plain { success: true } body the API now returns', async () => {
    mockPermanentDelete(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await runPermanentDelete();

    const calls = vi.mocked(showToast).mock.calls.map(c => c[0]);
    expect(calls).toContainEqual(expect.objectContaining({ type: 'success' }));
    expect(calls.some(c => c.type === 'warning')).toBe(false);
    // First request never forces (#11153): bodyless.
    expect(deleteCalls()).toHaveLength(1);
    expect((deleteCalls()[0][1] as RequestInit).body).toBeUndefined();
  });

  /**
   * The DISCRIMINATING half — a body still carrying the retired `warning`
   * field must NOT produce the old toast. Without this, a dead `if` left
   * behind would keep claiming an uninstall attempt that no longer happens.
   */
  it('ignores a stray legacy `warning` field instead of resurrecting the old toast', async () => {
    mockPermanentDelete(new Response(JSON.stringify({
      success: true,
      warning: 'The agent could not be reached for remote uninstall.',
    }), { status: 200 }));

    await runPermanentDelete();

    const calls = vi.mocked(showToast).mock.calls.map(c => c[0]);
    expect(calls.some(c => c.type === 'warning')).toBe(false);
    expect(calls).toContainEqual(expect.objectContaining({ type: 'success' }));
  });

  /**
   * #5023 — the detail-page kebab had no gate at all: one click and the undo
   * toast was already counting down on an irreversible, unrestorable delete,
   * while bulk purge on the same data demands a typed device count. The page
   * already owns exactly this gate for Remove (#3987), so this mirrors it.
   */
  it('asks before deleting, and deletes nothing until the dialog is confirmed', async () => {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByText('Permanent Delete'));

    expect(await screen.findByText('Delete alpha-01 permanently?')).toBeTruthy();
    expect(screen.getByText(/deletes all history for this device/i)).toBeTruthy();
    expect(deleteCalls()).toHaveLength(0);
    // The gate precedes the timer: no undo toast has been raised either.
    expect(vi.mocked(showToast).mock.calls.some(c => c[0].type === 'undo')).toBe(false);
  });

  it('cancelling the dialog deletes nothing', async () => {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByText('Permanent Delete'));
    await screen.findByTestId('detail-permanent-delete-confirm');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByTestId('detail-permanent-delete-confirm')).toBeNull(),
    );
    expect(deleteCalls()).toHaveLength(0);
  });
});

// #11153: a 409 UNINSTALL_NOT_CONFIRMED opens a force dialog instead of a toast.
describe('DeviceDetailPage permanent delete of an unconfirmed uninstall (#11153)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function confirmFirstDialog() {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByText('Permanent Delete'));
    const confirmBtn = await screen.findByTestId('detail-permanent-delete-confirm');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(confirmBtn);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it('shows the force dialog with the state copy and no error toast', async () => {
    mockPermanentDelete(notConfirmed('agent_returned'));

    await confirmFirstDialog();

    expect(await screen.findByTestId('detail-permanent-delete-force-confirm')).toBeTruthy();
    expect(screen.getByText('The agent did not confirm removal')).toBeTruthy();
    expect(screen.getByText(/checked in since/i)).toBeTruthy();
    expect(screen.getByText(/installed and running/i)).toBeTruthy();
    expect(deleteCalls()).toHaveLength(1);
    expect((deleteCalls()[0][1] as RequestInit).body).toBeUndefined();
    expect(vi.mocked(showToast).mock.calls.some(([t]) => t.type === 'error')).toBe(false);
  });

  it('Delete anyway re-sends with { force: true } and toasts success', async () => {
    mockPermanentDelete(notConfirmed('cancelled'), new Response(JSON.stringify({ success: true }), { status: 200 }));

    await confirmFirstDialog();
    fireEvent.click(await screen.findByTestId('detail-permanent-delete-force-confirm'));

    await waitFor(() => expect(deleteCalls()).toHaveLength(2));
    expect((deleteCalls()[1][1] as RequestInit).body).toBe(JSON.stringify({ force: true }));
    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringContaining('alpha-01') }),
      ),
    );
  });

  it('cancelling the force dialog sends no second request', async () => {
    mockPermanentDelete(notConfirmed('none'));

    await confirmFirstDialog();
    await screen.findByTestId('detail-permanent-delete-force-confirm');
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByTestId('detail-permanent-delete-force-confirm')).toBeNull(),
    );
    expect(deleteCalls()).toHaveLength(1);
  });

  it('a different 409 still toasts an error and shows no force dialog', async () => {
    mockPermanentDelete(
      new Response(JSON.stringify({ error: 'Uninstall still pending', code: 'UNINSTALL_PENDING' }), { status: 409 }),
    );

    await confirmFirstDialog();

    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: expect.stringContaining('Uninstall still pending') }),
      ),
    );
    expect(screen.queryByTestId('detail-permanent-delete-force-confirm')).toBeNull();
  });
});

