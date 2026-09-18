import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

vi.mock('./reportExport', () => ({
  exportReport: vi.fn(),
  downloadBlob: vi.fn(),
  getBrowserTimezone: () => 'UTC',
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import ReportsList from './ReportsList';

const baseReport = {
  id: 'rep-1',
  name: 'Monthly Inventory',
  type: 'device_inventory',
  schedule: 'monthly',
  format: 'csv',
  config: {},
  lastGeneratedAt: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

describe('ReportsList generate now', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toasts success and refetches so the row drops "Never" after a 200 generate', async () => {
    let reportsCallCount = 0;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/reports') {
        reportsCallCount += 1;
        const report = reportsCallCount === 1
          ? baseReport
          : { ...baseReport, lastGeneratedAt: '2026-09-16T12:00:00Z' };
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [report] }) });
      }
      if (url.startsWith('/reports/runs?')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      }
      if (url === '/reports/rep-1/generate' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ message: 'Report generated', runId: 'run-1', status: 'completed' }),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });

    render(<ReportsList />);

    await waitFor(() => expect(screen.getByText('Monthly Inventory')).toBeInTheDocument());
    expect(screen.getByText('Never')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('report-generate-rep-1'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }))
    );

    // Regression guard: the row must reflect the completed run without a
    // manual reload, so the list must have been refetched.
    await waitFor(() => expect(screen.queryByText('Never')).not.toBeInTheDocument());
    expect(reportsCallCount).toBeGreaterThanOrEqual(2);
  });

  it('toasts an error and leaves the row unchanged on a failed generate', async () => {
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/reports') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [baseReport] }) });
      }
      if (url.startsWith('/reports/runs?')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      }
      if (url === '/reports/rep-1/generate' && init?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });

    render(<ReportsList />);
    await waitFor(() => expect(screen.getByText('Monthly Inventory')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('report-generate-rep-1'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
    );
    expect(screen.getByText('Never')).toBeInTheDocument();
  });
});
