import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { tokens: null; user: undefined }) => unknown) => sel({ tokens: null, user: undefined }),
}));
vi.mock('../../hooks/useEventStream', () => ({ useEventStream: () => ({ subscribe: vi.fn() }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: () => vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../services/deviceActions', () => ({
  sendDeviceCommand: vi.fn(),
  executeScript: vi.fn(),
  exitMaintenanceMode: vi.fn(),
  decommissionDevice: vi.fn(),
  clearDeviceSessions: vi.fn(),
  restoreDevice: vi.fn(),
  permanentDeleteDevice: vi.fn(),
  sendWakeCommand: vi.fn(),
  watchWakeOutcome: vi.fn(),
  WakeCommandError: class WakeCommandError extends Error {},
  wakeFriendlyErrorMessage: vi.fn(),
  fetchRemovalConfig: vi.fn(async () => ({ uninstallDrainWindowHours: 72 })),
}));
// The page's own dialog is stubbed: what is under test is that the page OPENS
// it on `move-org` and REFETCHES on completion — the dialog's flow has its own suite.
const { dialogProps } = vi.hoisted(() => ({ dialogProps: { current: null as null | Record<string, any> } }));
vi.mock('./MoveDeviceOrgDialog', () => ({
  default: (props: Record<string, any>) => {
    dialogProps.current = props;
    return props.open ? <div data-testid="move-org-dialog-open" /> : null;
  },
}));
vi.mock('./DeviceDetails', () => ({
  default: ({ device, onAction }: { device: { hostname: string }; onAction: (a: string, d: unknown) => void }) => (
    <button type="button" data-testid="kebab-move-org" onClick={() => onAction('move-org', device)}>Move</button>
  ),
}));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));
vi.mock('./MaintenanceModeDialog', () => ({ default: () => null }));

const DEVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const device = {
  id: DEVICE_ID, hostname: 'edge-01', os: 'windows', osVersion: '11', status: 'online',
  cpuPercent: 1, ramPercent: 1, lastSeen: '2026-09-18T00:00:00.000Z',
  orgId: 'o1', orgName: 'Current Org', siteId: 's1', siteName: 'HQ', agentVersion: '1.0.0', tags: [],
};

describe('DeviceDetailPage — move-org action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogProps.current = null;
    // GET /devices/:id answers the device body unwrapped (no `data` envelope).
    vi.mocked(fetchWithAuth).mockImplementation(async () => ({ ok: true, json: async () => device }) as Response);
  });

  it('opens MoveDeviceOrgDialog on the move-org action and refetches + toasts on completion', async () => {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    await screen.findByTestId('kebab-move-org');
    const fetchesBefore = vi.mocked(fetchWithAuth).mock.calls.length;

    screen.getByTestId('kebab-move-org').click();
    await screen.findByTestId('move-org-dialog-open');
    expect(dialogProps.current?.device).toMatchObject({ id: DEVICE_ID, orgId: 'o1', orgName: 'Current Org' });

    dialogProps.current!.onCompleted({ targetOrgId: 'o2', targetOrgName: 'Target Org' });
    await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.length).toBeGreaterThan(fetchesBefore));
    expect(vi.mocked(fetchWithAuth).mock.calls.at(-1)?.[0]).toBe(`/devices/${DEVICE_ID}`);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringContaining('Target Org') }));
  });
});
