import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

vi.mock('./reportExport', () => ({
  exportReport: vi.fn(),
  downloadBlob: vi.fn(),
  getBrowserTimezone: () => 'UTC',
}));

import ReportsList from './ReportsList';

describe('ReportsList templates entry point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      if (url.startsWith('/reports/runs?')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
  });

  it('links to the report templates gallery', async () => {
    render(
      <ReportsList onEdit={() => {}} onGenerate={() => {}} onDelete={() => {}} />
    );

    const link = await waitFor(() =>
      screen.getByRole('link', { name: /templates/i })
    );
    expect(link).toHaveAttribute('href', '/reports/templates');
  });
});
