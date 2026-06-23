import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';

import { DeviceVulnerabilitiesTab } from './DeviceVulnerabilitiesTab';
import * as api from '../../lib/api/vulnerabilities';

vi.mock('../../lib/api/vulnerabilities', () => ({
  fetchDeviceVulnerabilities: vi.fn(),
  remediateVuln: vi.fn(),
  acceptVulnRisk: vi.fn(),
  mitigateVuln: vi.fn(),
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
};

beforeEach(() => {
  vi.clearAllMocks();
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
});
