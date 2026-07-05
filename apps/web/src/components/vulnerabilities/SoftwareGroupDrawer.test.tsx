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
    ticketIds: [],
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
      ticketId: null,
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
      ticketId: 't-9',
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
    expect(screen.getByTestId('vuln-ticket-chip-t-9')).toBeInTheDocument();
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
        acceptedUntil: new Date('2030-01-01T00:00:00Z').toISOString(),
      }),
    );
    await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
    expect(api.fetchSoftwareGroupDetail).toHaveBeenCalledTimes(2); // initial + reload
  });

  it('remediate acts on the selected findings', async () => {
    vi.mocked(api.remediateVuln).mockResolvedValue({ scheduled: 1, skipped: [] });
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    fireEvent.click(await screen.findByTestId('vuln-action-remediate'));
    await waitFor(() => expect(api.remediateVuln).toHaveBeenCalledWith(['dv-1']));
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
