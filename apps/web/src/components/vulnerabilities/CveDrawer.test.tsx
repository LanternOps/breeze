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
  fetchCveDevices: vi.fn(),
  remediateVuln: vi.fn(),
  bulkAcceptVulnRisk: vi.fn(),
  bulkMitigateVulns: vi.fn(),
  reopenVuln: vi.fn(),
  createVulnTicket: vi.fn(),
}));

import * as api from '../../lib/api/vulnerabilities';
import { CveDrawer } from './CveDrawer';
import type { CveDevicesPayload } from '../../lib/api/vulnerabilities';

const PAYLOAD: CveDevicesPayload = {
  cve: {
    cveId: 'CVE-2026-0001',
    description: 'Heap overflow in the render pipeline.',
    references: ['https://example.test/advisory'],
    cvssVersion: '3.1',
    cvssVector: 'CVSS:3.1/AV:N/AC:L',
    cvssScore: 9.1,
    epssScore: 0.42,
    knownExploited: true,
    patchAvailable: true,
    severity: 'critical',
    publishedAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-02-01T00:00:00.000Z',
  },
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
      patchAvailable: true,
      riskScore: 95,
      detectedAt: '2026-06-01T00:00:00.000Z',
      acceptedUntil: '2026-08-01T12:00:00.000Z',
      ticketId: null,
      ticketNumber: null,
    },
  ],
};

describe('CveDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.permissions = [{ resource: '*', action: '*' }];
    vi.mocked(api.fetchCveDevices).mockResolvedValue(PAYLOAD);
  });

  it('renders CVE metadata, vector, EPSS, KEV, and reference links', async () => {
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    const meta = await screen.findByTestId('vuln-cve-meta');
    expect(meta).toHaveTextContent('Heap overflow');
    expect(meta).toHaveTextContent('CVSS:3.1/AV:N/AC:L');
    expect(meta).toHaveTextContent('42.0%');
    expect(meta).toHaveTextContent('KEV');
    expect(screen.getByTestId('vuln-cve-reference-0')).toHaveAttribute('href', 'https://example.test/advisory');
  });

  it('shows an empty message instead of a bare heading when the CVE has no fleet findings', async () => {
    vi.mocked(api.fetchCveDevices).mockResolvedValue({ ...PAYLOAD, findings: [] });
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    expect(await screen.findByTestId('vuln-drawer-no-findings')).toHaveTextContent('No devices in your fleet are affected');
    expect(screen.queryByTestId('vuln-finding-check-dv-1')).toBeNull();
  });

  it('shows when an accepted finding expires ("Accepted until"), not a bare status chip', async () => {
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    const drawer = await screen.findByTestId('vuln-cve-drawer');
    expect(drawer).toHaveTextContent(`Accepted until ${new Date('2026-08-01T12:00:00.000Z').toLocaleDateString()}`);
  });

  it('shows Reopen only on accepted/mitigated findings and calls the API', async () => {
    vi.mocked(api.reopenVuln).mockResolvedValue(undefined as never);
    const onActionComplete = vi.fn();
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={onActionComplete} />);
    await screen.findByTestId('vuln-cve-drawer');
    expect(screen.queryByTestId('vuln-reopen-dv-1')).toBeNull();      // open finding
    fireEvent.click(screen.getByTestId('vuln-reopen-dv-2'));          // accepted finding
    await waitFor(() => expect(api.reopenVuln).toHaveBeenCalledWith('dv-2'));
    await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
  });

  it('hides Reopen without vulnerabilities:accept_risk', async () => {
    authState.permissions = [{ resource: 'devices', action: 'read' }];
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    await screen.findByTestId('vuln-cve-drawer');
    expect(screen.queryByTestId('vuln-reopen-dv-2')).toBeNull();
  });

  it('runs bulk accept-risk against the selected findings scoped to this CVE', async () => {
    vi.mocked(api.bulkAcceptVulnRisk).mockResolvedValue({ success: true, succeeded: 1, skipped: [] });
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    fireEvent.click(await screen.findByTestId('vuln-action-accept'));
    fireEvent.change(screen.getByTestId('vuln-bulk-text'), { target: { value: 'ok' } });
    fireEvent.change(screen.getByTestId('vuln-bulk-until'), { target: { value: '2030-01-01' } });
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    await waitFor(() => expect(api.bulkAcceptVulnRisk).toHaveBeenCalledWith(['dv-1'], expect.anything()));
  });

  it('remediate opens a confirmation and only fires on confirm', async () => {
    vi.mocked(api.remediateVuln).mockResolvedValue({ scheduled: 1, skipped: [] });
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    fireEvent.click(await screen.findByTestId('vuln-action-remediate'));
    expect(api.remediateVuln).not.toHaveBeenCalled();
    expect(screen.getByTestId('vuln-bulk-consequence')).toHaveTextContent('on 1 device (1 finding)');
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    await waitFor(() => expect(api.remediateVuln).toHaveBeenCalledWith(['dv-1']));
  });

  it('surfaces a remediate failure inline in the confirmation modal (not just the toast)', async () => {
    vi.mocked(api.remediateVuln).mockRejectedValue(new Error('No available patch mapped to these findings'));
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    fireEvent.click(await screen.findByTestId('vuln-action-remediate'));
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    expect(await screen.findByTestId('vuln-bulk-error')).toHaveTextContent('No available patch mapped to these findings');
    expect(screen.getByTestId('vuln-bulk-modal')).toBeInTheDocument();
  });

  it('pluralizes the findings heading for a single finding', async () => {
    vi.mocked(api.fetchCveDevices).mockResolvedValue({ ...PAYLOAD, findings: [PAYLOAD.findings[0]!] });
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    const drawer = await screen.findByTestId('vuln-cve-drawer');
    expect(drawer).toHaveTextContent('Devices (1 finding)');
    expect(drawer).not.toHaveTextContent('1 findings');
  });

  it('names each finding checkbox after its device for screen readers', async () => {
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    expect(await screen.findByTestId('vuln-finding-check-dv-1')).toHaveAttribute('aria-label', 'Select finding on WS-01');
  });

  it('select-all toggles between every finding and none, with indeterminate for partial selection', async () => {
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    const selectAll = (await screen.findByTestId('vuln-select-all')) as HTMLInputElement;
    // Pre-selection is open-only (dv-1 of 2) — partial, so indeterminate.
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);
    expect(selectAll).toHaveAccessibleName('Select all findings');

    fireEvent.click(selectAll); // partial → all
    expect(screen.getByTestId('vuln-finding-check-dv-2')).toBeChecked();
    expect(selectAll.checked).toBe(true);
    expect(selectAll.indeterminate).toBe(false);
    expect(selectAll).toHaveAccessibleName('Deselect all findings');

    fireEvent.click(selectAll); // all → none
    expect(screen.getByTestId('vuln-finding-check-dv-1')).not.toBeChecked();
    expect(screen.getByTestId('vuln-finding-check-dv-2')).not.toBeChecked();
    expect(selectAll.indeterminate).toBe(false);
    expect(screen.getByTestId('vuln-action-remediate')).toBeDisabled();
  });

  it('passes the selected device names (no CVE id — the drawer IS the CVE) to the bulk modal summary', async () => {
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    fireEvent.click(await screen.findByTestId('vuln-action-accept'));
    const summary = screen.getByTestId('vuln-bulk-selection');
    expect(summary).toHaveTextContent('WS-01');
    expect(summary).not.toHaveTextContent('CVE-2026-0001');
  });

  it('shows an inline retry on fetch failure and recovers on retry', async () => {
    vi.mocked(api.fetchCveDevices).mockRejectedValueOnce(new Error('boom'));
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    expect(await screen.findByTestId('vuln-drawer-error')).toHaveTextContent('boom');
    fireEvent.click(screen.getByTestId('vuln-drawer-retry'));
    expect(await screen.findByTestId('vuln-finding-check-dv-1')).toBeInTheDocument();
  });

  it('reloads and notifies after a partial-skip bulk accept (some findings skipped)', async () => {
    // A partial success (non-empty skipped) is still a success: the drawer reloads
    // and notifies. The summarized skip prose is produced by runAction inside the
    // (mocked-out) api layer; that string is unit-tested in bulkSummary/summarizeSkipReasons.
    vi.mocked(api.bulkAcceptVulnRisk).mockResolvedValue({
      success: true,
      succeeded: 1,
      skipped: [{ id: 'dv-1', reason: 'site_access_denied' }],
    });
    const onActionComplete = vi.fn();
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={onActionComplete} />);
    fireEvent.click(await screen.findByTestId('vuln-action-accept'));
    fireEvent.change(screen.getByTestId('vuln-bulk-text'), { target: { value: 'ok' } });
    fireEvent.change(screen.getByTestId('vuln-bulk-until'), { target: { value: '2030-01-01' } });
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    await waitFor(() => expect(api.bulkAcceptVulnRisk).toHaveBeenCalledWith(['dv-1'], expect.anything()));
    await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
    expect(api.fetchCveDevices).toHaveBeenCalledTimes(2); // initial + reload
  });
});
