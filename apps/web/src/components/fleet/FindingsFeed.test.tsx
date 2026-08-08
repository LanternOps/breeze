import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listFindingsMock, getFindingMock, patchFindingMock } = vi.hoisted(() => ({
  listFindingsMock: vi.fn(),
  getFindingMock: vi.fn(),
  patchFindingMock: vi.fn(),
}));

vi.mock('@/services/fleetFindings', () => ({
  listFindings: listFindingsMock,
  getFinding: getFindingMock,
  patchFinding: patchFindingMock,
}));

import FindingsFeed from './FindingsFeed';
import type { FleetFinding, FleetFindingDetail } from '@/services/fleetFindings';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const FINDING_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FINDING_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function finding(overrides: Partial<FleetFinding> = {}): FleetFinding {
  return {
    id: FINDING_A,
    orgId: ORG_A,
    orgName: 'Acme Corp',
    kind: 'metric_anomaly_pattern',
    semanticKey: 'cpu_saturation',
    status: 'open',
    severity: 'critical',
    title: 'Sustained CPU saturation across 6 devices',
    summary: 'Six devices held >95% CPU for over an hour.',
    evidence: { metric: 'cpu', threshold: 95 },
    deviceCount: 6,
    revision: 1,
    firstSeenAt: '2026-08-06T10:00:00.000Z',
    lastSeenAt: '2026-08-07T10:00:00.000Z',
    acknowledgedAt: null,
    acknowledgedBy: null,
    dismissedAt: null,
    dismissedBy: null,
    dismissNotes: null,
    resolvedAt: null,
    resolutionReason: null,
    ...overrides,
  };
}

function detail(overrides: Partial<FleetFindingDetail> = {}): FleetFindingDetail {
  return {
    ...finding(),
    members: [],
    runs: [],
    ...overrides,
  };
}

beforeEach(() => {
  window.location.hash = '';
  listFindingsMock.mockResolvedValue({ findings: [finding()], total: 1 });
  getFindingMock.mockResolvedValue(detail());
  patchFindingMock.mockImplementation(async (id: string) => finding({ id, status: 'acknowledged' }));
});

describe('FindingsFeed rendering', () => {
  it('renders a finding row with title, org, device count, kind and status', async () => {
    render(<FindingsFeed />);

    await waitFor(() => expect(screen.getByTestId(`finding-row-${FINDING_A}`)).toBeTruthy());
    const row = screen.getByTestId(`finding-row-${FINDING_A}`);
    expect(row.textContent).toContain('Sustained CPU saturation across 6 devices');
    expect(row.textContent).toContain('Acme Corp');
    expect(row.textContent).toContain('6');
    expect(row.textContent?.toLowerCase()).toContain('metric');
    expect(row.textContent?.toLowerCase()).toContain('open');
  });

  it('defaults to the open + acknowledged status filter', async () => {
    render(<FindingsFeed />);
    await waitFor(() => expect(listFindingsMock).toHaveBeenCalled());
    expect(listFindingsMock.mock.calls[0][0]).toMatchObject({
      statuses: ['open', 'acknowledged'],
    });
  });

  it('shows the "fleet is clean" empty state when there are no findings and no filters are applied', async () => {
    listFindingsMock.mockResolvedValue({ findings: [], total: 0 });
    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId('findings-empty')).toBeTruthy());
    expect(screen.getByTestId('findings-empty').textContent).toMatch(/clean/i);
  });

  it('shows a neutral "no matches" empty state (not "fleet is clean") when a filter excludes everything', async () => {
    listFindingsMock.mockResolvedValue({ findings: [], total: 0 });
    render(<FindingsFeed />);
    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('findings-filter-kind'), {
      target: { value: 'log_correlation' },
    });

    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('findings-empty')).toBeTruthy());
    expect(screen.getByTestId('findings-empty').textContent).not.toMatch(/clean/i);
  });

  it('shows an error banner with friendly copy (not the raw error) when the fetch fails, and keeps the filter bar usable', async () => {
    listFindingsMock.mockRejectedValue(new Error('Failed to fetch'));
    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId('findings-error')).toBeTruthy());
    expect(screen.getByTestId('findings-filter-kind')).toBeTruthy();
    expect(screen.getByTestId('findings-retry')).toBeTruthy();
    // The raw browser error must not be surfaced as the headline message.
    const banner = screen.getByTestId('findings-error');
    expect(banner.textContent).not.toBe('Failed to fetch');
  });

  it('retries the load when the retry button is clicked after a failure', async () => {
    listFindingsMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    listFindingsMock.mockResolvedValueOnce({ findings: [finding()], total: 1 });
    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId('findings-retry')).toBeTruthy());

    fireEvent.click(screen.getByTestId('findings-retry'));

    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId(`finding-row-${FINDING_A}`)).toBeTruthy());
    expect(screen.queryByTestId('findings-error')).toBeNull();
  });
});

describe('FindingsFeed pagination', () => {
  function pageOfFindings(count: number, prefix: string): FleetFinding[] {
    return Array.from({ length: count }, (_, i) =>
      finding({ id: `${prefix}-${i}`, title: `Finding ${prefix}-${i}` })
    );
  }

  it('shows a load-more control when more findings exist than the current page, and appends the next page', async () => {
    const page1 = pageOfFindings(50, 'p1');
    const page2 = pageOfFindings(17, 'p2');
    listFindingsMock.mockResolvedValueOnce({ findings: page1, total: 67 });
    listFindingsMock.mockResolvedValueOnce({ findings: page2, total: 67 });

    render(<FindingsFeed />);

    await waitFor(() => expect(screen.getByTestId('findings-load-more')).toBeTruthy());
    expect(screen.getByText('Showing 50 of 67')).toBeTruthy();

    fireEvent.click(screen.getByTestId('findings-load-more'));

    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(2));
    expect(listFindingsMock.mock.calls[1][0]).toMatchObject({ offset: 50, limit: 50 });

    await waitFor(() => expect(screen.getByText('Showing 67 of 67')).toBeTruthy());
    expect(screen.queryByTestId('findings-load-more')).toBeNull();
    expect(screen.getByTestId(`finding-row-${page2[16].id}`)).toBeTruthy();
  });

  it('does not show a load-more control when every finding is already loaded', async () => {
    listFindingsMock.mockResolvedValue({ findings: [finding()], total: 1 });
    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId(`finding-row-${FINDING_A}`)).toBeTruthy());
    expect(screen.queryByTestId('findings-load-more')).toBeNull();
  });

  it('resets accumulated pages when a filter changes', async () => {
    const page1 = pageOfFindings(50, 'p1');
    listFindingsMock.mockResolvedValueOnce({ findings: page1, total: 67 });
    listFindingsMock.mockResolvedValueOnce({ findings: pageOfFindings(17, 'p2'), total: 67 });

    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId('findings-load-more')).toBeTruthy());
    fireEvent.click(screen.getByTestId('findings-load-more'));
    await waitFor(() => expect(screen.getByText('Showing 67 of 67')).toBeTruthy());

    // A filter change fetches from the top again — the accumulated 67 rows
    // must not survive into the new (unrelated) result set.
    listFindingsMock.mockResolvedValueOnce({ findings: [finding()], total: 1 });
    fireEvent.change(screen.getByTestId('findings-filter-severity'), {
      target: { value: 'warning' },
    });

    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(3));
    expect(listFindingsMock.mock.calls[2][0]).toMatchObject({ severity: 'warning', offset: 0 });
    await waitFor(() => expect(screen.getByText('Showing 1 of 1')).toBeTruthy());
  });
});

describe('FindingsFeed filtering', () => {
  it('refetches with the selected kind', async () => {
    render(<FindingsFeed />);
    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('findings-filter-kind'), {
      target: { value: 'log_correlation' },
    });

    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(2));
    expect(listFindingsMock.mock.calls[1][0]).toMatchObject({ kind: 'log_correlation' });
  });

  it('refetches with the selected severity', async () => {
    render(<FindingsFeed />);
    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('findings-filter-severity'), {
      target: { value: 'warning' },
    });

    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(2));
    expect(listFindingsMock.mock.calls[1][0]).toMatchObject({ severity: 'warning' });
  });

  it('switches the status group to dismissed', async () => {
    render(<FindingsFeed />);
    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('findings-status-dismissed'));

    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(2));
    expect(listFindingsMock.mock.calls[1][0]).toMatchObject({ statuses: ['dismissed'] });
  });

  it('offers org options derived from the loaded findings and filters by org', async () => {
    listFindingsMock.mockResolvedValue({
      findings: [finding(), finding({ id: FINDING_B, orgId: ORG_B, orgName: 'Globex' })],
      total: 2,
    });
    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId(`finding-row-${FINDING_B}`)).toBeTruthy());

    fireEvent.change(screen.getByTestId('findings-filter-org'), { target: { value: ORG_B } });

    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(2));
    expect(listFindingsMock.mock.calls[1][0]).toMatchObject({ orgId: ORG_B });
  });
});

describe('FindingsFeed drawer wiring', () => {
  it('opens the drawer for the finding named in the hash', async () => {
    window.location.hash = `#${FINDING_A}`;
    render(<FindingsFeed />);

    await waitFor(() => expect(screen.getByTestId('finding-drawer')).toBeTruthy());
    expect(getFindingMock).toHaveBeenCalledWith(FINDING_A);
  });

  it('writes the finding id into the hash when a row is clicked', async () => {
    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId(`finding-row-${FINDING_A}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`finding-row-${FINDING_A}`));

    await waitFor(() => expect(window.location.hash).toBe(`#${FINDING_A}`));
    await waitFor(() => expect(screen.getByTestId('finding-drawer')).toBeTruthy());
  });

  it('clears the hash and closes the drawer on close', async () => {
    window.location.hash = `#${FINDING_A}`;
    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId('finding-drawer')).toBeTruthy());

    fireEvent.click(screen.getByTestId('finding-drawer-close'));

    await waitFor(() => expect(screen.queryByTestId('finding-drawer')).toBeNull());
    expect(window.location.hash).toBe('');
  });

  it('reflects a lifecycle change from the drawer back into the row when the new status still matches the active filter', async () => {
    window.location.hash = `#${FINDING_A}`;
    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId('finding-ack')).toBeTruthy());

    fireEvent.click(screen.getByTestId('finding-ack'));

    await waitFor(() =>
      expect(screen.getByTestId(`finding-row-${FINDING_A}`).textContent?.toLowerCase()).toContain(
        'acknowledged'
      )
    );
    // Acknowledging stays within the "active" (open+acknowledged) filter, so
    // this is an in-place patch, not a refetch.
    expect(listFindingsMock).toHaveBeenCalledTimes(1);
  });

  it('drops a row from the list (via refetch) once a lifecycle change moves it outside the active filter, without breaking the still-open drawer', async () => {
    window.location.hash = `#${FINDING_A}`;
    patchFindingMock.mockImplementation(async (id: string) =>
      finding({ id, status: 'dismissed', dismissedAt: '2026-08-08T00:00:00.000Z' })
    );
    // Initial load, then the refetch triggered by the dismiss no longer
    // matching the "active" status group.
    listFindingsMock
      .mockResolvedValueOnce({ findings: [finding()], total: 1 })
      .mockResolvedValueOnce({ findings: [], total: 0 });

    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId('finding-dismiss')).toBeTruthy());

    fireEvent.click(screen.getByTestId('finding-dismiss'));
    fireEvent.change(screen.getByTestId('finding-dismiss-notes'), {
      target: { value: 'No longer relevant' },
    });
    fireEvent.click(screen.getByTestId('finding-dismiss-confirm'));

    await waitFor(() => expect(listFindingsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId(`finding-row-${FINDING_A}`)).toBeNull());
    // The drawer keeps rendering (and reflecting the new status) throughout.
    expect(screen.getByTestId('finding-drawer')).toBeTruthy();
    expect(screen.getByTestId('finding-drawer').textContent?.toLowerCase()).toContain('dismissed');
  });
});
