import '@/lib/i18n';

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { useRecentsStore } from '../../stores/recentsStore';

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
vi.mock('./DeviceDetails', () => ({ default: () => null }));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));

const DEVICE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function deviceResponse(extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    id: DEVICE_ID,
    hostname: 'alpha-01',
    osType: 'windows',
    status: 'online',
    orgId: 'org-42',
    orgName: 'Acme Corp',
    ...extra,
  }), { status: 200 });
}

describe('DeviceDetailPage — recent devices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useRecentsStore.getState().hydrate(null);
  });

  it('records the device (display name first) once the store is hydrated for a user', async () => {
    useRecentsStore.getState().hydrate('u1');
    vi.mocked(fetchWithAuth).mockResolvedValue(deviceResponse({ displayName: 'Front desk PC' }));
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    await screen.findByRole('link', { name: 'Acme Corp' });
    expect(useRecentsStore.getState().devices).toEqual([
      expect.objectContaining({ id: DEVICE_ID, name: 'Front desk PC', orgId: 'org-42' }),
    ]);
  });

  it('still records a device whose fetch finished before the store hydrated', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(deviceResponse());
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    await screen.findByRole('link', { name: 'Acme Corp' });
    expect(useRecentsStore.getState().devices).toEqual([]);

    act(() => { useRecentsStore.getState().hydrate('u1'); });
    expect(useRecentsStore.getState().devices.map((d) => d.name)).toEqual(['alpha-01']);
  });

  it('forgets a device the API reports as gone', async () => {
    useRecentsStore.getState().hydrate('u1');
    useRecentsStore.getState().recordDevice({ id: DEVICE_ID, name: 'alpha-01' });
    useRecentsStore.getState().recordDevice({ id: 'other', name: 'other' });
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response('{}', { status: 404 }));
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    await screen.findByText(/Device not found/);
    expect(useRecentsStore.getState().devices.map((d) => d.id)).toEqual(['other']);
  });
});
