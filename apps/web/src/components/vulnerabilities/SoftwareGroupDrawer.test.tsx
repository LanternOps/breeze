import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@/lib/i18n';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
  remediateVuln: vi.fn(),
  bulkAcceptVulnRisk: vi.fn(),
  bulkMitigateVulns: vi.fn(),
  reopenVuln: vi.fn(),
  createVulnTicket: vi.fn(),
}));

import * as api from '../../lib/api/vulnerabilities';
import { SoftwareGroupDrawer } from './SoftwareGroupDrawer';
import type { SoftwareGroupDetail } from '../../lib/api/vulnerabilities';

const DETAIL: SoftwareGroupDetail = {
  group: {
    groupKey: 'sw:google chrome|google llc',
    kind: 'software',
    name: 'Google Chrome',
    vendor: 'Google LLC',
    versions: ['126.0'],
    deviceCount: 2,
    cveCount: 1,
    cveIds: ['CVE-2026-0001'],
    worstSeverity: 'critical',
    maxRiskScore: 95,
    kevCveCount: 1,
    maxEpss: 0.9,
    patchReadyFindingCount: 1,
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
    },
  ],
  findings: [
    {
      deviceVulnerabilityId: 'dv-1',
      deviceId: 'dev-1',
      deviceName: 'WS-01',
      orgId: 'org-1',
      orgName: 'Acme',
      cveId: 'CVE-2026-0001',
      status: 'open',
      patchAvailable: true,
      riskScore: 95,
      detectedAt: '2026-06-01T00:00:00.000Z',
      acceptedUntil: null,
      ticketId: null,
      ticketNumber: null,
    },
    {
      deviceVulnerabilityId: 'dv-2',
      deviceId: 'dev-2',
      deviceName: 'WS-02',
      orgId: 'org-1',
      orgName: 'Acme',
      cveId: 'CVE-2026-0001',
      status: 'accepted',
      patchAvailable: false,
      riskScore: 90,
      detectedAt: '2026-06-01T00:00:00.000Z',
      acceptedUntil: '2026-08-01T12:00:00.000Z',
      ticketId: 't-9',
      ticketNumber: 'T-2026-C009',
    },
  ],
};

describe('SoftwareGroupDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.permissions = [{ resource: '*', action: '*' }];
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue(DETAIL);
  });

  it('renders header, CVE list, and one row per device with open findings pre-selected', async () => {
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    expect(await screen.findByTestId('vuln-software-drawer')).toHaveTextContent('Google Chrome');
    expect(screen.getByTestId('vuln-drawer-cve-CVE-2026-0001')).toBeInTheDocument();
    // One row per device, not one per finding.
    expect(screen.getByTestId('vuln-device-row-dev-1')).toHaveTextContent('WS-01');
    expect(screen.getByTestId('vuln-device-row-dev-2')).toHaveTextContent('WS-02');
    expect(screen.getByTestId('vuln-device-check-dev-1')).toBeChecked();       // its only finding is open — pre-selected
    const dev2Check = screen.getByTestId('vuln-device-check-dev-2');
    expect(dev2Check).not.toBeChecked();                                       // accepted only — nothing selectable
    expect(dev2Check).toBeDisabled();
    // Per-finding rows stay collapsed until the device is expanded.
    expect(screen.queryByTestId('vuln-finding-check-dv-1')).toBeNull();
    expect(screen.queryByTestId('vuln-finding-ticket-dv-2')).toBeNull();
  });

  it('expansion shows the device’s per-CVE rows with status, ticket link, and no checkbox on non-open findings', async () => {
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    await screen.findByTestId('vuln-software-drawer');
    const toggle = screen.getByTestId('vuln-device-toggle-dev-2');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const row = screen.getByTestId('vuln-device-row-dev-2');
    expect(row).toHaveTextContent('CVE-2026-0001');
    expect(screen.getByTestId('vuln-finding-ticket-dv-2')).toHaveTextContent('T-2026-C009');
    // Accepted finding — not selectable, so no checkbox.
    expect(screen.queryByTestId('vuln-finding-check-dv-2')).toBeNull();
    // The open finding on dev-1 does get a checkbox once expanded.
    fireEvent.click(screen.getByTestId('vuln-device-toggle-dev-1'));
    expect(screen.getByTestId('vuln-finding-check-dv-1')).toBeChecked();
    // Collapse hides the rows again.
    fireEvent.click(toggle);
    expect(screen.queryByTestId('vuln-finding-ticket-dv-2')).toBeNull();
  });

  it('device checkbox selects only that device’s open findings, with indeterminate for partial selection', async () => {
    // dev-1 carries two open findings and one accepted one.
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue({
      ...DETAIL,
      findings: [
        DETAIL.findings[0]!,
        { ...DETAIL.findings[0]!, deviceVulnerabilityId: 'dv-3', cveId: 'CVE-2026-0002' },
        { ...DETAIL.findings[1]!, deviceVulnerabilityId: 'dv-4', deviceId: 'dev-1', deviceName: 'WS-01', ticketId: null, ticketNumber: null },
        DETAIL.findings[1]!,
      ],
    });
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    const dev1Check = (await screen.findByTestId('vuln-device-check-dev-1')) as HTMLInputElement;
    expect(dev1Check.checked).toBe(true); // both open findings pre-selected
    expect(screen.getByTestId('vuln-device-row-dev-1')).toHaveTextContent('3 findings · 2 open');

    fireEvent.click(dev1Check); // deselect the device's open findings
    expect(dev1Check.checked).toBe(false);
    expect(dev1Check.indeterminate).toBe(false);
    expect(screen.getByTestId('vuln-software-drawer')).toHaveTextContent('0 selected');

    fireEvent.click(dev1Check); // reselect — only the open ones come back
    expect(dev1Check.checked).toBe(true);
    expect(screen.getByTestId('vuln-software-drawer')).toHaveTextContent('2 selected');

    // Deselect one of the two via the expanded per-finding checkbox — device box goes indeterminate.
    fireEvent.click(screen.getByTestId('vuln-device-toggle-dev-1'));
    fireEvent.click(screen.getByTestId('vuln-finding-check-dv-3'));
    expect(dev1Check.checked).toBe(false);
    expect(dev1Check.indeterminate).toBe(true);
  });

  it('shows an empty message instead of a bare heading when the group has no findings', async () => {
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue({ ...DETAIL, findings: [] });
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    expect(await screen.findByTestId('vuln-drawer-no-findings')).toHaveTextContent('No device findings remain in this group');
    expect(screen.queryByTestId('vuln-finding-check-dv-1')).toBeNull();
  });

  it('renders distinct testids for the group ticket chip and a per-finding ticket link that share a ticketId', async () => {
    const detailWithSharedTicket: SoftwareGroupDetail = {
      ...DETAIL,
      group: { ...DETAIL.group, tickets: [{ id: 't-9', number: 'T-2026-C009' }] },
    };
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue(detailWithSharedTicket);
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    expect(await screen.findByTestId('vuln-software-drawer')).toHaveTextContent('Google Chrome');
    // Group-level header chip (aggregate of group.tickets) — canonical vuln-ticket-chip-<ticketId>,
    // labelled with the human ticket number, linking by number (TicketsPage resolves either).
    const chip = screen.getByTestId('vuln-ticket-chip-t-9');
    expect(chip).toHaveTextContent('Ticket T-2026-C009');
    expect(chip).toHaveAttribute('href', '/tickets#T-2026-C009');
    // Per-finding inline link for the finding whose own ticketId is also t-9 — distinct testid, no collision.
    fireEvent.click(screen.getByTestId('vuln-device-toggle-dev-2'));
    expect(screen.getByTestId('vuln-finding-ticket-dv-2')).toHaveTextContent('T-2026-C009');
  });

  it('falls back to a generic chip label when the ticket has no human number', async () => {
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue({
      ...DETAIL,
      group: { ...DETAIL.group, tickets: [{ id: 't-9', number: null }] },
    });
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    const chip = await screen.findByTestId('vuln-ticket-chip-t-9');
    expect(chip).toHaveTextContent('View ticket');
    expect(chip).toHaveAttribute('href', '/tickets#t-9');
  });

  it('accept-risk flow: opens modal, submits selected ids, reloads and notifies', async () => {
    vi.mocked(api.bulkAcceptVulnRisk).mockResolvedValue({ success: true, succeeded: 1, skipped: [] });
    const onActionComplete = vi.fn();
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={onActionComplete} onSelectCve={() => {}} />,
    );
    fireEvent.click(await screen.findByTestId('vuln-action-accept'));
    fireEvent.change(screen.getByTestId('vuln-bulk-text'), { target: { value: 'compensating control' } });
    fireEvent.change(screen.getByTestId('vuln-bulk-until'), { target: { value: '2030-01-01' } });
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    await waitFor(() =>
      expect(api.bulkAcceptVulnRisk).toHaveBeenCalledWith(['dv-1'], {
        reason: 'compensating control',
        // End of the picked day in the USER'S timezone (not UTC midnight, which
        // is the previous local day west of UTC).
        acceptedUntil: new Date(2030, 0, 1, 23, 59, 59, 999).toISOString(),
      }),
    );
    await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
    expect(api.fetchSoftwareGroupDetail).toHaveBeenCalledTimes(2); // initial + reload
  });

  it('remediate opens a confirmation with finding/device counts and only fires on confirm', async () => {
    vi.mocked(api.remediateVuln).mockResolvedValue({ scheduled: 1, skipped: [] });
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    fireEvent.click(await screen.findByTestId('vuln-action-remediate'));
    // Nothing fired yet — the confirmation stands between the button and the mutation.
    expect(api.remediateVuln).not.toHaveBeenCalled();
    expect(screen.getByTestId('vuln-bulk-modal')).toHaveTextContent('Remediate findings — 1 finding');
    expect(screen.getByTestId('vuln-bulk-consequence')).toHaveTextContent('on 1 device (1 finding)');
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    await waitFor(() => expect(api.remediateVuln).toHaveBeenCalledWith(['dv-1']));
  });

  it('surfaces a remediate failure inline in the confirmation modal (not just the toast)', async () => {
    vi.mocked(api.remediateVuln).mockRejectedValue(new Error('No available patch mapped to these findings'));
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    fireEvent.click(await screen.findByTestId('vuln-action-remediate'));
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    // Modal stays open with the failure message inline.
    expect(await screen.findByTestId('vuln-bulk-error')).toHaveTextContent('No available patch mapped to these findings');
    expect(screen.getByTestId('vuln-bulk-modal')).toBeInTheDocument();
    // Cancelling and reopening starts clean.
    fireEvent.click(screen.getByTestId('vuln-bulk-cancel'));
    fireEvent.click(screen.getByTestId('vuln-action-remediate'));
    expect(screen.queryByTestId('vuln-bulk-error')).toBeNull();
  });

  it('pluralizes the devices meta line and shows device + finding counts distinctly in the heading', async () => {
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue({
      ...DETAIL,
      group: { ...DETAIL.group, deviceCount: 1 },
      findings: [DETAIL.findings[0]!],
    });
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    const drawer = await screen.findByTestId('vuln-software-drawer');
    expect(drawer).toHaveTextContent('1 device ·');
    expect(drawer).toHaveTextContent('Devices (1) · 1 finding');
    expect(drawer).not.toHaveTextContent('1 devices');
    expect(drawer).not.toHaveTextContent('1 findings');
  });

  it('heading counts devices distinctly from findings', async () => {
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    // 2 devices, 2 findings total.
    expect(await screen.findByTestId('vuln-software-drawer')).toHaveTextContent('Devices (2) · 2 findings');
  });

  it('remediate confirmation can be cancelled without firing the mutation', async () => {
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    fireEvent.click(await screen.findByTestId('vuln-action-remediate'));
    fireEvent.click(screen.getByTestId('vuln-bulk-cancel'));
    expect(screen.queryByTestId('vuln-bulk-modal')).toBeNull();
    expect(api.remediateVuln).not.toHaveBeenCalled();
  });

  it('names the device and finding checkboxes for screen readers', async () => {
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    expect(await screen.findByTestId('vuln-device-check-dev-1')).toHaveAttribute(
      'aria-label',
      'Select all open findings on WS-01',
    );
    fireEvent.click(screen.getByTestId('vuln-device-toggle-dev-1'));
    expect(screen.getByTestId('vuln-finding-check-dv-1')).toHaveAttribute(
      'aria-label',
      'Select CVE-2026-0001 finding on WS-01',
    );
  });

  it('hides permission-gated actions', async () => {
    authState.permissions = [{ resource: 'devices', action: 'read' }];
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    await screen.findByTestId('vuln-software-drawer');
    expect(screen.queryByTestId('vuln-action-remediate')).toBeNull();
    expect(screen.queryByTestId('vuln-action-accept')).toBeNull();
    expect(screen.queryByTestId('vuln-action-mitigate')).toBeNull();
  });

  it('create-ticket flow: opens prefilled modal, submits, refreshes chips', async () => {
    vi.mocked(api.createVulnTicket).mockResolvedValue({ success: true, tickets: [{ ticketId: 't-1', orgId: 'org-1', findingCount: 1 }], skipped: [] });
    const onActionComplete = vi.fn();
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={onActionComplete} onSelectCve={() => {}} />,
    );
    fireEvent.click(await screen.findByTestId('vuln-action-ticket'));
    expect(screen.getByTestId('vuln-ticket-title')).toHaveValue('Remediate Google Chrome');
    fireEvent.click(screen.getByTestId('vuln-ticket-submit'));
    await waitFor(() =>
      expect(api.createVulnTicket).toHaveBeenCalledWith(['dv-1'], expect.objectContaining({ title: 'Remediate Google Chrome', priority: 'normal' })),
    );
    await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
  });

  it('hides Create ticket without tickets:write', async () => {
    authState.permissions = [
      { resource: 'devices', action: 'execute' },
      { resource: 'vulnerabilities', action: 'accept_risk' },
      { resource: 'devices', action: 'write' },
    ];
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    await screen.findByTestId('vuln-software-drawer');
    expect(screen.queryByTestId('vuln-action-ticket')).toBeNull();
  });

  it('shows Reopen only on accepted/mitigated findings and calls the API', async () => {
    vi.mocked(api.reopenVuln).mockResolvedValue(undefined as never);
    const onActionComplete = vi.fn();
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={onActionComplete} onSelectCve={() => {}} />,
    );
    await screen.findByTestId('vuln-software-drawer');
    fireEvent.click(screen.getByTestId('vuln-device-toggle-dev-1'));
    fireEvent.click(screen.getByTestId('vuln-device-toggle-dev-2'));
    expect(screen.queryByTestId('vuln-reopen-dv-1')).toBeNull();      // open finding
    fireEvent.click(screen.getByTestId('vuln-reopen-dv-2'));          // accepted finding
    await waitFor(() => expect(api.reopenVuln).toHaveBeenCalledWith('dv-2'));
    await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
    expect(api.fetchSoftwareGroupDetail).toHaveBeenCalledTimes(2); // initial + reload
  });

  it('hides Reopen without vulnerabilities:accept_risk', async () => {
    authState.permissions = [{ resource: 'devices', action: 'read' }];
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    await screen.findByTestId('vuln-software-drawer');
    fireEvent.click(screen.getByTestId('vuln-device-toggle-dev-2'));
    expect(screen.queryByTestId('vuln-reopen-dv-2')).toBeNull();
  });

  it('select-all covers only OPEN findings, with indeterminate for partial selection', async () => {
    // Two devices, three findings: dv-1 + dv-3 open, dv-2 accepted.
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue({
      ...DETAIL,
      findings: [
        DETAIL.findings[0]!,
        { ...DETAIL.findings[0]!, deviceVulnerabilityId: 'dv-3', cveId: 'CVE-2026-0002' },
        DETAIL.findings[1]!,
      ],
    });
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    const selectAll = (await screen.findByTestId('vuln-select-all')) as HTMLInputElement;
    // Pre-selection is every open finding — select-all starts fully checked; the
    // accepted dv-2 does NOT count against it.
    expect(selectAll.checked).toBe(true);
    expect(selectAll.indeterminate).toBe(false);
    expect(selectAll).toHaveAccessibleName('Deselect all open findings');
    // Label counts the selectable (open) findings, not all findings.
    expect(screen.getByTestId('vuln-software-drawer')).toHaveTextContent('Select all open (2)');

    fireEvent.click(selectAll); // all → none
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(false);
    expect(selectAll).toHaveAccessibleName('Select all open findings');
    expect(screen.getByTestId('vuln-device-check-dev-1')).not.toBeChecked();
    // Nothing selected — the bulk actions disable.
    expect(screen.getByTestId('vuln-action-remediate')).toBeDisabled();

    // Partial: select one of the two open findings — indeterminate, and toggling
    // select-all selects only the open ones (2 selected, never dv-2's 3).
    fireEvent.click(screen.getByTestId('vuln-device-toggle-dev-1'));
    fireEvent.click(screen.getByTestId('vuln-finding-check-dv-1'));
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);
    fireEvent.click(selectAll); // partial → all open
    expect(selectAll.checked).toBe(true);
    expect(screen.getByTestId('vuln-finding-check-dv-1')).toBeChecked();
    expect(screen.getByTestId('vuln-finding-check-dv-3')).toBeChecked();
    expect(screen.getByTestId('vuln-software-drawer')).toHaveTextContent('2 selected');
  });

  it('hides select-all when the group has no open findings', async () => {
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue({
      ...DETAIL,
      findings: [DETAIL.findings[1]!], // accepted only
    });
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    await screen.findByTestId('vuln-device-row-dev-2');
    expect(screen.queryByTestId('vuln-select-all')).toBeNull();
  });

  it('passes the selected devices (with CVE ids) to the bulk modal summary', async () => {
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    fireEvent.click(await screen.findByTestId('vuln-action-accept'));
    // dv-1 (open) is pre-selected; the group context mixes CVEs so the CVE id is shown.
    expect(screen.getByTestId('vuln-bulk-selection')).toHaveTextContent('WS-01 (CVE-2026-0001)');
  });

  it('hands focus to the By CVE tab before cross-navigating to the CVE drawer', async () => {
    const onSelectCve = vi.fn();
    render(
      <div>
        {/* Stand-in for the fleet page's persistent tab, which survives the drawer swap. */}
        <button type="button" data-testid="vuln-tab-cves">
          By CVE
        </button>
        <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={onSelectCve} />
      </div>,
    );
    const cveLink = await screen.findByTestId('vuln-drawer-cve-CVE-2026-0001');
    cveLink.focus();
    fireEvent.click(cveLink);
    expect(onSelectCve).toHaveBeenCalledWith('CVE-2026-0001');
    // Focus moved off the soon-to-unmount link so the incoming CVE drawer
    // captures a live focus-restore target.
    expect(document.activeElement).toBe(screen.getByTestId('vuln-tab-cves'));
  });

  it('forwards the table filters (severity/kevOnly/patchAvailable) into the detail fetch', async () => {
    render(
      <SoftwareGroupDrawer
        groupKey="sw:google chrome|google llc"
        filters={{ severity: 'critical', kevOnly: true }}
        onClose={() => {}}
        onActionComplete={() => {}}
        onSelectCve={() => {}}
      />,
    );
    await screen.findByTestId('vuln-software-drawer');
    expect(api.fetchSoftwareGroupDetail).toHaveBeenCalledWith(
      'sw:google chrome|google llc',
      expect.objectContaining({ severity: 'critical', kevOnly: true }),
    );
  });

  it('disables Remediate with an explanatory title when no selected finding has a patch', async () => {
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue({
      ...DETAIL,
      findings: [{ ...DETAIL.findings[0]!, patchAvailable: false }],
    });
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    const remediate = await screen.findByTestId('vuln-action-remediate');
    // The open patchless finding is pre-selected — remediation would be a no-op.
    expect(screen.getByTestId('vuln-software-drawer')).toHaveTextContent('1 selected');
    expect(remediate).toBeDisabled();
    expect(remediate).toHaveAttribute('title', 'No patch available for the selected findings');
    // The other bulk actions stay available for a patchless selection.
    expect(screen.getByTestId('vuln-action-accept')).toBeEnabled();
  });

  it('enables Remediate (no tooltip) when at least one selected finding has a patch', async () => {
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue({
      ...DETAIL,
      findings: [
        { ...DETAIL.findings[0]!, patchAvailable: false },
        { ...DETAIL.findings[0]!, deviceVulnerabilityId: 'dv-3', cveId: 'CVE-2026-0002', patchAvailable: true },
      ],
    });
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    const remediate = await screen.findByTestId('vuln-action-remediate');
    expect(remediate).toBeEnabled();
    expect(remediate).not.toHaveAttribute('title');
    // Narrow the selection down to only the patchless finding — Remediate grays out.
    fireEvent.click(screen.getByTestId('vuln-device-toggle-dev-1'));
    fireEvent.click(screen.getByTestId('vuln-finding-check-dv-3'));
    expect(remediate).toBeDisabled();
    expect(remediate).toHaveAttribute('title', 'No patch available for the selected findings');
  });

  it('shows an inline retry on fetch failure', async () => {
    vi.mocked(api.fetchSoftwareGroupDetail).mockRejectedValueOnce(new Error('boom'));
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    expect(await screen.findByTestId('vuln-drawer-error')).toHaveTextContent('boom');
    fireEvent.click(screen.getByTestId('vuln-drawer-retry'));
    expect(await screen.findByTestId('vuln-device-row-dev-1')).toBeInTheDocument();
  });
});
