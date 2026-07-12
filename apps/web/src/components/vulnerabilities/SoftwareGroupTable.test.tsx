import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@/lib/i18n';
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
    tickets: [],
    ...overrides,
  };
}

describe('SoftwareGroupTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fetchSoftwareGroups).mockResolvedValue({ items: [group()], hasMore: false });
  });

  it('explains the Risk column via a header help tooltip', async () => {
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} emptyVariant="filtered" onSelectGroup={() => {}} onClearFilters={() => {}} />);
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    fireEvent.click(desktop.getByRole('button', { name: 'About the risk score' }));
    expect(desktop.getByRole('tooltip')).toHaveTextContent('Higher = fix sooner');
  });

  it('renders one row per group with patch readiness and KEV flag', async () => {
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} emptyVariant="filtered" onSelectGroup={() => {}} onClearFilters={() => {}} />);
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    const row = desktop.getByTestId('software-group-row-sw:google chrome|google llc');
    expect(row).toHaveTextContent('Google Chrome');
    expect(row).toHaveTextContent('Google LLC');
    expect(row).toHaveTextContent('Ready · 12/14 devices');
    expect(row).toHaveTextContent('KEV');
  });

  it('invokes onSelectGroup with the groupKey on row click', async () => {
    const onSelect = vi.fn();
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} emptyVariant="filtered" onSelectGroup={onSelect} onClearFilters={() => {}} />);
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    fireEvent.click(desktop.getByTestId('software-group-row-sw:google chrome|google llc'));
    expect(onSelect).toHaveBeenCalledWith('sw:google chrome|google llc');
  });

  it('exposes a keyboard-activatable button in the primary cell (single activation)', async () => {
    const onSelect = vi.fn();
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} emptyVariant="filtered" onSelectGroup={onSelect} onClearFilters={() => {}} />);
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    const openBtn = desktop.getByTestId('software-group-open-sw:google chrome|google llc');
    expect(openBtn.tagName).toBe('BUTTON'); // real button => focusable + Enter/Space for free
    expect(openBtn).toHaveAccessibleName('Open Google Chrome vulnerability details');
    fireEvent.click(openBtn); // Enter/Space on a native button dispatches click
    expect(onSelect).toHaveBeenCalledTimes(1); // stopPropagation: no double fire via the row handler
    expect(onSelect).toHaveBeenCalledWith('sw:google chrome|google llc');
  });

  it('refetches when filters or refreshKey change', async () => {
    const { rerender } = render(
      <SoftwareGroupTable filters={FILTERS} refreshKey={0} emptyVariant="filtered" onSelectGroup={() => {}} onClearFilters={() => {}} />,
    );
    await screen.findByTestId('responsive-table-desktop');
    rerender(
      <SoftwareGroupTable filters={{ ...FILTERS, severity: 'critical' }} refreshKey={0} emptyVariant="filtered" onSelectGroup={() => {}} onClearFilters={() => {}} />,
    );
    await vi.waitFor(() => expect(api.fetchSoftwareGroups).toHaveBeenCalledTimes(2));
    expect(api.fetchSoftwareGroups).toHaveBeenLastCalledWith(expect.objectContaining({ severity: 'critical' }));
  });

  it('renders skeleton rows under the header while the first fetch is in flight', async () => {
    let resolve!: (v: { items: SoftwareGroup[]; hasMore: boolean }) => void;
    vi.mocked(api.fetchSoftwareGroups).mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} emptyVariant="filtered" onSelectGroup={() => {}} onClearFilters={() => {}} />);
    expect(screen.getByTestId('software-group-table-skeleton')).toBeInTheDocument();
    resolve({ items: [group()], hasMore: false });
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    expect(await desktop.findByTestId('software-group-row-sw:google chrome|google llc')).toBeInTheDocument();
    expect(screen.queryByTestId('software-group-table-skeleton')).toBeNull();
  });

  it('shows the truncation notice when the server reports more groups than the cap', async () => {
    vi.mocked(api.fetchSoftwareGroups).mockResolvedValue({ items: [group()], hasMore: true });
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} emptyVariant="filtered" onSelectGroup={() => {}} onClearFilters={() => {}} />);
    expect(await screen.findByTestId('software-group-has-more')).toHaveTextContent('top 500 groups');
  });

  it('shows the filtered-empty state with a clear-filters link', async () => {
    vi.mocked(api.fetchSoftwareGroups).mockResolvedValue({ items: [], hasMore: false });
    const onClear = vi.fn();
    render(
      <SoftwareGroupTable
        filters={{ ...FILTERS, severity: 'low' }}
        refreshKey={0} emptyVariant="filtered"
        onSelectGroup={() => {}}
        onClearFilters={onClear}
      />,
    );
    expect(await screen.findByTestId('vuln-empty-filtered')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('software-group-clear-filters'));
    expect(onClear).toHaveBeenCalled();
  });

  it('renders the clean-fleet and unscanned zero-states when the page resolves them', async () => {
    vi.mocked(api.fetchSoftwareGroups).mockResolvedValue({ items: [], hasMore: false });
    const { rerender } = render(
      <SoftwareGroupTable
        filters={FILTERS}
        refreshKey={0} emptyVariant="clean"
        lastDetectedAt="2026-06-30T00:00:00.000Z"
        onSelectGroup={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(await screen.findByTestId('vuln-empty-clean')).toHaveTextContent('No open vulnerabilities across your fleet');
    rerender(
      <SoftwareGroupTable
        filters={FILTERS}
        refreshKey={0} emptyVariant="unscanned"
        onSelectGroup={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(await screen.findByTestId('vuln-empty-unscanned')).toHaveTextContent('No vulnerability findings yet');
  });

  it('shows the error state on fetch failure', async () => {
    vi.mocked(api.fetchSoftwareGroups).mockRejectedValue(new Error('boom'));
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} emptyVariant="filtered" onSelectGroup={() => {}} onClearFilters={() => {}} />);
    expect(await screen.findByTestId('software-group-table-error')).toHaveTextContent('boom');
  });

  it('recovers from a fetch failure via the Retry button', async () => {
    vi.mocked(api.fetchSoftwareGroups)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ items: [group()], hasMore: false });
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} emptyVariant="filtered" onSelectGroup={() => {}} onClearFilters={() => {}} />);
    fireEvent.click(await screen.findByTestId('software-group-table-retry'));
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    expect(desktop.getByTestId('software-group-row-sw:google chrome|google llc')).toBeInTheDocument();
    expect(api.fetchSoftwareGroups).toHaveBeenCalledTimes(2);
  });
});
