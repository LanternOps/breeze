import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';

vi.mock('../../lib/api/vulnerabilities', () => ({
  fetchSoftwareGroups: vi.fn(),
}));

import * as api from '../../lib/api/vulnerabilities';
import { SoftwareGroupTable } from './SoftwareGroupTable';
import type { SoftwareGroup, VulnFleetFilters } from '../../lib/api/vulnerabilities';

const FILTERS: VulnFleetFilters = { search: '', severity: '', status: 'open', kevOnly: false, patchAvailable: false };

function group(overrides: Partial<SoftwareGroup> = {}): SoftwareGroup {
  return {
    groupKey: 'sw:google chrome|google llc',
    kind: 'software',
    name: 'Google Chrome',
    vendor: 'Google LLC',
    versions: ['125.0', '126.0'],
    deviceCount: 14,
    cveCount: 6,
    cveIds: ['CVE-2026-0001'],
    worstSeverity: 'critical',
    maxRiskScore: 95,
    kevCveCount: 1,
    maxEpss: 0.9,
    patchReadyFindingCount: 12,
    patchReadyDeviceCount: 12,
    ticketIds: [],
    ...overrides,
  };
}

describe('SoftwareGroupTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fetchSoftwareGroups).mockResolvedValue({ items: [group()], hasMore: false });
  });

  it('renders one row per group with patch readiness and KEV flag', async () => {
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} onSelectGroup={() => {}} onClearFilters={() => {}} />);
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    const row = desktop.getByTestId('software-group-row-sw:google chrome|google llc');
    expect(row).toHaveTextContent('Google Chrome');
    expect(row).toHaveTextContent('Google LLC');
    expect(row).toHaveTextContent('Ready · 12/14 devices');
    expect(row).toHaveTextContent('KEV');
  });

  it('invokes onSelectGroup with the groupKey on row click', async () => {
    const onSelect = vi.fn();
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} onSelectGroup={onSelect} onClearFilters={() => {}} />);
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    fireEvent.click(desktop.getByTestId('software-group-row-sw:google chrome|google llc'));
    expect(onSelect).toHaveBeenCalledWith('sw:google chrome|google llc');
  });

  it('refetches when filters or refreshKey change', async () => {
    const { rerender } = render(
      <SoftwareGroupTable filters={FILTERS} refreshKey={0} onSelectGroup={() => {}} onClearFilters={() => {}} />,
    );
    await screen.findByTestId('responsive-table-desktop');
    rerender(
      <SoftwareGroupTable filters={{ ...FILTERS, severity: 'critical' }} refreshKey={0} onSelectGroup={() => {}} onClearFilters={() => {}} />,
    );
    await vi.waitFor(() => expect(api.fetchSoftwareGroups).toHaveBeenCalledTimes(2));
    expect(api.fetchSoftwareGroups).toHaveBeenLastCalledWith(expect.objectContaining({ severity: 'critical' }));
  });

  it('shows the filtered-empty state with a clear-filters link', async () => {
    vi.mocked(api.fetchSoftwareGroups).mockResolvedValue({ items: [], hasMore: false });
    const onClear = vi.fn();
    render(
      <SoftwareGroupTable
        filters={{ ...FILTERS, severity: 'low' }}
        refreshKey={0}
        onSelectGroup={() => {}}
        onClearFilters={onClear}
      />,
    );
    fireEvent.click(await screen.findByTestId('software-group-clear-filters'));
    expect(onClear).toHaveBeenCalled();
  });

  it('shows the error state on fetch failure', async () => {
    vi.mocked(api.fetchSoftwareGroups).mockRejectedValue(new Error('boom'));
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} onSelectGroup={() => {}} onClearFilters={() => {}} />);
    expect(await screen.findByTestId('software-group-table-error')).toHaveTextContent('boom');
  });
});
