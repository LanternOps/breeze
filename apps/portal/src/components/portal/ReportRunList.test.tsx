// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PortalRunDto } from '@breeze/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportRunList } from './ReportRunList';

const { generateMock, listMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  listMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  portalApi: {
    generateReport: generateMock,
    getReportRuns: listMock,
    reportArtifactUrl: (id: string, format: string) =>
      `/api/v1/portal/reports/runs/${id}/${format}`,
  },
}));

const run: PortalRunDto = {
  id: 'run-1',
  reportId: 'report-1',
  name: 'Customer portal — Executive summary',
  type: 'executive_summary',
  status: 'completed',
  startedAt: '2026-09-02T12:00:00.000Z',
  completedAt: '2026-09-02T12:01:00.000Z',
  rowCount: 4,
  createdAt: '2026-09-02T12:00:00.000Z',
};

const runAt = (id: string): PortalRunDto => ({ ...run, id });

describe('ReportRunList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates a report and renders PDF/CSV download links', async () => {
    generateMock.mockResolvedValue({ data: run });
    listMock.mockResolvedValue({ data: [run] });

    render(<ReportRunList initialRuns={[]} timezone="America/Denver" />);

    fireEvent.click(
      screen.getByTestId('portal-reports-generate-executive'),
    );

    await waitFor(() => {
      expect(generateMock).toHaveBeenCalledWith('executive_summary');
    });
    expect(
      await screen.findByTestId('portal-report-run-row-run-1'),
    ).toBeTruthy();

    expect(
      screen.getByTestId('portal-report-run-pdf-run-1').getAttribute('href'),
    ).toBe(
      '/api/v1/portal/reports/runs/run-1/pdf',
    );
    expect(
      screen.getByTestId('portal-report-run-csv-run-1').getAttribute('href'),
    ).toBe(
      '/api/v1/portal/reports/runs/run-1/csv',
    );
  });

  it('renders generated timestamps in the organization timezone with its label', () => {
    render(
      <ReportRunList
        initialRuns={[run]}
        timezone="America/Denver"
      />,
    );

    expect(screen.getByTestId('portal-report-run-row-run-1').textContent)
      .toContain('Sep 2, 2026, 06:01 AM (America/Denver)');
  });

  it('rules the runs as a ledger with scoped column headers', () => {
    render(<ReportRunList initialRuns={[run]} timezone="UTC" />);

    const headers = Array.from(
      document.querySelectorAll('th[scope="col"]'),
    ).map((th) => th.textContent);
    expect(headers).toEqual(['Report', 'Generated', 'Download']);
  });

  it("strips the MSP-side 'Customer portal' prefix from the customer's own list", () => {
    render(<ReportRunList initialRuns={[run]} timezone="UTC" />);

    const row = screen.getByTestId('portal-report-run-row-run-1');
    expect(row.textContent).toContain('Executive summary');
    expect(row.textContent).not.toContain('Customer portal');
  });

  it('totals the ledger in a foot line', () => {
    render(
      <ReportRunList
        initialRuns={[runAt('a'), runAt('b'), runAt('c')]}
        timezone="UTC"
      />,
    );
    expect(screen.getByTestId('report-ledger-foot').textContent).toBe(
      '3 reports available',
    );
  });

  it('announces the generate progress and completion politely', async () => {
    let settle: ((value: unknown) => void) | undefined;
    generateMock.mockImplementation(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    listMock.mockResolvedValue({ data: [run] });

    render(<ReportRunList initialRuns={[]} timezone="UTC" />);

    const status = screen.getByTestId('portal-reports-status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');

    fireEvent.click(screen.getByTestId('portal-reports-generate-posture'));

    await waitFor(() => {
      expect(status.textContent).toBe(
        'Generating your security summary…',
      );
    });

    settle?.({ data: run });

    await waitFor(() => {
      expect(status.textContent).toBe('Your report is ready.');
    });
  });

  it('offers the two generate actions as peers, with no false primary', () => {
    render(<ReportRunList initialRuns={[run]} timezone="UTC" />);

    const posture = screen.getByTestId('portal-reports-generate-posture');
    const executive = screen.getByTestId('portal-reports-generate-executive');
    expect(posture.className).toBe(executive.className);
    // BTN_PRIMARY's service-green fill is the tell.
    expect(posture.className).not.toContain('bg-primary');
  });

  it('speaks of the machines rather than an "environment", and labels the summary plainly', () => {
    render(<ReportRunList initialRuns={[run]} timezone="UTC" />);

    const container = document.body.textContent ?? '';
    expect(container).toContain('Generate and download a current summary of your machines.');
    expect(container).not.toContain('environment');
    expect(screen.getByTestId('portal-reports-generate-posture').textContent).toBe(
      'Generate security summary',
    );
  });

  it.each([
    ['failed', 'Did not complete'],
    ['running', 'Still generating'],
  ] as const)('offers no download for a %s run', (status, copy) => {
    render(
      <ReportRunList
        initialRuns={[{ ...run, status, completedAt: null }]}
        timezone="UTC"
      />,
    );

    expect(screen.queryByTestId('portal-report-run-pdf-run-1')).toBeNull();
    expect(screen.queryByTestId('portal-report-run-csv-run-1')).toBeNull();
    expect(screen.getByTestId('portal-report-run-download-run-1').textContent).toBe(copy);
    // The outcome is stated once per row, not echoed in the Generated column.
    const row = screen.getByTestId('portal-report-run-row-run-1');
    expect(row.textContent?.split(copy)).toHaveLength(2);
    expect(row.textContent).not.toContain('Generated');
  });

  it('tells the customer when to come back after a rate limit', async () => {
    generateMock.mockResolvedValue({
      error: 'Report generation is temporarily limited',
      statusCode: 429,
      headers: new Headers({ 'Retry-After': '120' }),
    });

    render(<ReportRunList initialRuns={[run]} timezone="UTC" />);

    fireEvent.click(screen.getByTestId('portal-reports-generate-posture'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Report generation is temporarily limited. Try again in about 2 minutes.',
    );
    expect(screen.getByTestId('portal-reports-status').textContent).toBe('');
  });
});
