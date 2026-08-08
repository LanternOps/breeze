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

  it('shows the "fleet is clean" empty state when there are no findings', async () => {
    listFindingsMock.mockResolvedValue({ findings: [], total: 0 });
    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId('findings-empty')).toBeTruthy());
    expect(screen.getByTestId('findings-empty').textContent).toMatch(/clean/i);
  });

  it('shows an error banner when the fetch fails and keeps the filter bar usable', async () => {
    listFindingsMock.mockRejectedValue(new Error('boom'));
    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId('findings-error')).toBeTruthy());
    expect(screen.getByTestId('findings-filter-kind')).toBeTruthy();
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

  it('reflects a lifecycle change from the drawer back into the row', async () => {
    window.location.hash = `#${FINDING_A}`;
    render(<FindingsFeed />);
    await waitFor(() => expect(screen.getByTestId('finding-ack')).toBeTruthy());

    fireEvent.click(screen.getByTestId('finding-ack'));

    await waitFor(() =>
      expect(screen.getByTestId(`finding-row-${FINDING_A}`).textContent?.toLowerCase()).toContain(
        'acknowledged'
      )
    );
  });
});
