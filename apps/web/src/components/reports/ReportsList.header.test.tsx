import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: null }) => unknown) => selector({ user: null }),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: null }) }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => ({ status: 'unresolved' }) }));

vi.mock('./reportExport', () => ({
  exportReport: vi.fn(),
  downloadBlob: vi.fn(),
  getBrowserTimezone: () => 'UTC',
}));

import ReportsList from './ReportsList';

// #7151: the header row (title/description + templates/ad-hoc/new-report
// buttons) must stack on mobile instead of clipping the primary button.
describe('ReportsList header (#7151)', () => {
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

  it('stacks the title and action buttons below md via the shared PageHeader', async () => {
    render(<ReportsList onEdit={() => {}} onGenerate={() => {}} onDelete={() => {}} />);

    const newReportLink = await waitFor(() => screen.getByRole('link', { name: /new report/i }));
    const headerRow = newReportLink.closest('[class*="flex-col"]');
    expect(headerRow).not.toBeNull();
    expect(headerRow?.className).toContain('md:flex-row');

    const actionsContainer = newReportLink.closest('[class*="flex-wrap"]');
    expect(actionsContainer).not.toBeNull();
  });
});
