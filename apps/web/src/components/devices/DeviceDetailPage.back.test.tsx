import '@/lib/i18n';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { useOrgStore } from '@/stores/orgStore';

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
// The Devices breadcrumb is the Back control; DeviceDetails itself renders none.
vi.mock('./DeviceDetails', () => ({
  default: () => null,
}));
vi.mock('@/lib/orgSwitch', () => ({ applyOrgSwitch: vi.fn() }));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./MoveDeviceOrgDialog', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));

const DEVICE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// #9259 / #10959: the Devices crumb never pops history.
describe('DeviceDetailPage Devices crumb (#9259, #10959)', () => {
  const setReferrer = (value: string) =>
    Object.defineProperty(document, 'referrer', { value, configurable: true });

  beforeEach(() => {
    vi.clearAllMocks();
    // Guarantee history.length > 1 so the old length-only check would pop.
    window.history.pushState(null, '', '/devices/x');
    useOrgStore.setState({ currentOrgId: null, allOrgs: true } as never);
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({
      id: DEVICE_ID, hostname: 'alpha-01', osType: 'windows', status: 'online',
      orgId: 'org-42', orgName: 'Acme Corp', siteId: 'site-1', siteName: 'HQ',
    }), { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as { referrer?: string }).referrer;
  });

  // #10959: the crumb must always go to the list, never history.back()
  // (which landed on Dashboard / another tab of the same device).
  it.each([
    ['same-origin referrer', `${window.location.origin}/devices?status=online`, null],
    ['in-app soft navigation, empty referrer', '', { index: 1 }],
  ])('crumb goes to the Devices route, not history.back (%s)', async (_n, ref, state) => {
    setReferrer(ref);
    window.history.replaceState(state, '', '/devices/x');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByRole('link', { name: 'Devices' }));
    expect(back).not.toHaveBeenCalled();
    expect(navigateTo).toHaveBeenCalledWith('/devices');
  });

  it('crumb goes to the device org Devices tab when the working org differs', async () => {
    useOrgStore.setState({ currentOrgId: 'org-other', allOrgs: false } as never);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByRole('link', { name: 'Devices' }));
    expect(back).not.toHaveBeenCalled();
    expect(navigateTo).toHaveBeenCalledWith('/organizations/org-42#devices');
  });

  it.each(['','https://example.com/somewhere', 'not a url'])(
    'goes to the Devices route instead of leaving the app (referrer %j)',
    async (ref) => {
      setReferrer(ref);
      // history.length > 1 is exactly the case that used to call back().
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
      render(<DeviceDetailPage deviceId={DEVICE_ID} />);
      fireEvent.click(await screen.findByRole('link', { name: 'Devices' }));
      expect(back).not.toHaveBeenCalled();
      expect(navigateTo).toHaveBeenCalledWith('/devices');
    },
  );
});
