import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@/lib/i18n';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

type Perm = { resource: string; action: string };
const authState = vi.hoisted(() => ({ permissions: [{ resource: '*', action: '*' }] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: authState.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));

vi.mock('../../lib/api/vulnerabilities', () => ({
  fetchSoftwareGroupDetail: vi.fn(),
  fetchSoftwareGroupDeviceFindings: vi.fn(),
  remediateVuln: vi.fn(),
  bulkAcceptVulnRisk: vi.fn(),
  bulkMitigateVulns: vi.fn(),
  reopenVuln: vi.fn(),
  createVulnTicket: vi.fn(),
}));

import * as api from '../../lib/api/vulnerabilities';
import { SoftwareGroupDrawer } from './SoftwareGroupDrawer';
import type { GroupDevice, GroupFinding, SoftwareGroupDetail } from '../../lib/api/vulnerabilities';

const KEY = 'sw:google chrome|google llc';

function device(over: Partial<GroupDevice>): GroupDevice {
  return {
    deviceId: 'dev-x',
    deviceName: 'WS-X',
    orgId: 'org-1',
    orgName: 'Acme',
    installedVersions: ['140.0.1'],
    cveCount: 2,
    openFindingCount: 0,
    acceptedFindingCount: 0,
    mitigatedFindingCount: 0,
    patchedFindingCount: 0,
    patchReadyFindingCount: 0,
    worstOpenSeverity: null,
    maxOpenRiskScore: null,
    openFindingIds: [],
    tickets: [],
    ...over,
  };
}

// Three devices: WS-01 has two open findings, WS-02 only an accepted waiver
// (nothing to act on), WS-03 one open finding.
const DETAIL: SoftwareGroupDetail = {
  group: {
    groupKey: KEY,
    kind: 'software',
    name: 'Google Chrome',
    vendor: 'Google LLC',
    versions: ['140.0.1', '141.0.2'],
    deviceCount: 3,
    cveCount: 2,
    cveIds: ['CVE-2026-0001', 'CVE-2026-0002'],
    worstSeverity: 'critical',
    maxRiskScore: 95,
    kevCveCount: 1,
    maxEpss: 0.9,
    patchReadyFindingCount: 2,
    patchReadyDeviceCount: 1,
    tickets: [],
  },
  cves: [
    {
      cveId: 'CVE-2026-0001',
      vulnerabilityId: 'v-1',
      severity: 'critical',
      cvssScore: 9.1,
      epssScore: 0.9,
      knownExploited: true,
      patchAvailable: true,
      maxRiskScore: 95,
      deviceCount: 3,
      openDeviceCount: 2,
    },
    {
      cveId: 'CVE-2026-0002',
      vulnerabilityId: 'v-2',
      severity: 'high',
      cvssScore: 7.5,
      epssScore: null,
      knownExploited: false,
      patchAvailable: true,
      maxRiskScore: 75,
      deviceCount: 1,
      openDeviceCount: 1,
    },
  ],
  versions: [
    { version: '140.0.1', deviceCount: 2 },
    { version: '141.0.2', deviceCount: 1 },
  ],
  devices: [
    device({
      deviceId: 'dev-1',
      deviceName: 'WS-01',
      openFindingCount: 2,
      patchReadyFindingCount: 2,
      worstOpenSeverity: 'critical',
      maxOpenRiskScore: 95,
      openFindingIds: ['dv-1', 'dv-3'],
    }),
    device({
      deviceId: 'dev-2',
      deviceName: 'WS-02',
      cveCount: 1,
      acceptedFindingCount: 1,
      tickets: [{ id: 't-9', number: 'T-2026-C009' }],
    }),
    device({
      deviceId: 'dev-3',
      deviceName: 'WS-03',
      installedVersions: ['141.0.2'],
      cveCount: 1,
      openFindingCount: 1,
      worstOpenSeverity: 'critical',
      maxOpenRiskScore: 90,
      openFindingIds: ['dv-4'],
    }),
  ],
};

const DEV2_FINDINGS: GroupFinding[] = [
  {
    deviceVulnerabilityId: 'dv-2',
    deviceId: 'dev-2',
    deviceName: 'WS-02',
    orgId: 'org-1',
    orgName: 'Acme',
    cveId: 'CVE-2026-0001',
    status: 'accepted',
    patchAvailable: true,
    riskScore: 90,
    detectedAt: '2026-06-01T00:00:00.000Z',
    acceptedUntil: '2026-08-01T12:00:00.000Z',
    ticketId: 't-9',
    ticketNumber: 'T-2026-C009',
  },
];

function renderDrawer(props: Partial<Parameters<typeof SoftwareGroupDrawer>[0]> = {}) {
  return render(
    <SoftwareGroupDrawer groupKey={KEY} onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} {...props} />,
  );
}

describe('SoftwareGroupDrawer (device rollup, #2262)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.permissions = [{ resource: '*', action: '*' }];
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue(DETAIL);
    vi.mocked(api.fetchSoftwareGroupDeviceFindings).mockResolvedValue(DEV2_FINDINGS);
  });

  it('leads with the devices that need updating and demotes the CVE count', async () => {
    renderDrawer();
    const headline = await screen.findByTestId('vuln-drawer-headline');
    expect(headline).toHaveTextContent('2 devices need updating');
    expect(headline).toHaveTextContent('2 CVEs across 3 devices');
    // No per-device-per-CVE "findings" total anywhere in the drawer.
    expect(screen.getByTestId('vuln-software-drawer')).not.toHaveTextContent(/findings\)/);
  });

  it('renders ONE row per device, pre-selecting only devices with open findings', async () => {
    renderDrawer();
    await screen.findByTestId('vuln-device-row-dev-1');
    expect(screen.getAllByTestId(/^vuln-device-row-/)).toHaveLength(3);
    expect(screen.getByTestId('vuln-device-check-dev-1')).toBeChecked();
    expect(screen.getByTestId('vuln-device-check-dev-3')).toBeChecked();
    // WS-02 has nothing open — not selectable, so an action can never touch it.
    expect(screen.getByTestId('vuln-device-check-dev-2')).not.toBeChecked();
    expect(screen.getByTestId('vuln-device-check-dev-2')).toBeDisabled();
    expect(screen.getByTestId('vuln-device-row-dev-1')).toHaveTextContent('2 open of 2 CVEs');
    expect(screen.getByTestId('vuln-device-row-dev-2')).toHaveTextContent('1 accepted');
    expect(screen.getByTestId('vuln-device-row-dev-3')).toHaveTextContent('141.0.2');
    expect(screen.getByTestId('vuln-device-check-dev-1')).toHaveAttribute('aria-label', 'Select WS-01');
    // Per-finding rows are NOT rendered until a device is expanded.
    expect(api.fetchSoftwareGroupDeviceFindings).not.toHaveBeenCalled();
  });

  it('shows the installed-version breakdown and per-CVE device counts', async () => {
    renderDrawer();
    const versions = await screen.findByTestId('vuln-drawer-versions');
    expect(within(versions).getByTestId('vuln-version-140.0.1')).toHaveTextContent('2 devices');
    expect(within(versions).getByTestId('vuln-version-141.0.2')).toHaveTextContent('1 device');
    expect(screen.getByTestId('vuln-drawer-cve-CVE-2026-0001')).toHaveTextContent('2 of 3 devices open');
  });

  it('remediate sends exactly the selected devices\' open finding ids, after a confirmation', async () => {
    vi.mocked(api.remediateVuln).mockResolvedValue({ scheduled: 3, skipped: [] });
    renderDrawer();
    fireEvent.click(await screen.findByTestId('vuln-action-remediate'));
    // Nothing fired yet — the confirmation stands between the button and the mutation.
    expect(api.remediateVuln).not.toHaveBeenCalled();
    expect(screen.getByTestId('vuln-bulk-consequence')).toHaveTextContent('on 2 devices (3 findings)');
    expect(screen.getByTestId('vuln-bulk-selection')).toHaveTextContent('WS-01, WS-03');
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    await waitFor(() => expect(api.remediateVuln).toHaveBeenCalledWith(['dv-1', 'dv-3', 'dv-4']));
  });

  it('deselecting a device removes its findings from the action', async () => {
    vi.mocked(api.remediateVuln).mockResolvedValue({ scheduled: 1, skipped: [] });
    renderDrawer();
    fireEvent.click(await screen.findByTestId('vuln-device-check-dev-1'));
    fireEvent.click(screen.getByTestId('vuln-action-remediate'));
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    await waitFor(() => expect(api.remediateVuln).toHaveBeenCalledWith(['dv-4']));
  });

  it('remediate confirmation can be cancelled without firing the mutation', async () => {
    renderDrawer();
    fireEvent.click(await screen.findByTestId('vuln-action-remediate'));
    fireEvent.click(screen.getByTestId('vuln-bulk-cancel'));
    expect(screen.queryByTestId('vuln-bulk-modal')).toBeNull();
    expect(api.remediateVuln).not.toHaveBeenCalled();
  });

  it('surfaces a remediate failure inline in the confirmation modal', async () => {
    vi.mocked(api.remediateVuln).mockRejectedValue(new Error('No available patch mapped to these findings'));
    renderDrawer();
    fireEvent.click(await screen.findByTestId('vuln-action-remediate'));
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    expect(await screen.findByTestId('vuln-bulk-error')).toHaveTextContent('No available patch mapped to these findings');
    fireEvent.click(screen.getByTestId('vuln-bulk-cancel'));
    fireEvent.click(screen.getByTestId('vuln-action-remediate'));
    expect(screen.queryByTestId('vuln-bulk-error')).toBeNull();
  });

  it('accept-risk flow submits the selected open ids, reloads and notifies', async () => {
    vi.mocked(api.bulkAcceptVulnRisk).mockResolvedValue({ success: true, succeeded: 3, skipped: [] });
    const onActionComplete = vi.fn();
    renderDrawer({ onActionComplete });
    fireEvent.click(await screen.findByTestId('vuln-action-accept'));
    fireEvent.change(screen.getByTestId('vuln-bulk-text'), { target: { value: 'compensating control' } });
    fireEvent.change(screen.getByTestId('vuln-bulk-until'), { target: { value: '2030-01-01' } });
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    await waitFor(() =>
      expect(api.bulkAcceptVulnRisk).toHaveBeenCalledWith(['dv-1', 'dv-3', 'dv-4'], {
        reason: 'compensating control',
        acceptedUntil: new Date(2030, 0, 1, 23, 59, 59, 999).toISOString(),
      }),
    );
    await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
    expect(api.fetchSoftwareGroupDetail).toHaveBeenCalledTimes(2); // initial + reload
  });

  it('create-ticket flow submits the selected open ids', async () => {
    vi.mocked(api.createVulnTicket).mockResolvedValue({ success: true, tickets: [{ ticketId: 't-1', orgId: 'org-1', findingCount: 3 }], skipped: [] });
    renderDrawer();
    fireEvent.click(await screen.findByTestId('vuln-action-ticket'));
    expect(screen.getByTestId('vuln-ticket-title')).toHaveValue('Remediate Google Chrome');
    fireEvent.click(screen.getByTestId('vuln-ticket-submit'));
    await waitFor(() =>
      expect(api.createVulnTicket).toHaveBeenCalledWith(['dv-1', 'dv-3', 'dv-4'], expect.objectContaining({ title: 'Remediate Google Chrome' })),
    );
  });

  it('select-all toggles every actionable device, with indeterminate for partial selection', async () => {
    renderDrawer();
    const selectAll = (await screen.findByTestId('vuln-select-all')) as HTMLInputElement;
    expect(selectAll.checked).toBe(true); // both actionable devices pre-selected
    expect(selectAll).toHaveAccessibleName('Deselect all devices');

    fireEvent.click(screen.getByTestId('vuln-device-check-dev-3'));
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);

    fireEvent.click(selectAll); // partial → all
    expect(screen.getByTestId('vuln-device-check-dev-3')).toBeChecked();
    fireEvent.click(selectAll); // all → none
    expect(screen.getByTestId('vuln-device-check-dev-1')).not.toBeChecked();
    expect(screen.getByTestId('vuln-action-remediate')).toBeDisabled();
    expect(selectAll).toHaveAccessibleName('Select all devices');
  });

  it('expands a device to lazily load its findings, with Reopen on the waiver', async () => {
    vi.mocked(api.reopenVuln).mockResolvedValue(undefined as never);
    const onActionComplete = vi.fn();
    renderDrawer({ onActionComplete });
    fireEvent.click(await screen.findByTestId('vuln-device-expand-dev-2'));
    await waitFor(() => expect(api.fetchSoftwareGroupDeviceFindings).toHaveBeenCalledWith(KEY, 'dev-2'));
    const findings = await screen.findByTestId('vuln-device-findings-dev-2');
    expect(findings).toHaveTextContent('CVE-2026-0001');
    expect(screen.getByTestId('vuln-finding-ticket-dv-2')).toHaveTextContent('T-2026-C009');

    fireEvent.click(screen.getByTestId('vuln-reopen-dv-2'));
    await waitFor(() => expect(api.reopenVuln).toHaveBeenCalledWith('dv-2'));
    await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
    expect(api.fetchSoftwareGroupDetail).toHaveBeenCalledTimes(2); // initial + reload
    await waitFor(() => expect(api.fetchSoftwareGroupDeviceFindings).toHaveBeenCalledTimes(2)); // expansion refreshed
  });

  it('collapsing a device hides its findings without refetching', async () => {
    renderDrawer();
    fireEvent.click(await screen.findByTestId('vuln-device-expand-dev-2'));
    await screen.findByTestId('vuln-device-findings-dev-2');
    fireEvent.click(screen.getByTestId('vuln-device-expand-dev-2'));
    expect(screen.queryByTestId('vuln-device-findings-dev-2')).toBeNull();
    expect(screen.getByTestId('vuln-device-expand-dev-2')).toHaveAttribute('aria-expanded', 'false');
  });

  it('hides Reopen without vulnerabilities:accept_risk', async () => {
    authState.permissions = [{ resource: 'devices', action: 'read' }];
    renderDrawer();
    fireEvent.click(await screen.findByTestId('vuln-device-expand-dev-2'));
    await screen.findByTestId('vuln-device-findings-dev-2');
    expect(screen.queryByTestId('vuln-reopen-dv-2')).toBeNull();
  });

  it('shows a per-device error when the drill-down fails', async () => {
    vi.mocked(api.fetchSoftwareGroupDeviceFindings).mockRejectedValueOnce(new Error('nope'));
    renderDrawer();
    fireEvent.click(await screen.findByTestId('vuln-device-expand-dev-2'));
    expect(await screen.findByTestId('vuln-device-findings-error-dev-2')).toHaveTextContent('nope');
    fireEvent.click(screen.getByTestId('vuln-device-findings-retry-dev-2'));
    expect(await screen.findByTestId('vuln-device-findings-dev-2')).toHaveTextContent('CVE-2026-0001');
  });

  it('hides permission-gated actions', async () => {
    authState.permissions = [{ resource: 'devices', action: 'read' }];
    renderDrawer();
    await screen.findByTestId('vuln-software-drawer');
    await screen.findByTestId('vuln-device-row-dev-1');
    expect(screen.queryByTestId('vuln-action-remediate')).toBeNull();
    expect(screen.queryByTestId('vuln-action-accept')).toBeNull();
    expect(screen.queryByTestId('vuln-action-mitigate')).toBeNull();
    expect(screen.queryByTestId('vuln-action-ticket')).toBeNull();
  });

  it('renders the group ticket chip and a per-device ticket link with distinct testids', async () => {
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue({
      ...DETAIL,
      group: { ...DETAIL.group, tickets: [{ id: 't-9', number: 'T-2026-C009' }] },
    });
    renderDrawer();
    const chip = await screen.findByTestId('vuln-ticket-chip-t-9');
    expect(chip).toHaveTextContent('Ticket T-2026-C009');
    expect(chip).toHaveAttribute('href', '/tickets#T-2026-C009');
    expect(screen.getByTestId('vuln-device-ticket-dev-2-t-9')).toHaveAttribute('href', '/tickets#T-2026-C009');
  });

  it('shows an empty message when the group has no devices', async () => {
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue({ ...DETAIL, devices: [] });
    renderDrawer();
    expect(await screen.findByTestId('vuln-drawer-no-findings')).toHaveTextContent('No device findings remain in this group');
  });

  it('hands focus to the By CVE tab before cross-navigating to the CVE drawer', async () => {
    const onSelectCve = vi.fn();
    render(
      <div>
        <button type="button" data-testid="vuln-tab-cves">
          By CVE
        </button>
        <SoftwareGroupDrawer groupKey={KEY} onClose={() => {}} onActionComplete={() => {}} onSelectCve={onSelectCve} />
      </div>,
    );
    const cveLink = await screen.findByTestId('vuln-drawer-cve-CVE-2026-0001');
    cveLink.focus();
    fireEvent.click(cveLink);
    expect(onSelectCve).toHaveBeenCalledWith('CVE-2026-0001');
    expect(document.activeElement).toBe(screen.getByTestId('vuln-tab-cves'));
  });

  it('shows an inline retry on fetch failure', async () => {
    vi.mocked(api.fetchSoftwareGroupDetail).mockRejectedValueOnce(new Error('boom'));
    renderDrawer();
    expect(await screen.findByTestId('vuln-drawer-error')).toHaveTextContent('boom');
    fireEvent.click(screen.getByTestId('vuln-drawer-retry'));
    expect(await screen.findByTestId('vuln-device-check-dev-1')).toBeInTheDocument();
  });
});
