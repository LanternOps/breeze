import '@/lib/i18n';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';

import { DeviceVulnerabilitiesTab } from './DeviceVulnerabilitiesTab';
import * as api from '../../lib/api/vulnerabilities';
import type { DeviceVulnSoftwareResponse } from '@breeze/shared';

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
  fetchDeviceSoftwareGroups: vi.fn(),
  remediateVuln: vi.fn(),
  acceptVulnRisk: vi.fn(),
  mitigateVuln: vi.fn(),
  reopenVuln: vi.fn(),
}));

// Chrome group (2 open patch-ready findings: CVE-1, CVE-2) + OS group (1
// finding, no patch available). groupKeys match buildGroupKey in the
// aggregation layer: software groups are `sw:<name>|<vendor>` (empty vendor
// here), OS groups are `os:<osType>`.
const RESPONSE: DeviceVulnSoftwareResponse = {
  stats: { openTotal: 3, critical: 1, high: 1, medium: 1, low: 0, unscored: 0, kevFindingCount: 1, patchReadyFindingCount: 2 },
  groups: [
    { groupKey: 'sw:google chrome|', kind: 'software', name: 'Google Chrome', vendor: null, versions: ['126.0'], deviceCount: 1, cveCount: 2, cveIds: ['CVE-1', 'CVE-2'], worstSeverity: 'critical', maxRiskScore: 90, kevCveCount: 1, maxEpss: 0.4, patchReadyFindingCount: 2, patchReadyDeviceCount: 1, tickets: [] },
    { groupKey: 'os:windows', kind: 'os', name: 'Windows OS updates', vendor: null, versions: [], deviceCount: 1, cveCount: 1, cveIds: ['CVE-3'], worstSeverity: 'high', maxRiskScore: 70, kevCveCount: 0, maxEpss: null, patchReadyFindingCount: 0, patchReadyDeviceCount: 0, tickets: [] },
  ],
  findings: [
    { id: 'a', deviceId: 'd1', vulnerabilityId: 'v1', cveId: 'CVE-1', cvssScore: 9.1, cvssVector: null, severity: 'critical', knownExploited: true, epssScore: 0.4, riskScore: 90, status: 'open', detectedAt: '2026-06-01T00:00:00.000Z', patchAvailable: true, groupKey: 'sw:google chrome|' },
    { id: 'b', deviceId: 'd1', vulnerabilityId: 'v2', cveId: 'CVE-2', cvssScore: 5.0, cvssVector: null, severity: 'medium', knownExploited: false, epssScore: null, riskScore: 40, status: 'open', detectedAt: '2026-06-01T00:00:00.000Z', patchAvailable: true, groupKey: 'sw:google chrome|' },
    { id: 'c', deviceId: 'd1', vulnerabilityId: 'v3', cveId: 'CVE-3', cvssScore: 7.0, cvssVector: null, severity: 'high', knownExploited: false, epssScore: null, riskScore: 70, status: 'open', detectedAt: '2026-06-01T00:00:00.000Z', patchAvailable: false, groupKey: 'os:windows' },
  ],
};

const EMPTY_RESPONSE: DeviceVulnSoftwareResponse = {
  stats: { openTotal: 0, critical: 0, high: 0, medium: 0, low: 0, unscored: 0, kevFindingCount: 0, patchReadyFindingCount: 0 },
  groups: [],
  findings: [],
};

// A single software group with one 'accepted' finding, for the reopen /
// permission-gated tests (which previously used a flat `acceptedItem`).
const ACCEPTED_RESPONSE: DeviceVulnSoftwareResponse = {
  stats: { openTotal: 0, critical: 0, high: 1, medium: 0, low: 0, unscored: 0, kevFindingCount: 0, patchReadyFindingCount: 0 },
  groups: [
    { groupKey: 'sw:acme app|', kind: 'software', name: 'Acme App', vendor: null, versions: ['1.0'], deviceCount: 1, cveCount: 1, cveIds: ['CVE-9'], worstSeverity: 'high', maxRiskScore: 70, kevCveCount: 0, maxEpss: null, patchReadyFindingCount: 0, patchReadyDeviceCount: 0, tickets: [] },
  ],
  findings: [
    { id: 'acc1', deviceId: 'd1', vulnerabilityId: 'v9', cveId: 'CVE-9', cvssScore: 7.0, cvssVector: null, severity: 'high', knownExploited: false, epssScore: null, riskScore: 70, status: 'accepted', detectedAt: '2026-06-01T00:00:00.000Z', patchAvailable: true, groupKey: 'sw:acme app|' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  authState.permissions = [{ resource: '*', action: '*' }];
  vi.mocked(api.fetchDeviceSoftwareGroups).mockResolvedValue(RESPONSE);
});

describe('DeviceVulnerabilitiesTab', () => {
  it('renders the posture header from stats', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const header = await screen.findByTestId('device-vuln-stats');
    expect(header).toHaveTextContent('1'); // critical count etc.
    expect(header).toHaveTextContent(/Critical/i);
  });

  it('labels the first stat tile "Open" for the default open status filter', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const header = within(await screen.findByTestId('device-vuln-stats'));
    expect(header.getByText('Open')).toBeInTheDocument();
  });

  it('relabels the first stat tile when the status filter changes to a non-open value', async () => {
    vi.mocked(api.fetchDeviceSoftwareGroups).mockResolvedValue(EMPTY_RESPONSE);
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const header = within(await screen.findByTestId('device-vuln-stats'));
    await screen.findByTestId('device-vulnerabilities-empty');
    expect(header.getByText('Open')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('vulnerability-device-status-filter'), {
      target: { value: 'accepted' },
    });

    await waitFor(() => expect(header.getByText('Accepted')).toBeInTheDocument());
    expect(header.queryByText('Open')).not.toBeInTheDocument();
  });

  it('renders one row per software group, not per CVE', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    expect(await screen.findByTestId('vuln-group-sw:google chrome|')).toBeInTheDocument();
    expect(screen.getByTestId('vuln-group-os:windows')).toBeInTheDocument();
  });

  it('expands a group to reveal its CVE findings', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const toggle = await screen.findByTestId('vuln-group-toggle-sw:google chrome|');
    fireEvent.click(toggle);
    // ResponsiveTable renders both the desktop table and the mobile card list
    // simultaneously in jsdom, so unscoped queries would double-match.
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    expect(await desktop.findByText('CVE-1')).toBeInTheDocument();
    expect(desktop.getByText('CVE-2')).toBeInTheDocument();
  });

  it('Remediate all posts the group patch-ready open finding ids', async () => {
    const remediate = vi.mocked(api.remediateVuln).mockResolvedValue({ scheduled: 2, skipped: [] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('vuln-group-remediate-sw:google chrome|'));
    await waitFor(() => expect(remediate).toHaveBeenCalledWith(['a', 'b']));
  });

  it('disables Remediate all when the group has no patch-ready findings', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const btn = await screen.findByTestId('vuln-group-remediate-os:windows');
    expect(btn).toBeDisabled();
  });

  it('calls remediate when the per-finding remediate button is clicked', async () => {
    vi.mocked(api.remediateVuln).mockResolvedValue({ scheduled: 1, skipped: [] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('vuln-group-toggle-sw:google chrome|'));
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    fireEvent.click(await desktop.findByTestId('remediate-a'));
    await waitFor(() => expect(api.remediateVuln).toHaveBeenCalledWith(['a']));
  });

  it('shows the empty state when the device has no findings', async () => {
    vi.mocked(api.fetchDeviceSoftwareGroups).mockResolvedValue(EMPTY_RESPONSE);
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    expect(await screen.findByTestId('device-vulnerabilities-empty')).toBeInTheDocument();
  });

  it('renders the status filter with default value "open"', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const filter = screen.getByTestId('vulnerability-device-status-filter') as HTMLSelectElement;
    expect(filter.value).toBe('open');
  });

  it('refetches with the selected status when the filter changes', async () => {
    vi.mocked(api.fetchDeviceSoftwareGroups).mockResolvedValue(EMPTY_RESPONSE);
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    // Wait for initial load
    await screen.findByTestId('device-vulnerabilities-empty');
    expect(api.fetchDeviceSoftwareGroups).toHaveBeenCalledWith('d1', { status: 'open' });

    // Change filter to "accepted"
    fireEvent.change(screen.getByTestId('vulnerability-device-status-filter'), {
      target: { value: 'accepted' },
    });

    await waitFor(() =>
      expect(api.fetchDeviceSoftwareGroups).toHaveBeenCalledWith('d1', { status: 'accepted' }),
    );
  });

  it('refetches with status "all" when the filter is changed to All', async () => {
    vi.mocked(api.fetchDeviceSoftwareGroups).mockResolvedValue(EMPTY_RESPONSE);
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    await screen.findByTestId('device-vulnerabilities-empty');

    fireEvent.change(screen.getByTestId('vulnerability-device-status-filter'), {
      target: { value: 'all' },
    });

    await waitFor(() =>
      expect(api.fetchDeviceSoftwareGroups).toHaveBeenCalledWith('d1', { status: 'all' }),
    );
  });

  it('shows a Reopen button for accepted findings and calls reopenVuln', async () => {
    vi.mocked(api.fetchDeviceSoftwareGroups).mockResolvedValue(ACCEPTED_RESPONSE);
    vi.mocked(api.reopenVuln).mockResolvedValue(undefined);
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);

    fireEvent.click(await screen.findByTestId('vuln-group-toggle-sw:acme app|'));
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    const reopenBtn = await desktop.findByTestId('reopen-acc1');
    expect(reopenBtn).toBeInTheDocument();

    fireEvent.click(reopenBtn);
    await waitFor(() => expect(api.reopenVuln).toHaveBeenCalledWith('acc1'));
  });

  it('does not show Remediate/Accept/Mitigate buttons for accepted findings', async () => {
    vi.mocked(api.fetchDeviceSoftwareGroups).mockResolvedValue(ACCEPTED_RESPONSE);
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);

    fireEvent.click(await screen.findByTestId('vuln-group-toggle-sw:acme app|'));
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    await desktop.findByTestId('reopen-acc1');
    expect(desktop.queryByTestId('remediate-acc1')).not.toBeInTheDocument();
    expect(desktop.queryByTestId('accept-acc1')).not.toBeInTheDocument();
    expect(desktop.queryByTestId('mitigate-acc1')).not.toBeInTheDocument();
  });

  it('renders a Status badge for each finding row', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('vuln-group-toggle-sw:google chrome|'));
    const row = await screen.findByTestId('vulnerability-row-a');
    expect(row).toHaveTextContent('Open');
  });

  it('disables Remediate button when patchAvailable is false', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('vuln-group-toggle-os:windows'));
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    const remediateBtn = await desktop.findByTestId('remediate-c');
    expect(remediateBtn).toBeDisabled();
    expect(remediateBtn).toHaveAttribute('title', 'No patch available');
  });

  it('enables Remediate button when patchAvailable is true', async () => {
    vi.mocked(api.remediateVuln).mockResolvedValue({ scheduled: 1, skipped: [] });
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('vuln-group-toggle-sw:google chrome|'));
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    const remediateBtn = await desktop.findByTestId('remediate-a');
    expect(remediateBtn).not.toBeDisabled();
    expect(remediateBtn).not.toHaveAttribute('title', 'No patch available');
  });

  it('shows a "Patch available" indicator for open findings with patchAvailable', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('vuln-group-toggle-sw:google chrome|'));
    expect(await screen.findByTestId('patch-available-a')).toBeInTheDocument();
  });

  it('does not show a "Patch available" indicator when patchAvailable is false', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('vuln-group-toggle-os:windows'));
    await screen.findByTestId('vulnerability-row-c');
    expect(screen.queryByTestId('patch-available-c')).not.toBeInTheDocument();
  });

  it('has a Patched option in the status filter', async () => {
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    const filter = screen.getByTestId('vulnerability-device-status-filter');
    const options = Array.from(filter.querySelectorAll('option')).map((o) => o.value);
    expect(options).toContain('patched');
  });

  it('refetches with status "patched" when filter changes to Patched', async () => {
    vi.mocked(api.fetchDeviceSoftwareGroups).mockResolvedValue(EMPTY_RESPONSE);
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    await screen.findByTestId('device-vulnerabilities-empty');

    fireEvent.change(screen.getByTestId('vulnerability-device-status-filter'), {
      target: { value: 'patched' },
    });

    await waitFor(() =>
      expect(api.fetchDeviceSoftwareGroups).toHaveBeenCalledWith('d1', { status: 'patched' }),
    );
  });

  it('hides Accept risk when the user lacks vulnerabilities:accept_risk', async () => {
    authState.permissions = [
      { resource: 'devices', action: 'read' },
      { resource: 'devices', action: 'write' },
      { resource: 'devices', action: 'execute' },
    ];
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('vuln-group-toggle-sw:google chrome|'));
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    await desktop.findByTestId('vulnerability-row-a');
    expect(desktop.queryByTestId('accept-a')).not.toBeInTheDocument();
    // mitigate stays available on devices:write
    expect(desktop.getByTestId('mitigate-a')).toBeInTheDocument();
  });

  it('hides Reopen for accepted findings when the user lacks vulnerabilities:accept_risk', async () => {
    authState.permissions = [{ resource: 'devices', action: 'read' }];
    vi.mocked(api.fetchDeviceSoftwareGroups).mockResolvedValue(ACCEPTED_RESPONSE);
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('vuln-group-toggle-sw:acme app|'));
    await screen.findByTestId('vulnerability-row-acc1');
    expect(screen.queryByTestId('reopen-acc1')).not.toBeInTheDocument();
  });

  it('shows Accept risk when the user holds vulnerabilities:accept_risk', async () => {
    authState.permissions = [
      { resource: 'devices', action: 'read' },
      { resource: 'vulnerabilities', action: 'accept_risk' },
    ];
    render(<DeviceVulnerabilitiesTab deviceId="d1" />);
    fireEvent.click(await screen.findByTestId('vuln-group-toggle-sw:google chrome|'));
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    expect(await desktop.findByTestId('accept-a')).toBeInTheDocument();
  });
});
