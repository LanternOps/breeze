import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { executeScript } from '../../services/deviceActions';
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
    <button type="button" onClick={() => onAction('run-script', device)}>Run Script</button>
  ),
}));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({
  default: ({ isOpen, onSelect }: { isOpen: boolean; onSelect: (script: { id: string; name: string }, runAs: 'system') => void }) => isOpen ? (
    <button type="button" onClick={() => void onSelect({ id: 'script-1', name: 'Cleanup' }, 'system')}>Choose Cleanup</button>
  ) : null,
}));

const DEVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('DeviceDetailPage script admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({
      id: DEVICE_ID,
      hostname: 'alpha-01',
      osType: 'windows',
      status: 'online',
      orgId: 'org-1',
      siteId: 'site-1',
    }), { status: 200 }));
  });

  it('does not toast queued when the 201 admission rejects the device', async () => {
    vi.mocked(executeScript).mockResolvedValue({
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'rejected',
      targets: [{ requestedDeviceId: DEVICE_ID, admission: 'suppressed', reasonCode: 'maintenance_suppressed' }],
    } as never);

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByText('Run Script'));
    fireEvent.click(await screen.findByText('Choose Cleanup'));

    await waitFor(() => expect(vi.mocked(executeScript)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(vi.mocked(showToast)).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    // #4886 — a rejected admission must not redirect the operator anywhere.
    expect(window.location.hash).toBe('');
  });

  // #4886 — after a successful queue, the operator should land where the
  // result appears (the device's own Scripts tab) instead of staying wherever
  // they happened to trigger the run from.
  it('switches to the Scripts tab, highlighting the new execution, once the run is admitted', async () => {
    vi.mocked(executeScript).mockResolvedValue({
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'queued',
      targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: 'execution-1' }],
    } as never);

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByText('Run Script'));
    fireEvent.click(await screen.findByText('Choose Cleanup'));

    await waitFor(() => expect(vi.mocked(executeScript)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.location.hash).toBe('#scripts/execution-1'));
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
});
