import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  registerOrgIdProvider: vi.fn(),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./ReportBuilder', () => ({
  default: () => <div data-testid="report-builder-stub" />,
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportEditPage from './ReportEditPage';

const report = {
  id: 'report-1',
  name: 'Backups',
  orgId: 'org-7',
  type: 'backup_status',
  schedule: 'one_time',
  format: 'pdf',
  config: { includeDevicesWithoutBackup: false, sources: ['provider'] },
  lastGeneratedAt: null,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};

const generated = {
  type: 'backup_status',
  format: 'pdf',
  generatedAt: '2026-09-28T05:18:00.000Z',
  data: {
    rows: [],
    rowCount: 0,
    summary: {
      summary: { byHealth: { healthy: 7, warning: 2, critical: 1, unknown: 0 } },
      truncated: false,
    },
  },
};

describe('ReportEditPage backup status preview (#7506)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/reports/report-1') return Promise.resolve({ ok: true, json: () => Promise.resolve(report) });
      if (url === '/reports/generate') return Promise.resolve({ ok: true, json: () => Promise.resolve(generated) });
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });
  });

  it('generates nothing until the user asks, then renders the health tiles from the real report type', async () => {
    render(<ReportEditPage reportId="report-1" />);
    const run = await screen.findByTestId('backup-status-preview-run');
    expect(fetchWithAuth.mock.calls.some(([u]) => u === '/reports/generate')).toBe(false);

    await userEvent.setup().click(run);

    const tiles = await screen.findByTestId('backup-status-summary');
    expect(tiles).toHaveTextContent('Healthy');
    const call = fetchWithAuth.mock.calls.find(([u]) => u === '/reports/generate')!;
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body).toMatchObject({
      type: 'backup_status',
      orgId: 'org-7',
      config: { includeDevicesWithoutBackup: false, sources: ['provider'] },
    });
  });

  it('shows an inline error when generation fails', async () => {
    fetchWithAuth.mockImplementation((url: string) =>
      url === '/reports/report-1'
        ? Promise.resolve({ ok: true, json: () => Promise.resolve(report) })
        : Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    render(<ReportEditPage reportId="report-1" />);
    await userEvent.setup().click(await screen.findByTestId('backup-status-preview-run'));
    await waitFor(() => expect(screen.getByTestId('backup-status-preview-error')).toBeInTheDocument());
  });
});
