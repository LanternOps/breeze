import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

vi.mock('./reportExport', () => ({
  exportReport: vi.fn(),
  downloadBlob: vi.fn(),
  getBrowserTimezone: () => 'UTC',
}));

import ReportsList from './ReportsList';

const monthlyReport = {
  id: 'rep-1',
  name: 'Monthly Inventory',
  type: 'device_inventory',
  schedule: 'monthly',
  format: 'csv',
  config: { schedule: { time: '09:00', date: '1' }, emailRecipients: ['a@b.co', 'c@d.co'] },
  lastGeneratedAt: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

const oneTimeReport = {
  id: 'rep-2',
  name: 'One-off Alert Summary',
  type: 'alert_summary',
  schedule: 'one_time',
  format: 'pdf',
  config: {},
  lastGeneratedAt: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

function mountWith(reports: unknown[]) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: reports }) });
    if (url.startsWith('/reports/runs?')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('ReportsList schedule cell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows next-run time and recipient count for a recurring report', async () => {
    mountWith([monthlyReport]);
    render(<ReportsList onEdit={() => {}} onGenerate={() => {}} onDelete={() => {}} />);

    await waitFor(() => expect(screen.getByText('Monthly Inventory')).toBeInTheDocument());
    expect(screen.getByText(/^Next: .+/)).toBeInTheDocument();
    expect(within(screen.getByTitle('Email recipients')).getByText('2')).toBeInTheDocument();
  });

  it('renders no next-run line for a one-time report', async () => {
    mountWith([oneTimeReport]);
    render(<ReportsList onEdit={() => {}} onGenerate={() => {}} onDelete={() => {}} />);

    await waitFor(() => expect(screen.getByText('One-off Alert Summary')).toBeInTheDocument());
    expect(screen.queryByText(/^Next: .+/)).not.toBeInTheDocument();
  });
});
