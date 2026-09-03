// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const run = {
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

describe('ReportRunList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates a report and renders PDF/CSV download links', async () => {
    generateMock.mockResolvedValue({ data: run });
    listMock.mockResolvedValue({ data: [run] });

    render(<ReportRunList initialRuns={[]} />);

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
});
