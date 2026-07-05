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
      patchAvailable: true,
      riskScore: 95,
      detectedAt: '2026-06-01T00:00:00.000Z',
      ticketId: null,
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
});
