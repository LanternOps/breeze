import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

const exportReport = vi.fn();
const downloadBlob = vi.fn();
vi.mock('./reportExport', () => ({
  exportReport: (...a: unknown[]) => exportReport(...a),
  downloadBlob: (...a: unknown[]) => downloadBlob(...a),
  getBrowserTimezone: () => 'UTC',
}));

import ReportsList from './ReportsList';

const completedRun = {
  id: 'run-1',
  reportId: 'rep-1',
  status: 'completed',
  startedAt: '2026-06-28T00:00:00Z',
  completedAt: '2026-06-28T00:01:00Z',
  outputUrl: '/api/reports/runs/run-1/download',
  errorMessage: null,
  createdAt: '2026-06-28T00:00:00Z',
  reportName: 'Inventory',
  reportType: 'device_inventory',
};

/** Mount with the saved-reports + recent-runs list responses; per-test cases add the download response. */
function mountWith(downloadResponse: (url: string) => Promise<unknown> | undefined) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    if (url.startsWith('/reports/runs?')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [completedRun] }) });
    }
    const handled = downloadResponse(url);
    if (handled) return handled;
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('ReportsList download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves the returned CSV blob without regenerating', async () => {
    const blob = new Blob(['hostname\n"pc-1"'], { type: 'text/csv' });
    mountWith((url) => {
      if (url === '/reports/runs/run-1/download') {
        return Promise.resolve({
          ok: true,
          headers: new Headers({
            'content-type': 'text/csv',
            'content-disposition': 'attachment; filename="device_inventory-report-2026-06-28.csv"',
          }),
          blob: () => Promise.resolve(blob),
        });
      }
      return undefined;
    });

    render(<ReportsList />);
    await userEvent.click(await screen.findByText('Recent Runs'));
    await userEvent.click(await screen.findByText('Download'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(downloadBlob).toHaveBeenCalledWith(blob, 'device_inventory-report-2026-06-28.csv');
    expect(exportReport).not.toHaveBeenCalled();
    // Never re-queries the live generate endpoint.
    expect(fetchWithAuth).not.toHaveBeenCalledWith('/reports/generate', expect.anything());
  });

  it('renders PDF client-side from the JSON snapshot', async () => {
    mountWith((url) => {
      if (url === '/reports/runs/run-1/download') {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ type: 'device_inventory', format: 'pdf', data: { rows: [{ hostname: 'pc-1' }] } }),
        });
      }
      return undefined;
    });

    render(<ReportsList />);
    await userEvent.click(await screen.findByText('Recent Runs'));
    await userEvent.click(await screen.findByText('Download'));

    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
    expect(exportReport).toHaveBeenCalledWith(
      [{ hostname: 'pc-1' }],
      expect.objectContaining({ format: 'pdf', reportType: 'device_inventory' }),
    );
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('surfaces a server error message', async () => {
    mountWith((url) => {
      if (url === '/reports/runs/run-1/download') {
        return Promise.resolve({
          ok: false,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ error: 'Report run has no tabular data to download' }),
        });
      }
      return undefined;
    });

    render(<ReportsList />);
    await userEvent.click(await screen.findByText('Recent Runs'));
    await userEvent.click(await screen.findByText('Download'));

    expect(await screen.findByText('Report run has no tabular data to download')).toBeInTheDocument();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(exportReport).not.toHaveBeenCalled();
  });
});
