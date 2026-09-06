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
vi.mock('./DeviceDetails', () => ({ default: () => null }));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));

const DEVICE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// #3839 (Discord ask): a tech looking at a device wants a one-click way to
// jump to the device's Organization page instead of using the OrgSwitcher
// dropdown at the top of the window and searching for the org there. The
// breadcrumb ("the path", per the issue) is the natural one-click target —
// it's already rendered on every device detail page.
describe('DeviceDetailPage organization breadcrumb (#3839)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links the organization name in the breadcrumb to the org settings page', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({
      id: DEVICE_ID,
      hostname: 'alpha-01',
      osType: 'windows',
      status: 'online',
      orgId: 'org-42',
      orgName: 'Acme Corp',
      siteId: 'site-1',
      siteName: 'HQ',
    }), { status: 200 }));

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    const orgLink = await screen.findByRole('link', { name: 'Acme Corp' });
    expect(orgLink).toHaveAttribute('href', '/settings/organizations/org-42');
  });

  it('omits the organization crumb when the device has no orgId', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({
      id: DEVICE_ID,
      hostname: 'alpha-01',
      osType: 'windows',
      status: 'online',
      orgId: '',
      orgName: '',
      siteId: 'site-1',
    }), { status: 200 }));

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    await screen.findByText('alpha-01');
    expect(screen.queryByRole('link', { name: 'Unknown Org' })).not.toBeInTheDocument();
  });
});
