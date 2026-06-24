import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';

import { DeviceVulnerabilitiesTab } from './DeviceVulnerabilitiesTab';
import * as api from '../../lib/api/vulnerabilities';

type Perm = { resource: string; action: string };
// Mutable grant set the mocked auth store reads from. Default = wildcard so the
// existing (button-present) tests stay green once the component gates on
// usePermissions; individual tests narrow it to cover the negative branch.
const authState = vi.hoisted(() => ({ permissions: [{ resource: '*', action: '*' }] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: authState.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));

vi.mock('../../lib/api/vulnerabilities', () => ({
  fetchDeviceVulnerabilities: vi.fn(),
  remediateVuln: vi.fn(),
  acceptVulnRisk: vi.fn(),
  mitigateVuln: vi.fn(),
  reopenVuln: vi.fn(),
}));

const sampleItem = {
  id: 'dv1',
  deviceId: 'd1',
  vulnerabilityId: 'v1',
  cveId: 'CVE-2025-1',
  cvssScore: 9.8,
  cvssVector: null,
  severity: 'critical',
  knownExploited: true,
  epssScore: 0.5,
  riskScore: 100,
  status: 'open',
  detectedAt: '2026-06-23T00:00:00Z',
  patchAvailable: true,
};

const noPatchItem = {
  ...sampleItem,
  id: 'dv3',
  cveId: 'CVE-2025-3',
  patchAvailable: false,
};

const acceptedItem = {
  ...sampleItem,
  id: 'dv2',
  status: 'accepted',
};

beforeEach(() => {
  vi.clearAllMocks();
  authState.permissions = [{ resource: '*', action: '*' }];
  vi.mocked(api.fetchDeviceVulnerabilities).mockResolvedValue({ items: [sampleItem] });
});

describe('DeviceVulnerabilitiesTab', () => {
  it('renders the device findings', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    expect(await desktop.findByTestId('vulnerability-row-dv1')).toHaveTextContent('CVE-2025-1');
  });

  it('calls remediate when the remediate button is clicked', async () => {
    vi.mocked(api.remediateVuln).mockResolvedValue({ scheduled: 1, skipped: [] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    fireEvent.click(await desktop.findByTestId('remediate-dv1'));
    await waitFor(() => expect(api.remediateVuln).toHaveBeenCalledWith(['dv1']));
  });

  it('shows the empty state when the device has no findings', async () => {
    vi.mocked(api.fetchDeviceVulnerabilities).mockResolvedValue({ items: [] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    expect(await screen.findByTestId('device-vulnerabilities-empty')).toBeInTheDocument();
  });

  it('renders the status filter with default value "open"', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const filter = screen.getByTestId('vulnerability-device-status-filter') as HTMLSelectElement;
    expect(filter.value).toBe('open');
  });

  it('refetches with the selected status when the filter changes', async () => {
    vi.mocked(api.fetchDeviceVulnerabilities).mockResolvedValue({ items: [] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    // Wait for initial load
    await screen.findByTestId('device-vulnerabilities-empty');
    expect(api.fetchDeviceVulnerabilities).toHaveBeenCalledWith('d1', { status: 'open' });

    // Change filter to "accepted"
    fireEvent.change(screen.getByTestId('vulnerability-device-status-filter'), {
      target: { value: 'accepted' },
    });

    await waitFor(() =>
      expect(api.fetchDeviceVulnerabilities).toHaveBeenCalledWith('d1', { status: 'accepted' }),
    );
  });

  it('refetches with status "all" when the filter is changed to All', async () => {
    vi.mocked(api.fetchDeviceVulnerabilities).mockResolvedValue({ items: [] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    await screen.findByTestId('device-vulnerabilities-empty');

    fireEvent.change(screen.getByTestId('vulnerability-device-status-filter'), {
      target: { value: 'all' },
    });

    await waitFor(() =>
      expect(api.fetchDeviceVulnerabilities).toHaveBeenCalledWith('d1', { status: 'all' }),
    );
  });

  it('shows a Reopen button for accepted findings and calls reopenVuln', async () => {
    vi.mocked(api.fetchDeviceVulnerabilities).mockResolvedValue({ items: [acceptedItem] });
    vi.mocked(api.reopenVuln).mockResolvedValue(undefined);
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);

    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    const reopenBtn = await desktop.findByTestId('reopen-dv2');
    expect(reopenBtn).toBeInTheDocument();

    fireEvent.click(reopenBtn);
    await waitFor(() => expect(api.reopenVuln).toHaveBeenCalledWith('dv2'));
  });

  it('does not show Remediate/Accept/Mitigate buttons for accepted findings', async () => {
    vi.mocked(api.fetchDeviceVulnerabilities).mockResolvedValue({ items: [acceptedItem] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);

    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    await desktop.findByTestId('reopen-dv2');
    expect(desktop.queryByTestId('remediate-dv2')).not.toBeInTheDocument();
    expect(desktop.queryByTestId('accept-dv2')).not.toBeInTheDocument();
    expect(desktop.queryByTestId('mitigate-dv2')).not.toBeInTheDocument();
  });

  it('renders a Status column badge for each row', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    const row = await desktop.findByTestId('vulnerability-row-dv1');
    expect(row).toHaveTextContent('Open');
  });

  it('disables Remediate button when patchAvailable is false', async () => {
    vi.mocked(api.fetchDeviceVulnerabilities).mockResolvedValue({ items: [noPatchItem] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    const remediateBtn = await desktop.findByTestId('remediate-dv3');
    expect(remediateBtn).toBeDisabled();
    expect(remediateBtn).toHaveAttribute('title', 'No patch available');
  });

  it('enables Remediate button when patchAvailable is true', async () => {
    vi.mocked(api.remediateVuln).mockResolvedValue({ scheduled: 1, skipped: [] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    const remediateBtn = await desktop.findByTestId('remediate-dv1');
    expect(remediateBtn).not.toBeDisabled();
    expect(remediateBtn).not.toHaveAttribute('title', 'No patch available');
  });

  it('shows a "Patch available" indicator for open findings with patchAvailable', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    expect(await desktop.findByTestId('patch-available-dv1')).toBeInTheDocument();
  });

  it('does not show a "Patch available" indicator when patchAvailable is false', async () => {
    vi.mocked(api.fetchDeviceVulnerabilities).mockResolvedValue({ items: [noPatchItem] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    await desktop.findByTestId('vulnerability-row-dv3');
    expect(desktop.queryByTestId('patch-available-dv3')).not.toBeInTheDocument();
  });

  it('bulk-remediate button is disabled when no rows are selected', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const bulkBtn = await screen.findByTestId('vuln-bulk-remediate');
    expect(bulkBtn).toBeDisabled();
  });

  it('selecting a row enables the bulk-remediate button', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    await desktop.findByTestId('vulnerability-row-dv1');
    fireEvent.click(desktop.getByTestId('vuln-select-dv1'));
    const bulkBtn = screen.getByTestId('vuln-bulk-remediate');
    expect(bulkBtn).not.toBeDisabled();
    expect(bulkBtn).toHaveTextContent('Remediate selected (1)');
  });

  it('bulk-remediate calls remediateVuln with selected ids then clears selection', async () => {
    vi.mocked(api.remediateVuln).mockResolvedValue({ scheduled: 1, skipped: [] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    await desktop.findByTestId('vulnerability-row-dv1');
    fireEvent.click(desktop.getByTestId('vuln-select-dv1'));
    fireEvent.click(screen.getByTestId('vuln-bulk-remediate'));
    await waitFor(() => expect(api.remediateVuln).toHaveBeenCalledWith(['dv1']));
    await waitFor(() => expect(screen.getByTestId('vuln-bulk-remediate')).toBeDisabled());
  });

  it('cannot select a row when patchAvailable is false', async () => {
    vi.mocked(api.fetchDeviceVulnerabilities).mockResolvedValue({ items: [noPatchItem] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    const checkbox = await desktop.findByTestId('vuln-select-dv3');
    expect(checkbox).toBeDisabled();
  });

  it('has a Patched option in the status filter', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const filter = screen.getByTestId('vulnerability-device-status-filter');
    const options = Array.from(filter.querySelectorAll('option')).map((o) => o.value);
    expect(options).toContain('patched');
  });

  it('refetches with status "patched" when filter changes to Patched', async () => {
    vi.mocked(api.fetchDeviceVulnerabilities).mockResolvedValue({ items: [] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    await screen.findByTestId('device-vulnerabilities-empty');

    fireEvent.change(screen.getByTestId('vulnerability-device-status-filter'), {
      target: { value: 'patched' },
    });

    await waitFor(() =>
      expect(api.fetchDeviceVulnerabilities).toHaveBeenCalledWith('d1', { status: 'patched' }),
    );
  });

  it('hides Accept risk when the user lacks vulnerabilities:accept_risk', async () => {
    authState.permissions = [
      { resource: 'devices', action: 'read' },
      { resource: 'devices', action: 'write' },
      { resource: 'devices', action: 'execute' },
    ];
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    await desktop.findByTestId('vulnerability-row-dv1');
    expect(desktop.queryByTestId('accept-dv1')).not.toBeInTheDocument();
    // mitigate stays available on devices:write
    expect(desktop.getByTestId('mitigate-dv1')).toBeInTheDocument();
  });

  it('hides Reopen for accepted findings when the user lacks vulnerabilities:accept_risk', async () => {
    authState.permissions = [{ resource: 'devices', action: 'read' }];
    vi.mocked(api.fetchDeviceVulnerabilities).mockResolvedValue({ items: [acceptedItem] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    await desktop.findByTestId('vulnerability-row-dv2');
    expect(desktop.queryByTestId('reopen-dv2')).not.toBeInTheDocument();
  });

  it('shows Accept risk when the user holds vulnerabilities:accept_risk', async () => {
    authState.permissions = [
      { resource: 'devices', action: 'read' },
      { resource: 'vulnerabilities', action: 'accept_risk' },
    ];
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    expect(await desktop.findByTestId('accept-dv1')).toBeInTheDocument();
  });
});
