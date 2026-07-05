import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('renders header, CVE list, and device findings with open findings pre-selected', async () => {
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    expect(await screen.findByTestId('vuln-software-drawer')).toHaveTextContent('Google Chrome');
    expect(screen.getByTestId('vuln-drawer-cve-CVE-2026-0001')).toBeInTheDocument();
    expect(screen.getByTestId('vuln-finding-check-dv-1')).toBeChecked();       // open — pre-selected
    expect(screen.getByTestId('vuln-finding-check-dv-2')).not.toBeChecked();   // accepted — not pre-selected
    expect(screen.getByTestId('vuln-finding-ticket-dv-2')).toBeInTheDocument();
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
    expect(screen.getByTestId('vuln-bulk-remediate-summary')).toHaveTextContent('1 finding on 1 device');
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

  it('pluralizes the devices meta line and findings heading', async () => {
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
    expect(drawer).toHaveTextContent('Devices (1 finding)');
    expect(drawer).not.toHaveTextContent('1 devices');
    expect(drawer).not.toHaveTextContent('1 findings');
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

  it('names each finding checkbox after its device for screen readers', async () => {
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    expect(await screen.findByTestId('vuln-finding-check-dv-1')).toHaveAttribute(
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

  it('shows an inline retry on fetch failure', async () => {
    vi.mocked(api.fetchSoftwareGroupDetail).mockRejectedValueOnce(new Error('boom'));
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    expect(await screen.findByTestId('vuln-drawer-error')).toHaveTextContent('boom');
    fireEvent.click(screen.getByTestId('vuln-drawer-retry'));
    expect(await screen.findByTestId('vuln-finding-check-dv-1')).toBeInTheDocument();
  });
});
