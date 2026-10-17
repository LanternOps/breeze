import '@/lib/i18n';

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  permanentDeleteDevice: vi.fn(),
  sendWakeCommand: vi.fn(),
  watchWakeOutcome: vi.fn(),
  WakeCommandError: class WakeCommandError extends Error {},
  wakeFriendlyErrorMessage: vi.fn(),
}));
vi.mock('./DeviceDetails', () => ({
  default: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>back</button>,
}));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
// The real dialog pulls in the org store, which needs more of stores/auth than this suite mocks.
vi.mock('./MoveDeviceOrgDialog', () => ({ default: () => null }));
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
    useOrgStore.setState({ currentOrgId: null, allOrgs: true } as never);
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
    // #5076: the breadcrumb now opens the organization RECORD page, not the
    // settings editor — the record page is the new one-click destination for
    // "jump to this device's org" (settings stays reachable from the record
    // page's own header action instead).
    expect(orgLink).toHaveAttribute('href', '/organizations/org-42');
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

describe('Devices crumb (ui-flow A4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it('goes to /devices in fleet view', async () => {
    useOrgStore.setState({ currentOrgId: null, allOrgs: true } as never);
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    expect(await screen.findByRole('link', { name: 'Devices' })).toHaveAttribute('href', '/devices');
  });

  it('goes to /devices when the working org is the device org', async () => {
    useOrgStore.setState({ currentOrgId: 'org-42', allOrgs: false } as never);
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    expect(await screen.findByRole('link', { name: 'Devices' })).toHaveAttribute('href', '/devices');
  });

  it("goes to the device org's Devices tab when the working org differs, and so does Back", async () => {
    useOrgStore.setState({ currentOrgId: 'org-99', allOrgs: false } as never);
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    expect(await screen.findByRole('link', { name: 'Devices' })).toHaveAttribute(
      'href',
      '/organizations/org-42#devices',
    );
    fireEvent.click(screen.getByText('back'));
    expect(navigateTo).toHaveBeenCalledWith('/organizations/org-42#devices');
  });
});
