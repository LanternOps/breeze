import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportTemplates from './ReportTemplates';

// GET /reports/templates returns the org's saved reports. Using a curated
// template saves a report carrying the curated name, so the next load must
// fold that row into the curated card instead of rendering a second card
// with the same name.
function mockSavedReports(rows: Record<string, unknown>[]) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports/templates') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: rows, pagination: {} }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('ReportTemplates — saved reports merged into curated cards', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not duplicate a curated card when a saved report carries its name', async () => {
    mockSavedReports([
      {
        id: '5d0f4c1e-9c3b-4a7e-9c2f-1c9a6f1d2b33',
        name: 'Hardware Lifecycle Report',
        type: 'hardware_lifecycle',
        schedule: 'quarterly',
        format: 'pdf',
        config: { dateRange: { preset: 'last_30_days' } }
      },
      {
        id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
        name: 'Hardware Lifecycle Report',
        type: 'hardware_lifecycle',
        schedule: 'monthly',
        format: 'pdf',
        config: { dateRange: { preset: 'last_30_days' } }
      }
    ]);
    render(<ReportTemplates />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/reports/templates'));
    await waitFor(() => expect(screen.queryByText(/syncing/i)).toBeNull());

    expect(screen.getAllByText('Hardware Lifecycle Report')).toHaveLength(1);
  });

  it('still lists a saved report with a novel name as its own card', async () => {
    mockSavedReports([
      {
        id: '5d0f4c1e-9c3b-4a7e-9c2f-1c9a6f1d2b33',
        name: 'Quarterly board pack',
        type: 'executive_summary',
        schedule: 'quarterly',
        format: 'pdf',
        config: { dateRange: { preset: 'last_90_days' } }
      }
    ]);
    render(<ReportTemplates />);

    expect(await screen.findByText('Quarterly board pack')).toBeTruthy();
    expect(screen.getAllByText('Hardware Lifecycle Report')).toHaveLength(1);
  });
});
