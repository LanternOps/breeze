import '@/lib/i18n';

import { fireEvent, render, screen, within } from '@testing-library/react';
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
  default: ({
    onBack,
    workingOrgId,
    onSwitchToDeviceOrg,
  }: {
    onBack: () => void;
    workingOrgId?: string | null;
    onSwitchToDeviceOrg?: () => void;
  }) => (
    <>
      <button onClick={onBack}>back</button>
      <span data-testid="working-org-prop">{String(workingOrgId)}</span>
      {onSwitchToDeviceOrg && <button onClick={onSwitchToDeviceOrg}>switch-scope</button>}
    </>
  ),
}));
const { applyOrgSwitchMock } = vi.hoisted(() => ({ applyOrgSwitchMock: vi.fn() }));
vi.mock('@/lib/orgSwitch', () => ({ applyOrgSwitch: applyOrgSwitchMock }));
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

  it('explains the cross-org Devices crumb in its tooltip (#9027)', async () => {
    useOrgStore.setState({
      currentOrgId: 'org-99',
      allOrgs: false,
      organizations: [{ id: 'org-99', name: 'Acme Dental' }],
    } as never);
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    const crumb = await screen.findByRole('link', { name: 'Devices' });
    const text = "Opens Acme Corp's Devices tab; your working org stays Acme Dental";
    expect(crumb).toHaveAttribute('title', text);
    expect(crumb).toHaveAttribute('aria-description', text);
  });

  it('gives crumb links a 32px tap height below md (#9028)', async () => {
    useOrgStore.setState({ currentOrgId: null, allOrgs: true } as never);
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    expect((await screen.findByRole('link', { name: 'Devices' })).className).toContain('max-md:min-h-[32px]');
    expect(screen.getByRole('link', { name: 'Acme Corp' }).className).toContain('max-md:min-h-[32px]');
  });

  it('gives the Devices crumb no tooltip when the scopes match (#9027)', async () => {
    useOrgStore.setState({ currentOrgId: 'org-42', allOrgs: false } as never);
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    const crumb = await screen.findByRole('link', { name: 'Devices' });
    expect(crumb).not.toHaveAttribute('title');
  });

  it('switches to the device org and stays on this record (#9027)', async () => {
    useOrgStore.setState({ currentOrgId: 'org-99', allOrgs: false } as never);
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    expect(await screen.findByTestId('working-org-prop')).toHaveTextContent('org-99');
    fireEvent.click(screen.getByText('switch-scope'));
    expect(applyOrgSwitchMock).toHaveBeenCalledWith('org-42', 'Switched to Acme Corp', `/devices/${DEVICE_ID}`);
  });
});

describe('crumb leaf (#9026)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: null, allOrgs: true } as never);
  });

  it('shows the display name with the hostname in the title', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({
      id: DEVICE_ID,
      hostname: 'DESKTOP-7QK2',
      displayName: 'Front desk PC',
      osType: 'windows',
      status: 'online',
      orgId: 'org-42',
      orgName: 'Acme Corp',
      siteId: 'site-1',
      siteName: 'HQ',
    }), { status: 200 }));
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    const nav = await screen.findByRole('navigation', { name: /breadcrumb/i });
    const leaf = await within(nav).findByText('Front desk PC');
    expect(leaf).toHaveAttribute('title', 'DESKTOP-7QK2');
    expect(within(nav).queryByText('DESKTOP-7QK2')).toBeNull();
  });
});
