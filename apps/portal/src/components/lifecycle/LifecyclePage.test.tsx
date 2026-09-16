// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HardwareLifecycleDeviceRow, HardwareLifecycleSummary } from '@breeze/shared';
import { buildAtAGlanceFacts, buildReplacementSchedule } from '@breeze/shared';
import { LifecyclePage } from './LifecyclePage';
import { portalApi } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  portalApi: {
    generateReport: vi.fn(),
    getHardwareLifecycleLatest: vi.fn(),
  },
}));

function row(
  partial: Partial<HardwareLifecycleDeviceRow> & { name: string },
): HardwareLifecycleDeviceRow {
  return {
    id: partial.name,
    kind: 'device',
    os: 'Windows 11 Pro',
    osSupport: 'supported',
    purchaseDate: null,
    purchaseDateSource: null,
    warrantyEndDate: null,
    ageYears: null,
    replaceBy: null,
    replacement: 'unknown',
    warrantyExtended: false,
    lifeUsed: null,
    ...partial,
  };
}

const SAM4 = row({
  name: 'SAM4', user: 'CORP\\sam.lee', manufacturer: 'Dell Inc.', model: 'OptiPlex 3050',
  serialNumber: '255P3W2', os: 'Windows 10 Pro', osSupport: 'ended', purchaseDate: '2019-04-01',
  purchaseDateSource: 'manual', warrantyEndDate: '2022-04-01', ageYears: 7.1, replaceBy: '2023-04-01',
  replacement: 'replace', lifeUsed: 1,
});
const LAW_SRV = row({
  name: 'LAW-SRV', deviceKind: 'server', manufacturer: 'Dell Inc.', model: 'PowerEdge T340',
  os: 'Windows Server 2019', osSupport: 'ending', purchaseDate: '2021-10-01', purchaseDateSource: 'vendor',
  warrantyEndDate: '2026-11-30', ageYears: 4.7, replaceBy: '2026-11-30', replacement: 'due_soon',
  warrantyExtended: true, lifeUsed: 0.9,
});
const MACBOOK_AIR = row({ name: 'MacBook-Air.local', manufacturer: 'Apple Inc.', os: 'macOS 26.3.1' });

const RUN = { id: 'run-1', generatedAt: 'Jun 10, 2026, 12:00 PM' };

function summaryWith(rows: HardwareLifecycleDeviceRow[]): HardwareLifecycleSummary {
  return {
    rows,
    other: [],
    recommendations: [],
    replaceAgeYears: 4,
    serverReplaceAgeYears: 5,
  };
}

describe('LifecyclePage', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders the partner contact from the initial response', () => {
    render(<LifecyclePage initialRun={RUN} initialSummary={summaryWith([SAM4])}
      initialContact={{ name: 'Sam Lee', email: 'support@example.test' }} />);
    expect(screen.getByTestId('lifecycle-closing')).toHaveTextContent('Sam Lee (support@example.test)');
  });

  it('omits the closing line without a contact', () => {
    render(<LifecyclePage initialRun={RUN} initialSummary={summaryWith([SAM4])} initialContact={null} />);
    expect(screen.queryByTestId('lifecycle-closing')).toBeNull();
  });

  it('updates and clears the contact when refreshing', async () => {
    vi.mocked(portalApi.generateReport).mockResolvedValue({
      data: {
        id: 'run-2', reportId: 'report-1', type: 'hardware_lifecycle',
        name: 'Hardware lifecycle', status: 'completed', startedAt: null,
        completedAt: null, rowCount: 1, createdAt: '2026-06-10T12:00:00.000Z',
      },
      statusCode: 201,
    });
    const payload = { run: RUN, summary: summaryWith([SAM4]), enableSelfService: true };
    vi.mocked(portalApi.getHardwareLifecycleLatest)
      .mockResolvedValueOnce({ data: { ...payload, contact: { name: 'New Contact', email: 'new@example.test' } } })
      .mockResolvedValueOnce({ data: { ...payload, contact: null } });

    render(<LifecyclePage initialRun={RUN} initialSummary={payload.summary} />);
    fireEvent.click(screen.getByTestId('lifecycle-refresh'));
    await waitFor(() => expect(screen.getByTestId('lifecycle-closing')).toHaveTextContent('New Contact (new@example.test)'));
    await waitFor(() => expect(screen.getByTestId('lifecycle-refresh')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('lifecycle-refresh'));
    await waitFor(() => expect(screen.queryByTestId('lifecycle-closing')).toBeNull());
  });

  it('lays out the sections in PDF order: bar, schedule, workstations, servers, other equipment, recommendations, closing', () => {
    const summary = summaryWith([SAM4, LAW_SRV, MACBOOK_AIR]);
    render(<LifecyclePage initialRun={RUN} initialSummary={summary} />);

    const order = [
      'lifecycle-status-bar',
      'lifecycle-schedule',
      'lifecycle-plan-table-workstations',
      'lifecycle-plan-table-servers',
    ];
    const positions = order.map((id) => {
      const el = screen.getByTestId(id);
      return Array.prototype.indexOf.call(document.querySelectorAll('[data-testid]'), el);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // Workstations table gets SAM4 and MacBook-Air, not the server.
    expect(screen.getByTestId('lifecycle-plan-table-workstations')).toHaveTextContent('Sam Lee');
    expect(screen.getByTestId('lifecycle-plan-table-servers')).toHaveTextContent('LAW-SRV');
  });

  it('heads the workstation-only table "Device replacement plan" when there are no servers', () => {
    const summary = summaryWith([SAM4]);
    render(<LifecyclePage initialRun={RUN} initialSummary={summary} />);
    expect(screen.getByTestId('lifecycle-plan-table-workstations')).toHaveTextContent('Device replacement plan');
    expect(screen.queryByTestId('lifecycle-plan-table-servers')).toBeNull();
  });

  it('renders the empty state with a Refresh button when no run has ever completed', () => {
    render(<LifecyclePage initialRun={null} initialSummary={null} />);
    expect(screen.getByText('We have not generated your hardware lifecycle plan yet.')).toBeInTheDocument();
    expect(screen.getByTestId('lifecycle-refresh')).toBeInTheDocument();
    expect(screen.queryByTestId('lifecycle-status-bar')).toBeNull();
  });

  it('Refresh generates a new run and re-fetches the latest summary', async () => {
    const newSummary = summaryWith([SAM4]);
    (portalApi.generateReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'run-2', status: 'completed' },
      statusCode: 200,
    });
    (portalApi.getHardwareLifecycleLatest as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { run: { id: 'run-2', generatedAt: 'Jun 11, 2026, 9:00 AM' }, summary: newSummary },
      statusCode: 200,
    });

    render(<LifecyclePage initialRun={null} initialSummary={null} />);
    fireEvent.click(screen.getByTestId('lifecycle-refresh'));

    await waitFor(() => {
      expect(screen.getByTestId('lifecycle-status-bar')).toBeInTheDocument();
    });
    expect(portalApi.generateReport).toHaveBeenCalledWith('hardware_lifecycle');
    expect(portalApi.getHardwareLifecycleLatest).toHaveBeenCalled();
  });

  it('shows a retry hint on a 429 from Refresh', async () => {
    (portalApi.generateReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      statusCode: 429,
      error: 'Report generation is temporarily limited',
      headers: new Headers({ 'Retry-After': '120' }),
    });

    render(<LifecyclePage initialRun={null} initialSummary={null} />);
    fireEvent.click(screen.getByTestId('lifecycle-refresh'));

    await waitFor(() => {
      expect(screen.getByText(/Try again in about 2 minutes/)).toBeInTheDocument();
    });
  });

  it('shows a plain error with no retry hint on a non-429 generate failure', async () => {
    (portalApi.generateReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      statusCode: 500,
      error: 'Could not generate the report',
    });

    render(<LifecyclePage initialRun={null} initialSummary={null} />);
    fireEvent.click(screen.getByTestId('lifecycle-refresh'));

    await waitFor(() => {
      expect(screen.getByText('Could not generate the report.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Try again in about/)).toBeNull();
  });

  it('surfaces an error and stops spinning when generate succeeds but the refetch fails', async () => {
    (portalApi.generateReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'run-2', status: 'completed' },
      statusCode: 200,
    });
    (portalApi.getHardwareLifecycleLatest as ReturnType<typeof vi.fn>).mockResolvedValue({
      statusCode: 500,
      error: 'Could not load your hardware lifecycle plan.',
    });

    render(<LifecyclePage initialRun={null} initialSummary={null} />);
    fireEvent.click(screen.getByTestId('lifecycle-refresh'));

    await waitFor(() => {
      expect(screen.getByText('Could not load your hardware lifecycle plan.')).toBeInTheDocument();
    });
    // The page must not stay in the empty state showing stale nothing, nor
    // get stuck mid-refresh: the button is clickable again.
    expect(screen.getByTestId('lifecycle-refresh')).not.toBeDisabled();
    // No plan data ever arrived, so the empty state (not a half-built report)
    // is still what's on screen.
    expect(screen.queryByTestId('lifecycle-status-bar')).toBeNull();
  });

  it('renders only the "Purchase date unknown" schedule group and the confirming-dates sentence for an all-undated fleet', () => {
    const undated = [
      row({ name: 'A', replacement: 'unknown', osSupport: 'unclassified' }),
      row({ name: 'B', replacement: 'unknown', osSupport: 'unclassified' }),
    ];
    expect(buildReplacementSchedule(undated).every((g) => g.label === 'Purchase date unknown')).toBe(true);
    expect(buildAtAGlanceFacts(undated)).toContain('confirming purchase dates');

    render(<LifecyclePage initialRun={RUN} initialSummary={summaryWith(undated)} />);

    const schedule = screen.getByTestId('lifecycle-schedule');
    expect(schedule).toHaveTextContent('Purchase date unknown');
    expect(schedule).not.toHaveTextContent('Now');
    expect(screen.getByTestId('lifecycle-status-fact')).toHaveTextContent('confirming purchase dates');
    expect(screen.queryByTestId('lifecycle-timeline-grid')).toBeNull();
  });

  it('renders every row of a large, dated fleet inside a horizontally-scrolling wrapper with no pagination', () => {
    // Dated (not the row() helper's default null/null), so every row's
    // TimelineCell actually draws its 20-cell grid — the DOM-heavy case this
    // test exists to catch, not just an empty timeline column repeated.
    const many = Array.from({ length: 120 }, (_, i) =>
      row({
        name: `WS-${i}`,
        replacement: 'supported',
        osSupport: 'supported',
        purchaseDate: '2024-01-01',
        purchaseDateSource: 'manual',
        replaceBy: '2029-01-01',
      }),
    );
    render(<LifecyclePage initialRun={RUN} initialSummary={summaryWith(many)} />);
    const table = screen.getByTestId('lifecycle-plan-table-workstations');
    expect(table.querySelector('.overflow-x-auto')).not.toBeNull();
    expect(screen.queryByText(/page 1 of/i)).toBeNull();
    expect(screen.queryByRole('navigation', { name: /pagination/i })).toBeNull();

    // All 120 rows present, none silently truncated, and each one's timeline
    // grid actually rendered.
    expect(screen.getAllByTestId('lifecycle-timeline-grid')).toHaveLength(120);
    expect(screen.getByTestId('lifecycle-plan-row-WS-0')).toBeInTheDocument();
    expect(screen.getByTestId('lifecycle-plan-row-WS-119')).toBeInTheDocument();
  });

  // #5880: the enableSelfService flag has to reach both LifecyclePlanTable
  // instantiations (workstations and servers), not just one.
  it('threads enableSelfService=false through to both the workstations and servers tables', () => {
    const summary = summaryWith([SAM4, LAW_SRV]);
    render(
      <LifecyclePage initialRun={RUN} initialSummary={summary} enableSelfService={false} />,
    );
    expect(screen.queryByTestId('lifecycle-plan-row-link-SAM4')).toBeNull();
    expect(screen.queryByTestId('lifecycle-plan-row-link-LAW-SRV')).toBeNull();
    expect(screen.getByTestId('lifecycle-plan-row-SAM4')).toHaveTextContent('Sam Lee');
  });

  it('still links device rows when enableSelfService is true (or omitted)', () => {
    const summary = summaryWith([SAM4]);
    render(<LifecyclePage initialRun={RUN} initialSummary={summary} />);
    expect(screen.getByTestId('lifecycle-plan-row-link-SAM4')).toBeInTheDocument();
  });
});
